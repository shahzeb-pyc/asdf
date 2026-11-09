import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Scheduled-downgrade activation, worker side of option A (PR 120
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
    // Plan-check C3: one cheap EXISTS probe before the full
    // payments select. Nothing due costs a LIMIT 1 existence
    // check instead of a full row select; a due schedule runs the
    // full path exactly as before. A probe failure never breaks
    // the caller: it is logged loudly and the full path runs.
    // (The inner try/catch is load-bearing — the outer one
    // returns false on any throw, which would silently skip an
    // activation the full path could have performed.)
    let hasDue: boolean;
    try {
      const { data: probe, error: probeError } = await supabase
        .from('subscription_payments')
        .select('id')
        .eq('user_id', ownerId)
        .eq('status', 'approved')
        .is('period_id', null)
        .eq('is_downgrade', true)
        .lte('scheduled_starts_at', now.toISOString())
        .limit(1);
      if (probeError) {
        console.error('[worker] due scheduled downgrade probe failed:', probeError);
        hasDue = true;
      } else {
        hasDue = Array.isArray(probe) && probe.length > 0;
      }
    } catch (probeErr) {
      console.error('[worker] due scheduled downgrade probe failed:', probeErr);
      hasDue = true;
    }
    if (!hasDue) return false;
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
 *
 * C4: the check itself is ONE call to the shared Postgres function
 * workspace_has_active_period (migration
 * 20261110000000_workspace_has_active_period) — the same function
 * the three claim RPCs call, so the SQL and TS gates can never
 * diverge again. The workspace's owner is resolved only on the
 * false path, to run the C3 activation backstop below, so the
 * active/admin path costs exactly one RPC call.
 */
export async function workspaceOwnerHasActivePeriod(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date = new Date()
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('workspace_has_active_period', {
      p_workspace_id: workspaceId,
      p_at: now.toISOString(),
    });
    if (error) {
      console.error('[worker] active-period check failed:', error);
      return false;
    }
    if (data === true) return true;
    // No active period: a scheduled downgrade whose start has
    // arrived activates here, on the worker tick — a publishing
    // plan must not wait for the user to open the app. This is
    // C3's backstop, kept by C4; it is also what un-pauses mirrors
    // now that the mirror gate calls this helper. If activation
    // created a period, re-check with the same RPC — never with a
    // periods select.
    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    const ownerId = (workspace as { owner_id?: string } | null)?.owner_id;
    if (workspaceError || !ownerId) return false;
    if (await activateDueScheduledDowngrade(supabase, ownerId, now)) {
      const { data: rechecked, error: recheckError } = await supabase.rpc(
        'workspace_has_active_period',
        { p_workspace_id: workspaceId, p_at: now.toISOString() }
      );
      if (recheckError) {
        console.error('[worker] active-period re-check failed:', recheckError);
        return false;
      }
      return rechecked === true;
    }
    return false;
  } catch {
    return false;
  }
}
