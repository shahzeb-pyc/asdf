import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Entitlement gate for worker publish paths (audit fix 2026-11-01).
 *
 * At expiry or refund-drop, queued posts PAUSE: they stay queued
 * and are never claimed. On renewal they RESUME claiming at future
 * slots; missed slots stay lost, no flood. The slot-claim RPCs
 * enforce the same rule in SQL (migration
 * 20261101090001_billing_audit_claim_entitlement, unapplied until
 * the owner applies it); ADU and mirror publishing have no RPC
 * claim, so they call this helper directly from worker code.
 *
 * Admin owners are exempt (admins never buy plans). Any lookup
 * failure returns false (fail closed): the job stays queued for a
 * later tick instead of publishing on an unverified entitlement.
 */
export async function workspaceOwnerHasActivePeriod(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    const ownerId = (workspace as { owner_id?: string } | null)?.owner_id;
    if (workspaceError || !ownerId) return false;
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', ownerId)
      .maybeSingle();
    if (userError) return false;
    if ((user as { role?: string } | null)?.role === 'admin') return true;
    // No is/lte/gt here on purpose: the window filter runs in code
    // over the owner's period rows (bounded by a limit), the same
    // shape the mirror consumer's check uses.
    const { data: periods, error: periodError } = await supabase
      .from('subscription_periods')
      .select('starts_at, ends_at, superseded_at')
      .eq('user_id', ownerId)
      .limit(100);
    if (periodError || !Array.isArray(periods)) return false;
    const nowMs = now.getTime();
    return periods.some((row) => {
      const period = row as Record<string, unknown>;
      if (period['superseded_at'] !== null) return false;
      const starts =
        typeof period['starts_at'] === 'string' ? Date.parse(period['starts_at']) : Number.NaN;
      const ends = typeof period['ends_at'] === 'string' ? Date.parse(period['ends_at']) : Number.NaN;
      return !Number.isNaN(starts) && !Number.isNaN(ends) && starts <= nowMs && ends > nowMs;
    });
  } catch {
    return false;
  }
}
