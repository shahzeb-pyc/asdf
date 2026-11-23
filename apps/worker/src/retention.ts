import { InternalError } from '@fbuploadpro/contracts';
import { captureWorkerError, type PostHogEnv } from './analytics.js';

// ==========================================
// Retention cleanup job (spec 139 residue — CTO ceiling #3)
// ==========================================
//
// Shahzeb ruled 2026-10-24: publish history is retained 30 DAYS.
// `publish_logs` and `queue_items` are the two unbounded-growth tables
// of the publishing engine; without this job they are the first
// storage wall at certified volume.
//
// A SEPARATE scheduled job (cron `0 2 * * *` — daily 02:00 UTC, see
// wrangler.toml) that calls the cleanup RPC
// `cleanup_expired_publish_history` (migration
// 20261024120000_retention_cleanup.sql) in a bounded loop:
//
//   - The RPC deletes ONE batch round per call (up to
//     RETENTION_BATCH_SIZE rows per table per call), so every call is
//     its own short transaction — row locks are released between
//     batches and no single statement can lock or flood the tables.
//   - This loop keeps calling until a round comes back short for BOTH
//     tables (nothing expired remains) or RETENTION_MAX_BATCHES_PER_RUN
//     rounds have run — a run is always bounded; a backlog larger than
//     one run's cap simply continues on the next daily run. The RPC's
//     predicates only ever match expired rows, so the job is
//     IDEMPOTENT: re-running after a partial or interrupted run is a
//     no-op beyond the remaining expired rows.
//
// What is deleted (the terminal-only guarantee lives in the RPC and is
// proven by the SQL rig in tests/retention-rpc):
//   - publish_logs rows older than the cutoff whose parent queue item
//     is TERMINAL (published / failed / cancelled). Logs of live items
//     (queued / publishing) are never touched at any age.
//   - queue_items rows in a terminal state whose `updated_at` — the
//     terminal timestamp; a settled row is never written again — is
//     older than the cutoff. Their remaining logs cascade-delete.
//   Live work can never match: both predicates whitelist terminal
//   statuses instead of blacklisting live ones.
//
// Kill-switch / dry-run (worker env, read per run):
//   - RETENTION_DISABLED = 'true' (or '1') skips the run entirely.
//     The job is ENABLED BY DEFAULT: the retention policy is ruled, and
//     a default-off flag would silently recreate the unbounded-growth
//     problem this job exists to close. The flag exists so an operator
//     can stop deletion immediately without a deploy.
//   - RETENTION_DRY_RUN = 'true' (or '1') makes one count-only RPC
//     call: the run logs the full counts a real run would delete and
//     removes nothing — the first-run / incident verification mode.
//
// Observability: every run logs ONE structured counter line (counts
// only — never row contents, ids, or captions). An RPC failure is
// captured to PostHog and rethrown so the cron invocation reports the
// failure; the next daily run retries whatever remains.

/** Cron expression for the retention cleanup job (wrangler.toml triggers). */
export const RETENTION_CRON = '0 2 * * *';

/** Retention window in days (Shahzeb's 2026-10-24 ruling). */
export const RETENTION_DAYS = 30;

/** Rows deleted per table per RPC call (one batch round). */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * Per-run work bound: a run executes at most this many batch rounds
 * (so at most RETENTION_BATCH_SIZE × this many rows per table). A
 * larger backlog drains across subsequent daily runs.
 */
export const RETENTION_MAX_BATCHES_PER_RUN = 500;

/** Optional bound overrides (tests use these to exercise the loop cheaply). */
export interface RetentionRunOptions {
  batchSize?: number;
  maxBatchesPerRun?: number;
}

export interface RetentionEnv extends PostHogEnv {
  /** Kill-switch: 'true'/'1' skips the run. Unset = job enabled. */
  RETENTION_DISABLED?: string;
  /** Dry-run: 'true'/'1' counts what would be deleted, deletes nothing. */
  RETENTION_DRY_RUN?: string;
}

/** One RPC result from the cleanup job's Supabase-shaped client. */
export interface RetentionRpcResult {
  data: unknown;
  error: unknown;
}

/** Minimal delete-chain shape the insights-run prune uses. */
export interface RetentionDeleteQuery {
  in(column: string, values: unknown[]): RetentionDeleteQuery;
  lt(column: string, value: unknown): RetentionDeleteQuery;
  select(
    columns?: string,
    options?: { count?: string; head?: boolean }
  ): PromiseLike<{ data: unknown; error: unknown; count: number | null }>;
}

/** The slice of the Supabase client the retention job uses. */
export interface RetentionDbClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RetentionRpcResult>;
  from(table: string): { delete(): RetentionDeleteQuery };
}

/** Structured per-run counters (logged on every run). */
export interface RetentionRunResult {
  /** True when the kill-switch skipped the run (no RPC call made). */
  skipped: boolean;
  /** True when the run only counted (RETENTION_DRY_RUN). */
  dryRun: boolean;
  /** Batch rounds executed (dry-run always reports 1 count call). */
  batches: number;
  /** publish_logs rows deleted (or counted, in dry-run). */
  publishLogsDeleted: number;
  /** queue_items rows deleted (or counted, in dry-run). */
  queueItemsDeleted: number;
  /** Finished/failed/stale insights runs older than the cutoff deleted. */
  insightsRunsDeleted: number;
  /** True when the run stopped at the per-run batch cap with a full batch still coming back. */
  capReached: boolean;
  /** The retention cutoff applied by this run (ISO timestamp). */
  cutoff: string;
}

function flagEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function saneBound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function dbError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface CleanupCounts {
  publishLogsDeleted: number;
  queueItemsDeleted: number;
}

/**
 * Calls the cleanup RPC once and validates the returned counts at the
 * boundary: the RPC returns exactly one row of two non-negative
 * counts; anything else is a plumbing failure, thrown loudly (never
 * silently read as zero — a misread here would hide a broken cleanup).
 */
async function callCleanupRpc(
  db: RetentionDbClient,
  args: Record<string, unknown>
): Promise<CleanupCounts> {
  const { data, error } = await db.rpc('cleanup_expired_publish_history', args);
  if (error) throw dbError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new InternalError('cleanup_expired_publish_history returned no result row');
  }
  const logs = (row as { publish_logs_deleted?: unknown }).publish_logs_deleted;
  const items = (row as { queue_items_deleted?: unknown }).queue_items_deleted;
  if (
    typeof logs !== 'number' ||
    typeof items !== 'number' ||
    !Number.isFinite(logs) ||
    !Number.isFinite(items) ||
    logs < 0 ||
    items < 0
  ) {
    throw new InternalError('cleanup_expired_publish_history returned malformed counts');
  }
  return { publishLogsDeleted: logs, queueItemsDeleted: items };
}

/**
 * Deletes terminal insights runs (finished / failed / stale) older
 * than the cutoff — one DELETE, no batching: one row per run, and a
 * day's runs are a handful. Live runs are never touched (not in the
 * status list), and a terminal row always carries finished_at, so the
 * cutoff predicate can only match rows the cycle has already closed.
 * The count comes back from the delete itself (count: exact, head),
 * never from a second read — a misread here would hide a broken
 * prune. Idempotent: re-running deletes nothing already gone.
 */
async function pruneOldInsightsRuns(
  db: RetentionDbClient,
  cutoff: string
): Promise<number> {
  const { error, count } = await db
    .from('insights_runs')
    .delete()
    .in('status', ['finished', 'failed', 'stale'])
    .lt('finished_at', cutoff)
    .select('id', { count: 'exact', head: true });
  if (error) throw dbError(error);
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new InternalError('insights runs prune returned no usable count');
  }
  return count;
}

/**
 * Runs one retention cleanup cycle: see the file header for the batch
 * loop, the terminal-only guarantee, and the env flags.
 */
export async function runRetentionCleanup(
  db: RetentionDbClient,
  env: RetentionEnv,
  now: Date = new Date(),
  options: RetentionRunOptions = {}
): Promise<RetentionRunResult> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  if (flagEnabled(env.RETENTION_DISABLED)) {
    console.warn('[retention] run skipped: RETENTION_DISABLED is set');
    return {
      skipped: true,
      dryRun: false,
      batches: 0,
      publishLogsDeleted: 0,
      queueItemsDeleted: 0,
      insightsRunsDeleted: 0,
      capReached: false,
      cutoff,
    };
  }

  const batchSize = saneBound(options.batchSize, RETENTION_BATCH_SIZE);
  const maxBatches = saneBound(options.maxBatchesPerRun, RETENTION_MAX_BATCHES_PER_RUN);
  const dryRun = flagEnabled(env.RETENTION_DRY_RUN);

  try {
    if (dryRun) {
      const counts = await callCleanupRpc(db, {
        p_cutoff: cutoff,
        p_batch_size: batchSize,
        p_dry_run: true,
      });
      console.info(
        `[retention] dry-run cutoff=${cutoff} would-delete publish_logs=${counts.publishLogsDeleted} ` +
          `queue_items=${counts.queueItemsDeleted}`
      );
      return {
        skipped: false,
        dryRun: true,
        batches: 1,
        publishLogsDeleted: counts.publishLogsDeleted,
        queueItemsDeleted: counts.queueItemsDeleted,
        insightsRunsDeleted: 0,
        capReached: false,
        cutoff,
      };
    }

    let batches = 0;
    let publishLogsDeleted = 0;
    let queueItemsDeleted = 0;
    let capReached = false;
    for (;;) {
      const counts = await callCleanupRpc(db, {
        p_cutoff: cutoff,
        p_batch_size: batchSize,
        p_dry_run: false,
      });
      batches++;
      publishLogsDeleted += counts.publishLogsDeleted;
      queueItemsDeleted += counts.queueItemsDeleted;

      const logsExhausted = counts.publishLogsDeleted < batchSize;
      const itemsExhausted = counts.queueItemsDeleted < batchSize;
      if (logsExhausted && itemsExhausted) break;
      if (batches >= maxBatches) {
        // A full batch was still coming back when the cap hit: more
        // expired rows remain and the next daily run continues them.
        capReached = true;
        break;
      }
    }

    // Spec 240: terminal insights runs older than the same cutoff
    // are pruned in this same run (one DELETE). A failure here is
    // loud like an RPC failure — the catch below captures and
    // rethrows, and the next daily run retries the prune.
    const insightsRunsDeleted = await pruneOldInsightsRuns(db, cutoff);

    console.info(
      `[retention] run cutoff=${cutoff} batches=${batches} publish_logs_deleted=${publishLogsDeleted} ` +
        `queue_items_deleted=${queueItemsDeleted} insights_runs_deleted=${insightsRunsDeleted} cap_reached=${capReached}`
    );
    return {
      skipped: false,
      dryRun: false,
      batches,
      publishLogsDeleted,
      queueItemsDeleted,
      insightsRunsDeleted,
      capReached,
      cutoff,
    };
  } catch (err) {
    captureWorkerError(env, err, { site: 'runRetentionCleanup', kind: 'cleanup_failed' });
    console.error('[retention] cleanup run failed:', err);
    throw err;
  }
}
