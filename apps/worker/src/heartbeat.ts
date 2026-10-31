/**
 * Worker heartbeat persistence (spec 116, extended by spec 121 Scope 7).
 *
 * The scheduled handler upserts one row per tick — including the
 * early-return / skip paths — so the web internal health tier can detect a
 * dead or silently-skipping publishing pipeline. Skip reasons are stable
 * machine codes, never raw error text.
 *
 * Spec 121 adds per-lane counters alongside the spec 116 claimed/settled
 * aggregates:
 *   - `enqueuedFast` / `enqueuedHeavy`: written by the claimer each tick.
 *   - `dlqFast` / `dlqHeavy`: written by the DLQ consumers (counts-only
 *     writes, see `countsOnly` below) when a DLQ batch is processed.
 *   - `settled`: written by the publish consumers (counts-only writes)
 *     for the messages they settled in a batch.
 *
 * A counts-only write touches ONLY the counter columns it carries: the
 * tick-owned fields (`last_run_at`, `last_success_at`, claimed/enqueued)
 * are left exactly as the last claimer tick wrote them, so consumer
 * activity can never mask a dead cron in the health tier. Counter fields
 * left `undefined` are omitted from the upsert entirely (PostgREST
 * upserts update only the columns present in the payload), which is what
 * lets the claimer, the publish consumers, and the DLQ consumers share
 * one row without clobbering each other's counters.
 *
 * The per-lane columns (`last_enqueued_fast`, …) are added by a sibling
 * spec 121 migration. Until it lands, an upsert carrying them fails with
 * a schema error — which this module already swallows (heartbeat writes
 * never throw), exactly like any other heartbeat failure today.
 */

export const WORKER_HEARTBEAT_NAME = 'fbuploadpro-worker';

export type HeartbeatSkipReason =
  | 'missing_token_encryption_key'
  | 'db_unconfigured'
  | 'claim_error'
  /**
   * A sub-tick of the every-minute tick failed (slot claim, mirror-job
   * consumer, or ADU tick). The tick itself still completes — the
   * failed subsystem retries next minute — but the heartbeat must
   * NOT report success: last_success_at stays at the last fully
   * healthy tick, so the health tier degrades honestly instead of
   * reporting a broken pipeline healthy. The failing subsystem is
   * also captured in the structured error log + PostHog.
   */
  | 'slot_claim_tick_failed'
  | 'mirror_job_tick_failed'
  | 'adu_tick_failed';

export interface HeartbeatRecord {
  success: boolean;
  claimed?: number;
  settled?: number;
  /** Items the claimer enqueued to the publish-fast lane this tick. */
  enqueuedFast?: number;
  /** Items the claimer enqueued to the publish-heavy lane this tick. */
  enqueuedHeavy?: number;
  /** publish-fast DLQ messages processed in the DLQ batch being reported. */
  dlqFast?: number;
  /** publish-heavy DLQ messages processed in the DLQ batch being reported. */
  dlqHeavy?: number;
  skipReason?: HeartbeatSkipReason | null;
  now?: Date;
  /**
   * When true, write ONLY the counter columns present on the record —
   * no `last_run_at` / `last_success_at` / skip-reason changes. Used by
   * queue consumers reporting settled / DLQ counts between ticks.
   */
  countsOnly?: boolean;
}

interface HeartbeatDb {
  from?: (table: string) => {
    upsert: (
      row: Record<string, unknown>,
      options: { onConflict: string }
    ) => Promise<{ error: unknown }>;
  };
  query?: (
    text: string,
    params?: unknown[]
  ) => Promise<unknown>;
}

function counterColumns(record: HeartbeatRecord): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (record.claimed !== undefined) columns.last_claimed_count = record.claimed;
  if (record.settled !== undefined) columns.last_settled_count = record.settled;
  if (record.enqueuedFast !== undefined) columns.last_enqueued_fast = record.enqueuedFast;
  if (record.enqueuedHeavy !== undefined) columns.last_enqueued_heavy = record.enqueuedHeavy;
  if (record.dlqFast !== undefined) columns.last_dlq_fast = record.dlqFast;
  if (record.dlqHeavy !== undefined) columns.last_dlq_heavy = record.dlqHeavy;
  return columns;
}

/**
 * Writes the heartbeat row. Never throws: a heartbeat failure must not
 * break the pipeline cycle it is observing. Returns whether it was written.
 */
export async function recordHeartbeat(
  db: HeartbeatDb | null | undefined,
  record: HeartbeatRecord
): Promise<boolean> {
  if (!db) return false;
  const now = (record.now ?? new Date()).toISOString();

  if (record.countsOnly) {
    const row: Record<string, unknown> = {
      worker_name: WORKER_HEARTBEAT_NAME,
      updated_at: now,
      ...counterColumns(record),
    };
    try {
      if (typeof db.from === 'function') {
        const { error } = await db
          .from('worker_heartbeats')
          .upsert(row, { onConflict: 'worker_name' });
        if (error) {
          console.error('[heartbeat] counts-only upsert failed:', error);
          return false;
        }
        return true;
      }
    } catch (err) {
      console.error('[heartbeat] counts-only write failed:', err);
    }
    return false;
  }

  const row: Record<string, unknown> = {
    worker_name: WORKER_HEARTBEAT_NAME,
    last_run_at: now,
    last_skip_reason: record.success ? null : (record.skipReason ?? null),
    updated_at: now,
    ...counterColumns(record),
  };
  if (record.success) {
    row.last_success_at = now;
  }
  // Full tick writes always carry the claimed counter (0 when the
  // caller did not supply it), preserving the spec 116 behaviour.
  // `last_settled_count` is deliberately NOT forced: it is owned by the
  // publish consumers (counts-only writes), so a full tick write that
  // does not supply it must omit the field entirely — forcing 0 here
  // wiped the consumer-settled count on every tick (spec 139).
  if (row.last_claimed_count === undefined) row.last_claimed_count = 0;

  try {
    if (typeof db.from === 'function') {
      const { error } = await db
        .from('worker_heartbeats')
        .upsert(row, { onConflict: 'worker_name' });
      if (error) {
        console.error('[heartbeat] upsert failed:', error);
        return false;
      }
      return true;
    }
    if (typeof db.query === 'function') {
      // `last_settled_count` is omitted when the caller did not supply
      // it (see above): the INSERT leaves it at its default for a new
      // row and the ON CONFLICT update does not touch it, so consumer
      // counts survive claimer ticks. When supplied, it is written.
      if (record.settled !== undefined) {
        await db.query(
          `INSERT INTO worker_heartbeats
             (worker_name, last_run_at, last_success_at, last_claimed_count, last_settled_count, last_skip_reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $2)
           ON CONFLICT (worker_name) DO UPDATE SET
             last_run_at = EXCLUDED.last_run_at,
             last_success_at = COALESCE(EXCLUDED.last_success_at, worker_heartbeats.last_success_at),
             last_claimed_count = EXCLUDED.last_claimed_count,
             last_settled_count = EXCLUDED.last_settled_count,
             last_skip_reason = EXCLUDED.last_skip_reason,
             updated_at = EXCLUDED.updated_at`,
          [
            WORKER_HEARTBEAT_NAME,
            now,
            record.success ? now : null,
            record.claimed ?? 0,
            record.settled,
            record.success ? null : (record.skipReason ?? null),
          ]
        );
      } else {
        await db.query(
          `INSERT INTO worker_heartbeats
             (worker_name, last_run_at, last_success_at, last_claimed_count, last_skip_reason, updated_at)
           VALUES ($1, $2, $3, $4, $5, $2)
           ON CONFLICT (worker_name) DO UPDATE SET
             last_run_at = EXCLUDED.last_run_at,
             last_success_at = COALESCE(EXCLUDED.last_success_at, worker_heartbeats.last_success_at),
             last_claimed_count = EXCLUDED.last_claimed_count,
             last_skip_reason = EXCLUDED.last_skip_reason,
             updated_at = EXCLUDED.updated_at`,
          [
            WORKER_HEARTBEAT_NAME,
            now,
            record.success ? now : null,
            record.claimed ?? 0,
            record.success ? null : (record.skipReason ?? null),
          ]
        );
      }
      return true;
    }
  } catch (err) {
    console.error('[heartbeat] write failed:', err);
  }
  return false;
}

/** True when a raw TOKEN_ENCRYPTION_KEY value is present and well-formed (64 hex chars or 32 bytes). */
export function isTokenEncryptionKeyWellFormed(raw: string | undefined | null): boolean {
  if (!raw || raw.trim().length === 0) return false;
  const trimmed = raw.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) return true;
  return new TextEncoder().encode(trimmed).length === 32;
}
