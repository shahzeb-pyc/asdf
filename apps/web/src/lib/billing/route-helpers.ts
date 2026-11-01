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
  return getSupabaseAdminClient() as SupabaseClient | null;
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
    screenshotStorageKey: payment.screenshotStorageKey,
    nowpaymentsPaymentId: payment.nowpaymentsPaymentId,
    nowpaymentsPayAddress: payment.nowpaymentsPayAddress,
    nowpaymentsPayAmount: payment.nowpaymentsPayAmount,
    nowpaymentsNetwork: payment.nowpaymentsNetwork,
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
