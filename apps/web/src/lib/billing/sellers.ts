import type { SupabaseClient } from '@supabase/supabase-js';
import {
  commissionAmountPkr,
  normalizeReferralCode,
  SELLER_COMMISSION_PAYABLE_AFTER_DAYS,
  SELLER_PAYOUT_MINIMUM_PKR,
  type CommissionStatus,
  type SellerPayoutMethod,
  type SellerScope,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import type { SubscriptionPaymentRow, SubscriptionPeriodRow } from './entitlement';

/**
 * Sellers (reseller) system, server-side only.
 *
 * Referral-only: no seller coupons exist anywhere in this module.
 * Sellers are `users` rows with role 'seller' (no workspace row).
 * Attribution is the referral stored on the buyer account at
 * signup, frozen forever; commission rows snapshot the seller's
 * rate and scope at purchase time, so later setting changes
 * never rewrite history.
 *
 * Commission lifecycle: pending -> payable once BOTH 10 days
 * have passed from plan start AND no unresolved refund request
 * exists on that payment. Refund integration note: the refunds
 * system (PR #81, merged) owns `refund_requests`.
 * `hasUnresolvedRefundRequest` treats a missing table (42P01)
 * as "no requests" — a dormant safety net, not a silent
 * fallback: with no refund system there can be no refund
 * requests. The refunds approval path must call
 * `applyRefundOutcomeToCommission` on approval
 * (cancel/reduce) — flagged as a follow-up in the PR report.
 */

export class SellerError extends Error {
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

export interface SellerSettings {
  sellerId: string;
  rate: number;
  scope: SellerScope;
  status: 'active' | 'paused' | 'deleted';
}

export interface SellerCommission {
  id: string;
  sellerId: string;
  userId: string;
  paymentId: string;
  periodId: string | null;
  periodStartsAt: string;
  rateSnapshot: number;
  scopeSnapshot: SellerScope;
  amountPkr: number;
  status: CommissionStatus;
  payoutRequestId: string | null;
  createdAt: string;
}

export interface SellerPayoutRequest {
  id: string;
  sellerId: string;
  totalPkr: number;
  status: 'pending' | 'paid' | 'rejected';
  sellerNameSnapshot: string | null;
  sellerEmailSnapshot: string;
  payoutMethodSnapshot: SellerPayoutMethod | null;
  payoutAccountSnapshot: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

function settingsFromRow(row: UnknownRow): SellerSettings | null {
  const sellerId = stringField(row, 'user_id');
  const scope = stringField(row, 'scope');
  const status = stringField(row, 'status');
  if (!sellerId || (scope !== 'one-time' && scope !== 'every')) return null;
  if (status !== 'active' && status !== 'paused' && status !== 'deleted') return null;
  return {
    sellerId,
    rate: numberField(row, 'rate'),
    scope,
    status,
  };
}

function commissionFromRow(row: UnknownRow): SellerCommission | null {
  const id = stringField(row, 'id');
  const sellerId = stringField(row, 'seller_id');
  const userId = stringField(row, 'user_id');
  const paymentId = stringField(row, 'payment_id');
  const periodStartsAt = stringField(row, 'period_starts_at');
  const scope = stringField(row, 'scope_snapshot');
  const status = stringField(row, 'status');
  if (!id || !sellerId || !userId || !paymentId || !periodStartsAt) return null;
  if (scope !== 'one-time' && scope !== 'every') return null;
  if (
    status !== 'pending' &&
    status !== 'payable' &&
    status !== 'requested' &&
    status !== 'paid' &&
    status !== 'cancelled'
  ) {
    return null;
  }
  return {
    id,
    sellerId,
    userId,
    paymentId,
    periodId: stringField(row, 'period_id'),
    periodStartsAt,
    rateSnapshot: numberField(row, 'rate_snapshot'),
    scopeSnapshot: scope,
    amountPkr: numberField(row, 'amount_pkr'),
    status,
    payoutRequestId: stringField(row, 'payout_request_id'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

export async function getSellerSettings(
  client: SupabaseClient,
  sellerId: string
): Promise<SellerSettings | null> {
  const { data, error } = await client
    .from('seller_settings')
    .select('user_id,rate,scope,status')
    .eq('user_id', sellerId)
    .maybeSingle();
  if (error) {
    logServerError('[sellers] settings lookup failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const row = asRow(data);
  return row ? settingsFromRow(row) : null;
}

/**
 * Resolve a referral code to an ACTIVE seller. Any code row for
 * the seller resolves, current or superseded — past codes stay
 * valid forever. Unknown codes, and codes belonging to paused
 * or deleted sellers, resolve to null (no new attribution).
 */
export async function resolveReferralCode(
  client: SupabaseClient,
  rawCode: string
): Promise<{ sellerId: string; sellerName: string | null } | null> {
  const code = normalizeReferralCode(rawCode);
  if (code.length === 0) return null;
  const { data: codeRow, error: codeError } = await client
    .from('referral_codes')
    .select('seller_id')
    .eq('code', code)
    .maybeSingle();
  if (codeError) {
    logServerError('[sellers] referral code lookup failed', codeError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const codeData = asRow(codeRow);
  const sellerId = codeData ? stringField(codeData, 'seller_id') : null;
  if (!sellerId) return null;
  const settings = await getSellerSettings(client, sellerId);
  if (!settings || settings.status !== 'active') return null;
  const { data: userRow, error: userError } = await client
    .from('users')
    .select('name')
    .eq('id', sellerId)
    .maybeSingle();
  if (userError) {
    logServerError('[sellers] seller user lookup failed', userError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const userData = asRow(userRow);
  return { sellerId, sellerName: userData ? stringField(userData, 'name') : null };
}

/** Current (non-superseded) code for a seller, if one is picked. */
export async function getCurrentReferralCode(
  client: SupabaseClient,
  sellerId: string
): Promise<string | null> {
  const { data, error } = await client
    .from('referral_codes')
    .select('code')
    .eq('seller_id', sellerId)
    .is('superseded_at', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    logServerError('[sellers] current code lookup failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const first = Array.isArray(data) && data.length > 0 ? asRow(data[0]) : null;
  return first ? stringField(first, 'code') : null;
}

/** All codes a seller has ever used, newest first. */
export async function listReferralCodes(
  client: SupabaseClient,
  sellerId: string
): Promise<Array<{ code: string; current: boolean; createdAt: string }>> {
  const { data, error } = await client
    .from('referral_codes')
    .select('code,superseded_at,created_at')
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    logServerError('[sellers] code list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  return rows
    .map((r) => ({
      code: stringField(r, 'code') ?? '',
      current: stringField(r, 'superseded_at') === null,
      createdAt: stringField(r, 'created_at') ?? '',
    }))
    .filter((r) => r.code.length > 0);
}

/**
 * Change (or first pick) a seller's referral code. The new code
 * must be globally unique across every code ever used, by any
 * seller, current or superseded — the unique index enforces it
 * (23505 → a loud duplicate error, never a silent reuse).
 * The previous current code is superseded, never deleted, so
 * links carrying it keep attributing forever.
 */
export async function changeReferralCode(
  client: SupabaseClient,
  sellerId: string,
  rawCode: string
): Promise<{ code: string }> {
  const code = normalizeReferralCode(rawCode);
  const { data: clash, error: clashError } = await client
    .from('referral_codes')
    .select('id')
    .eq('code', code)
    .limit(1);
  if (clashError) {
    logServerError('[sellers] code clash check failed', clashError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  if (Array.isArray(clash) && clash.length > 0) {
    throw new SellerError(
      'REFERRAL_CODE_TAKEN',
      'That referral code is already used. Pick a different one.'
    );
  }
  const { error: supersedeError } = await client
    .from('referral_codes')
    .update({ superseded_at: new Date().toISOString() })
    .eq('seller_id', sellerId)
    .is('superseded_at', null);
  if (supersedeError) {
    logServerError('[sellers] code supersede failed', supersedeError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The referral code could not be changed right now.');
  }
  const { error: insertError } = await client
    .from('referral_codes')
    .insert({ seller_id: sellerId, code });
  if (insertError) {
    if (insertError.code === '23505') {
      throw new SellerError(
        'REFERRAL_CODE_TAKEN',
        'That referral code is already used. Pick a different one.'
      );
    }
    logServerError('[sellers] code insert failed', insertError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The referral code could not be changed right now.');
  }
  return { code };
}

/**
 * Record the commission for one approved/finished payment.
 * Idempotent: a second call for the same payment returns the
 * existing row (approval re-runs and webhook redelivery share
 * this path). Returns null when no commission is owed: buyer
 * has no referrer, seller missing/paused/deleted, or a one-time
 * bounty already spent (any prior period for the buyer other
 * than this one — a refunded or zero-due first purchase still
 * spent it, because the period row survives).
 */
export async function recordCommissionForPayment(
  client: SupabaseClient,
  payment: Pick<SubscriptionPaymentRow, 'id' | 'userId' | 'amountPkr'>,
  period: Pick<SubscriptionPeriodRow, 'id' | 'startsAt'>
): Promise<SellerCommission | null> {
  const { data: existing, error: existingError } = await client
    .from('seller_commissions')
    .select(
      'id,seller_id,user_id,payment_id,period_id,period_starts_at,rate_snapshot,scope_snapshot,amount_pkr,status,payout_request_id,created_at'
    )
    .eq('payment_id', payment.id)
    .maybeSingle();
  if (existingError) {
    logServerError('[sellers] commission existence check failed', existingError, {
      source: 'sellers',
    });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The commission could not be recorded right now.');
  }
  const existingRow = asRow(existing);
  if (existingRow) {
    const parsed = commissionFromRow(existingRow);
    if (parsed) return parsed;
  }

  const { data: buyerRow, error: buyerError } = await client
    .from('users')
    .select('referred_by_seller_id')
    .eq('id', payment.userId)
    .maybeSingle();
  if (buyerError) {
    logServerError('[sellers] buyer referral lookup failed', buyerError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The commission could not be recorded right now.');
  }
  const buyerData = asRow(buyerRow);
  const sellerId = buyerData ? stringField(buyerData, 'referred_by_seller_id') : null;
  if (!sellerId) return null;

  const settings = await getSellerSettings(client, sellerId);
  if (!settings || settings.status !== 'active') return null;

  if (settings.scope === 'one-time') {
    const { data: priorPeriods, error: priorError } = await client
      .from('subscription_periods')
      .select('id')
      .eq('user_id', payment.userId)
      .neq('id', period.id)
      .limit(1);
    if (priorError) {
      logServerError('[sellers] prior period check failed', priorError, { source: 'sellers' });
      throw new SellerError(
        'SELLERS_UNAVAILABLE',
        'The commission could not be recorded right now.'
      );
    }
    if (Array.isArray(priorPeriods) && priorPeriods.length > 0) return null;
  }

  const amountPkr = commissionAmountPkr(settings.rate, payment.amountPkr);
  const { data: inserted, error: insertError } = await client
    .from('seller_commissions')
    .insert({
      seller_id: sellerId,
      user_id: payment.userId,
      payment_id: payment.id,
      period_id: period.id,
      period_starts_at: period.startsAt.toISOString(),
      rate_snapshot: settings.rate,
      scope_snapshot: settings.scope,
      amount_pkr: amountPkr,
      status: 'pending',
    })
    .select(
      'id,seller_id,user_id,payment_id,period_id,period_starts_at,rate_snapshot,scope_snapshot,amount_pkr,status,payout_request_id,created_at'
    )
    .maybeSingle();
  if (insertError) {
    // 23505 = a concurrent approval recorded it first. That is a
    // success, not a failure: return the existing row.
    if (insertError.code === '23505') {
      const { data: raced } = await client
        .from('seller_commissions')
        .select(
          'id,seller_id,user_id,payment_id,period_id,period_starts_at,rate_snapshot,scope_snapshot,amount_pkr,status,payout_request_id,created_at'
        )
        .eq('payment_id', payment.id)
        .maybeSingle();
      const racedRow = asRow(raced);
      return racedRow ? commissionFromRow(racedRow) : null;
    }
    logServerError('[sellers] commission insert failed', insertError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The commission could not be recorded right now.');
  }
  const insertedRow = asRow(inserted);
  return insertedRow ? commissionFromRow(insertedRow) : null;
}

/**
 * True when an unresolved refund request exists on a payment.
 * Unresolved = status 'requested' (the refunds system's pending
 * state; approved/sent/rejected are terminal for this purpose).
 * Missing table (42P01 — dormant safety net for a database
 * without the refunds migration) means no requests can exist,
 * so it returns false. Any other error fails loud.
 */
export async function hasUnresolvedRefundRequest(
  client: SupabaseClient,
  paymentId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('refund_requests')
    .select('id')
    .eq('payment_id', paymentId)
    .eq('status', 'requested')
    .limit(1);
  if (error) {
    if (error.code === '42P01') return false;
    logServerError('[sellers] refund request lookup failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Move pending commissions to payable once BOTH conditions hold:
 * 10 days passed from plan start AND no unresolved refund
 * request on the payment. Idempotent; returns how many moved.
 * Called on balance reads, admin detail reads, and payout
 * request creation, so buckets are never stale without a cron.
 */
export async function refreshSellerCommissions(
  client: SupabaseClient,
  sellerId: string,
  now: Date = new Date()
): Promise<number> {
  const { data, error } = await client
    .from('seller_commissions')
    .select('id,period_starts_at,payment_id')
    .eq('seller_id', sellerId)
    .eq('status', 'pending')
    .limit(500);
  if (error) {
    logServerError('[sellers] pending commission scan failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  let moved = 0;
  const thresholdMs = SELLER_COMMISSION_PAYABLE_AFTER_DAYS * 86_400_000;
  for (const row of rows) {
    const id = stringField(row, 'id');
    const startsAt = stringField(row, 'period_starts_at');
    const paymentId = stringField(row, 'payment_id');
    if (!id || !startsAt || !paymentId) continue;
    if (now.getTime() - new Date(startsAt).getTime() < thresholdMs) continue;
    if (await hasUnresolvedRefundRequest(client, paymentId)) continue;
    const { error: updateError } = await client
      .from('seller_commissions')
      .update({ status: 'payable', updated_at: now.toISOString() })
      .eq('id', id)
      .eq('status', 'pending');
    if (updateError) {
      logServerError('[sellers] commission payable transition failed', updateError, {
        source: 'sellers',
      });
      throw new SellerError(
        'SELLERS_UNAVAILABLE',
        'Seller data could not be loaded right now.'
      );
    }
    moved += 1;
  }
  return moved;
}

/**
 * Refund outcome hook — for the refunds PR to call on approval.
 * A commission still pending when its payment's refund is
 * approved is cancelled (full refund, kept ≤ 0) or reduced to
 * rate × kept amount (partial refund). Payable/requested rows
 * are reduced the same way and their payout request total is
 * corrected by the same delta (the hold rule should make this
 * unreachable, but the correction keeps request totals honest
 * if it ever happens). Paid rows are never rewritten: the
 * discrepancy is logged loudly for manual handling.
 */
export async function applyRefundOutcomeToCommission(
  client: SupabaseClient,
  paymentId: string,
  keptPkr: number
): Promise<SellerCommission | null> {
  const { data, error } = await client
    .from('seller_commissions')
    .select(
      'id,seller_id,user_id,payment_id,period_id,period_starts_at,rate_snapshot,scope_snapshot,amount_pkr,status,payout_request_id,created_at'
    )
    .eq('payment_id', paymentId)
    .maybeSingle();
  if (error) {
    logServerError('[sellers] refund commission lookup failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The commission could not be adjusted right now.');
  }
  const row = asRow(data);
  const commission = row ? commissionFromRow(row) : null;
  if (!commission) return null;
  if (commission.status === 'paid' || commission.status === 'cancelled') {
    if (commission.status === 'paid') {
      logServerError('[sellers] refund approved after commission paid', null, {
        source: 'sellers',
        paymentId,
        commissionId: commission.id,
      });
    }
    return commission;
  }
  const now = new Date().toISOString();
  if (keptPkr <= 0) {
    const { error: cancelError } = await client
      .from('seller_commissions')
      .update({ status: 'cancelled', updated_at: now })
      .eq('id', commission.id);
    if (cancelError) {
      logServerError('[sellers] commission cancel failed', cancelError, { source: 'sellers' });
      throw new SellerError(
        'SELLERS_UNAVAILABLE',
        'The commission could not be adjusted right now.'
      );
    }
    if (commission.status === 'requested' && commission.payoutRequestId) {
      await client
        .from('seller_payout_requests')
        .update({ total_pkr: 0, updated_at: now })
        .eq('id', commission.payoutRequestId);
    }
    return { ...commission, status: 'cancelled', amountPkr: commission.amountPkr };
  }
  const reduced = commissionAmountPkr(commission.rateSnapshot, keptPkr);
  const delta = commission.amountPkr - reduced;
  const { error: reduceError } = await client
    .from('seller_commissions')
    .update({ amount_pkr: reduced, updated_at: now })
    .eq('id', commission.id);
  if (reduceError) {
    logServerError('[sellers] commission reduce failed', reduceError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The commission could not be adjusted right now.');
  }
  if (delta > 0 && commission.status === 'requested' && commission.payoutRequestId) {
    const { data: reqRow } = await client
      .from('seller_payout_requests')
      .select('total_pkr')
      .eq('id', commission.payoutRequestId)
      .maybeSingle();
    const reqData = asRow(reqRow);
    const total = reqData ? numberField(reqData, 'total_pkr') : 0;
    await client
      .from('seller_payout_requests')
      .update({ total_pkr: Math.max(0, total - delta), updated_at: now })
      .eq('id', commission.payoutRequestId);
  }
  return { ...commission, amountPkr: reduced };
}

/** Sum of a seller's commissions by status (exact, paged — never truncated). */
export async function getSellerBalances(
  client: SupabaseClient,
  sellerId: string
): Promise<{ pending: number; payable: number; requested: number; paid: number }> {
  const totals = { pending: 0, payable: 0, requested: 0, paid: 0 };
  let from = 0;
  const pageSize = 500;
  for (;;) {
    const { data, error } = await client
      .from('seller_commissions')
      .select('amount_pkr,status')
      .eq('seller_id', sellerId)
      .in('status', ['pending', 'payable', 'requested', 'paid'])
      .range(from, from + pageSize - 1);
    if (error) {
      logServerError('[sellers] balance scan failed', error, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
    }
    const rows = (Array.isArray(data) ? data : [])
      .map((r) => asRow(r))
      .filter((r): r is UnknownRow => r !== null);
    for (const row of rows) {
      const status = stringField(row, 'status');
      const amount = numberField(row, 'amount_pkr');
      if (status === 'pending') totals.pending += amount;
      else if (status === 'payable') totals.payable += amount;
      else if (status === 'requested') totals.requested += amount;
      else if (status === 'paid') totals.paid += amount;
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return totals;
}

/** Exact signup count for a seller (count query, never a row list). */
export async function getSellerSignupCount(
  client: SupabaseClient,
  sellerId: string
): Promise<number> {
  const { count, error } = await client
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('referred_by_seller_id', sellerId);
  if (error) {
    logServerError('[sellers] signup count failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  return typeof count === 'number' ? count : 0;
}

/**
 * Referred users who purchased: distinct referred buyers with at
 * least one subscription period. Referred ids are fetched paged
 * (never truncated), then matched against periods in chunks.
 */
export async function getSellerPurchaserCount(
  client: SupabaseClient,
  sellerId: string
): Promise<number> {
  const referredIds: string[] = [];
  let from = 0;
  const pageSize = 500;
  for (;;) {
    const { data, error } = await client
      .from('users')
      .select('id')
      .eq('referred_by_seller_id', sellerId)
      .range(from, from + pageSize - 1);
    if (error) {
      logServerError('[sellers] referred ids scan failed', error, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
    }
    const rows = (Array.isArray(data) ? data : [])
      .map((r) => asRow(r))
      .filter((r): r is UnknownRow => r !== null);
    for (const row of rows) {
      const id = stringField(row, 'id');
      if (id) referredIds.push(id);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  if (referredIds.length === 0) return 0;
  const purchasers = new Set<string>();
  for (let i = 0; i < referredIds.length; i += 200) {
    const chunk = referredIds.slice(i, i + 200);
    const { data, error } = await client
      .from('subscription_periods')
      .select('user_id')
      .in('user_id', chunk);
    if (error) {
      logServerError('[sellers] purchaser period scan failed', error, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
    }
    const rows = (Array.isArray(data) ? data : [])
      .map((r) => asRow(r))
      .filter((r): r is UnknownRow => r !== null);
    for (const row of rows) {
      const userId = stringField(row, 'user_id');
      if (userId) purchasers.add(userId);
    }
  }
  return purchasers.size;
}

export interface SellerPayoutDetails {
  method: SellerPayoutMethod;
  accountLabel: string;
}

export async function getSellerPayoutDetails(
  client: SupabaseClient,
  sellerId: string
): Promise<SellerPayoutDetails | null> {
  const { data, error } = await client
    .from('seller_payout_details')
    .select('method,account_label')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (error) {
    logServerError('[sellers] payout details lookup failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const row = asRow(data);
  if (!row) return null;
  const method = stringField(row, 'method');
  const accountLabel = stringField(row, 'account_label');
  if (
    method !== 'easypaisa' &&
    method !== 'nayapay' &&
    method !== 'ubl' &&
    method !== 'binance'
  ) {
    return null;
  }
  return { method, accountLabel: accountLabel ?? '' };
}

export async function saveSellerPayoutDetails(
  client: SupabaseClient,
  sellerId: string,
  details: SellerPayoutDetails
): Promise<SellerPayoutDetails> {
  const { error } = await client.from('seller_payout_details').upsert(
    {
      seller_id: sellerId,
      method: details.method,
      account_label: details.accountLabel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'seller_id' }
  );
  if (error) {
    logServerError('[sellers] payout details save failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Payout details could not be saved right now.');
  }
  return details;
}

/**
 * Request payout of ALL currently payable commissions at once.
 * Below the 1000 PKR minimum the request is refused with the
 * shortfall (no partial requests, no picking). The request
 * snapshots its commissions: later payables wait for the next
 * request. The status-guarded update keeps a concurrent double
 * request from paying the same commission twice — if the
 * guarded update lands fewer rows than selected, the request
 * total is corrected to what actually moved, and if that falls
 * below the minimum the whole request is rolled back.
 */
export async function requestPayout(
  client: SupabaseClient,
  sellerId: string,
  now: Date = new Date()
): Promise<{ request: SellerPayoutRequest; count: number }> {
  await refreshSellerCommissions(client, sellerId, now);
  const { data: payableRows, error: payableError } = await client
    .from('seller_commissions')
    .select('id,amount_pkr')
    .eq('seller_id', sellerId)
    .eq('status', 'payable')
    .limit(500);
  if (payableError) {
    logServerError('[sellers] payable scan failed', payableError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The payout could not be requested right now.');
  }
  const rows = (Array.isArray(payableRows) ? payableRows : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const selectedTotal = rows.reduce((sum, r) => sum + numberField(r, 'amount_pkr'), 0);
  if (selectedTotal < SELLER_PAYOUT_MINIMUM_PKR) {
    throw new SellerError(
      'PAYOUT_BELOW_MINIMUM',
      `Payout requests need at least ${SELLER_PAYOUT_MINIMUM_PKR} PKR ready. You have ${selectedTotal} PKR payable — ${SELLER_PAYOUT_MINIMUM_PKR - selectedTotal} PKR more to go.`
    );
  }
  const details = await getSellerPayoutDetails(client, sellerId);
  if (!details) {
    throw new SellerError(
      'PAYOUT_DETAILS_MISSING',
      'Save your payout details first — Easypaisa, bank, or Binance — so the payment can reach you.'
    );
  }
  const { data: sellerRow } = await client
    .from('users')
    .select('name,email')
    .eq('id', sellerId)
    .maybeSingle();
  const sellerData = asRow(sellerRow);
  const { data: requestRow, error: requestError } = await client
    .from('seller_payout_requests')
    .insert({
      seller_id: sellerId,
      total_pkr: selectedTotal,
      status: 'pending',
      seller_name_snapshot: sellerData ? stringField(sellerData, 'name') : null,
      seller_email_snapshot: sellerData ? stringField(sellerData, 'email') ?? '' : '',
      payout_method_snapshot: details.method,
      payout_account_snapshot: details.accountLabel,
      requested_at: now.toISOString(),
    })
    .select(
      'id,seller_id,total_pkr,status,seller_name_snapshot,seller_email_snapshot,payout_method_snapshot,payout_account_snapshot,requested_at,decided_at'
    )
    .single();
  if (requestError || !requestRow) {
    logServerError('[sellers] payout request insert failed', requestError, {
      source: 'sellers',
    });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The payout could not be requested right now.');
  }
  const requestData = asRow(requestRow);
  const requestId = requestData ? stringField(requestData, 'id') : null;
  if (!requestId) {
    throw new SellerError('SELLERS_UNAVAILABLE', 'The payout could not be requested right now.');
  }
  const ids = rows
    .map((r) => stringField(r, 'id'))
    .filter((id): id is string => id !== null);
  const { data: movedRows, error: moveError } = await client
    .from('seller_commissions')
    .update({ status: 'requested', payout_request_id: requestId, updated_at: now.toISOString() })
    .in('id', ids)
    .eq('status', 'payable')
    .select('amount_pkr');
  if (moveError) {
    logServerError('[sellers] payout row move failed', moveError, { source: 'sellers' });
    await client.from('seller_payout_requests').delete().eq('id', requestId);
    throw new SellerError('SELLERS_UNAVAILABLE', 'The payout could not be requested right now.');
  }
  const moved = (Array.isArray(movedRows) ? movedRows : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const movedTotal = moved.reduce((sum, r) => sum + numberField(r, 'amount_pkr'), 0);
  if (moved.length === 0 || movedTotal < SELLER_PAYOUT_MINIMUM_PKR) {
    // Lost the race to a concurrent request: roll everything back.
    await client
      .from('seller_commissions')
      .update({ status: 'payable', payout_request_id: null, updated_at: now.toISOString() })
      .eq('payout_request_id', requestId);
    await client.from('seller_payout_requests').delete().eq('id', requestId);
    throw new SellerError(
      'PAYOUT_BELOW_MINIMUM',
      `Payout requests need at least ${SELLER_PAYOUT_MINIMUM_PKR} PKR ready.`
    );
  }
  if (movedTotal !== selectedTotal) {
    await client
      .from('seller_payout_requests')
      .update({ total_pkr: movedTotal, updated_at: now.toISOString() })
      .eq('id', requestId);
  }
  const request: SellerPayoutRequest = {
    id: requestId,
    sellerId,
    totalPkr: movedTotal,
    status: 'pending',
    sellerNameSnapshot: requestData ? stringField(requestData, 'seller_name_snapshot') : null,
    sellerEmailSnapshot: requestData ? stringField(requestData, 'seller_email_snapshot') ?? '' : '',
    payoutMethodSnapshot: null,
    payoutAccountSnapshot: requestData
      ? stringField(requestData, 'payout_account_snapshot')
      : null,
    requestedAt: requestData ? stringField(requestData, 'requested_at') ?? '' : '',
    decidedAt: null,
  };
  const method = requestData ? stringField(requestData, 'payout_method_snapshot') : null;
  request.payoutMethodSnapshot =
    method === 'easypaisa' || method === 'nayapay' || method === 'ubl' || method === 'binance'
      ? method
      : null;
  return { request, count: moved.length };
}

function payoutRequestFromRow(row: UnknownRow): SellerPayoutRequest | null {
  const id = stringField(row, 'id');
  const sellerId = stringField(row, 'seller_id');
  const status = stringField(row, 'status');
  if (!id || !sellerId) return null;
  if (status !== 'pending' && status !== 'paid' && status !== 'rejected') return null;
  const method = stringField(row, 'payout_method_snapshot');
  return {
    id,
    sellerId,
    totalPkr: numberField(row, 'total_pkr'),
    status,
    sellerNameSnapshot: stringField(row, 'seller_name_snapshot'),
    sellerEmailSnapshot: stringField(row, 'seller_email_snapshot') ?? '',
    payoutMethodSnapshot:
      method === 'easypaisa' || method === 'nayapay' || method === 'ubl' || method === 'binance'
        ? method
        : null,
    payoutAccountSnapshot: stringField(row, 'payout_account_snapshot'),
    requestedAt: stringField(row, 'requested_at') ?? '',
    decidedAt: stringField(row, 'decided_at'),
  };
}

/**
 * Decide a payout request (admin only — routes enforce the role).
 * 'mark-sent': the batch is paid, every row in it becomes paid.
 * 'reject': the batch returns to payable, rows detached, so the
 * seller can request them again. Terminal requests refuse
 * further decisions with 409.
 */
export async function decidePayoutRequest(
  client: SupabaseClient,
  requestId: string,
  adminUserId: string,
  action: 'mark-sent' | 'reject',
  now: Date = new Date()
): Promise<SellerPayoutRequest> {
  const { data, error } = await client
    .from('seller_payout_requests')
    .select(
      'id,seller_id,total_pkr,status,seller_name_snapshot,seller_email_snapshot,payout_method_snapshot,payout_account_snapshot,requested_at,decided_at'
    )
    .eq('id', requestId)
    .maybeSingle();
  if (error || !data) {
    throw new SellerError('PAYOUT_REQUEST_NOT_FOUND', 'That payout request could not be found.');
  }
  const row = asRow(data);
  const request = row ? payoutRequestFromRow(row) : null;
  if (!request) {
    throw new SellerError('PAYOUT_REQUEST_NOT_FOUND', 'That payout request could not be found.');
  }
  if (request.status !== 'pending') {
    throw new SellerError(
      'PAYOUT_REQUEST_ALREADY_DECIDED',
      'That payout request has already been decided.'
    );
  }
  if (action === 'mark-sent') {
    const { error: updateError } = await client
      .from('seller_payout_requests')
      .update({
        status: 'paid',
        decided_at: now.toISOString(),
        decided_by: adminUserId,
        updated_at: now.toISOString(),
      })
      .eq('id', requestId)
      .eq('status', 'pending');
    if (updateError) {
      logServerError('[sellers] payout mark-sent failed', updateError, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'The decision could not be saved right now.');
    }
    const { error: rowsError } = await client
      .from('seller_commissions')
      .update({ status: 'paid', updated_at: now.toISOString() })
      .eq('payout_request_id', requestId)
      .eq('status', 'requested');
    if (rowsError) {
      logServerError('[sellers] payout rows mark-paid failed', rowsError, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'The decision could not be saved right now.');
    }
    return { ...request, status: 'paid', decidedAt: now.toISOString() };
  }
  const { error: rejectError } = await client
    .from('seller_payout_requests')
    .update({
      status: 'rejected',
      decided_at: now.toISOString(),
      decided_by: adminUserId,
      updated_at: now.toISOString(),
    })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (rejectError) {
    logServerError('[sellers] payout reject failed', rejectError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The decision could not be saved right now.');
  }
  const { error: rowsError } = await client
    .from('seller_commissions')
    .update({ status: 'payable', payout_request_id: null, updated_at: now.toISOString() })
    .eq('payout_request_id', requestId)
    .eq('status', 'requested');
  if (rowsError) {
    logServerError('[sellers] payout rows release failed', rowsError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The decision could not be saved right now.');
  }
  return { ...request, status: 'rejected', decidedAt: now.toISOString() };
}

/**
 * Create a seller account (admin only — routes enforce the role).
 * Supabase Auth creates the login (email auto-confirmed, no OTP),
 * then the users row (role 'seller') and the settings row. No
 * workspace row is ever created for a seller. If the profile
 * writes fail after Auth creation, the Auth user is rolled back
 * best-effort so a retry does not collide on "already
 * registered". An already-registered email is a loud 409.
 */
export async function createSeller(
  client: SupabaseClient,
  input: {
    name: string;
    email: string;
    password: string;
    rate: number;
    scope: SellerScope;
  }
): Promise<{ sellerId: string }> {
  const canonicalEmail = input.email.trim().toLowerCase();
  const { data: existing, error: existingError } = await client
    .from('users')
    .select('id')
    .or(`normalized_email.eq.${canonicalEmail},email.ilike.${canonicalEmail}`)
    .maybeSingle();
  if (existingError) {
    logServerError('[sellers] seller email check failed', existingError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be created right now.');
  }
  if (asRow(existing)) {
    throw new SellerError('SELLER_EMAIL_EXISTS', 'That email is already registered.');
  }
  const { data: authData, error: authError } = await client.auth.admin.createUser({
    email: canonicalEmail,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name },
  });
  if (authError || !authData?.user) {
    if (authError?.message?.toLowerCase().includes('already registered')) {
      throw new SellerError('SELLER_EMAIL_EXISTS', 'That email is already registered.');
    }
    logServerError('[sellers] seller auth creation failed', authError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be created right now.');
  }
  const sellerId = authData.user.id;
  try {
    const { error: userError } = await client.from('users').upsert(
      {
        id: sellerId,
        email: canonicalEmail,
        normalized_email: canonicalEmail,
        name: input.name,
        role: 'seller',
        status: 'active',
      },
      { onConflict: 'id' }
    );
    if (userError) throw userError;
    const { error: settingsError } = await client.from('seller_settings').insert({
      user_id: sellerId,
      rate: input.rate,
      scope: input.scope,
      status: 'active',
    });
    if (settingsError) throw settingsError;
  } catch (err) {
    // Roll the Auth user back so a retry does not collide.
    try {
      await client.auth.admin.deleteUser(sellerId);
    } catch (rollbackErr) {
      logServerError('[sellers] seller auth rollback failed', rollbackErr, {
        source: 'sellers',
      });
    }
    logServerError('[sellers] seller profile creation failed', err, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be created right now.');
  }
  return { sellerId };
}

/** Update a seller's rate, scope, or active/paused status (prospective only). */
export async function updateSeller(
  client: SupabaseClient,
  sellerId: string,
  patch: { rate?: number; scope?: SellerScope; status?: 'active' | 'paused' }
): Promise<SellerSettings> {
  const settings = await getSellerSettings(client, sellerId);
  if (!settings) {
    throw new SellerError('SELLER_NOT_FOUND', 'That seller could not be found.');
  }
  if (settings.status === 'deleted') {
    throw new SellerError('SELLER_NOT_FOUND', 'That seller could not be found.');
  }
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.rate !== undefined) update['rate'] = patch.rate;
  if (patch.scope !== undefined) update['scope'] = patch.scope;
  if (patch.status !== undefined) update['status'] = patch.status;
  const { error } = await client
    .from('seller_settings')
    .update(update)
    .eq('user_id', sellerId);
  if (error) {
    logServerError('[sellers] seller update failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be updated right now.');
  }
  return {
    sellerId,
    rate: patch.rate ?? settings.rate,
    scope: patch.scope ?? settings.scope,
    status: patch.status ?? settings.status,
  };
}

/**
 * Delete a seller (admin only). Blocked until every commission
 * is paid out — pending, payable, AND requested rows all block,
 * because pending rows must first mature and be paid; the
 * caller gets the outstanding breakdown. Auth is deleted first
 * (not-found tolerated) so a failed profile delete stays
 * retryable. Referral codes are deleted with the seller; payout
 * requests and commission rows survive via their snapshots and
 * non-FK seller ids for audit.
 */
export async function deleteSeller(
  client: SupabaseClient,
  sellerId: string
): Promise<{ deleted: true }> {
  const settings = await getSellerSettings(client, sellerId);
  if (!settings) {
    throw new SellerError('SELLER_NOT_FOUND', 'That seller could not be found.');
  }
  const outstanding: Record<string, number> = { pending: 0, payable: 0, requested: 0 };
  for (const status of ['pending', 'payable', 'requested'] as const) {
    const { count, error } = await client
      .from('seller_commissions')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', status);
    if (error) {
      logServerError('[sellers] delete outstanding check failed', error, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be deleted right now.');
    }
    outstanding[status] = typeof count === 'number' ? count : 0;
  }
  const totalOutstanding = outstanding['pending']! + outstanding['payable']! + outstanding['requested']!;
  if (totalOutstanding > 0) {
    throw new SellerError(
      'SELLER_HAS_UNPAID_COMMISSIONS',
      `Pay out this seller first: ${outstanding['pending']} pending, ${outstanding['payable']} payable, and ${outstanding['requested']} requested commissions are still unpaid.`
    );
  }
  try {
    await client.auth.admin.deleteUser(sellerId);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!message.toLowerCase().includes('not found')) {
      logServerError('[sellers] seller auth delete failed', err, { source: 'sellers' });
      throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be deleted right now.');
    }
  }
  const { error: codesError } = await client
    .from('referral_codes')
    .delete()
    .eq('seller_id', sellerId);
  if (codesError) {
    logServerError('[sellers] seller codes delete failed', codesError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be deleted right now.');
  }
  const { error: userError } = await client.from('users').delete().eq('id', sellerId);
  if (userError) {
    logServerError('[sellers] seller user delete failed', userError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'The seller could not be deleted right now.');
  }
  return { deleted: true as const };
}

export interface SellerStats {
  signups: number;
  purchasers: number;
  balances: { pending: number; payable: number; requested: number; paid: number };
}

export async function getSellerStats(
  client: SupabaseClient,
  sellerId: string
): Promise<SellerStats> {
  const [signups, purchasers, balances] = await Promise.all([
    getSellerSignupCount(client, sellerId),
    getSellerPurchaserCount(client, sellerId),
    getSellerBalances(client, sellerId),
  ]);
  return { signups, purchasers, balances };
}

export interface AdminSellerListItem {
  id: string;
  name: string | null;
  email: string;
  currentCode: string | null;
  rate: number;
  scope: SellerScope;
  status: 'active' | 'paused' | 'deleted';
  signups: number;
  purchasers: number;
  payablePkr: number;
  paidPkr: number;
  createdAt: string;
}

export async function listSellers(
  client: SupabaseClient,
  limit: number,
  offset: number
): Promise<{ sellers: AdminSellerListItem[]; total: number }> {
  const { count, error: countError } = await client
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'seller');
  if (countError) {
    logServerError('[sellers] seller list count failed', countError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const { data, error } = await client
    .from('users')
    .select('id,name,email,created_at')
    .eq('role', 'seller')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    logServerError('[sellers] seller list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const sellers: AdminSellerListItem[] = [];
  for (const row of rows) {
    const id = stringField(row, 'id');
    if (!id) continue;
    const settings = await getSellerSettings(client, id);
    if (!settings) continue;
    const [code, stats] = await Promise.all([
      getCurrentReferralCode(client, id),
      getSellerStats(client, id),
    ]);
    sellers.push({
      id,
      name: stringField(row, 'name'),
      email: stringField(row, 'email') ?? '',
      currentCode: code,
      rate: settings.rate,
      scope: settings.scope,
      status: settings.status,
      signups: stats.signups,
      purchasers: stats.purchasers,
      payablePkr: stats.balances.payable,
      paidPkr: stats.balances.paid,
      createdAt: stringField(row, 'created_at') ?? '',
    });
  }
  return { sellers, total: typeof count === 'number' ? count : sellers.length };
}

export interface ReferredUserItem {
  id: string;
  name: string | null;
  email: string;
  referralCode: string | null;
  purchased: boolean;
  signedUpAt: string;
}

/** Referred users, paged, with a purchased flag from one periods query. */
export async function listReferredUsers(
  client: SupabaseClient,
  sellerId: string,
  limit: number,
  offset: number
): Promise<{ users: ReferredUserItem[]; total: number }> {
  const total = await getSellerSignupCount(client, sellerId);
  const { data, error } = await client
    .from('users')
    .select('id,name,email,referred_by_code,created_at')
    .eq('referred_by_seller_id', sellerId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    logServerError('[sellers] referred users list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const ids = rows
    .map((r) => stringField(r, 'id'))
    .filter((id): id is string => id !== null);
  const purchased = new Set<string>();
  if (ids.length > 0) {
    const { data: periodRows, error: periodError } = await client
      .from('subscription_periods')
      .select('user_id')
      .in('user_id', ids);
    if (periodError) {
      logServerError('[sellers] referred purchaser scan failed', periodError, {
        source: 'sellers',
      });
      throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
    }
    const periodData = (Array.isArray(periodRows) ? periodRows : [])
      .map((r) => asRow(r))
      .filter((r): r is UnknownRow => r !== null);
    for (const r of periodData) {
      const userId = stringField(r, 'user_id');
      if (userId) purchased.add(userId);
    }
  }
  return {
    users: rows.map((r) => ({
      id: stringField(r, 'id') ?? '',
      name: stringField(r, 'name'),
      email: stringField(r, 'email') ?? '',
      referralCode: stringField(r, 'referred_by_code'),
      purchased: purchased.has(stringField(r, 'id') ?? ''),
      signedUpAt: stringField(r, 'created_at') ?? '',
    })),
    total,
  };
}

export interface PayoutRequestListItem extends SellerPayoutRequest {
  commissionCount: number;
}

async function payoutRequestListItem(
  client: SupabaseClient,
  row: UnknownRow
): Promise<PayoutRequestListItem | null> {
  const request = payoutRequestFromRow(row);
  if (!request) return null;
  const { count, error } = await client
    .from('seller_commissions')
    .select('id', { count: 'exact', head: true })
    .eq('payout_request_id', request.id);
  if (error) {
    logServerError('[sellers] payout commission count failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  return { ...request, commissionCount: typeof count === 'number' ? count : 0 };
}

/** A seller's own payout requests, newest first, paged. */
export async function listSellerPayoutRequests(
  client: SupabaseClient,
  sellerId: string,
  limit: number,
  offset: number
): Promise<{ requests: PayoutRequestListItem[]; total: number }> {
  const { count, error: countError } = await client
    .from('seller_payout_requests')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId);
  if (countError) {
    logServerError('[sellers] payout request count failed', countError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const { data, error } = await client
    .from('seller_payout_requests')
    .select(
      'id,seller_id,total_pkr,status,seller_name_snapshot,seller_email_snapshot,payout_method_snapshot,payout_account_snapshot,requested_at,decided_at'
    )
    .eq('seller_id', sellerId)
    .order('requested_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    logServerError('[sellers] payout request list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const requests: PayoutRequestListItem[] = [];
  for (const row of rows) {
    const item = await payoutRequestListItem(client, row);
    if (item) requests.push(item);
  }
  return { requests, total: typeof count === 'number' ? count : requests.length };
}

/** The admin payout queue, newest first (the UI groups pending on top). */
export async function listAdminPayoutRequests(
  client: SupabaseClient,
  limit: number,
  offset: number
): Promise<{ requests: PayoutRequestListItem[]; total: number }> {
  const { count, error: countError } = await client
    .from('seller_payout_requests')
    .select('id', { count: 'exact', head: true });
  if (countError) {
    logServerError('[sellers] admin payout count failed', countError, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const { data, error } = await client
    .from('seller_payout_requests')
    .select(
      'id,seller_id,total_pkr,status,seller_name_snapshot,seller_email_snapshot,payout_method_snapshot,payout_account_snapshot,requested_at,decided_at'
    )
    .order('requested_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    logServerError('[sellers] admin payout list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const requests: PayoutRequestListItem[] = [];
  for (const row of rows) {
    const item = await payoutRequestListItem(client, row);
    if (item) requests.push(item);
  }
  return { requests, total: typeof count === 'number' ? count : requests.length };
}

export interface CommissionListItem extends SellerCommission {
  buyerName: string | null;
  buyerEmail: string;
}

/** A seller's commissions, newest first, with buyer names (one users query). */
export async function listSellerCommissions(
  client: SupabaseClient,
  sellerId: string,
  limit: number
): Promise<CommissionListItem[]> {
  const { data, error } = await client
    .from('seller_commissions')
    .select(
      'id,seller_id,user_id,payment_id,period_id,period_starts_at,rate_snapshot,scope_snapshot,amount_pkr,status,payout_request_id,created_at'
    )
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    logServerError('[sellers] commission list failed', error, { source: 'sellers' });
    throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
  }
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => asRow(r))
    .filter((r): r is UnknownRow => r !== null);
  const commissions = rows
    .map((r) => commissionFromRow(r))
    .filter((c): c is SellerCommission => c !== null);
  const buyerIds = [...new Set(commissions.map((c) => c.userId))];
  const buyers = new Map<string, { name: string | null; email: string }>();
  if (buyerIds.length > 0) {
    const { data: userRows, error: userError } = await client
      .from('users')
      .select('id,name,email')
      .in('id', buyerIds);
    if (userError) {
      logServerError('[sellers] commission buyer lookup failed', userError, {
        source: 'sellers',
      });
      throw new SellerError('SELLERS_UNAVAILABLE', 'Seller data could not be loaded right now.');
    }
    const userData = (Array.isArray(userRows) ? userRows : [])
      .map((r) => asRow(r))
      .filter((r): r is UnknownRow => r !== null);
    for (const r of userData) {
      const id = stringField(r, 'id');
      if (id) buyers.set(id, { name: stringField(r, 'name'), email: stringField(r, 'email') ?? '' });
    }
  }
  return commissions.map((c) => ({
    ...c,
    buyerName: buyers.get(c.userId)?.name ?? null,
    buyerEmail: buyers.get(c.userId)?.email ?? '',
  }));
}
