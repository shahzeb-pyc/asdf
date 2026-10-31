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

export function getBillingAdminClient(): SupabaseClient | null {
  return getSupabaseAdminClient() as SupabaseClient | null;
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
  };
}

export function paymentRowToItem(value: unknown): BillingPaymentItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const payment = paymentFromRow(value as Record<string, unknown>);
  return payment ? mapPaymentToItem(payment) : null;
}
