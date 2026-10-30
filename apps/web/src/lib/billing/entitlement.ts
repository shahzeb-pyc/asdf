import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canUseDestination,
  isPeriodActive,
  quoteUpgrade,
  totalPricePkr,
  SUBSCRIPTION_PERIOD_DAYS,
  SUBSCRIPTION_PLATFORMS,
  type PlatformCounts,
  type SubscriptionPlatform,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

/**
 * Subscription entitlement, server-side only.
 *
 * The usage registry is the single source of truth for the cap:
 * one row per distinct destination a user has used in a feature,
 * per platform. Connecting an account/page never writes here.
 * Posting gates call assertCanPost/registerUsage; future features
 * (auto download-upload, auto repost) call the same functions
 * through the usage-register API route.
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
  bankMethod: 'easypaisa' | 'nayapay' | 'ubl' | null;
  status: string;
  counts: PlatformCounts;
  amountPkr: number;
  isUpgrade: boolean;
  screenshotStorageKey: string | null;
  nowpaymentsPaymentId: string | null;
  nowpaymentsPayAddress: string | null;
  nowpaymentsPayAmount: number | null;
  nowpaymentsNetwork: 'trc20' | 'bep20' | null;
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
  return {
    id,
    userId,
    method: method === 'nowpayments' ? 'nowpayments' : 'bank',
    bankMethod:
      bankMethod === 'easypaisa' || bankMethod === 'nayapay' || bankMethod === 'ubl'
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
    periodId: stringField(row, 'period_id'),
    approvedAt: stringField(row, 'approved_at'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

const COUNT_COLUMNS =
  'facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count';

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
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const row = Array.isArray(data) && data.length > 0 ? asRow(data[0]) : null;
  return row ? periodFromRow(row) : null;
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
      .eq('platform', platform);
    if (error) {
      throw new SubscriptionGateError(
        'ENTITLEMENT_UNAVAILABLE',
        'Your plan could not be checked right now. Please try again.'
      );
    }
    usage[platform] = typeof count === 'number' ? count : 0;
  }
  return usage;
}

export async function getUsedDestinationKeys(
  client: SupabaseClient,
  userId: string,
  platform: SubscriptionPlatform
): Promise<string[]> {
  const { data, error } = await client
    .from('subscription_usage')
    .select('destination_key')
    .eq('user_id', userId)
    .eq('platform', platform);
  if (error) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const keys: string[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      const row = asRow(item);
      const key = row ? stringField(row, 'destination_key') : null;
      if (key) keys.push(key);
    }
  }
  return keys;
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
  };
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
  const usedKeys = await getUsedDestinationKeys(client, userId, platform);
  const allowed = entitlement.counts[platform];
  if (!canUseDestination(usedKeys, destinationKey, allowed)) {
    throw new SubscriptionGateError(
      'SUBSCRIPTION_CAP_REACHED',
      `You have reached your limit of ${allowed} ${platform === 'facebook' ? 'pages' : 'accounts'} on ${platform}. Upgrade your plan to use more.`
    );
  }
  return entitlement.period;
}

/**
 * Register a destination as used in a feature. The gate runs first;
 * a race that inserts the same destination twice is treated as
 * already-used (the unique constraint), never as a second unit.
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
  await assertCanPost(client, userId, platform, destinationKey, now);
  const usedBefore = await getUsedDestinationKeys(client, userId, platform);
  if (usedBefore.includes(destinationKey)) {
    return { alreadyUsed: true, usedCount: usedBefore.length };
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
    // destination in the meantime. That is a success, not a failure.
    if (error.code === '23505') {
      const usedAfter = await getUsedDestinationKeys(client, userId, platform);
      return { alreadyUsed: true, usedCount: usedAfter.length };
    }
    logServerError('[billing] usage insert failed', error, { source: 'billing' });
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your plan could not be checked right now. Please try again.'
    );
  }
  const usedAfter = await getUsedDestinationKeys(client, userId, platform);
  return { alreadyUsed: false, usedCount: usedAfter.length };
}

/** Supersede the user's current periods and start a fresh 30-day period for a payment. */
export async function createPeriodForPayment(
  client: SupabaseClient,
  payment: SubscriptionPaymentRow,
  startsAt: Date = new Date()
): Promise<SubscriptionPeriodRow> {
  const endsAt = new Date(startsAt.getTime() + SUBSCRIPTION_PERIOD_DAYS * 86_400_000);
  const { error: supersedeError } = await client
    .from('subscription_periods')
    .update({ superseded_at: startsAt.toISOString() })
    .eq('user_id', payment.userId)
    .is('superseded_at', null)
    .gt('ends_at', startsAt.toISOString());
  if (supersedeError) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  const { data, error } = await client
    .from('subscription_periods')
    .insert({
      user_id: payment.userId,
      payment_id: payment.id,
      facebook_count: payment.counts.facebook,
      instagram_count: payment.counts.instagram,
      threads_count: payment.counts.threads,
      x_count: payment.counts.x,
      tiktok_count: payment.counts.tiktok,
      youtube_count: payment.counts.youtube,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
    .single();
  if (error || !data) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  const period = periodFromRow(asRow(data) ?? {});
  if (!period) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'Your paid period could not be started right now. Please try again.'
    );
  }
  return period;
}

/**
 * Approve a bank payment. Idempotent: approving an already-approved
 * payment returns its existing period and does NOT extend it again.
 * Only pending payments can be approved or rejected.
 */
export async function approvePayment(
  client: SupabaseClient,
  paymentId: string,
  adminUserId: string,
  now: Date = new Date()
): Promise<{ payment: SubscriptionPaymentRow; period: SubscriptionPeriodRow }> {
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at`
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
  if (payment.periodId) {
    const { data: periodData } = await client
      .from('subscription_periods')
      .select(`id,user_id,${COUNT_COLUMNS},starts_at,ends_at,superseded_at`)
      .eq('id', payment.periodId)
      .maybeSingle();
    const period = periodData ? periodFromRow(asRow(periodData) ?? {}) : null;
    if (period) return { payment, period };
  }
  if (payment.status !== 'pending') {
    throw new SubscriptionGateError(
      'PAYMENT_ALREADY_DECIDED',
      'That payment has already been decided.'
    );
  }
  const period = await createPeriodForPayment(client, payment, now);
  const { error: updateError } = await client
    .from('subscription_payments')
    .update({
      status: 'approved',
      approved_at: now.toISOString(),
      approved_by: adminUserId,
      period_id: period.id,
      updated_at: now.toISOString(),
    })
    .eq('id', payment.id)
    .eq('status', 'pending');
  if (updateError) {
    throw new SubscriptionGateError(
      'ENTITLEMENT_UNAVAILABLE',
      'That payment could not be approved right now. Please try again.'
    );
  }
  return {
    payment: { ...payment, status: 'approved', approvedAt: now.toISOString(), periodId: period.id },
    period,
  };
}

export async function rejectPayment(
  client: SupabaseClient,
  paymentId: string,
  now: Date = new Date()
): Promise<SubscriptionPaymentRow> {
  const { data, error } = await client
    .from('subscription_payments')
    .select(
      `id,user_id,method,bank_method,status,${COUNT_COLUMNS},amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at`
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
  const { error: updateError } = await client
    .from('subscription_payments')
    .update({ status: 'rejected', updated_at: now.toISOString() })
    .eq('id', payment.id)
    .eq('status', 'pending');
  if (updateError) {
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
  const quote = quoteUpgrade(activePeriod.counts, counts, daysRemaining);
  return { amountPkr: quote.amountToPayPkr, isUpgrade: true, quote };
}
