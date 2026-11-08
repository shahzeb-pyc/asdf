import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DomainError,
  isPeriodActive,
  quoteDowngrade,
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
  method: 'bank';
  bankMethod: 'easypaisa' | 'nayapay' | 'ubl' | 'binance' | null;
  status: string;
  counts: PlatformCounts;
  amountPkr: number;
  isUpgrade: boolean;
  isDowngrade: boolean;
  scheduledStartsAt: Date | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  overrideReason: string | null;
  decidedAt: string | null;
  screenshotStorageKey: string | null;
  couponCode: string | null;
  discountPkr: number;
  periodId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface Entitlement {
  /**
   * The plan as the client sees it. 'expired' is explicit: no active
   * period but a prior paid period. Never derived client-side from
   * `active` + `hasPriorPeriod` — every consumer reads this value.
   */
  plan: 'free' | 'paid' | 'expired';
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
  const bankMethod = stringField(row, 'bank_method');
  return {
    id,
    userId,
    method: 'bank',
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
    isDowngrade: boolField(row, 'is_downgrade'),
    scheduledStartsAt: dateField(row, 'scheduled_starts_at'),
    rejectionReason: stringField(row, 'rejection_reason'),
    rejectionDetail: stringField(row, 'rejection_detail'),
    overrideReason: stringField(row, 'override_reason'),
    decidedAt: stringField(row, 'decided_at'),
    screenshotStorageKey: stringField(row, 'screenshot_storage_key'),
    couponCode: stringField(row, 'coupon_code'),
    discountPkr: numberField(row, 'discount_pkr'),
    periodId: stringField(row, 'period_id'),
    approvedAt: stringField(row, 'approved_at'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}


/** Load new payment columns tolerantly: if the migration that adds
 * them is unapplied, the select errors and defaults are returned
 * instead of failing the whole load. */
async function loadNewPaymentFieldsForRow(
  client: SupabaseClient,
  paymentId: string
): Promise<Partial<SubscriptionPaymentRow>> {
  try {
    const { data, error } = await client
      .from('subscription_payments')
      .select('is_downgrade,scheduled_starts_at,rejection_reason,rejection_detail,override_reason,decided_at')
      .eq('id', paymentId)
      .maybeSingle();
    if (error || !data) return {};
    const row = asRow(data) ?? {};
    return {
      isDowngrade: boolField(row, 'is_downgrade'),
      scheduledStartsAt: dateField(row, 'scheduled_starts_at'),
      rejectionReason: stringField(row, 'rejection_reason'),
      rejectionDetail: stringField(row, 'rejection_detail'),
      overrideReason: stringField(row, 'override_reason'),
      decidedAt: stringField(row, 'decided_at'),
    };
  } catch {
    return {};
  }
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
 * status 'pending' exists for the user, new submissions are blocked.
 * Approved, rejected, paid, failed, and expired payments never block.
 * A query failure fails closed: the caller must not proceed to create
 * a payment it cannot prove is the user's only pending one.
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

/**
 * Disconnected destinations do NOT count toward the cap (owner
 * decision 2026-11-02, exact boundary: ONLY status 'disconnected').
 * Expired tokens (invalid_token), identity checks (page_checkpoint),
 * paused, and rate-limited destinations KEEP counting.
 *
 * The exclusion is a read-time filter, never a row deletion: a
 * disconnected destination that is later reconnected (status flips
 * back) counts again automatically, with no re-registration step.
 *
 * Link rule: a usage row links to a destinations row ONLY through
 * `subscription_usage.destination_id` (= `destinations.id`; every
 * current registerUsage call site passes the row id). The
 * `destination_key` column is NOT a link — it carries
 * `external_destination_id ?? id`, a platform id in the common
 * case — so it is never matched against `destinations.id`. Rows
 * with a NULL `destination_id` (legacy / generic-feature rows) link
 * to nothing and keep counting exactly as before.
 */
async function getDisconnectedDestinationIdsByPlatform(
  client: SupabaseClient,
  userId: string
): Promise<Map<SubscriptionPlatform, string[]>> {
  const byPlatform = new Map<SubscriptionPlatform, string[]>();
  const { data: workspaceRows, error: workspaceError } = await client
    .from('workspaces')
    .select('id')
    .eq('owner_id', userId);
  if (workspaceError) {
    logServerError('[billing] user workspaces query failed', workspaceError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const workspaceIds = (Array.isArray(workspaceRows) ? workspaceRows : [])
    .map((row) => asRow(row)?.['id'])
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (workspaceIds.length === 0) return byPlatform;
  const { data: destinationRows, error: destinationError } = await client
    .from('destinations')
    .select('id, platform')
    .in('workspace_id', workspaceIds)
    .eq('status', 'disconnected');
  if (destinationError) {
    logServerError('[billing] disconnected destinations query failed', destinationError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const knownPlatforms = new Set<string>(SUBSCRIPTION_PLATFORMS);
  for (const row of Array.isArray(destinationRows) ? destinationRows : []) {
    const parsed = asRow(row);
    const id = parsed?.['id'];
    const platform = parsed?.['platform'];
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof platform !== 'string' ||
      !knownPlatforms.has(platform)
    ) {
      continue;
    }
    const list = byPlatform.get(platform as SubscriptionPlatform) ?? [];
    list.push(id);
    byPlatform.set(platform as SubscriptionPlatform, list);
  }
  return byPlatform;
}

/**
 * Exact usage count for one platform, via count queries — never a
 * row list. A row list would silently truncate at PostgREST's
 * 1,000-row limit and under-report usage; the count queries do not.
 * When disconnected destination ids are supplied, usage rows linked
 * to them are subtracted (same publish-now exclusions on both
 * counts, so a disconnected destination's legacy publish-now row
 * can never over-subtract). The result is clamped at zero: a
 * registry that somehow holds more disconnected-linked rows than
 * total rows must never report a negative count.
 */
async function countUsageForPlatform(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  disconnectedDestinationIds: string[],
  // The two callers keep their distinct log messages (existing
  // tests assert each one); the shared helper must not merge them.
  failureLogMessage: string
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
    logServerError(failureLogMessage, error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const raw = typeof count === 'number' ? count : 0;
  if (disconnectedDestinationIds.length === 0) return raw;
  const { count: disconnectedCount, error: disconnectedError } = await client
    .from('subscription_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('platform', platform)
    .neq('feature', 'publish-now')
    .neq('feature', 'instagram-publish-now')
    .neq('feature', 'threads-publish-now')
    .in('destination_id', disconnectedDestinationIds);
  if (disconnectedError) {
    logServerError('[billing] disconnected usage count query failed', disconnectedError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const disconnected = typeof disconnectedCount === 'number' ? disconnectedCount : 0;
  return Math.max(0, raw - disconnected);
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
  const disconnectedByPlatform = await getDisconnectedDestinationIdsByPlatform(
    client,
    userId
  );
  // The six per-platform counts are independent given the
  // disconnected map above: each writes only its own key of the
  // result and runs its own count query, with no shared mutable
  // state between platforms. Run them together instead of one
  // after another, so one slow platform cannot stall the rest.
  const counts = await Promise.all(
    SUBSCRIPTION_PLATFORMS.map((platform) =>
      countUsageForPlatform(
        client,
        userId,
        platform,
        disconnectedByPlatform.get(platform) ?? [],
        '[billing] usage counts query failed'
      )
    )
  );
  SUBSCRIPTION_PLATFORMS.forEach((platform, index) => {
    usage[platform] = counts[index];
  });
  return usage;
}

/**
 * Exact usage count for one platform, via a count query — never a
 * row list. A row list would silently truncate at PostgREST's
 * 1,000-row limit and under-report usage; the count query does not.
 * Usage rows linked to a 'disconnected' destinations row are
 * excluded (see getDisconnectedDestinationIdsByPlatform).
 */
export async function getUsageCount(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform
): Promise<number> {
  const disconnectedByPlatform = await getDisconnectedDestinationIdsByPlatform(
    client,
    userId
  );
  return countUsageForPlatform(
    client,
    userId,
    platform,
    disconnectedByPlatform.get(platform) ?? [],
    '[billing] usage count query failed'
  );
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
  // Perf round 1: the usage read does not depend on the period (or
  // on the scheduled-downgrade activation below), so it runs
  // concurrently with the period read instead of waiting for it.
  // Any read failure still throws ENTITLEMENT_UNAVAILABLE with the
  // same user message; each failing query still logs its own
  // site-specific message first.
  const [periodResult, usage] = await Promise.all([
    getActivePeriod(client, userId, now),
    getUsageCounts(client, userId),
  ]);
  let period = periodResult;
  if (!period) {
    // A scheduled downgrade whose start has arrived activates
    // here, on any entitlement check — not only when the user
    // opens a page. A failed activation never breaks the read:
    // it is logged loudly and retried on the next check, and the
    // worker tick path activates independently of this one.
    try {
      period = (await activateDueScheduledDowngrades(client, userId, now)) ?? period;
    } catch (err) {
      logServerError('[billing] scheduled downgrade activation failed on entitlement check', err, {
        source: 'billing',
      });
    }
  }
  if (!period) {
    // Expired is an explicit plan, never free: a prior paid period
    // means the user lapsed, and the gate, the sidebar word, and
    // Home must all read the same value (owner decision 2026-11-07:
    // expired users browse like paid users; only publishing stops).
    const hasPriorPeriod = await hasAnyPeriod(client, userId);
    return {
      plan: hasPriorPeriod ? 'expired' : 'free',
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
      reason: hasPriorPeriod
        ? 'Posting is paused. Your paid period has ended — renew it to post again.'
        : 'Your plan is Free, which covers the Prompt Library only. Choose a paid plan to post or schedule.',
      hasPriorPeriod,
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
 * Shared-entitlement ownership guard (plan-check R3): a route that
 * already read the entitlement for the session user may pass it in
 * instead of paying for a second full read. The object is
 * internal-only — never from the client — but a typed object alone
 * cannot prove whose it is, so a paid entitlement whose period
 * belongs to another user is rejected fail-closed: without this
 * check a caller could pass user A's paid entitlement for user B
 * and the gate would let B publish. A period-less (free/expired)
 * entitlement can only ever block — the gate throws
 * SUBSCRIPTION_REQUIRED either way — so there is nothing to forge
 * there. Callers always fetch for the session user; this guard is
 * the backstop that makes a wrong-user pass loud instead of
 * silently effective.
 */
function assertSharedEntitlementOwner(userId: string, entitlement: Entitlement): Entitlement {
  if (entitlement.period && entitlement.period.userId !== userId) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  return entitlement;
}

/**
 * Fail-closed posting gate: throws SubscriptionGateError unless the
 * user has an active paid period AND the destination fits the cap.
 * Admins are not gated here — callers skip this check for role
 * 'admin' (admins approve subscriptions; they do not subscribe).
 *
 * The optional `sharedEntitlement` is a read the caller already made for
 * this same user in this same request (plan-check R3): the gate
 * reuses it instead of reading the entitlement a second time. It
 * is ownership-checked (see assertSharedEntitlementOwner) and is
 * never taken from the client.
 */
export async function assertCanPost(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string,
  now: Date = new Date(),
  sharedEntitlement?: Entitlement
): Promise<SubscriptionPeriodRow> {
  const entitlement = sharedEntitlement
    ? assertSharedEntitlementOwner(userId, sharedEntitlement)
    : await getEntitlement(client, userId, now);
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
/**
 * R5b guard: the derived usedCount (gate usage + 1) is exact only
 * when the row just inserted counts toward the cap. A row linked
 * to a disconnected destination does NOT count (its count is
 * subtracted at read time), so deriving +1 would overstate by one
 * for exactly that destination. One single-row status lookup
 * decides: disconnected → re-read the count; anything else
 * (connected, missing row, null id) → the row counts, derive. A
 * lookup failure also falls back to the re-read — the guard must
 * never invent a count.
 */
async function shouldDeriveUsedCount(
  client: SupabaseClient,
  destinationId: string | null
): Promise<boolean> {
  if (!destinationId) return true;
  try {
    const { data, error } = await client
      .from('destinations')
      .select('status')
      .eq('id', destinationId)
      .maybeSingle();
    if (error) return false;
    const row = data ? asRow(data) : null;
    if (!row) return true;
    return row['status'] !== 'disconnected';
  } catch {
    return false;
  }
}

export async function registerUsage(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform,
  destinationKey: string,
  feature: string,
  destinationId: string | null = null,
  now: Date = new Date(),
  sharedEntitlement?: Entitlement
): Promise<{ alreadyUsed: boolean; usedCount: number }> {
  if (isLegacyUncappedUsageFeature(feature)) {
    throw new SubscriptionGateError(
      'INVALID_REQUEST',
      'Publish Now does not register usage.'
    );
  }
  // R3: resolve the gate read once here and hand it to the gate —
  // a caller that already read the entitlement for this user
  // passes it in and no second full read happens. The same
  // resolved read also supplies the R5b derived count below.
  const gateEntitlement = sharedEntitlement
    ? assertSharedEntitlementOwner(userId, sharedEntitlement)
    : await getEntitlement(client, userId, now);
  await assertCanPost(client, userId, platform, destinationKey, now, gateEntitlement);
  // R5: no second isDestinationUsed lookup here. assertCanPost
  // already did one, and a pre-check can never be a race guard —
  // the race happens after the check. The INSERT's 23505 handler
  // below is the real guard: a concurrent registration of this
  // destination resolves to already-used, never to a second unit.
  // Pre-insert re-check, shared-read only: the gate above ran on
  // the shared read, which on the mirror routes is stale by the
  // time this register runs — the duplicate check, the paid
  // external profile fetch, and the mirror insert all run between
  // the gate and here — so a concurrent registration of a
  // DIFFERENT destination in the meantime would otherwise publish
  // over the cap (the worker claim RPCs enforce an active period
  // only, not usage counts, so there is no backstop downstream).
  // Re-count fresh, immediately before the INSERT, with the same
  // disconnected exclusion as the gate (getUsageCount), and refuse
  // a genuinely new destination at/over the gate's allowed count.
  // What this does: it narrows the race window back to the old
  // size — the last usage read is ~1 query before the insert, as
  // it was before the shared read. What it does NOT do: eliminate
  // the race — no check-then-insert can, short of a DB
  // constraint/trigger or a serializable transaction; two requests
  // can still both re-check under the cap and both insert. An
  // already-used destination is never refused here: it consumes
  // no new unit, so a concurrent registration of THIS destination
  // still resolves to already-used via the 23505 handler below.
  // Without a shared read there is nothing to re-check:
  // registerUsage just read the entitlement fresh above.
  if (sharedEntitlement) {
    const allowed = gateEntitlement.counts[platform];
    const freshUsage = await getUsageCount(client, userId, platform);
    if (freshUsage >= allowed) {
      if (!(await isDestinationUsed(client, userId, platform, destinationKey))) {
        throw new SubscriptionGateError(
          'SUBSCRIPTION_CAP_REACHED',
          `You have reached your limit of ${allowed} ${platform === 'facebook' ? 'pages' : 'accounts'} on ${platform}. Upgrade your plan to use more.`
        );
      }
    }
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
  // R5b, clean-insert path only: the count after this insert is
  // the gate read's usage plus the row just added — no re-count
  // needed. The cap decision never uses usedCount (it uses the
  // pre-insert entitlement + the 23505 guard above), so the only
  // cost of the derivation is a display number: a concurrent
  // insert of a *different* destination on the same platform in
  // the same milliseconds can leave it lagging by one. The
  // already-used and race (23505) paths above keep their exact
  // re-read, where the true count is not derivable from the gate
  // read — as does a disconnected destination (see
  // shouldDeriveUsedCount), whose row does not count at all.
  if (await shouldDeriveUsedCount(client, destinationId)) {
    return { alreadyUsed: false, usedCount: gateEntitlement.usage[platform] + 1 };
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
  now: Date = new Date(),
  sharedEntitlement?: Entitlement
): Promise<{ allowed: number; used: number; newCount: number }> {
  // R3: reuse a read the caller already made for this user in
  // this request instead of reading the entitlement a second
  // time. Ownership-checked (see assertSharedEntitlementOwner);
  // never taken from the client.
  const entitlement = sharedEntitlement
    ? assertSharedEntitlementOwner(userId, sharedEntitlement)
    : await getEntitlement(client, userId, now);
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

/**
 * Scheduled downgrades, option A (owner choice 2026-11-02, PR 120
 * send-back fix B2): the schedule lives ON THE PAYMENT ROW ONLY
 * (is_downgrade + scheduled_starts_at). Approval NEVER inserts a
 * future period row — a future non-superseded row coexisting with
 * the live period violates the shipped one-live-per-user partial
 * unique index (20261101090000_billing_audit_period_index.sql),
 * and a static partial-index predicate cannot express "started"
 * (now() is not immutable), so no index tweak can rescue that
 * design. The period is created only by activateDueScheduled-
 * Downgrades, when the schedule goes live, through the same
 * createPeriodForPurchase path every other activation uses — so
 * at most one non-superseded period ever exists, with or without
 * the index applied.
 *
 * Timing consequences, stated plainly (fresh verification must
 * re-check these): the coupon is applied at APPROVAL (held ->
 * applied, period link null), and so is the seller commission —
 * commission is earned when the payment is approved, and the
 * worker cannot import the sellers logic, so recording it at
 * activation would lose it whenever a worker tick activates
 * first. The commission row is therefore recorded at approval
 * with period_id null and period_starts_at set to the scheduled
 * start, and activation backfills period_id to the real period
 * (a raw update, in both the web and worker activation paths).
 * A period created late (no entitlement check or worker tick ran
 * exactly at the scheduled start) starts at activation time and
 * runs a full 30 days from there — a late activation must never
 * silently shorten a month the user already paid for.
 */
export const SCHEDULED_DOWNGRADE_EXISTS_MESSAGE =
  'You already have a lower plan scheduled for next month. Wait until it starts before choosing another plan.';

/** True when the user has an approved downgrade payment whose
 * period has not been created yet. Pre-migration (new columns
 * unapplied) the tolerant load returns no flags, so this is
 * best-effort until migration 20261102150000 is applied — which
 * the merge instruction names as a required pre-live step. */
export async function hasOutstandingScheduledDowngrade(
  client: SupabaseClient,
  userId: string,
  excludePaymentId?: string | null
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_payments')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .is('period_id', null);
  if (error) {
    logServerError('[billing] scheduled downgrade lookup failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const ids = (Array.isArray(data) ? data : [])
    .map((row) => asRow(row)?.['id'])
    .filter((id): id is string => typeof id === 'string' && id !== excludePaymentId);
  for (const id of ids) {
    const fields = await loadNewPaymentFieldsForRow(client, id);
    if (fields.isDowngrade) return true;
  }
  return false;
}

/** Block a new purchase/upgrade while a downgrade schedule is
 * outstanding. Activation runs first: a schedule that is already
 * due is activated (and then no longer blocks) instead of
 * blocking a purchase the user should be allowed to make. */
export async function assertNoOutstandingScheduledDowngrade(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<void> {
  await activateDueScheduledDowngrades(client, userId, now);
  if (await hasOutstandingScheduledDowngrade(client, userId)) {
    throw new SubscriptionGateError('PAYMENT_ALREADY_DECIDED', SCHEDULED_DOWNGRADE_EXISTS_MESSAGE);
  }
}

/**
 * The ONE defined activation path for scheduled downgrades.
 * Claim-first and idempotent: the period is created through
 * createPeriodForPurchase (which supersedes every non-superseded
 * row, so the lapsed old period can never coexist with the new
 * one), then linked conditionally on period_id IS NULL. A loser
 * that finds the payment already linked returns the winner's
 * period; a link failure with no winner period still returns the
 * created period, because the period row itself is live by its
 * time window and superseding it would kill the plan just
 * activated — the link is then repaired by the already-linked
 * re-approve path. At most one schedule activates per call, and
 * activation never runs while a period is still active.
 *
 * Called from getEntitlement (web: every API/gate/entitlement
 * check) and from the worker's period check — never only from a
 * page the user happens to visit, so a publishing plan activates
 * on a worker tick even if the user never opens the app.
 */
export async function activateDueScheduledDowngrades(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<SubscriptionPeriodRow | null> {
  if (await getActivePeriod(client, userId, now)) return null;
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,coupon_code,discount_pkr,period_id,approved_at,created_at`
    )
    .eq('user_id', userId)
    .eq('status', 'approved')
    .is('period_id', null);
  if (error) {
    logServerError('[billing] scheduled downgrade activation lookup failed', error, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const candidates: SubscriptionPaymentRow[] = [];
  for (const raw of Array.isArray(data) ? data : []) {
    const base = paymentFromRow(asRow(raw) ?? {});
    if (!base) continue;
    const payment = { ...base, ...(await loadNewPaymentFieldsForRow(client, base.id)) };
    if (
      payment.isDowngrade &&
      payment.scheduledStartsAt &&
      payment.scheduledStartsAt.getTime() <= now.getTime()
    ) {
      candidates.push(payment);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => (a.scheduledStartsAt?.getTime() ?? 0) - (b.scheduledStartsAt?.getTime() ?? 0)
  );
  if (candidates.length > 1) {
    // Should not happen: the submit/approval guards allow only one
    // outstanding schedule. Activating the earliest only; the rest
    // stay approved-but-unlinked and need an admin decision — never
    // activate two competing periods in one call.
    logServerError('[billing] multiple due scheduled downgrades; activating earliest only', null, {
      source: 'billing',
      userId,
      count: candidates.length,
    });
  }
  const candidate = candidates[0];
  // Commission was recorded at approval with period_id null
  // (option A); activation backfills the real period id. This
  // update is best-effort and never fails activation — a missed
  // backfill leaves a valid commission row pointing at no period,
  // which the already-linked re-approve path also repairs.
  const backfillCommissionPeriod = async (periodId: string): Promise<void> => {
    try {
      await client
        .from('seller_commissions')
        .update({ period_id: periodId })
        .eq('payment_id', candidate.id)
        .is('period_id', null);
    } catch (err) {
      logServerError('[billing] scheduled downgrade commission backfill failed', err, {
        source: 'billing',
        paymentId: candidate.id,
      });
    }
  };
  const period = await createPeriodForPurchase(
    client,
    { userId, counts: candidate.counts, paymentId: candidate.id, isUpgrade: false },
    now
  );
  const { data: linked, error: linkError } = await client
    .from('subscription_payments')
    .update({ period_id: period.id, updated_at: now.toISOString() })
    .eq('id', candidate.id)
    .is('period_id', null)
    .select('id');
  if (linkError || !Array.isArray(linked) || linked.length === 0) {
    if (linkError) {
      logServerError('[billing] scheduled downgrade link failed; period is live anyway', linkError, {
        source: 'billing',
        paymentId: candidate.id,
        periodId: period.id,
      });
    }
    // A winner may have linked a different period for this payment.
    const { data: reloaded } = await client
      .from('subscription_payments')
      .select('period_id')
      .eq('id', candidate.id)
      .maybeSingle();
    const winnerPeriodId = reloaded ? stringField(asRow(reloaded) ?? {}, 'period_id') : null;
    if (winnerPeriodId && winnerPeriodId !== period.id) {
      const { data: winnerData } = await client
        .from('subscription_periods')
        .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
        .eq('id', winnerPeriodId)
        .maybeSingle();
      const winnerPeriod = winnerData ? periodFromRow(asRow(winnerData) ?? {}) : null;
      if (winnerPeriod) {
        await client
          .from('subscription_periods')
          .update({ superseded_at: now.toISOString() })
          .eq('id', period.id)
          .is('superseded_at', null);
        await backfillCommissionPeriod(winnerPeriod.id);
        return winnerPeriod;
      }
    }
  }
  await backfillCommissionPeriod(period.id);
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
  now: Date = new Date(),
  options: { overrideReason?: string | null } = {}
): Promise<{ payment: SubscriptionPaymentRow; period: SubscriptionPeriodRow | null }> {
  const loadPayment = async (): Promise<SubscriptionPaymentRow | null> => {
    const { data, error } = await client
      .from('subscription_payments')
      .select(
        `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,coupon_code,discount_pkr,period_id,approved_at,created_at`
      )
      .eq('id', paymentId)
      .maybeSingle();
    // DB errors are NOT a missing payment: fail loud with a retryable
    // error instead of the old 404 masquerade (audit fix, this build).
    if (error) {
      logServerError('[billing] payment approve load failed', error, { source: 'billing' });
      throw new SubscriptionGateError(
        'ENTITLEMENT_UNAVAILABLE',
        'That payment could not be loaded right now. Please try again.'
      );
    }
    if (!data) return null;
    const base = paymentFromRow(asRow(data) ?? {});
    if (!base) return null;
    return { ...base, ...(await loadNewPaymentFieldsForRow(client, paymentId)) };
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

  // Screenshot override (owner decisions 2026-11-02): a bank payment
  // may be approved without a screenshot ONLY with a recorded reason.
  // The user side can never submit without one; the admin side may
  // rescue a genuine upload failure, auditable via override_reason.
  if (payment.method === 'bank' && !payment.screenshotStorageKey && !options.overrideReason) {
    throw new SubscriptionGateError(
      'INVALID_REQUEST',
      'This payment has no screenshot. Approve it only with a recorded reason, or reject it.'
    );
  }
  if (payment.isDowngrade) {
    // Second-schedule guard, BEFORE the claim: once claimed, a
    // blocked approval would strand an approved-but-unscheduled
    // payment. A due older schedule activates first, so it no
    // longer blocks; an activation failure fails closed here
    // (retryable 500) rather than creating a second schedule.
    await activateDueScheduledDowngrades(client, payment.userId, now);
    if (await hasOutstandingScheduledDowngrade(client, payment.userId, payment.id)) {
      throw new SubscriptionGateError(
        'PAYMENT_ALREADY_DECIDED',
        SCHEDULED_DOWNGRADE_EXISTS_MESSAGE
      );
    }
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

  if (options.overrideReason) {
    try {
      await client
        .from('subscription_payments')
        .update({ override_reason: options.overrideReason, decided_at: now.toISOString(), updated_at: now.toISOString() })
        .eq('id', payment.id);
    } catch (err) {
      logServerError('[billing] override reason record failed (migration may be unapplied)', err, {
        source: 'billing',
      });
    }
  }
  return linkPeriodForApprovedPayment(
    client,
    { ...payment, status: 'approved', approvedAt: now.toISOString(), overrideReason: options.overrideReason ?? payment.overrideReason },
    adminUserId,
    now,
    loadPeriod
  );
}

/**
 * Create the period for an already-claimed (approved) payment and
 * link it conditionally. If the link loses, the orphan period is
 * superseded immediately and the winner's period is returned.
 * A scheduled downgrade returns period null: approval records
 * the schedule only (option A, PR 120 send-back fix B2) — the
 * period is created later by activateDueScheduledDowngrades.
 */
async function linkPeriodForApprovedPayment(
  client: SupabaseClient,
  payment: SubscriptionPaymentRow,
  adminUserId: string,
  now: Date,
  loadPeriod: (periodId: string) => Promise<SubscriptionPeriodRow | null>
): Promise<{ payment: SubscriptionPaymentRow; period: SubscriptionPeriodRow | null }> {
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
  let period: SubscriptionPeriodRow | null = null;
  if (payment.isDowngrade) {
    // Repair case: activation already created this payment's period
    // but the link failed. Link to that period instead of minting
    // a second one — and instead of re-scheduling a payment whose
    // plan is already live.
    const { data: existingPeriods } = await client
      .from('subscription_periods')
      .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
      .eq('payment_id', payment.id)
      .is('superseded_at', null)
      .order('ends_at', { ascending: false })
      .limit(1);
    const existing =
      Array.isArray(existingPeriods) && existingPeriods.length > 0
        ? periodFromRow(asRow(existingPeriods[0]) ?? {})
        : null;
    if (existing) {
      period = existing;
    } else {
      // Second-schedule guard, repair path too: scheduling this
      // payment while another schedule is outstanding would leave
      // two competing future plans. The payment stays approved;
      // the admin rejects it (or waits for the other schedule).
      if (await hasOutstandingScheduledDowngrade(client, payment.userId, payment.id)) {
        throw new SubscriptionGateError(
          'PAYMENT_ALREADY_DECIDED',
          SCHEDULED_DOWNGRADE_EXISTS_MESSAGE
        );
      }
      const live = await getActivePeriod(client, payment.userId, now);
      if (live && live.endsAt > now) {
        // Schedule ONLY (option A): record the schedule on the
        // payment, apply the coupon now (period link null), and
        // record NO commission yet — commission is recorded at
        // activation, with the real period. No period row is
        // inserted here, so the one-live-per-user index can never
        // see a live + scheduled pair.
        const scheduledStartsAt = live.endsAt;
        try {
          await client
            .from('subscription_payments')
            .update({
              scheduled_starts_at: scheduledStartsAt.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq('id', payment.id);
        } catch (err) {
          logServerError('[billing] scheduled starts_at record failed (migration may be unapplied)', err, {
            source: 'billing',
          });
        }
        await applyHeldRedemptionsForPayment(client, payment.id, null);
        // Commission is earned at approval, not activation (see
        // the option-A comment above): recorded with a null
        // period id and the scheduled start; activation backfills
        // period_id. It throws on failure, fail loud, like every
        // other approval path — a re-approve through the repair
        // path retries it idempotently per payment.
        await recordCommissionForPayment(
          client,
          { ...payment, scheduledStartsAt },
          null
        );
        return {
          payment: { ...payment, scheduledStartsAt },
          period: null,
        };
      }
      // Lapsed: no live plan to preserve, so a downgrade approved
      // now is an immediate period, never backdated.
    }
  }
  if (!period) {
    period = await createPeriodForPayment(client, payment, now);
  }
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

export async function rejectPayment(
  client: SupabaseClient,
  paymentId: string,
  now: Date = new Date(),
  options: { reason?: string | null; detail?: string | null; adminUserId?: string | null } = {}
): Promise<SubscriptionPaymentRow> {
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,coupon_code,discount_pkr,period_id,approved_at,created_at`
    )
    .eq('id', paymentId)
    .maybeSingle();
  if (error) {
    logServerError('[billing] payment reject load failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be loaded right now. Please try again.'
    );
  }
  if (!data) {
    throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }
  let payment = paymentFromRow(asRow(data) ?? {});
  if (!payment) {
    throw new SubscriptionGateError('PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }
  payment = { ...payment, ...(await loadNewPaymentFieldsForRow(client, paymentId)) };
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
  // Reason columns ship with a new migration (unapplied until the
  // owner applies it): record best-effort, never fail the rejection
  // for them, but always return the reason in memory so the UI
  // shows it for this decision.
  if (options.reason) {
    try {
      await client
        .from('subscription_payments')
        .update({
          rejection_reason: options.reason,
          rejection_detail: options.detail ?? null,
          decided_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', payment.id);
    } catch (err) {
      logServerError('[billing] rejection reason record failed (migration may be unapplied)', err, {
        source: 'billing',
      });
    }
  }
  if (updateError) {
    logServerError('[billing] payment reject update failed', updateError, {
      source: 'billing',
    });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be rejected right now. Please try again.'
    );
  }
  return {
    ...payment,
    status: 'rejected',
    rejectionReason: options.reason ?? payment.rejectionReason,
    rejectionDetail: options.detail ?? payment.rejectionDetail,
    decidedAt: now.toISOString(),
  };
}

/** Price a purchase: fresh purchase pays the full total; an upgrade pays new total minus credit. */
export function pricePurchase(
  counts: import('@fbuploadpro/contracts').PlatformCounts,
  activePeriod: SubscriptionPeriodRow | null,
  now: Date = new Date()
): {
  amountPkr: number;
  isUpgrade: boolean;
  isDowngrade: boolean;
  quote: ReturnType<typeof quoteUpgrade> | null;
  downgradeQuote: ReturnType<typeof quoteDowngrade> | null;
} {
  if (!activePeriod) {
    return { amountPkr: totalPricePkr(counts), isUpgrade: false, isDowngrade: false, quote: null, downgradeQuote: null };
  }
  const daysRemaining = Math.ceil(
    Math.max(0, activePeriod.endsAt.getTime() - now.getTime()) / 86_400_000
  );
  try {
    const quote = quoteUpgrade(activePeriod.counts, counts, daysRemaining);
    return { amountPkr: quote.amountToPayPkr, isUpgrade: true, isDowngrade: false, quote, downgradeQuote: null };
  } catch (upgradeErr) {
    // Downgrade (owner decision 2026-11-02): lower total, no platform
    // raised. It is priced at the new monthly total with NO credit.
    try {
      const downgradeQuote = quoteDowngrade(activePeriod.counts, counts);
      return { amountPkr: downgradeQuote.amountToPayPkr, isUpgrade: false, isDowngrade: true, quote: null, downgradeQuote };
    } catch (downgradeErr) {
      // Mixed change (some up, some down) or same total: report the
      // downgrade reason when a platform was raised (that is what
      // blocks a downgrade), otherwise the upgrade reason.
      const message =
        downgradeErr instanceof DomainError && downgradeErr.message.includes('cannot raise')
          ? downgradeErr.message
          : upgradeErr instanceof Error
            ? upgradeErr.message
            : 'That change is not an upgrade or a downgrade.';
      throw new SubscriptionGateError('INVALID_REQUEST', message);
    }
  }
}
