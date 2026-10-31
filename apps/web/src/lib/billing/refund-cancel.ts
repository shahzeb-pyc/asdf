import type { SupabaseClient } from '@supabase/supabase-js';
import { UPGRADE_CANCEL_REFUND_REASON } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

/**
 * Upgrade-cancels-refund (owner-decided, 2026-11-01).
 *
 * When an upgrade activation lands, any PENDING refund request on
 * the period being replaced is cancelled: the upgrade credit
 * already compensates the user for the old plan's unused value, so
 * paying the refund too would double-compensate. Only requests on
 * the given period ids are touched, and only while still
 * 'requested' — an already-approved or already-rejected request is
 * never rewritten, and a request on any other period is left alone.
 *
 * The status CHECK on refund_requests allows only
 * requested/approved/rejected/sent, so a cancellation is recorded
 * as status 'rejected' WITH the exact upgrade reason (never a bare
 * rejection): both refund views recognise that reason and render
 * the row as "Cancelled because you upgraded".
 *
 * Returns how many requests were cancelled. A database failure
 * throws: callers that cannot afford to fail the activation (the
 * period insert) catch, log loudly, and continue — a surviving
 * pending request is visible to the admin, while a failed upgrade
 * would strand the user's money.
 */
export async function cancelPendingRefundsForSupersededPeriods(
  client: SupabaseClient,
  periodIds: string[],
  now: Date = new Date()
): Promise<number> {
  if (periodIds.length === 0) return 0;
  const { data, error } = await client
    .from('refund_requests')
    .update({
      status: 'rejected',
      reason: UPGRADE_CANCEL_REFUND_REASON,
      decided_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .in('period_id', periodIds)
    .eq('status', 'requested')
    .select('id');
  if (error) {
    logServerError('[billing] upgrade refund cancel failed', error, {
      source: 'billing',
    });
    throw error;
  }
  const count = Array.isArray(data) ? data.length : 0;
  if (count > 0) {
    logServerError('[billing] pending refunds cancelled by upgrade', null, {
      source: 'billing',
      cancelledCount: count,
    });
  }
  return count;
}
