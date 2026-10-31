import type { SupabaseClient } from '@supabase/supabase-js';
import {
  balanceDiscountPkr,
  normalizeCouponCode,
  percentDiscountPkr,
  type Coupon,
  type CouponKind,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

/**
 * Coupons, server-side only.
 *
 * The money rules live here, not in the routes:
 * - Percent discounts round to the nearest PKR; balance discounts
 *   are capped at the remaining balance.
 * - A coupon is only ever claimed, applied, or released through
 *   single-statement conditional updates below. There is no
 *   read-then-write on balances anywhere: a balance decrement only
 *   lands when the row still holds at least that much, and a
 *   balance restore only lands when the row still holds exactly
 *   the value it was read at (optimistic retry). Two concurrent
 *   applications can therefore never overdraw a shared pool.
 * - Hold → apply → release lifecycle: a redemption is HELD at
 *   submission, APPLIED when the money finalises (admin approval,
 *   crypto finished, zero-due activation), and RELEASED when it
 *   does not (admin rejection, crypto failed/expired). A release
 *   is exactly-once: the held→released flip gates it, and the
 *   claim undo is guarded (percent consumption is only nulled
 *   when no other live redemption holds the coupon; a balance
 *   restore records itself via balance_restored) so a retry after
 *   a failed release recovers instead of double-restoring or
 *   undoing someone else's later claim.
 */

export class CouponError extends Error {
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

function numberField(row: UnknownRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? value : null;
}

function boolField(row: UnknownRow, key: string): boolean {
  return row[key] === true;
}

export interface CouponRow {
  id: string;
  code: string;
  kind: CouponKind;
  percent: number | null;
  initialBalancePkr: number | null;
  remainingBalancePkr: number | null;
  consumedAt: string | null;
  status: 'active' | 'paused' | 'deleted';
  createdBy: string | null;
  createdAt: string;
}

export function couponFromRow(row: UnknownRow): CouponRow | null {
  const id = stringField(row, 'id');
  const code = stringField(row, 'code');
  const kind = stringField(row, 'kind');
  if (!id || !code) return null;
  if (kind !== 'percent_once' && kind !== 'percent_multi' && kind !== 'balance') return null;
  const status = stringField(row, 'status');
  return {
    id,
    code,
    kind,
    percent: numberField(row, 'percent'),
    initialBalancePkr: numberField(row, 'initial_balance_pkr'),
    remainingBalancePkr: numberField(row, 'remaining_balance_pkr'),
    consumedAt: stringField(row, 'consumed_at'),
    status: status === 'paused' || status === 'deleted' ? status : 'active',
    createdBy: stringField(row, 'created_by'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

export interface CouponRedemptionRow {
  id: string;
  couponId: string;
  couponKind: CouponKind;
  userId: string;
  paymentId: string | null;
  periodId: string | null;
  amountPkr: number;
  status: 'held' | 'applied' | 'released';
  balanceRestored: boolean;
  createdAt: string;
}

export function redemptionFromRow(row: UnknownRow): CouponRedemptionRow | null {
  const id = stringField(row, 'id');
  const couponId = stringField(row, 'coupon_id');
  const userId = stringField(row, 'user_id');
  const kind = stringField(row, 'coupon_kind');
  if (!id || !couponId || !userId) return null;
  if (kind !== 'percent_once' && kind !== 'percent_multi' && kind !== 'balance') return null;
  const status = stringField(row, 'status');
  const amount = numberField(row, 'amount_pkr');
  return {
    id,
    couponId,
    couponKind: kind,
    userId,
    paymentId: stringField(row, 'payment_id'),
    periodId: stringField(row, 'period_id'),
    amountPkr: amount ?? 0,
    status: status === 'applied' || status === 'released' ? status : 'held',
    balanceRestored: boolField(row, 'balance_restored'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

const COUPON_COLUMNS =
  'id,code,kind,percent,initial_balance_pkr,remaining_balance_pkr,consumed_at,status,created_by,created_at,updated_at';

const REDEMPTION_COLUMNS =
  'id,coupon_id,coupon_kind,user_id,payment_id,period_id,amount_pkr,status,balance_restored,created_at,updated_at';

function nowIso(): string {
  return new Date().toISOString();
}

export async function loadCouponByCode(
  client: SupabaseClient,
  rawCode: string
): Promise<CouponRow | null> {
  const code = normalizeCouponCode(rawCode);
  if (!code) return null;
  const { data, error } = await client
    .from('coupons')
    .select(COUPON_COLUMNS)
    .eq('code', code)
    .maybeSingle();
  if (error) {
    logServerError('[billing] coupon lookup failed', error, { source: 'billing' });
    throw new CouponError('COUPON_UNAVAILABLE', 'The coupon could not be checked right now. Please try again.');
  }
  return data ? couponFromRow(asRow(data) ?? {}) : null;
}

/**
 * Discount for a coupon against an amount due, without touching the
 * database. Throws CouponError with a plain message for every
 * unusable state. A deleted coupon reports as not found, so admin
 * actions are not leaked through the user-facing path.
 */
export function computeDiscount(coupon: CouponRow, amountDuePkr: number): number {
  if (coupon.status === 'deleted') {
    throw new CouponError('COUPON_NOT_FOUND', 'That coupon code was not found.');
  }
  if (coupon.status === 'paused') {
    throw new CouponError('COUPON_PAUSED', 'This coupon is paused right now and cannot be used.');
  }
  if (amountDuePkr <= 0) {
    throw new CouponError(
      'COUPON_NO_DISCOUNT',
      'This purchase has nothing left to pay, so a coupon cannot be applied.'
    );
  }
  let discount = 0;
  if (coupon.kind === 'percent_once') {
    if (coupon.consumedAt !== null) {
      throw new CouponError('COUPON_USED', 'This coupon has already been used.');
    }
    discount = percentDiscountPkr(amountDuePkr, coupon.percent ?? 0);
  } else if (coupon.kind === 'percent_multi') {
    discount = percentDiscountPkr(amountDuePkr, coupon.percent ?? 0);
  } else {
    const remaining = coupon.remainingBalancePkr ?? 0;
    if (remaining <= 0) {
      throw new CouponError('COUPON_EXHAUSTED', 'This coupon has no balance left.');
    }
    discount = balanceDiscountPkr(amountDuePkr, remaining);
  }
  if (discount <= 0) {
    throw new CouponError(
      'COUPON_NO_DISCOUNT',
      'This coupon gives no discount on this purchase.'
    );
  }
  return discount;
}

/** Validate a coupon for preview only: no writes, no holds. */
export async function previewCoupon(
  client: SupabaseClient,
  rawCode: string,
  amountDuePkr: number
): Promise<{ coupon: CouponRow; discountPkr: number }> {
  const coupon = await loadCouponByCode(client, rawCode);
  if (!coupon) {
    throw new CouponError('COUPON_NOT_FOUND', 'That coupon code was not found.');
  }
  return { coupon, discountPkr: computeDiscount(coupon, amountDuePkr) };
}

async function claimCoupon(
  client: SupabaseClient,
  coupon: CouponRow,
  discountPkr: number
): Promise<{ claimed: boolean; discountPkr: number }> {
  const now = nowIso();
  if (coupon.kind === 'balance') {
    // First attempt with the computed discount; the guard makes a
    // concurrent draw fail closed instead of overdrawing.
    let attemptDiscount = discountPkr;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = coupon.remainingBalancePkr ?? 0;
      const { data, error } = await client
        .from('coupons')
        .update({
          remaining_balance_pkr: remaining - attemptDiscount,
          updated_at: now,
        })
        .eq('id', coupon.id)
        .eq('status', 'active')
        .gte('remaining_balance_pkr', attemptDiscount)
        .select('id');
      if (error) {
        logServerError('[billing] coupon claim failed', error, { source: 'billing' });
        throw new CouponError(
          'COUPON_UNAVAILABLE',
          'The coupon could not be applied right now. Please try again.'
        );
      }
      if (Array.isArray(data) && data.length > 0) {
        coupon.remainingBalancePkr = remaining - attemptDiscount;
        return { claimed: true, discountPkr: attemptDiscount };
      }
      // Lost the race (or paused/deleted concurrently): reload once
      // and, if balance remains but is smaller than the discount,
      // retry with the smaller capped discount. Anything else is a
      // plain terminal error, never a silent partial claim.
      const fresh = await loadCouponByCode(client, coupon.code);
      if (!fresh || fresh.status === 'deleted') {
        throw new CouponError('COUPON_NOT_FOUND', 'That coupon code was not found.');
      }
      if (fresh.status === 'paused') {
        throw new CouponError('COUPON_PAUSED', 'This coupon is paused right now and cannot be used.');
      }
      const freshRemaining = fresh.remainingBalancePkr ?? 0;
      if (freshRemaining <= 0) {
        throw new CouponError('COUPON_EXHAUSTED', 'This coupon has no balance left.');
      }
      coupon.remainingBalancePkr = freshRemaining;
      attemptDiscount = Math.min(freshRemaining, discountPkr);
    }
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon changed just now. Please try applying it again.'
    );
  }
  if (coupon.kind === 'percent_once') {
    const { data, error } = await client
      .from('coupons')
      .update({ consumed_at: now, updated_at: now })
      .eq('id', coupon.id)
      .eq('status', 'active')
      .is('consumed_at', null)
      .select('id');
    if (error) {
      logServerError('[billing] coupon claim failed', error, { source: 'billing' });
      throw new CouponError(
        'COUPON_UNAVAILABLE',
        'The coupon could not be applied right now. Please try again.'
      );
    }
    if (!Array.isArray(data) || data.length === 0) {
      const fresh = await loadCouponByCode(client, coupon.code);
      if (!fresh || fresh.status === 'deleted') {
        throw new CouponError('COUPON_NOT_FOUND', 'That coupon code was not found.');
      }
      if (fresh.status === 'paused') {
        throw new CouponError('COUPON_PAUSED', 'This coupon is paused right now and cannot be used.');
      }
      throw new CouponError('COUPON_USED', 'This coupon has already been used.');
    }
    coupon.consumedAt = now;
    return { claimed: true, discountPkr };
  }
  // percent_multi: no consumption to claim — only prove the coupon
  // is still active at claim time, so a pause landing between the
  // preview and the submit cannot slip one more redemption through.
  const { data, error } = await client
    .from('coupons')
    .update({ updated_at: now })
    .eq('id', coupon.id)
    .eq('status', 'active')
    .select('id');
  if (error) {
    logServerError('[billing] coupon claim failed', error, { source: 'billing' });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be applied right now. Please try again.'
    );
  }
  if (!Array.isArray(data) || data.length === 0) {
    const fresh = await loadCouponByCode(client, coupon.code);
    if (!fresh || fresh.status === 'deleted') {
      throw new CouponError('COUPON_NOT_FOUND', 'That coupon code was not found.');
    }
    throw new CouponError('COUPON_PAUSED', 'This coupon is paused right now and cannot be used.');
  }
  return { claimed: true, discountPkr };
}

/**
 * Hold a coupon: claim it, then record a HELD redemption. If the
 * redemption insert fails after a successful claim, the claim is
 * compensated (balance restored / consumption undone) so money is
 * never lost to a half-finished hold.
 */
export async function holdCoupon(
  client: SupabaseClient,
  args: {
    coupon: CouponRow;
    userId: string;
    paymentId: string | null;
    discountPkr: number;
  }
): Promise<CouponRedemptionRow> {
  const { coupon, userId, paymentId, discountPkr } = args;
  const { discountPkr: finalDiscount } = await claimCoupon(client, coupon, discountPkr);
  const { data, error } = await client
    .from('coupon_redemptions')
    .insert({
      coupon_id: coupon.id,
      coupon_kind: coupon.kind,
      user_id: userId,
      payment_id: paymentId,
      period_id: null,
      amount_pkr: finalDiscount,
      status: 'held',
      balance_restored: false,
    })
    .select(REDEMPTION_COLUMNS)
    .single();
  if (error || !data) {
    // Compensate the claim: the redemption never landed, so the
    // coupon must be exactly as it was before the hold.
    try {
      await compensateClaim(client, coupon, finalDiscount);
    } catch (compError) {
      logServerError('[billing] coupon hold compensation failed', compError, {
        source: 'billing',
        couponId: coupon.id,
      });
    }
    logServerError('[billing] coupon redemption insert failed', error, { source: 'billing' });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be applied right now. Please try again.'
    );
  }
  const redemption = redemptionFromRow(asRow(data) ?? {});
  if (!redemption) {
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be applied right now. Please try again.'
    );
  }
  return redemption;
}

async function compensateClaim(
  client: SupabaseClient,
  coupon: CouponRow,
  discountPkr: number
): Promise<void> {
  const now = nowIso();
  if (coupon.kind === 'balance') {
    // Add the discount back, guarded by the value just read, so a
    // concurrent draw cannot be undone. Retried on contention.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const fresh = await loadCouponByCode(client, coupon.code);
      if (!fresh) return;
      const current = fresh.remainingBalancePkr ?? 0;
      const { data, error } = await client
        .from('coupons')
        .update({ remaining_balance_pkr: current + discountPkr, updated_at: now })
        .eq('id', coupon.id)
        .eq('remaining_balance_pkr', current)
        .select('id');
      if (error) throw error;
      if (Array.isArray(data) && data.length > 0) return;
    }
    throw new Error('Coupon balance compensation did not land');
  }
  if (coupon.kind === 'percent_once') {
    // Guard on the timestamp this claim actually wrote (claimCoupon
    // records it on coupon.consumedAt), not on this function's fresh
    // `now`: the two timestamps are never equal, so guarding on the
    // fresh one silently never undid the consumption and a failed
    // hold permanently burned a one-time coupon.
    await client
      .from('coupons')
      .update({ consumed_at: null, updated_at: now })
      .eq('id', coupon.id)
      .is('consumed_at', coupon.consumedAt);
  }
}

/** Apply one redemption: held → applied. Idempotent (already-applied is a no-op). */
export async function applyRedemption(
  client: SupabaseClient,
  redemptionId: string,
  periodId: string | null = null
): Promise<boolean> {
  const patch: Record<string, unknown> = { status: 'applied', updated_at: nowIso() };
  if (periodId) patch['period_id'] = periodId;
  const { data, error } = await client
    .from('coupon_redemptions')
    .update(patch)
    .eq('id', redemptionId)
    .eq('status', 'held')
    .select('id');
  if (error) {
    logServerError('[billing] coupon redemption apply failed', error, { source: 'billing' });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be applied right now. Please try again.'
    );
  }
  return Array.isArray(data) && data.length > 0;
}

/** Apply every HELD redemption for a payment (approve / webhook idempotent paths). */
export async function applyHeldRedemptionsForPayment(
  client: SupabaseClient,
  paymentId: string
): Promise<void> {
  const { data, error } = await client
    .from('coupon_redemptions')
    .select(REDEMPTION_COLUMNS)
    .eq('payment_id', paymentId)
    .eq('status', 'held');
  if (error) {
    logServerError('[billing] coupon held redemptions lookup failed', error, {
      source: 'billing',
    });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be applied right now. Please try again.'
    );
  }
  for (const row of Array.isArray(data) ? data : []) {
    const redemption = redemptionFromRow(asRow(row) ?? {});
    if (redemption) await applyRedemption(client, redemption.id);
  }
}

/**
 * Release one redemption: held → released, exactly once, then undo
 * the claim. The flip comes FIRST and gates everything: only the
 * redemption that wins the flip may undo a claim, so a retry can
 * never undo someone else's later claim. For percent_once, the
 * consumption is only nulled when no other live (held/applied)
 * redemption holds the coupon — a later legitimate claim therefore
 * survives any retry. Balance restores are optimistic-retry with a
 * balance_restored marker, so a retry after a failed restore
 * recovers instead of double-restoring.
 */
export async function releaseRedemption(
  client: SupabaseClient,
  redemption: CouponRedemptionRow
): Promise<boolean> {
  const now = nowIso();
  const { data, error } = await client
    .from('coupon_redemptions')
    .update({ status: 'released', updated_at: now })
    .eq('id', redemption.id)
    .eq('status', 'held')
    .select('id');
  if (error) {
    logServerError('[billing] coupon redemption release failed', error, { source: 'billing' });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be released right now. Please try again.'
    );
  }
  if (!Array.isArray(data) || data.length === 0) {
    return false;
  }
  if (redemption.couponKind === 'percent_once') {
    await undoPercentOnceConsumption(client, redemption.couponId);
  } else if (redemption.couponKind === 'balance') {
    await restoreBalance(client, redemption);
  }
  return true;
}

/** Null a percent_once coupon's consumption, but only when no live
 *  redemption holds it now — otherwise a later legitimate claim
 *  would be undone. Safe to call on retries. */
async function undoPercentOnceConsumption(
  client: SupabaseClient,
  couponId: string
): Promise<void> {
  const { data, error } = await client
    .from('coupon_redemptions')
    .select('id')
    .eq('coupon_id', couponId)
    .in('status', ['held', 'applied'])
    .limit(1);
  if (error) {
    logServerError('[billing] coupon live redemption check failed', error, {
      source: 'billing',
    });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be released right now. Please try again.'
    );
  }
  if (Array.isArray(data) && data.length > 0) return;
  await client
    .from('coupons')
    .update({ consumed_at: null, updated_at: nowIso() })
    .eq('id', couponId)
    .select('id');
}

async function restoreBalance(
  client: SupabaseClient,
  redemption: CouponRedemptionRow
): Promise<void> {
  const now = nowIso();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Re-check the marker first: a concurrent release may already
    // have restored, in which case there is nothing left to do.
    const { data: markerData } = await client
      .from('coupon_redemptions')
      .select('balance_restored')
      .eq('id', redemption.id)
      .maybeSingle();
    const markerRow = asRow(markerData);
    if (markerRow && boolField(markerRow, 'balance_restored')) return;
    const { data: couponData } = await client
      .from('coupons')
      .select('remaining_balance_pkr')
      .eq('id', redemption.couponId)
      .maybeSingle();
    const couponRow = asRow(couponData);
    const current = couponRow ? (numberField(couponRow, 'remaining_balance_pkr') ?? 0) : 0;
    const { data, error } = await client
      .from('coupons')
      .update({ remaining_balance_pkr: current + redemption.amountPkr, updated_at: now })
      .eq('id', redemption.couponId)
      .eq('remaining_balance_pkr', current)
      .select('id');
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) {
      await client
        .from('coupon_redemptions')
        .update({ balance_restored: true, updated_at: now })
        .eq('id', redemption.id)
        .select('id');
      return;
    }
  }
  logServerError('[billing] coupon balance restore did not land', null, {
    source: 'billing',
    couponId: redemption.couponId,
    redemptionId: redemption.id,
  });
  throw new CouponError(
    'COUPON_UNAVAILABLE',
    'The coupon could not be released right now. Please try again.'
  );
}

/** Release every HELD redemption for a payment, plus recover any
 *  balance restore left unfinished by an earlier failed release,
 *  and any percent_once consumption left behind by one. */
export async function releaseHeldRedemptionsForPayment(
  client: SupabaseClient,
  paymentId: string
): Promise<void> {
  const { data, error } = await client
    .from('coupon_redemptions')
    .select(REDEMPTION_COLUMNS)
    .eq('payment_id', paymentId)
    .in('status', ['held', 'released']);
  if (error) {
    logServerError('[billing] coupon redemptions lookup failed', error, { source: 'billing' });
    throw new CouponError(
      'COUPON_UNAVAILABLE',
      'The coupon could not be released right now. Please try again.'
    );
  }
  for (const row of Array.isArray(data) ? data : []) {
    const redemption = redemptionFromRow(asRow(row) ?? {});
    if (!redemption) continue;
    if (redemption.status === 'held') {
      await releaseRedemption(client, redemption);
    } else if (redemption.couponKind === 'balance') {
      // Recovery: a previous release flipped this row but its
      // restore did not land. Only restore when the marker says
      // it has not happened yet.
      if (!redemption.balanceRestored && redemption.amountPkr > 0) {
        await restoreBalance(client, redemption);
      }
    } else if (redemption.couponKind === 'percent_once') {
      // Recovery: a previous release flipped this row but its
      // consumption was never undone. The guarded check inside
      // keeps a later legitimate claim safe.
      await undoPercentOnceConsumption(client, redemption.couponId);
    }
  }
}

export function couponToItem(
  row: CouponRow,
  redemptionsCount: number
): Coupon {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    percent: row.percent,
    initialBalancePkr: row.initialBalancePkr,
    remainingBalancePkr: row.remainingBalancePkr,
    consumedAt: row.consumedAt,
    status: row.status,
    redemptionsCount,
    createdAt: row.createdAt,
  };
}
