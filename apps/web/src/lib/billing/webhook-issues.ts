import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebhookIssueReason } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

/**
 * Admin-visible webhook issues (audit fix 2026-11-01).
 *
 * The NOWPayments webhook never fails on a payment it cannot act on
 * automatically: it records an issue row and answers 200, and the
 * admin clears it by acting on the payment (rescue approve/expire)
 * or dismissing the row. Every function here is best-effort: the
 * issues table arrives with a migration that ships unapplied, so
 * until it is applied every insert/select fails with a missing
 * table — and that must never break the webhook or the admin view.
 * Failures are logged loudly (the visible signal that the
 * migration is still pending) and swallowed.
 */

export interface WebhookIssueRow {
  id: string;
  provider: string;
  providerPaymentId: string;
  paymentId: string | null;
  reason: WebhookIssueReason;
  detail: string | null;
  dismissedAt: string | null;
  createdAt: string;
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

const ISSUE_REASONS: readonly string[] = [
  'unknown_payment',
  'amount_mismatch',
  'currency_mismatch',
  'underpaid',
  'coupon_released_before_finish',
  'refunded',
];

export function webhookIssueFromRow(row: UnknownRow): WebhookIssueRow | null {
  const id = stringField(row, 'id');
  const provider = stringField(row, 'provider');
  const providerPaymentId = stringField(row, 'provider_payment_id');
  const reason = stringField(row, 'reason');
  if (!id || !provider || !providerPaymentId || !reason || !ISSUE_REASONS.includes(reason)) {
    return null;
  }
  return {
    id,
    provider,
    providerPaymentId,
    paymentId: stringField(row, 'payment_id'),
    reason: reason as WebhookIssueReason,
    detail: stringField(row, 'detail'),
    dismissedAt: stringField(row, 'dismissed_at'),
    createdAt: stringField(row, 'created_at') ?? '',
  };
}

/**
 * Record an issue. Idempotent per open issue: a repeat notification
 * for the same provider payment + reason does not pile up rows
 * (the partial unique index enforces it; a 23505 here is a no-op).
 * Returns false when the table is not there yet.
 */
export async function recordWebhookIssue(
  client: SupabaseClient,
  args: {
    providerPaymentId: string;
    paymentId: string | null;
    reason: WebhookIssueReason;
    detail: string | null;
  }
): Promise<boolean> {
  const { error } = await client.from('subscription_webhook_issues').insert({
    provider: 'nowpayments',
    provider_payment_id: args.providerPaymentId,
    payment_id: args.paymentId,
    reason: args.reason,
    detail: args.detail,
  });
  if (error) {
    // 23505 = an open issue for this payment + reason already
    // exists: the repeat is recorded by the existing row.
    if (error.code === '23505') return true;
    logServerError('[billing] webhook issue record unavailable', error, {
      source: 'billing',
    });
    return false;
  }
  return true;
}

/** Open (undismissed) issues, newest first, bounded. Empty when the table is absent. */
export async function listOpenWebhookIssues(
  client: SupabaseClient
): Promise<WebhookIssueRow[]> {
  const { data, error } = await client
    .from('subscription_webhook_issues')
    .select(
      'id,provider,provider_payment_id,payment_id,reason,detail,dismissed_at,created_at'
    )
    .is('dismissed_at', null)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    logServerError('[billing] webhook issues list unavailable', error, {
      source: 'billing',
    });
    return [];
  }
  return (Array.isArray(data) ? data : [])
    .map((row) => webhookIssueFromRow(asRow(row) ?? {}))
    .filter((issue): issue is WebhookIssueRow => issue !== null);
}

export async function dismissWebhookIssue(
  client: SupabaseClient,
  issueId: string
): Promise<boolean> {
  const { data, error } = await client
    .from('subscription_webhook_issues')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', issueId)
    .is('dismissed_at', null)
    .select('id');
  if (error) {
    logServerError('[billing] webhook issue dismiss failed', error, {
      source: 'billing',
    });
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
