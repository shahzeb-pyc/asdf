import type { SupabaseClient } from '@supabase/supabase-js';
import { InternalError } from '@fbuploadpro/contracts';
import { activateDueScheduledDowngrade } from './entitlement.js';

/**
 * Plan-check C3 — dedicated scheduled-downgrade activation tick.
 *
 * Before C3, a due schedule only activated when a read or an ADU
 * gate happened to probe for it (web `activateDueScheduledDowngrades`
 * on every plan read, worker `activateDueScheduledDowngrade` from the
 * ADU publish gate). This tick is the mechanism that activates due
 * schedules on its own: one global scan per minute, then the
 * EXISTING worker activation function per owner — no third copy of
 * the activation logic, so the earliest-only guard, the claim-first
 * idempotency, and the commission backfill all come along for free.
 * The read-path probe stays as the backstop: if this tick ever
 * stops, the next read or ADU gate still activates on demand.
 */

export interface DowngradeTickDb {
  from: SupabaseClient['from'];
}

export interface DowngradeTickResult {
  /** Rows the scan returned (before per-owner dedupe). */
  scanned: number;
  /** Distinct owners with at least one due schedule. */
  dueOwners: number;
  /** Owners whose activation created (or confirmed) a period. */
  activated: number;
  /** Owners whose activation returned false. */
  failed: number;
}

/** Hard safety bound on the scan (no unbounded SELECTs, ever). */
export const DOWNGRADE_TICK_SCAN_LIMIT = 100;

export async function runDowngradeActivationTick(options: {
  db: DowngradeTickDb;
  now: Date;
}): Promise<DowngradeTickResult> {
  const { db, now } = options;
  const supabase = db as unknown as SupabaseClient;
  const { data: rows, error: scanError } = await supabase
    .from('subscription_payments')
    .select('user_id, scheduled_starts_at')
    .eq('status', 'approved')
    .is('period_id', null)
    .eq('is_downgrade', true)
    .lte('scheduled_starts_at', now.toISOString())
    .order('scheduled_starts_at', { ascending: true })
    .limit(DOWNGRADE_TICK_SCAN_LIMIT);
  if (scanError) {
    // Tick-level failure, not a per-owner one: it throws to the
    // caller, whose isolation wrapper fails the heartbeat (a tick
    // whose activation scan is broken is not a successful tick),
    // and the next minute retries. This is also what makes an
    // unapplied 20261102160001 loud instead of silent.
    throw new InternalError(
      `Downgrade activation scan failed: ${scanError.code ?? 'unknown'} ${scanError.message ?? ''}`
    );
  }
  const scannedRows = (rows ?? []) as Array<Record<string, unknown>>;
  // Dedupe owner ids in code, preserving earliest-first order:
  // one activation call per owner per tick. A second due schedule
  // for the same owner stays for an admin decision, exactly as
  // the activation function's earliest-only guard does today.
  const owners: string[] = [];
  const seen = new Set<string>();
  for (const row of scannedRows) {
    const userId = row['user_id'];
    if (typeof userId !== 'string' || seen.has(userId)) continue;
    seen.add(userId);
    owners.push(userId);
  }
  let activated = 0;
  let failed = 0;
  for (const ownerId of owners) {
    // Per-owner isolation: activateDueScheduledDowngrade already
    // returns false and logs instead of throwing, so one owner's
    // failure never stops the others. The catch below is
    // belt-and-braces for the same guarantee.
    let ok: boolean;
    try {
      ok = await activateDueScheduledDowngrade(supabase, ownerId, now);
    } catch (err) {
      console.error(`[downgrade-tick] activation failed for user ${ownerId}:`, err);
      ok = false;
    }
    if (ok) activated += 1;
    else failed += 1;
  }
  const result: DowngradeTickResult = {
    scanned: scannedRows.length,
    dueOwners: owners.length,
    activated,
    failed,
  };
  console.info(
    `[downgrade-tick] scanned=${result.scanned} dueOwners=${result.dueOwners} activated=${result.activated} failed=${result.failed}`
  );
  return result;
}
