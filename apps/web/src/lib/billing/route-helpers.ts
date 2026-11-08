import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BillingPaymentItem,
  EntitlementResponse,
  PlatformCounts,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paymentFromRow,
  SubscriptionGateError,
  type Entitlement,
  type SubscriptionPaymentRow,
} from './entitlement';
import {
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  storeIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';
import type { IdempotencyAction } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

export function getBillingAdminClient(): SupabaseClient | null {
  // Privilege proof (PR 108) throws in production on a bad key.
  // Map that throw to null here, once, so every billing/admin
  // route that checks for null returns the mapped 503 instead of
  // an unhandled 500 — the gap the billing audit found on most
  // routes, where only the entitlement route mapped it.
  try {
    return getSupabaseAdminClient() as SupabaseClient | null;
  } catch (err) {
    logServerError('[billing] admin client unavailable', err, { source: 'billing' });
    return null;
  }
}

/**
 * Billing-submission idempotency (audit fix 2026-11-01): the same
 * Idempotency-Key contract as publishing, scoped to the tenant
 * workspace + user + submission route. Absent key = old behaviour
 * (no replay possible); invalid key = 400; a stored success replays
 * verbatim with Idempotency-Replayed. Only successes are stored.
 * When the workspace cannot be resolved, idempotency is skipped
 * with a loud log — the one-pending rule still guards duplicates,
 * so a missed scope must not fail the submission itself.
 */
export async function lookupBillingIdempotency(
  client: SupabaseClient,
  workspaceId: string | null,
  userId: string,
  action: IdempotencyAction,
  headers: { get(name: string): string | null }
): Promise<
  | { key: null; replay: null }
  | { key: string; replay: { status: number; body: unknown } | null }
  | { invalid: true }
> {
  const parsed = parseIdempotencyKeyHeader(headers);
  if (parsed.invalid) return { invalid: true };
  if (!parsed.key) return { key: null, replay: null };
  if (!workspaceId) {
    logServerError('[billing] idempotency skipped: workspace unresolved', null, {
      source: 'billing',
      userId,
      action,
    });
    return { key: parsed.key, replay: null };
  }
  const scope: IdempotencyScope = { workspaceId, userId, action, key: parsed.key };
  const replay = await lookupIdempotencyResult(client, scope);
  return { key: parsed.key, replay };
}

export async function storeBillingIdempotency(
  client: SupabaseClient,
  workspaceId: string | null,
  userId: string,
  action: IdempotencyAction,
  key: string | null,
  result: { status: number; body: unknown }
): Promise<void> {
  if (!key || !workspaceId) return;
  const scope: IdempotencyScope = { workspaceId, userId, action, key };
  // Store failures are swallowed + logged inside, like publishing:
  // the request already succeeded, so failing the response would
  // cause the exact duplicate retry this exists to prevent.
  await storeIdempotencyResult(client, scope, result);
}

/**
 * Maps a thrown SubscriptionGateError to its HTTP response, or null for
 * any other error (which the caller rethrows / handles as a 500). Add
 * routes use this so the cap error shape stays uniform: 403 with the
 * machine-readable code, never a silent skip or a bare 500.
 */
export function subscriptionGateResponse(err: unknown): NextResponse | null {
  if (!(err instanceof SubscriptionGateError)) return null;
  const status =
    err.code === 'SUBSCRIPTION_CAP_REACHED' ||
    err.code === 'SUBSCRIPTION_REQUIRED'
      ? 403
      : 500;
  return NextResponse.json(
    { error: err.code, message: err.message },
    { status }
  );
}

export function mapPaymentToItem(payment: SubscriptionPaymentRow): BillingPaymentItem {
  return {
    id: payment.id,
    method: payment.method,
    bankMethod: payment.bankMethod,
    status:
      payment.status === 'approved' ||
      payment.status === 'rejected' ||
      payment.status === 'paid' ||
      payment.status === 'failed' ||
      payment.status === 'expired'
        ? payment.status
        : 'pending',
    counts: payment.counts,
    amountPkr: payment.amountPkr,
    isUpgrade: payment.isUpgrade,
    isDowngrade: payment.isDowngrade,
    scheduledStartsAt: payment.scheduledStartsAt ? payment.scheduledStartsAt.toISOString() : null,
    rejectionReason: payment.rejectionReason,
    rejectionDetail: payment.rejectionDetail,
    overrideReason: payment.overrideReason,
    decidedAt: payment.decidedAt,
    screenshotStorageKey: payment.screenshotStorageKey,
    couponCode: payment.couponCode,
    discountPkr: payment.discountPkr,
    createdAt: payment.createdAt,
    approvedAt: payment.approvedAt,
  };
}

export function mapEntitlementToResponse(entitlement: Entitlement): EntitlementResponse {
  const counts: PlatformCounts = entitlement.counts;
  return {
    plan: entitlement.plan,
    active: entitlement.active,
    counts,
    usage: entitlement.usage,
    periodEndsAt: entitlement.period ? entitlement.period.endsAt.toISOString() : null,
    periodStartsAt: entitlement.period ? entitlement.period.startsAt.toISOString() : null,
    canPost: entitlement.canPost,
    readOnly: entitlement.readOnly,
    reason: entitlement.reason,
    hasPriorPeriod: entitlement.hasPriorPeriod,
  };
}

export function paymentRowToItem(value: unknown): BillingPaymentItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const payment = paymentFromRow(value as Record<string, unknown>);
  return payment ? mapPaymentToItem(payment) : null;
}

export interface NewPaymentFields {
  isDowngrade: boolean;
  scheduledStartsAt: string | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  overrideReason: string | null;
  decidedAt: string | null;
}

/**
 * Load the billing-separate-sections payment fields tolerantly.
 * These columns ship with a migration that is unapplied until the
 * owner applies it: if the select errors (missing column), log
 * loudly and return an empty map so callers fall back to defaults
 * instead of failing the whole payments list.
 */
export async function loadNewPaymentFields(
  client: SupabaseClient,
  ids: string[]
): Promise<Map<string, NewPaymentFields>> {
  const empty = new Map<string, NewPaymentFields>();
  if (ids.length === 0) return empty;
  try {
    const { data, error } = await client
      .from('subscription_payments')
      .select('id,is_downgrade,scheduled_starts_at,rejection_reason,rejection_detail,override_reason,decided_at')
      .in('id', ids);
    if (error || !Array.isArray(data)) {
      logServerError('[billing] new payment fields unavailable (migration may be unapplied)', error ?? null, {
        source: 'billing',
      });
      return empty;
    }
    const map = new Map<string, NewPaymentFields>();
    for (const raw of data) {
      if (raw === null || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = typeof row['id'] === 'string' ? row['id'] : null;
      if (!id) continue;
      map.set(id, {
        isDowngrade: row['is_downgrade'] === true,
        scheduledStartsAt: typeof row['scheduled_starts_at'] === 'string' ? row['scheduled_starts_at'] : null,
        rejectionReason: typeof row['rejection_reason'] === 'string' ? row['rejection_reason'] : null,
        rejectionDetail: typeof row['rejection_detail'] === 'string' ? row['rejection_detail'] : null,
        overrideReason: typeof row['override_reason'] === 'string' ? row['override_reason'] : null,
        decidedAt: typeof row['decided_at'] === 'string' ? row['decided_at'] : null,
      });
    }
    return map;
  } catch (err) {
    logServerError('[billing] new payment fields load failed', err, { source: 'billing' });
    return empty;
  }
}
