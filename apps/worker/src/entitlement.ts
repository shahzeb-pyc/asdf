import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Scheduled-downgrade activation, worker side of option A (PR #120
 * send-back fix B2; the web side is activateDueScheduledDowngrades
 * in apps/web/src/lib/billing/entitlement.ts). The schedule lives
 * on the payment row only (is_downgrade + scheduled_starts_at);
 * approval never inserts a future period row, so the
 * one-live-per-user index can never see a live + scheduled pair.
 *
 * Claim-first and idempotent: the period is created (superseding
 * every non-superseded row, exactly like the web path), then
 * linked conditionally on period_id IS NULL. A loser that finds
 * the payment already linked supersedes its orphan and returns
 * true; a link failure with no winner still returns true, because
 * the period row itself is live by its time window and
 * superseding it would kill the plan just activated — the link
 * is then repaired by the web re-approve path. Commission is
 * recorded at approval with period_id null (the worker cannot
 * import the sellers logic); activation backfills period_id to
 * the real period with a raw update, in both paths. A period
 * created late starts at activation time and runs a full 30 days
 * from there. Returns false on any failure (fail closed: the job
 * stays queued for a later tick) and never throws.
 */
export async function activateDueScheduledDowngrade(
  supabase: SupabaseClient,
  ownerId: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const nowMs = now.getTime();
    const { data: periods, error: periodError } = await supabase
      .from('subscription_periods')
      .select('starts_at, ends_at, superseded_at')
      .eq('user_id', ownerId)
      .limit(100);
    if (periodError || !Array.isArray(periods)) return false;
    const hasActive = periods.some((row) => {
      const period = row as Record<string, unknown>;
      if (period['superseded_at'] !== null) return false;
      const starts =
        typeof period['starts_at'] === 'string' ? Date.parse(period['starts_at']) : Number.NaN;
      const ends = typeof period['ends_at'] === 'string' ? Date.parse(period['ends_at']) : Number.NaN;
      return !Number.isNaN(starts) && !Number.isNaN(ends) && starts <= nowMs && ends > nowMs;
    });
    if (hasActive) return false;
    const { data: payments, error: paymentError } = await supabase
      .from('subscription_payments')
      .select(
        'id,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,scheduled_starts_at,is_downgrade,period_id,status'
      )
      .eq('user_id', ownerId)
      .eq('status', 'approved')
      .is('period_id', null);
    if (paymentError || !Array.isArray(payments)) {
      console.error('[worker] scheduled downgrade activation lookup failed:', paymentError);
      return false;
    }
    const due = payments
      .map((row) => row as Record<string, unknown>)
      .filter((row) => {
        if (row['is_downgrade'] !== true) return false;
        const scheduled =
          typeof row['scheduled_starts_at'] === 'string'
            ? Date.parse(row['scheduled_starts_at'])
            : Number.NaN;
        return !Number.isNaN(scheduled) && scheduled <= nowMs;
      })
      .sort((a, b) => {
        const aMs = Date.parse(a['scheduled_starts_at'] as string);
        const bMs = Date.parse(b['scheduled_starts_at'] as string);
        return aMs - bMs;
      });
    if (due.length === 0) return false;
    if (due.length > 1) {
      console.error(
        `[worker] multiple due scheduled downgrades for user ${ownerId}; activating earliest only`
      );
    }
    const payment = due[0];
    const count = (key: string): number =>
      typeof payment[key] === 'number' ? (payment[key] as number) : 0;
    const { error: supersedeError } = await supabase
      .from('subscription_periods')
      .update({ superseded_at: now.toISOString() })
      .eq('user_id', ownerId)
      .is('superseded_at', null);
    if (supersedeError) {
      console.error('[worker] scheduled downgrade supersede failed:', supersedeError);
      return false;
    }
    const endsAt = new Date(now.getTime() + 30 * 86_400_000);
    const { data: inserted, error: insertError } = await supabase
      .from('subscription_periods')
      .insert({
        user_id: ownerId,
        payment_id: payment['id'],
        facebook_count: count('facebook_count'),
        instagram_count: count('instagram_count'),
        threads_count: count('threads_count'),
        x_count: count('x_count'),
        tiktok_count: count('tiktok_count'),
        youtube_count: count('youtube_count'),
        starts_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
      })
      .select('id')
      .single();
    if (insertError || !inserted) {
      console.error('[worker] scheduled downgrade period insert failed:', insertError);
      return false;
    }
    const periodId = (inserted as Record<string, unknown>)['id'];
    if (typeof periodId !== 'string') {
      console.error('[worker] scheduled downgrade period insert returned no id');
      return false;
    }
    const { data: linked, error: linkError } = await supabase
      .from('subscription_payments')
      .update({ period_id: periodId, updated_at: now.toISOString() })
      .eq('id', payment['id'])
      .is('period_id', null)
      .select('id');
    if (linkError || !Array.isArray(linked) || linked.length === 0) {
      if (linkError) {
        console.error('[worker] scheduled downgrade link failed; period is live anyway:', linkError);
      }
      const { data: reloaded } = await supabase
        .from('subscription_payments')
        .select('period_id')
        .eq('id', payment['id'])
        .maybeSingle();
      const winnerId = (reloaded as Record<string, unknown> | null)?.['period_id'];
      if (typeof winnerId === 'string' && winnerId !== periodId) {
        await supabase
          .from('subscription_periods')
          .update({ superseded_at: now.toISOString() })
          .eq('id', periodId)
          .is('superseded_at', null);
        await supabase
          .from('seller_commissions')
          .update({ period_id: winnerId })
          .eq('payment_id', payment['id'])
          .is('period_id', null);
        return true;
      }
    }
    const { error: backfillError } = await supabase
      .from('seller_commissions')
      .update({ period_id: periodId })
      .eq('payment_id', payment['id'])
      .is('period_id', null);
    if (backfillError) {
      console.error('[worker] scheduled downgrade commission backfill failed:', backfillError);
    }
    return true;
  } catch (err) {
    console.error('[worker] scheduled downgrade activation failed:', err);
    return false;
  }
}

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
    const hasActive = periods.some((row) => {
      const period = row as Record<string, unknown>;
      if (period['superseded_at'] !== null) return false;
      const starts =
        typeof period['starts_at'] === 'string' ? Date.parse(period['starts_at']) : Number.NaN;
      const ends = typeof period['ends_at'] === 'string' ? Date.parse(period['ends_at']) : Number.NaN;
      return !Number.isNaN(starts) && !Number.isNaN(ends) && starts <= nowMs && ends > nowMs;
    });
    if (hasActive) return true;
    // No active period: a scheduled downgrade whose start has
    // arrived activates here, on the worker tick — a publishing
    // plan must not wait for the user to open the app. If
    // activation created a period, re-check it the same way.
    if (await activateDueScheduledDowngrade(supabase, ownerId, now)) {
      const { data: rechecked, error: recheckError } = await supabase
        .from('subscription_periods')
        .select('starts_at, ends_at, superseded_at')
        .eq('user_id', ownerId)
        .limit(100);
      if (recheckError || !Array.isArray(rechecked)) return false;
      return rechecked.some((row) => {
        const period = row as Record<string, unknown>;
        if (period['superseded_at'] !== null) return false;
        const starts =
          typeof period['starts_at'] === 'string' ? Date.parse(period['starts_at']) : Number.NaN;
        const ends = typeof period['ends_at'] === 'string' ? Date.parse(period['ends_at']) : Number.NaN;
        return !Number.isNaN(starts) && !Number.isNaN(ends) && starts <= nowMs && ends > nowMs;
      });
    }
    return false;
  } catch {
    return false;
  }
}
