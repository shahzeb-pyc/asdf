import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DomainError,
  isPeriodActive,
  quoteUpgrade,
  totalPricePkr,
  SUBSCRIPTION_PERIOD_DAYS,
  SUBSCRIPTION_PLATFORMS,
  type PlatformCounts,
  type SubscriptionPlatform,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import {
  applyHeldRedemptionsForPayment,
  releaseHeldRedemptionsForPayment,
} from './coupons';
import { recordCommissionForPayment } from './sellers';
import { cancelPendingRefundsForSupersededPeriods } from './refund-cancel';

/**
 * Subscription entitlement, server-side only.
 *
 * The usage registry is the single source of truth for the cap:
 * one row per distinct destination a user has used in a feature,
 * per platform. Connecting an account/page never writes here.
 * Posting gates call assertCanPost/registerUsage; future features
 * (auto download-upload, auto repost) call the same functions
 * through the usage-register API route.
 *
 * EXCEPTION — Publish Now is unlimited (owner decision 2026-10-31):
 * it writes NO usage rows at all and its routes use the plan-only
 * assertPaidPlan gate instead of assertCanPost/registerUsage. Rows
 * with publish-now features that predate the 2026-11-01 audit fix
 * are legacy history: every cap check below excludes them, and a
 * capped registration colliding with one replaces it (see
 * registerUsage). Never write a publish-now row again.
 *
 * SCOPE — per user account, across all workspaces (owner decision
 * 2026-10-31): every cap function below takes only a userId.
 * There is deliberately NO workspace parameter in the cap path:
 * usage in workspace A plus usage in workspace B counts against
 * the same purchased units, and at-cap in one workspace blocks
 * adding a destination in any other workspace. Verified
 * 2026-10-31: no cap query filters by workspace, and every
 * enforcement call site passes the person-level session userId.
 * The workspace_id columns on subscription_periods/payments are
 * unused dead columns (never written or read); they are left in
 * place, not removed, until a migration decision is made.
 */

export interface SubscriptionPeriodRow {
  id: string;
  userId: string;
  counts: PlatformCounts;
  startsAt: Date;
  endsAt: Date;
  supersededAt: Date | null;
}

export interface SubscriptionPaymentRow {
  id: string;
  userId: string;
  method: 'bank' | 'nowpayments';
  bankMethod: 'easypaisa' | 'nayapay' | 'ubl' | 'binance' | null;
  status: string;
  counts: PlatformCounts;
  amountPkr: number;
  isUpgrade: boolean;
  screenshotStorageKey: string | null;
  nowpaymentsPaymentId: string | null;
  nowpaymentsPayAddress: string | null;
  nowpaymentsPayAmount: number | null;
  nowpaymentsNetwork: 'trc20' | 'bep20' | null;
  /** IPN actuals (audit fix 2026-11-01): what the gateway really
   *  received, persisted from the finished notification. Null until
   *  a finished IPN with actuals arrives (or the columns predate
   *  the migration that adds them). Refund math prefers this over
   *  the checkout estimate. Stored alongside amount_pkr, never
   *  converted into it. */
  nowpaymentsActualPaid?: number | null;
  nowpaymentsActualCurrency?: string | null;
  couponCode: string | null;
  discountPkr: number;
  periodId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface Entitlement {
  plan: 'free' | 'paid';
  active: boolean;
  counts: PlatformCounts;
  usage: PlatformCounts;
  period: SubscriptionPeriodRow | null;
  canPost: boolean;
  readOnly: boolean;
  reason: string | null;
  /**
   * True when the user has ever held a paid period, active or lapsed.
   * The active-period lookup alone cannot tell "never paid" from
   * "lapsed": both report period null. The sidebar plan word needs
   * the distinction (Free vs Expired).
   */
  hasPriorPeriod: boolean;
}

export class SubscriptionGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type UnknownRow = Record<string, unknown>;

function asRow(value: unknown): UnknownRow | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRow)
    : null;
}

function stringField(row: UnknownRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function numberField(row: UnknownRow, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : 0;
}

function boolField(row: UnknownRow, key: string): boolean {
  return row[key] === true;
}

function dateField(row: UnknownRow, key: string): Date | null {
  const value = row[key];
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function countsFromRow(row: UnknownRow): PlatformCounts {
  return {
    facebook: numberField(row, 'facebook_count'),
    instagram: numberField(row, 'instagram_count'),
    threads: numberField(row, 'threads_count'),
    x: numberField(row, 'x_count'),
    tiktok: numberField(row, 'tiktok_count'),
    youtube: numberField(row, 'youtube_count'),
  };
}

export function periodFromRow(row: UnknownRow): SubscriptionPeriodRow | null {
  const id = stringField(row, 'id');
  const userId = stringField(row, 'user_id');
  const startsAt = dateField(row, 'starts_at');
  const endsAt = dateField(row, 'ends_at');
  if (!id || !userId || !startsAt || !endsAt) return null;
  return {
    id,
    userId,
    counts: countsFromRow(row),
    startsAt,
    endsAt,
    supersededAt: dateField(row, 'superseded_at'),
  };
}

export function paymentFromRow(row: UnknownRow): SubscriptionPaymentRow | null {
  const id = stringField(row, 'id');
  const userId = stringField(row, 'user_id');
  if (!id || !userId) return null;
  const method = stringField(row, 'method');
  const bankMethod = stringField(row, 'bank_method');
  const network = stringField(row, 'nowpayments_network');
  const payAmount = row['nowpayments_pay_amount'];
  const actualPaid = row['nowpayments_actual_paid'];
  const actualCurrency = row['nowpayments_actual_currency'];
  return {
    id,
    userId,
    method: method === 'nowpayments' ? 'nowpayments' : 'bank',
    bankMethod:
      bankMethod === 'easypaisa' ||
      bankMethod === 'nayapay' ||
      bankMethod === 'ubl' ||
      bankMethod === 'binance'
        ? bankMethod
        : null,
    status: stringField(row, 'status') ?? 'pending',
    counts: countsFromRow(row),
    amountPkr: numberField(row, 'amount_pkr'),
    isUpgrade: boolField(row, 'is_upgrade'),
    screenshotStorageKey: stringField(row, 'screenshot_storage_key'),
    nowpaymentsPaymentId: stringField(row, 'nowpayments_payment_id'),
    nowpaymentsPayAddress: stringField(row, 'nowpayments_pay_address'),
    nowpaymentsPayAmount: typeof payAmount === 'number' ? payAmount : null,
    nowpaymentsNetwork: network === 'trc20' || network === 'bep20' ? network : null,
    nowpaymentsActualPaid: typeof actualPaid === 'number' ? actualPaid : null,
    nowpaymentsActualCurrency: typeof actualCurrency === 'string' ? actualCurrency : null,
    couponCode: stringField(row, 'coupon_code'),
    discountPkr: numberField(row, 'discount_pkr'),
    periodId: stringField(row, 'period_id'),
    approvedAt: stringField(row, 'approved_at'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

const COUNT_COLUMNS =
  'facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count';

/**
 * Publish Now features, LEGACY rows only (audit fix 2026-11-01).
 * Publish Now is unlimited and writes NO usage rows at all: the
 * usage route rejects publish-now features, and registerUsage
 * refuses them, so no new row with these features can ever appear.
 * The exclusions in the cap counts below exist ONLY for rows
 * written before that fix (PR #77 kept them for history): a
 * legacy publish-now-only destination must not suddenly consume
 * cap. A capped registration colliding with a legacy row deletes
 * that row and inserts the capped row (see registerUsage) — the
 * legacy row is gone afterwards, never reclassified in place.
 */
export const LEGACY_UNCAPPED_USAGE_FEATURES = [
  'publish-now',
  'instagram-publish-now',
  'threads-publish-now',
] as const;

export function isLegacyUncappedUsageFeature(feature: unknown): boolean {
  return (
    typeof feature === 'string' &&
    (LEGACY_UNCAPPED_USAGE_FEATURES as readonly string[]).includes(feature)
  );
}

export async function getActivePeriod(
  client: SupabaseClient,
  userId: string,
  now: Date
): Promise<SubscriptionPeriodRow | null> {
  const { data, error } = await client
    .from('subscription_periods')
    .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
    .eq('user_id', userId)
    .is('superseded_at', null)
    .lte('starts_at', now.toISOString())
    .gt('ends_at', now.toISOString())
    .order('ends_at', { ascending: false })
    .limit(1);
  if (error) {
    // Log at the site that sees the database error: callers turn
    // this into a plain user message without logging, so without
    // this line a database outage would leave no reason in the logs.
    logServerError('[billing] active period query failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const row = Array.isArray(data) && data.length > 0 ? asRow(data[0]) : null;
  return row ? periodFromRow(row) : null;
}

/**
 * One pending payment per user at a time. While any payment with
 * status 'pending' exists for the user, new submissions (bank and
 * crypto alike) are blocked. Approved, rejected, paid, failed, and
 * expired payments never block. A query failure fails closed: the
 * caller must not proceed to create a payment it cannot prove is
 * the user's only pending one.
 */
export const PENDING_PAYMENT_EXISTS_MESSAGE =
  'You already have a payment waiting for approval. Wait for it to be decided before submitting another.';

export async function hasPendingPayment(
  client: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_payments')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .limit(1);
  if (error) {
    logServerError('[billing] pending payment query failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}

export async function getUsageCounts(
  client: SupabaseClient,
  userId: string
): Promise<PlatformCounts> {
  const usage: PlatformCounts = {
    facebook: 0,
    instagram: 0,
    threads: 0,
    x: 0,
    tiktok: 0,
    youtube: 0,
  };
  for (const platform of SUBSCRIPTION_PLATFORMS) {
    const { count, error } = await client
      .from('subscription_usage')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('platform', platform)
      // Publish Now rows never count toward any cap.
      .neq('feature', 'publish-now')
      .neq('feature', 'instagram-publish-now')
      .neq('feature', 'threads-publish-now');
    if (error) {
      logServerError('[billing] usage counts query failed', error, { source: 'billing' });
      throw new SubscriptionGateError(
        'ENTITLEMENT_UNAVAILABLE',
        'Your plan could not be checked right now. Please try again.'
      );
    }
    usage[platform] = typeof count === 'number' ? count : 0;
  }
  return usage;
}

/**
 * Exact usage count for one platform, via a count query — never a
 * row list. A row list would silently truncate at PostgREST's
 * 1,000-row limit and under-report usage; the count query does not.
 */
export async function getUsageCount(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform
): Promise<number> {
  const { count, error } = await client
    .from('subscription_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('platform', platform)
    // Publish Now rows never count toward any cap.
    .neq('feature', 'publish-now')
    .neq('feature', 'instagram-publish-now')
    .neq('feature', 'threads-publish-now');
  if (error) {
    logServerError('[billing] usage count query failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return typeof count === 'number' ? count : 0;
}

/** Single-row existence check for one destination in the registry. */
export async function isDestinationUsed(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_usage')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('destination_key', destinationKey)
    // A destination used ONLY via Publish Now does not count as
    // used for any cap: Publish Now grants no queueing rights.
    .neq('feature', 'publish-now')
    .neq('feature', 'instagram-publish-now')
    .neq('feature', 'threads-publish-now')
    .limit(1);
  if (error) {
    logServerError('[billing] destination existence query failed', error, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}

export async function getEntitlement(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<Entitlement> {
  const period = await getActivePeriod(client, userId, now);
  const usage = await getUsageCounts(client, userId);
  if (!period) {
    return {
      plan: 'free',
      active: false,
      counts: {
        facebook: 0,
        instagram: 0,
        threads: 0,
        x: 0,
        tiktok: 0,
        youtube: 0,
      },
      usage,
      period: null,
      canPost: false,
      readOnly: true,
      reason:
        'Your plan is Free, which covers the Prompt Library only. Choose a paid plan to post or schedule.',
      hasPriorPeriod: await hasAnyPeriod(client, userId),
    };
  }
  return {
    plan: 'paid',
    active: isPeriodActive(period, now),
    counts: period.counts,
    usage,
    period,
    canPost: isPeriodActive(period, now),
    readOnly: !isPeriodActive(period, now),
    reason: null,
    // An active period is itself a prior period; no extra query.
    hasPriorPeriod: true,
  };
}

/**
 * Existence check for any paid period row for the user, active or
 * lapsed (limit 1 — the row content is never read). Only used when
 * no active period exists, so the active path costs no extra query.
 */
export async function hasAnyPeriod(
  client: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_periods')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  if (error) {
    logServerError('[billing] prior period query failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Fail-closed posting gate: throws SubscriptionGateError unless the
 * user has an active paid period AND the destination fits the cap.
 * Admins are not gated here — callers skip this check for role
 * 'admin' (admins approve subscriptions; they do not subscribe).
 */
export async function assertCanPost(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string,
  now: Date = new Date()
): Promise<SubscriptionPeriodRow> {
  const entitlement = await getEntitlement(client, userId, now);
  if (!entitlement.period || !entitlement.canPost) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_REQUIRED',
      entitlement.reason ??
        'Posting is paused. Your paid period has ended — renew it to post again.'
    );
  }
  const allowed = entitlement.counts[platform];
  // The gate must never decide from a full keys list: PostgREST
  // silently truncates at 1,000 rows, which would under-report
  // usage and fail the cap open. Decide from the exact count
  // (already fetched with the entitlement) plus a single-row
  // existence check for this destination instead.
  if (await isDestinationUsed(client, userId, platform, destinationKey)) {
    return entitlement.period;
  }
  if (entitlement.usage[platform] >= allowed) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_CAP_REACHED',
      `You have reached your limit of ${allowed} ${platform === 'facebook' ? 'pages' : 'accounts'} on ${platform}. Upgrade your plan to use more.`
    );
  }
  return entitlement.period;
}

/**
 * Plan-only gate for Publish Now (owner decision 2026-10-31):
 * Publish Now is unlimited — no per-page/per-account cap and no
 * usage registration. The ONLY gate is an active paid period.
 * Free users and expired users stay blocked, with the same
 * SUBSCRIPTION_REQUIRED error the capped gate used for its plan
 * branch. Admins are not gated here — callers skip this check
 * for role 'admin', exactly as they did for assertCanPost.
 */
export async function assertPaidPlan(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SubscriptionPeriodRow> {
  const entitlement = await getEntitlement(client, userId, now);
  if (!entitlement.period || !entitlement.canPost) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_REQUIRED',
      entitlement.reason ??
        'Posting is paused. Your paid period has ended — renew it to post again.'
    );
  }
  return entitlement.period;
}

/**
 * Register a destination as used in a feature. The gate runs first;
 * a race that inserts the same destination twice is treated as
 * already-used (the unique constraint), never as a second unit.
 *
 * Publish Now features are REFUSED here (audit fix 2026-11-01):
 * Publish Now is uncapped and must leave no registry trace. A
 * caller passing one is a bug, failed loud, never silently stored.
 *
 * Legacy note: a destination used ONLY via Publish Now before the
 * fix still has a legacy publish-now row, which the cap checks
 * deliberately ignore. When a capped feature registers that
 * destination, the insert collides (23505) on the legacy row; the
 * legacy row is then DELETED and the capped row inserted, so the
 * destination starts counting toward the cap and no publish-now
 * row survives. A collision on a capped row is plain already-used.
 */
export async function registerUsage(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string,
  feature: string,
  destinationId: string | null = null,
  now: Date = new Date()
): Promise<{ alreadyUsed: boolean; usedCount: number }> {
  if (isLegacyUncappedUsageFeature(feature)) {
    throw new SubscriptionGateError(
      'INVALID_REQUEST',
      'Publish Now does not register usage.'
    );
  }
  await assertCanPost(client, userId, platform, destinationKey, now);
  if (await isDestinationUsed(client, userId, platform, destinationKey)) {
    return { alreadyUsed: true, usedCount: await getUsageCount(client, userId, platform) };
  }
  const { error } = await client.from('subscription_usage').insert({
    user_id: userId,
    platform,
    destination_key: destinationKey,
    feature,
    destination_id: destinationId,
  });
  if (error) {
    // 23505 = unique violation: another request registered this
    // destination in the meantime, or a legacy publish-now row is
    // still there. A capped row means already-used. A legacy row
    // is deleted and the capped row inserted instead (see above).
    if (error.code === '23505') {
      const { data: existing, error: existingError } = await client
        .from('subscription_usage')
        .select('feature')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq('destination_key', destinationKey)
        .limit(1);
      if (existingError) {
        logServerError('[billing] usage row lookup failed', existingError, {
          source: 'billing',
        });
        throw new SubscriptionGateError(
          'ENTITLEMENT_UNAVAILABLE',
          'Your plan could not be checked right now. Please try again.'
        );
      }
      const existingRow = Array.isArray(existing) && existing.length > 0 ? asRow(existing[0]) : null;
      if (existingRow && isLegacyUncappedUsageFeature(existingRow['feature'])) {
        const { error: deleteError } = await client
          .from('subscription_usage')
          .delete()
          .eq('user_id', userId)
          .eq('platform', platform)
          .eq('destination_key', destinationKey)
          .eq('feature', existingRow['feature']);
        if (deleteError) {
          logServerError('[billing] legacy usage row delete failed', deleteError, {
            source: 'billing',
          });
          throw new SubscriptionGateError(
            'ENTITLEMENT_UNAVAILABLE',
            'Your plan could not be checked right now. Please try again.'
          );
        }
        const { error: retryError } = await client.from('subscription_usage').insert({
          user_id: userId,
          platform,
          destination_key: destinationKey,
          feature,
          destination_id: destinationId,
        });
        if (retryError) {
          // A concurrent capped registration won the retry: that is
          // already-used, not a failure.
          if (retryError.code === '23505') {
            return { alreadyUsed: true, usedCount: await getUsageCount(client, userId, platform) };
          }
          logServerError('[billing] usage insert retry failed', retryError, {
            source: 'billing',
          });
          throw new SubscriptionGateError(
            'ENTITLEMENT_UNAVAILABLE',
            'Your plan could not be checked right now. Please try again.'
          );
        }
        return { alreadyUsed: false, usedCount: await getUsageCount(client, userId, platform) };
      }
      return { alreadyUsed: true, usedCount: await getUsageCount(client, userId, platform) };
    }
    logServerError('[billing] usage insert failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return { alreadyUsed: false, usedCount: await getUsageCount(client, userId, platform) };
}

/**
 * Release a worker-feature usage unit (audit fix 2026-11-01: cap at
 * add). Deleting an ADU config, mirror, or auto-repost config frees
 * its unit — but ONLY when the registry row still carries that
 * feature. The registry holds one row per destination, shared
 * across features: if queueing registered the destination first
 * (or later replaced a legacy row), the row's feature differs and
 * the destination is still in use, so the row must stay.
 */
export async function releaseUsageForFeature(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string,
  feature: string
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_usage')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('destination_key', destinationKey)
    .eq('feature', feature)
    .select('id');
  if (error) {
    logServerError('[billing] usage release failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}


/**
 * Cap check for feature-section "add" actions (Add Page, Add Auto
 * Repost, Add to Schedule, Add ADU config). Unlike registerUsage it
 * writes NOTHING: adding a destination does not consume the cap —
 * only using it in a feature does (queue/publish). The check refuses
 * the add when the destinations it would newly expose (keys not
 * already in the registry) would push usage past the purchased
 * count. Already-registered destinations always pass, and a request
 * that adds only already-registered destinations never fails the
 * cap. Admins are not gated — callers skip this check for role
 * 'admin', exactly like the posting gates.
 */
export async function assertFeatureAddWithinCap(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKeys: string[],
  now: Date = new Date()
): Promise<{ allowed: number; used: number; newCount: number }> {
  const entitlement = await getEntitlement(client, userId, now);
  if (!entitlement.period || !entitlement.canPost) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_REQUIRED',
      entitlement.reason ??
        'Posting is paused. Your paid period has ended — renew it to post again.'
    );
  }
  const allowed = entitlement.counts[platform];
  const uniqueKeys = [...new Set(destinationKeys.filter((key) => key.length > 0))];
  let newCount = uniqueKeys.length;
  if (uniqueKeys.length > 0) {
    const { data, error } = await client
      .from('subscription_usage')
      .select('destination_key')
      .eq('user_id', userId)
      .eq('platform', platform)
      // A destination used ONLY via Publish Now (legacy rows) does
      // NOT count as registered here — matching isDestinationUsed
      // and the queue gate. Without this, an add would pass at cap
      // for a publish-now-only destination and queueing would then
      // refuse it: display, add-gate, and queue-gate must agree.
      .neq('feature', 'publish-now')
      .neq('feature', 'instagram-publish-now')
      .neq('feature', 'threads-publish-now')
      .in('destination_key', uniqueKeys);
    if (error) {
      logServerError('[billing] feature-add cap check failed', error, { source: 'billing' });
      throw new SubscriptionGateError(
        'ENTITLEMENT_UNAVAILABLE',
        'Your plan could not be checked right now. Please try again.'
      );
    }
    const alreadyUsed = new Set(
      (Array.isArray(data) ? data : [])
        .map((row) => asRow(row)?.destination_key)
        .filter((key): key is string => typeof key === 'string')
    );
    newCount = uniqueKeys.filter((key) => !alreadyUsed.has(key)).length;
  }
  if (entitlement.usage[platform] + newCount > allowed) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_CAP_REACHED',
      `You have reached your limit of ${allowed} ${platform === 'facebook' ? 'pages' : 'accounts'} on ${platform}. Upgrade your plan to use more.`
    );
  }
  return { allowed, used: entitlement.usage[platform], newCount };
}

/** Supersede the user's current periods and start a fresh 30-day period.
 *  paymentId is null for zero-due coupon activations, which create no
 *  payment row; the coupon redemption carries the period link there.
 *  isUpgrade marks an activation where upgrade credit was applied:
 *  only then are pending refund requests on the replaced period
 *  cancelled (upgrade-cancels-refund, owner decision 2026-11-01) —
 *  a fresh purchase or renewal after expiry never cancels one. */
export async function createPeriodForPurchase(
  client: SupabaseClient,
  args: { userId: string; counts: PlatformCounts; paymentId: string | null; isUpgrade?: boolean },
  startsAt: Date = new Date()
): Promise<SubscriptionPeriodRow> {
  const endsAt = new Date(startsAt.getTime() + SUBSCRIPTION_PERIOD_DAYS * 86_400_000);
  // The periods this activation replaces: active right now, not
  // merely unsuperseded. A lapsed period's pending refund (if one
  // survived past expiry) is NOT the plan being upgraded from, so
  // it is left alone for a late admin decision; only the active
  // plan's pending refund is cancelled by the upgrade credit.
  let replacedPeriodIds: string[] = [];
  if (args.isUpgrade) {
    const { data: activeData, error: activeError } = await client
      .from('subscription_periods')
      .select('id')
      .eq('user_id', args.userId)
      .is('superseded_at', null)
      .lte('starts_at', startsAt.toISOString())
      .gt('ends_at', startsAt.toISOString());
    if (activeError) {
      logServerError('[billing] replaced period lookup failed', activeError, { source: 'billing' });
      throw new SubscriptionGateError(
        'ENTITLEMENT_UNAVAILABLE',
        'Your paid period could not be started right now. Please try again.'
      );
    }
    replacedPeriodIds = (Array.isArray(activeData) ? activeData : [])
      .map((row) => asRow(row)?.id)
      .filter((id): id is string => typeof id === 'string');
  }
  // Supersede EVERY non-superseded period, including lapsed ones.
  // The partial unique index on non-superseded periods (audit fix
  // 2026-11-01) allows only one live period row per user, so an
  // expired-but-unsuperseded row must not survive a renewal — and
  // superseding it changes nothing observable: the time-window
  // filters already exclude lapsed periods everywhere.
  const { error: supersedeError } = await client
    .from('subscription_periods')
    .update({ superseded_at: startsAt.toISOString() })
    .eq('user_id', args.userId)
    .is('superseded_at', null);
  if (supersedeError) {
    logServerError('[billing] period supersede failed', supersedeError, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  const { data, error } = await client
    .from('subscription_periods')
    .insert({
      user_id: args.userId,
      payment_id: args.paymentId,
      facebook_count: args.counts.facebook,
      instagram_count: args.counts.instagram,
      threads_count: args.counts.threads,
      x_count: args.counts.x,
      tiktok_count: args.counts.tiktok,
      youtube_count: args.counts.youtube,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
    .single();
  if (error || !data) {
    // No branch on error here: the untyped client's single() types
    // make the linter misread error/data nullability, and a branch
    // would only add a warning. The PostgREST error (when present)
    // carries code/message; a missing row still records the site.
    logServerError('[billing] period insert failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  const period = periodFromRow(asRow(data) ?? {});
  if (!period) {
    logServerError(
      '[billing] period insert returned unreadable row',
      new Error('Period insert returned unreadable row'),
      { source: 'billing' }
    );
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  // Upgrade-cancels-refund: the new period is live, so a pending
  // refund on the replaced plan must not pay out on top of the
  // upgrade credit. A cancel failure never fails the activation —
  // the upgrade proceeds normally — but it is logged loudly, so a
  // surviving pending request is visible to the admin instead of
  // silently double-compensating later.
  if (args.isUpgrade && replacedPeriodIds.length > 0) {
    try {
      await cancelPendingRefundsForSupersededPeriods(client, replacedPeriodIds, startsAt);
    } catch (cancelError) {
      logServerError('[billing] upgrade refund cancel did not land; upgrade proceeds', cancelError, {
        source: 'billing',
        userId: args.userId,
      });
    }
  }
  return period;
}

/** Supersede the user's current periods and start a fresh 30-day period for a payment. */
export async function createPeriodForPayment(
  client: SupabaseClient,
  payment: SubscriptionPaymentRow,
  startsAt: Date = new Date()
): Promise<SubscriptionPeriodRow> {
  return createPeriodForPurchase(
    client,
    { userId: payment.userId, counts: payment.counts, paymentId: payment.id, isUpgrade: payment.isUpgrade },
    startsAt
  );
}

/**
 * Approve a bank payment. Idempotent: approving an already-approved
 * payment returns its existing period and does NOT extend it again.
 * Only pending payments can be approved or rejected.
 *
 * Approval race (audit fix 2026-11-01, option C): the FIRST write
 * is a conditional claim — pending -> approved — so of two
 * concurrent approves exactly one wins the claim. The loser reloads
 * and returns the winner's period instead of creating a second one.
 * The period link is a second conditional update (period_id IS
 * NULL): if it loses, the orphan period just created is superseded
 * at once, so at most one non-superseded period is ever linked.
 * The partial unique index on non-superseded periods is the
 * database backstop for the same race.
 */
export async function approvePayment(
  client: SupabaseClient,
  paymentId: string,
  adminUserId: string,
  now: Date = new Date()
): Promise<{ payment: SubscriptionPaymentRow; period: SubscriptionPeriodRow }> {
  const loadPayment = async (): Promise<SubscriptionPaymentRow | null> => {
    const { data, error } = await client
      .from('subscription_payments')
      .select(
        `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at`
      )
      .eq('id', paymentId)
      .maybeSingle();
    if (error || !data) return null;
    return paymentFromRow(asRow(data) ?? {});
  };
  const loadPeriod = async (periodId: string): Promise<SubscriptionPeriodRow | null> => {
    const { data } = await client
      .from('subscription_periods')
      .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
      .eq('id', periodId)
      .maybeSingle();
    return data ? periodFromRow(asRow(data) ?? {}) : null;
  };

  const payment = await loadPayment();
  if (!payment) {
    throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }
  // Already linked: plain idempotent re-approve. A coupon redemption
  // held on this payment may never have been applied (e.g. the first
  // approve failed after linking); applying is held->applied only,
  // so re-running it is safe, and now records the period link.
  if (payment.periodId) {
    const period = await loadPeriod(payment.periodId);
    // Idempotent re-approve: the period already exists, but a coupon
    // redemption held on this payment may never have been applied
    // (e.g. the first approve failed after linking); applying is
    // held→applied only, so re-running it is safe, and now records
    // the period link. The same recovery applies to the seller
    // commission: recording is idempotent per payment, so a first
    // approve that failed after the period but before the
    // commission still lands it here.
    if (period) {
      await applyHeldRedemptionsForPayment(client, payment.id, period.id);
      await recordCommissionForPayment(client, payment, period);
      return { payment, period };
    }
  }
  if (payment.status !== 'pending') {
    throw new SubscriptionGateError(
      'PAYMENT_ALREADY_DECIDED',
      'That payment has already been decided.'
    );
  }

  // Claim FIRST: exactly one concurrent approve wins this update.
  const { data: claimed, error: claimError } = await client
    .from('subscription_payments')
    .update({
      status: 'approved',
      approved_at: now.toISOString(),
      approved_by: adminUserId,
      updated_at: now.toISOString(),
    })
    .eq('id', payment.id)
    .eq('status', 'pending')
    .select('id');
  if (claimError) {
    logServerError('[billing] payment approve claim failed', claimError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be approved right now. Please try again.'
    );
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    // Lost the race: the winner owns the outcome now. Poll briefly
    // for its linked period (the winner links right after creating
    // it); if it appears, return it as a success, not a failure.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const winner = await loadPayment();
      if (winner?.periodId) {
        const period = await loadPeriod(winner.periodId);
        if (period) return { payment: winner, period };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The winner crashed between claim and link (or is stuck): the
    // payment is approved but period-less. Fall through to the
    // repair path below, which creates the period and links it
    // conditionally — only one repair can win the link.
    const repaired = await loadPayment();
    if (!repaired) {
      throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
    }
    if (repaired.periodId) {
      const period = await loadPeriod(repaired.periodId);
      if (period) return { payment: repaired, period };
    }
    if (repaired.status !== 'approved') {
      throw new SubscriptionGateError(
        'PAYMENT_ALREADY_DECIDED',
        'That payment has already been decided.'
      );
    }
    return linkPeriodForApprovedPayment(client, repaired, adminUserId, now, loadPeriod);
  }

  return linkPeriodForApprovedPayment(
    client,
    { ...payment, status: 'approved', approvedAt: now.toISOString() },
    adminUserId,
    now,
    loadPeriod
  );
}

/**
 * Create the period for an already-claimed (approved) payment and
 * link it conditionally. If the link loses, the orphan period is
 * superseded immediately and the winner's period is returned.
 */
async function linkPeriodForApprovedPayment(
  client: SupabaseClient,
  payment: SubscriptionPaymentRow,
  adminUserId: string,
  now: Date,
  loadPeriod: (periodId: string) => Promise<SubscriptionPeriodRow | null>
): Promise<{ payment: SubscriptionPaymentRow; period: SubscriptionPeriodRow }> {
  void adminUserId;
  // Re-check before creating: a repair racing the winner's link
  // must not mint a second period when the link already landed.
  const fresh = await client
    .from('subscription_payments')
    .select('period_id')
    .eq('id', payment.id)
    .maybeSingle();
  const freshRow = fresh.data ? asRow(fresh.data) : null;
  const freshPeriodId = freshRow ? stringField(freshRow, 'period_id') : null;
  if (freshPeriodId) {
    const period = await loadPeriod(freshPeriodId);
    if (period) {
      await applyHeldRedemptionsForPayment(client, payment.id, period.id);
      // Same recovery as the already-linked path: if the winner
      // linked but crashed before recording the seller commission,
      // this repair records it (idempotent per payment).
      await recordCommissionForPayment(client, payment, period);
      return { payment: { ...payment, periodId: period.id }, period };
    }
    // Stale link: the stored id resolves to no period row, so no
    // winner period exists to protect. The link update below
    // replaces exactly that stale value (guarded: a concurrent
    // writer changing period_id in between makes it match 0 rows,
    // and the loser path below handles it) instead of refusing to
    // link at all — otherwise a payment whose period row is gone
    // could never activate.
  }
  const period = await createPeriodForPayment(client, payment, now);
  // The period exists now; applying the held coupon redemption is
  // part of the same approval, and now records the period link.
  await applyHeldRedemptionsForPayment(client, payment.id, period.id);
  const linkQuery = client
    .from('subscription_payments')
    .update({ period_id: period.id, updated_at: now.toISOString() })
    .eq('id', payment.id);
  const { data: linked, error: linkError } = await (freshPeriodId
    ? linkQuery.eq('period_id', freshPeriodId)
    : linkQuery.is('period_id', null)
  ).select('id');
  if (linkError) {
    logServerError('[billing] payment approve link failed', linkError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be approved right now. Please try again.'
    );
  }
  if (Array.isArray(linked) && linked.length > 0) {
    // The period is live now. Recording the seller commission
    // throws on failure (fail loud): the payment stays approved
    // and linked, and a later re-approve through the
    // already-linked path recovers the commission — the same
    // recovery the sellers flow relies on.
    await recordCommissionForPayment(client, payment, period);
    return {
      payment: { ...payment, periodId: period.id },
      period,
    };
  }
  // Lost the link race: supersede the orphan at once so it can
  // never become the live period, then return the winner's period.
  await client
    .from('subscription_periods')
    .update({ superseded_at: now.toISOString() })
    .eq('id', period.id)
    .is('superseded_at', null);
  const winner = await client
    .from('subscription_payments')
    .select('period_id')
    .eq('id', payment.id)
    .maybeSingle();
  const winnerRow = winner.data ? asRow(winner.data) : null;
  const winnerPeriodId = winnerRow ? stringField(winnerRow, 'period_id') : null;
  if (winnerPeriodId) {
    const winnerPeriod = await loadPeriod(winnerPeriodId);
    if (winnerPeriod) {
      return { payment: { ...payment, periodId: winnerPeriod.id }, period: winnerPeriod };
    }
  }
  logServerError('[billing] payment approve link lost with no winner period', null, {
    source: 'billing',
    paymentId: payment.id,
  });
  throw new SubscriptionGateError(
    'ENTITLEMENT_UNAVAILABLE',
    'That payment could not be approved right now. Please try again.'
  );
}

/**
 * Activate a crypto payment from a finished webhook or an admin
 * rescue approval (audit fix 2026-11-01). Same claim-first shape
 * as approvePayment: the FIRST write claims the payment
 * (pending/failed/expired -> paid), so a finished event racing a
 * failed event cannot double-activate, and a failed event that
 * already ran cannot overwrite a paid payment. failed/expired is
 * NOT terminal: a later finished event still activates.
 * A rejected payment never activates, and a payment that already
 * has a period is returned as already-activated, never re-created.
 * couponReleasedBeforeFinish is true when a failed/expired event
 * already released this payment's coupon before the finish arrived:
 * the period is still owed (the user paid), but the coupon went
 * back to the pool — the caller records an admin-visible issue.
 */
export async function activateCryptoPayment(
  client: SupabaseClient,
  payment: SubscriptionPaymentRow,
  now: Date = new Date()
): Promise<{
  payment: SubscriptionPaymentRow;
  period: SubscriptionPeriodRow;
  alreadyActivated: boolean;
  couponReleasedBeforeFinish: boolean;
}> {
  const loadPeriodById = async (periodId: string): Promise<SubscriptionPeriodRow | null> => {
    const { data } = await client
      .from('subscription_periods')
      .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
      .eq('id', periodId)
      .maybeSingle();
    return data ? periodFromRow(asRow(data) ?? {}) : null;
  };
  if (payment.periodId) {
    const period = await loadPeriodById(payment.periodId);
    if (period) return { payment, period, alreadyActivated: true, couponReleasedBeforeFinish: false };
  }
  if (payment.status === 'rejected') {
    throw new SubscriptionGateError(
      'PAYMENT_ALREADY_DECIDED',
      'That payment was rejected and cannot be activated.'
    );
  }
  if (payment.status !== 'pending' && payment.status !== 'failed' && payment.status !== 'expired') {
    throw new SubscriptionGateError(
      'PAYMENT_ALREADY_DECIDED',
      'That payment has already been decided.'
    );
  }
  const { data: claimed, error: claimError } = await client
    .from('subscription_payments')
    .update({ status: 'paid', updated_at: now.toISOString() })
    .eq('id', payment.id)
    .is('period_id', null)
    .in('status', ['pending', 'failed', 'expired'])
    .select('id');
  if (claimError) {
    logServerError('[billing] crypto activation claim failed', claimError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be activated right now. Please try again.'
    );
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    // Another event won: a period means already-activated; a paid
    // row without a period is a crashed winner — repair it below.
    const { data: current } = await client
      .from('subscription_payments')
      .select('status,period_id')
      .eq('id', payment.id)
      .maybeSingle();
    const currentRow = current ? asRow(current) : null;
    const currentPeriodId = currentRow ? stringField(currentRow, 'period_id') : null;
    if (currentPeriodId) {
      const period = await loadPeriodById(currentPeriodId);
      if (period) {
        return { payment, period, alreadyActivated: true, couponReleasedBeforeFinish: false };
      }
    }
    const currentStatus = currentRow ? stringField(currentRow, 'status') : null;
    if (currentStatus !== 'paid') {
      throw new SubscriptionGateError(
        'PAYMENT_ALREADY_DECIDED',
        'That payment has already been decided.'
      );
    }
    // Repair: paid but period-less. The link inside is conditional,
    // so only one repair can win it.
    const repaired = await linkPeriodForApprovedPayment(
      client,
      { ...payment, status: 'paid' },
      '',
      now,
      loadPeriodById
    );
    return { ...repaired, alreadyActivated: false, couponReleasedBeforeFinish: await hadReleasedRedemption(client, payment.id) };
  }
  const linked = await linkPeriodForApprovedPayment(
    client,
    { ...payment, status: 'paid' },
    '',
    now,
    loadPeriodById
  );
  return { ...linked, alreadyActivated: false, couponReleasedBeforeFinish: await hadReleasedRedemption(client, payment.id) };
}

async function hadReleasedRedemption(
  client: SupabaseClient,
  paymentId: string
): Promise<boolean> {
  const { data } = await client
    .from('coupon_redemptions')
    .select('id')
    .eq('payment_id', paymentId)
    .eq('status', 'released')
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Mark a crypto payment failed/expired from the webhook, but ONLY
 * when it is still pending: a payment that already has a period, or
 * is already paid, must never be overwritten by a late failure
 * event. Returns false when another event already decided it.
 * The caller releases the coupon only when this returns true.
 */
export async function markCryptoFailed(
  client: SupabaseClient,
  paymentId: string,
  status: 'failed' | 'expired',
  now: Date = new Date()
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_payments')
    .update({ status, updated_at: now.toISOString() })
    .eq('id', paymentId)
    .eq('status', 'pending')
    .is('period_id', null)
    .select('id');
  if (error) {
    logServerError('[billing] crypto mark failed update failed', error, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be updated right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * IPN actuals for a payment, read tolerantly (audit fix 2026-11-01).
 * The nowpayments_actual_* columns arrive with a migration that
 * ships unapplied: until it is applied, this select errors and the
 * caller falls back to the checkout estimate. A missing-column
 * error is therefore NOT fatal here — it is logged loudly so the
 * pending migration stays visible, and nulls are returned.
 */
export async function loadPaymentActuals(
  client: SupabaseClient,
  paymentId: string
): Promise<{ actualPaid: number | null; actualCurrency: string | null }> {
  const { data, error } = await client
    .from('subscription_payments')
    .select('nowpayments_actual_paid,nowpayments_actual_currency')
    .eq('id', paymentId)
    .maybeSingle();
  if (error || !data) {
    if (error) {
      logServerError('[billing] payment actuals lookup unavailable', error, {
        source: 'billing',
      });
    }
    return { actualPaid: null, actualCurrency: null };
  }
  const row = asRow(data) ?? {};
  const paid = row['nowpayments_actual_paid'];
  const currency = row['nowpayments_actual_currency'];
  return {
    actualPaid: typeof paid === 'number' ? paid : null,
    actualCurrency: typeof currency === 'string' ? currency : null,
  };
}

/**
 * Persist IPN actuals on a payment, best-effort (audit fix
 * 2026-11-01). This update is deliberately SEPARATE from the
 * activation update: until the migration adding the columns is
 * applied, this fails with a missing-column error, and that must
 * never break activation. Returns false when the columns are not
 * there yet (or any other failure), true when persisted.
 */
export async function savePaymentActuals(
  client: SupabaseClient,
  paymentId: string,
  actualPaid: number | null,
  actualCurrency: string | null
): Promise<boolean> {
  const { error } = await client
    .from('subscription_payments')
    .update({
      nowpayments_actual_paid: actualPaid,
      nowpayments_actual_currency: actualCurrency,
      updated_at: new Date().toISOString(),
    })
    .eq('id', paymentId);
  if (error) {
    logServerError('[billing] payment actuals save unavailable', error, {
      source: 'billing',
    });
    return false;
  }
  return true;
}

export async function rejectPayment(
  client: SupabaseClient,
  paymentId: string,
  now: Date = new Date()
): Promise<SubscriptionPaymentRow> {
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at`
    )
    .eq('id', paymentId)
    .maybeSingle();
  if (error || !data) {
    throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }
  const payment = paymentFromRow(asRow(data) ?? {});
  if (!payment) {
    throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }
  if (payment.status !== 'pending') {
    throw new SubscriptionGateError(
      'PAYMENT_ALREADY_DECIDED',
      'That payment has already been decided.'
    );
  }
  // Release BEFORE the status update: if the release fails, the
  // payment stays pending and the admin's retry recovers, instead
  // of a rejected payment keeping a coupon held forever.
  await releaseHeldRedemptionsForPayment(client, payment.id);
  const { error: updateError } = await client
    .from('subscription_payments')
    .update({ status: 'rejected', updated_at: now.toISOString() })
    .eq('id', payment.id)
    .eq('status', 'pending');
  if (updateError) {
    logServerError('[billing] payment reject update failed', updateError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be rejected right now. Please try again.'
    );
  }
  return { ...payment, status: 'rejected' };
}

/** Price a purchase: fresh purchase pays the full total; an upgrade pays new total minus credit. */
export function pricePurchase(
  counts: import('@fbuploadpro/contracts').PlatformCounts,
  activePeriod: SubscriptionPeriodRow | null,
  now: Date = new Date()
): { amountPkr: number; isUpgrade: boolean; quote: ReturnType<typeof quoteUpgrade> | null } {
  if (!activePeriod) {
    return { amountPkr: totalPricePkr(counts), isUpgrade: false, quote: null };
  }
  const daysRemaining = Math.ceil(
    Math.max(0, activePeriod.endsAt.getTime() - now.getTime()) / 86_400_000
  );
  let quote: ReturnType<typeof quoteUpgrade>;
  try {
    quote = quoteUpgrade(activePeriod.counts, counts, daysRemaining);
  } catch (err) {
    // Boundary conversion: the checkout routes turn a
    // SubscriptionGateError into a plain 400, but a raw DomainError
    // (downgrade, per-platform decrease, same-total change) would
    // fall through to a misleading 500. Convert here so both
    // checkout routes refuse a downgrade with the plain message.
    if (err instanceof DomainError) {
      throw new SubscriptionGateError('INVALID_REQUEST', err.message);
    }
    throw err;
  }
  return { amountPkr: quote.amountToPayPkr, isUpgrade: true, quote };
}
