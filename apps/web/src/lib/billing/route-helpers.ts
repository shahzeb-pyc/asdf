import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BillingPaymentItem,
  EntitlementResponse,
  PlatformCounts,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paymentFromRow,
  type Entitlement,
  type SubscriptionPaymentRow,
} from './entitlement';

export function getBillingAdminClient(): SupabaseClient | null {
  return getSupabaseAdminClient() as SupabaseClient | null;
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
    hasPriorPeriod: entitlement.hasPriorPeriod,
  };
}

export function paymentRowToItem(value: unknown): BillingPaymentItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const payment = paymentFromRow(value as Record<string, unknown>);
  return payment ? mapPaymentToItem(payment) : null;
}
