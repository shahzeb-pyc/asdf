import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { InternalError } from '@fbuploadpro/contracts';
import {
  INSIGHTS_FOLLOWERS_CONCURRENCY,
  INSIGHTS_FOLLOWERS_PAGE_SIZE,
  fetchLiveFollowersFromGraph,
  listDestinationPage,
  processPage,
  type InsightsFollowersDb,
  type InsightsFollowersResult,
} from './insights-followers-tick.js';

/**
 * Spec 240 — the insights cycle as chunked Cloudflare Queue messages.
 *
 * One queue message per 200-row offset page; the manual endpoint and
 * the 03:00 cron both enqueue the chunks and return, and queue
 * consumers run one chunk each. The run record IS the in-flight
 * guard (a partial unique index allows at most one `running` row,
 * on every isolate — the module-level boolean it replaces could
 * stick at 409 in a reused isolate, and a cancelled waitUntil could
 * never clear it). Completion is provable: every chunk marks its
 * own row done/failed with its counters, and exactly one finisher
 * logs the finished line with the run totals.
 *
 * Chunk failure handling: a chunk that throws is redelivered by the
 * queue (max 3 retries), then lands in the DLQ; the DLQ consumer
 * marks that chunk failed so the run can still finish — with
 * `chunks_failed > 0`, logged loudly, never silently green.
 * Reprocessing a chunk is safe (idempotent): follower writes are
 * wholesale replace of the freshly fetched values, and chunk
 * completion is a conditional update (only from pending/processing),
 * so a retry counts once.
 */

export const INSIGHTS_CYCLE_QUEUE_NAME = 'insights-cycle';
export const INSIGHTS_CYCLE_DLQ_NAME = 'insights-cycle-dlq';

/** One chunk = one offset page of the follower scan. */
export const INSIGHTS_CHUNK_SIZE = INSIGHTS_FOLLOWERS_PAGE_SIZE;

/** A live run older than this is superseded loudly by the next start. */
export const INSIGHTS_RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** The slice of the Supabase client the run/chunk bookkeeping uses. */
export interface InsightsRunDb {
  from: SupabaseClient['from'];
}

/** Chunk message: one offset page of one run. Validated at enqueue and at consume. */
export const InsightsChunkMessageSchema = z
  .object({
    runId: z.string().uuid(),
    chunkIndex: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(INSIGHTS_CHUNK_SIZE),
  })
  .strict();

export type InsightsChunkMessage = z.infer<typeof InsightsChunkMessageSchema>;

export type InsightsRunTrigger = 'manual' | 'cron';

export interface InsightsRunStart {
  runId: string;
  chunks: InsightsChunkMessage[];
}

export interface InsightsChunkDeps {
  /** Test seam: single-attempt live-count fetch (defaults to the Graph read). */
  fetchFollowers?: (fbPageId: string, accessToken: string) => Promise<number>;
  /** Test seam: delay (429 backoff). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

type RunRow = {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  chunks_total: number;
  chunks_done: number;
  chunks_failed: number;
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  adu_updated: number;
  mirrors_updated: number;
};

type ChunkRow = {
  status: string;
  attempts: number;
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  adu_updated: number;
  mirrors_updated: number;
};

const ZERO_COUNTERS: InsightsFollowersResult = {
  scanned: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  aduUpdated: 0,
  mirrorsUpdated: 0,
};

function dbErrorDetail(error: unknown): string {
  const detail = error as { code?: unknown; message?: unknown };
  const code = typeof detail?.code === 'string' ? detail.code : 'unknown';
  const message = typeof detail?.message === 'string' ? detail.message : '';
  return `${code} ${message}`.trim();
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

function logRunFinished(
  runId: string,
  trigger: string,
  totals: InsightsFollowersResult,
  chunksTotal: number,
  chunksFailed: number,
  startedAt: string,
  now: Date
): void {
  const durationMs = Math.max(
    0,
    now.getTime() - new Date(startedAt).getTime()
  );
  const line =
    `[insights-run] run finished runId=${runId} trigger=${trigger} ` +
    `scanned=${totals.scanned} updated=${totals.updated} skipped=${totals.skipped} ` +
    `failed=${totals.failed} adu_updated=${totals.aduUpdated} ` +
    `mirrors_updated=${totals.mirrorsUpdated} chunks_total=${chunksTotal} ` +
    `chunks_failed=${chunksFailed} durationMs=${durationMs}`;
  // A run finishing with failed chunks is loud (error, not info) —
  // the run finished, but not cleanly, and the log must say so.
  if (chunksFailed > 0) console.error(line);
  else console.info(line);
}

/**
 * Shared start path for the manual endpoint and the 03:00 cron.
 * Supersedes stale live runs loudly, inserts the run header + one
 * chunk row per offset page, and returns the chunk messages for the
 * caller to enqueue. Returns null when a run is already live (the
 * caller maps that to 409 / skip) — the partial unique index makes
 * concurrent starts fail the insert, on every isolate.
 *
 * A zero-row scan finishes immediately: the header is inserted
 * already finished with an empty finished line, never a stuck run.
 * A failure between the header and chunk inserts marks the header
 * failed and throws — never a live run with no chunks.
 */
export async function startInsightsRun(
  db: InsightsRunDb,
  trigger: InsightsRunTrigger,
  now: Date = new Date()
): Promise<InsightsRunStart | null> {
  const supabase = db as unknown as SupabaseClient;
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - INSIGHTS_RUN_STALE_AFTER_MS).toISOString();

  const { data: superseded, error: supersedeError } = await supabase
    .from('insights_runs')
    .update({ status: 'stale', finished_at: nowIso })
    .eq('status', 'running')
    .lt('started_at', staleBefore)
    .select('id, started_at');
  if (supersedeError) {
    throw new InternalError(
      `Insights run stale-supersede failed: ${dbErrorDetail(supersedeError)}`
    );
  }
  for (const row of (superseded ?? []) as Array<{ id: string; started_at: string }>) {
    console.error(
      `[insights-run] superseded stale live run ${row.id} (started_at=${row.started_at}); the guard never sticks at 409`
    );
  }

  const { count, error: countError } = await supabase
    .from('destinations')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'facebook');
  if (countError) {
    throw new InternalError(
      `Insights run destination count failed: ${dbErrorDetail(countError)}`
    );
  }
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new InternalError('Insights run destination count returned no usable count');
  }

  const chunksTotal = Math.ceil(count / INSIGHTS_CHUNK_SIZE);
  const { data: inserted, error: insertError } = await supabase
    .from('insights_runs')
    .insert({
      trigger,
      status: chunksTotal === 0 ? 'finished' : 'running',
      started_at: nowIso,
      finished_at: chunksTotal === 0 ? nowIso : null,
      chunks_total: chunksTotal,
    })
    .select('id');
  if (insertError) {
    // The partial unique index: another start won the race — a run
    // is live, so the caller gets 409 / skip, not an error.
    if (isUniqueViolation(insertError)) return null;
    throw new InternalError(
      `Insights run header insert failed: ${dbErrorDetail(insertError)}`
    );
  }
  const header = (inserted ?? [])[0] as RunRow | undefined;
  if (!header || typeof header.id !== 'string') {
    throw new InternalError('Insights run header insert returned no row');
  }
  const runId = header.id;

  if (chunksTotal === 0) {
    logRunFinished(runId, trigger, ZERO_COUNTERS, 0, 0, nowIso, now);
    return { runId, chunks: [] };
  }

  const chunkRows = Array.from({ length: chunksTotal }, (_, chunkIndex) => ({
    run_id: runId,
    chunk_index: chunkIndex,
    offset: chunkIndex * INSIGHTS_CHUNK_SIZE,
    limit: INSIGHTS_CHUNK_SIZE,
  }));
  const { error: chunksError } = await supabase
    .from('insights_run_chunks')
    .insert(chunkRows);
  if (chunksError) {
    await markInsightsRunFailed(db, runId, now);
    throw new InternalError(
      `Insights run chunk insert failed: ${dbErrorDetail(chunksError)}`
    );
  }

  return {
    runId,
    chunks: chunkRows.map((row) => ({
      runId,
      chunkIndex: row.chunk_index,
      offset: row.offset,
      limit: row.limit,
    })),
  };
}

/** Marks a run failed (enqueue threw — no 202 for work that never started). */
export async function markInsightsRunFailed(
  db: InsightsRunDb,
  runId: string,
  now: Date = new Date()
): Promise<void> {
  const supabase = db as unknown as SupabaseClient;
  const { error } = await supabase
    .from('insights_runs')
    .update({ status: 'failed', finished_at: now.toISOString() })
    .eq('id', runId)
    .eq('status', 'running');
  if (error) {
    throw new InternalError(
      `Insights run mark-failed failed: ${dbErrorDetail(error)}`
    );
  }
}

/**
 * Finisher election: reads the run's chunk rows, and when every chunk
 * is terminal flips the run to finished in ONE conditional update
 * (only while status = 'running') — only the invocation whose UPDATE
 * returns a row logs the finished line, so concurrent completions
 * elect exactly one finisher. The header counters come from the
 * chunk rows, never from in-place increments, so concurrent
 * completions cannot lose a count. A stale run never finishes here
 * (its status is no longer 'running'), and its chunks' completion
 * stays silent — the supersede was already loud.
 */
async function tryFinishInsightsRun(
  db: InsightsRunDb,
  runId: string,
  now: Date
): Promise<boolean> {
  const supabase = db as unknown as SupabaseClient;
  const { data: chunkRows, error: chunksError } = await supabase
    .from('insights_run_chunks')
    .select('status, scanned, updated, skipped, failed, adu_updated, mirrors_updated')
    .eq('run_id', runId);
  if (chunksError) {
    throw new InternalError(
      `Insights run finish check failed: ${dbErrorDetail(chunksError)}`
    );
  }
  const rows = (chunkRows ?? []) as ChunkRow[];
  const done = rows.filter((r) => r.status === 'done').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  if (rows.length === 0 || done + failed !== rows.length) return false;

  const totals: InsightsFollowersResult = {
    scanned: rows.reduce((sum, r) => sum + r.scanned, 0),
    updated: rows.reduce((sum, r) => sum + r.updated, 0),
    skipped: rows.reduce((sum, r) => sum + r.skipped, 0),
    failed: rows.reduce((sum, r) => sum + r.failed, 0),
    aduUpdated: rows.reduce((sum, r) => sum + r.adu_updated, 0),
    mirrorsUpdated: rows.reduce((sum, r) => sum + r.mirrors_updated, 0),
  };
  const { data: finished, error: finishError } = await supabase
    .from('insights_runs')
    .update({
      status: 'finished',
      finished_at: now.toISOString(),
      chunks_done: done,
      chunks_failed: failed,
      scanned: totals.scanned,
      updated: totals.updated,
      skipped: totals.skipped,
      failed: totals.failed,
      adu_updated: totals.aduUpdated,
      mirrors_updated: totals.mirrorsUpdated,
    })
    .eq('id', runId)
    .eq('status', 'running')
    .select('id, trigger, started_at');
  if (finishError) {
    throw new InternalError(
      `Insights run finish update failed: ${dbErrorDetail(finishError)}`
    );
  }
  const winner = (finished ?? [])[0] as RunRow | undefined;
  if (!winner) return false;
  logRunFinished(
    runId,
    winner.trigger,
    totals,
    rows.length,
    failed,
    winner.started_at,
    now
  );
  return true;
}

async function completeInsightsChunk(
  db: InsightsRunDb,
  runId: string,
  chunkIndex: number,
  counters: InsightsFollowersResult,
  now: Date
): Promise<void> {
  const supabase = db as unknown as SupabaseClient;
  const { data: updated, error } = await supabase
    .from('insights_run_chunks')
    .update({
      status: 'done',
      scanned: counters.scanned,
      updated: counters.updated,
      skipped: counters.skipped,
      failed: counters.failed,
      adu_updated: counters.aduUpdated,
      mirrors_updated: counters.mirrorsUpdated,
      updated_at: now.toISOString(),
    })
    .eq('run_id', runId)
    .eq('chunk_index', chunkIndex)
    .in('status', ['pending', 'processing'])
    .select('id');
  if (error) {
    throw new InternalError(
      `Insights chunk completion failed: ${dbErrorDetail(error)}`
    );
  }
  // Zero matched rows: a retry after this chunk already completed —
  // the writes are identical and the totals were counted once, so
  // there is nothing more to do (and no finisher to elect here).
  if ((updated ?? []).length === 0) return;
  await tryFinishInsightsRun(db, runId, now);
}

/**
 * Runs one chunk: one offset page of the follower scan, exactly as
 * the old full-cycle loop did it for that page (list page → group
 * by Facebook page id → processPage at concurrency 5, with a
 * per-chunk fetchedByPage cache — a page straddling two chunks may
 * be fetched twice, same values written). A scan-level DB error
 * throws (fail loud — the queue redelivers); per-row failures stay
 * per-row inside processPage.
 *
 * A chunk for a run that is no longer live, or already done/failed,
 * is a no-op returning zero counters — a redelivery after
 * completion never double-counts, and work for a failed/stale run
 * is never started.
 */
export async function runInsightsFollowersChunk(
  db: InsightsFollowersDb,
  masterKey: string,
  runId: string,
  chunkIndex: number,
  offset: number,
  limit: number,
  now: Date,
  deps: InsightsChunkDeps = {}
): Promise<InsightsFollowersResult> {
  const supabase = db as unknown as SupabaseClient;
  const nowIso = now.toISOString();
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const fetchFollowers =
    deps.fetchFollowers ??
    ((fbPageId: string, accessToken: string) =>
      fetchLiveFollowersFromGraph(fbPageId, accessToken));

  const { data: runRows, error: runError } = await supabase
    .from('insights_runs')
    .select('status')
    .eq('id', runId);
  if (runError) {
    throw new InternalError(
      `Insights chunk run lookup failed: ${dbErrorDetail(runError)}`
    );
  }
  const run = (runRows ?? [])[0] as { status?: unknown } | undefined;
  if (!run || typeof run.status !== 'string') {
    throw new InternalError(`Insights chunk references missing run ${runId}`);
  }
  if (run.status !== 'running') {
    console.info(
      `[insights-run] chunk ${chunkIndex} of run ${runId} skipped: run is ${run.status}`
    );
    return ZERO_COUNTERS;
  }

  const { data: chunkRows, error: chunkError } = await supabase
    .from('insights_run_chunks')
    .select('status, attempts')
    .eq('run_id', runId)
    .eq('chunk_index', chunkIndex);
  if (chunkError) {
    throw new InternalError(
      `Insights chunk lookup failed: ${dbErrorDetail(chunkError)}`
    );
  }
  const chunk = (chunkRows ?? [])[0] as
    | { status?: unknown; attempts?: unknown }
    | undefined;
  if (!chunk || typeof chunk.status !== 'string') {
    throw new InternalError(
      `Insights chunk ${chunkIndex} of run ${runId} does not exist`
    );
  }
  if (chunk.status === 'done' || chunk.status === 'failed') {
    // The finish attempt after this chunk completed may have thrown
    // (a transient DB error) — the queue redelivers, and this is the
    // only retry path: re-attempt it. It is idempotent — the
    // conditional UPDATE returns no row once the run is finished,
    // so a finished run logs no second finished line.
    await tryFinishInsightsRun(db as unknown as InsightsRunDb, runId, now);
    return ZERO_COUNTERS;
  }

  const attempts = typeof chunk.attempts === 'number' ? chunk.attempts + 1 : 1;
  const { data: claimed, error: claimError } = await supabase
    .from('insights_run_chunks')
    .update({ status: 'processing', attempts, updated_at: nowIso })
    .eq('run_id', runId)
    .eq('chunk_index', chunkIndex)
    .in('status', ['pending', 'processing'])
    .select('id');
  if (claimError) {
    throw new InternalError(
      `Insights chunk claim failed: ${dbErrorDetail(claimError)}`
    );
  }
  if ((claimed ?? []).length === 0) return ZERO_COUNTERS;

  const page = await listDestinationPage(supabase, offset, limit);
  const result: InsightsFollowersResult = {
    scanned: page.length,
    updated: 0,
    skipped: 0,
    failed: 0,
    aduUpdated: 0,
    mirrorsUpdated: 0,
  };
  const groups = new Map<string, Parameters<typeof processPage>[1]>();
  for (const dest of page) {
    const key = dest.external_destination_id || dest.id;
    const group = groups.get(key);
    if (group) group.push(dest);
    else groups.set(key, [dest]);
  }
  // Per-chunk cache: a page fetched earlier in THIS chunk (its rows
  // straddled two scan pages) reuses the total instead of fetching
  // again. Across chunks the cache is fresh by design (see spec).
  const fetchedByPage = new Map<string, number>();
  const groupList = [...groups.values()];
  for (let i = 0; i < groupList.length; i += INSIGHTS_FOLLOWERS_CONCURRENCY) {
    const batch = groupList.slice(i, i + INSIGHTS_FOLLOWERS_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map((dests) =>
        processPage(supabase, dests, masterKey, nowIso, fetchFollowers, sleep, fetchedByPage)
      )
    );
    for (const outcome of outcomes) {
      result.updated += outcome.updated;
      result.skipped += outcome.skipped;
      result.failed += outcome.failed;
      result.aduUpdated += outcome.adu;
      result.mirrorsUpdated += outcome.mirrors;
    }
  }

  await completeInsightsChunk(db as unknown as InsightsRunDb, runId, chunkIndex, result, now);
  return result;
}

/**
 * Finish with a bounded retry. The DLQ handler acks in a finally
 * block, so a throw here has no redelivery — without a retry, a
 * transient DB error on the finish would strand the run until the
 * 2h staleness supersede. The finish itself is idempotent (the
 * conditional UPDATE returns no row once the run is finished), so
 * retrying cannot double-log the finished line. If every attempt
 * fails the last error is thrown (fail loud — the DLQ handler
 * captures it); the run then self-clears at the staleness threshold.
 */
async function tryFinishInsightsRunWithRetry(
  db: InsightsRunDb,
  runId: string,
  now: Date,
  attempts = 3
): Promise<boolean> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await tryFinishInsightsRun(db, runId, now);
    } catch (err) {
      lastError = err;
      console.error(
        `[insights-run] finish attempt ${attempt}/${attempts} for run ${runId} failed; retrying:`,
        err
      );
    }
  }
  throw lastError;
}

/**
 * DLQ path: a chunk that exhausted queue retries is marked failed
 * (only from pending/processing — an already-done chunk is a
 * no-op), then the finisher election runs so the run can finish
 * with chunks_failed > 0, logged loudly.
 */
export async function markInsightsChunkFailed(
  db: InsightsRunDb,
  runId: string,
  chunkIndex: number,
  now: Date = new Date()
): Promise<void> {
  const supabase = db as unknown as SupabaseClient;
  const { data: updated, error } = await supabase
    .from('insights_run_chunks')
    .update({ status: 'failed', updated_at: now.toISOString() })
    .eq('run_id', runId)
    .eq('chunk_index', chunkIndex)
    .in('status', ['pending', 'processing'])
    .select('id');
  if (error) {
    throw new InternalError(
      `Insights chunk mark-failed failed: ${dbErrorDetail(error)}`
    );
  }
  if ((updated ?? []).length === 0) return;
  await tryFinishInsightsRunWithRetry(db, runId, now);
}
