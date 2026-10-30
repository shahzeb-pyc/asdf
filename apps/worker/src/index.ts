import { createClient } from '@supabase/supabase-js';
import { InternalError, parseTikwmApiKeys, type PublisherRegistry } from '@fbuploadpro/contracts';
import {
  runClaimTick,
  type ClaimerDbClient,
  type ClaimerQueues,
  type PublishQueueMessage,
} from './claimer.js';
import { runSlotClaimTick } from './slot-claim.js';
import {
  buildMirrorTickDeps,
  MIRROR_DISPATCH_CRON,
  runMirrorDispatch,
  runMirrorJobTick,
} from './mirror-tick.js';
import { runAduTick } from './adu-tick.js';
import { handleQueueBatch, type ConsumerDbClient } from './consumers.js';
import {
  isTokenEncryptionKeyWellFormed,
  recordHeartbeat,
  WORKER_HEARTBEAT_NAME,
} from './heartbeat.js';
import { createWorkerPublisherRegistry } from './registry.js';
import {
  runRetentionCleanup,
  RETENTION_CRON,
  type RetentionDbClient,
} from './retention.js';
import {
  runRefreshCycle,
  TOKEN_REFRESH_CRON,
  type RefreshDbClient,
} from './refresh.js';
import { captureWorkerError } from './analytics.js';
import { resolveWorkerMasterKey } from './master-key.js';

/**
 * Derive a `waitUntil` callback from an ExecutionContext (spec 139).
 * Returns undefined when no usable ctx is present (tests, direct calls)
 * — `captureWorkerError` is a safe no-op without it, it just cannot
 * extend the isolate's lifetime.
 */
export function waitUntilFromCtx(
  ctx?: ExecutionContext | null
): ((promise: Promise<unknown>) => void) | undefined {
  if (!ctx || typeof ctx.waitUntil !== 'function') return undefined;
  return (promise: Promise<unknown>) => {
    ctx.waitUntil(promise);
  };
}

export { recordHeartbeat, WORKER_HEARTBEAT_NAME } from './heartbeat.js';
export {
  runClaimTick,
  runRecoverySweep,
  isRecoveryTick,
  CLAIM_ROUND_LIMIT,
  MAX_CLAIM_ROUNDS_PER_PLATFORM_LANE_PER_TICK,
} from './claimer.js';
export {
  handlePublishBatch,
  handleDlqBatch,
  handleQueueBatch,
  mapPublishOutcomeToSettleArgs,
  buildDlqSettleArgs,
} from './consumers.js';
export { createWorkerPublisherRegistry } from './registry.js';
export {
  runRefreshCycle,
  TOKEN_REFRESH_CRON,
  CLAIM_TICK_CRON,
  REFRESH_LEASE_TTL_MS,
  REFRESH_BACKLOG_EVENT,
} from './refresh.js';
export { runRetentionCleanup, RETENTION_CRON } from './retention.js';
export type { RetentionRunResult, RetentionDbClient } from './retention.js';
export type { RefreshCycleResult, RefreshDbClient } from './refresh.js';

export interface Env {
  ENVIRONMENT?: string;
  /**
   * Test-only seam: integration tests inject a mock DB handle here.
   * Never set in production. Never derived from request input.
   */
  __TEST_DB__?: unknown;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  /**
   * Paid tikwmapi keys for TikTok mirror feed discovery
   * (comma-separated list, plus singular fallback — see
   * contracts parseTikwmApiKeys). Worker secret, set via
   * wrangler secret; never committed. Empty = every mirror
   * feed fetch fails loudly as a per-mirror error.
   */
  TIKWMAPI_KEYS?: string;
  TIKWMAPI_KEY?: string;
  /** Post for Me API key (specs 125/126) — provider-managed YouTube/TikTok. Worker env only, via GitHub Secrets. */
  POST_FOR_ME_API_KEY?: string;
  /** X global-app client ID (spec 127, D7) — GitHub Secrets → worker env only, never the database. */
  X_CLIENT_ID?: string;
  /** X global-app client secret (spec 127, D7) — GitHub Secrets → worker env only, never the database. */
  X_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  /** Retention cleanup kill-switch (spec 139 residue): 'true'/'1' skips the daily run. Unset = enabled. */
  RETENTION_DISABLED?: string;
  /** Retention cleanup dry-run (spec 139 residue): 'true'/'1' counts what would be deleted, deletes nothing. */
  RETENTION_DRY_RUN?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Producer binding for the publish-fast lane queue (spec 121). */
  PUBLISH_FAST_QUEUE?: Queue<PublishQueueMessage>;
  /** Producer binding for the publish-heavy lane queue (spec 121). */
  PUBLISH_HEAVY_QUEUE?: Queue<PublishQueueMessage>;
  /** Comma-separated extra origins allowed by CORS (see getAllowedOrigin). */
  CORS_ALLOWED_ORIGINS?: string;
}

export interface ScheduledOptions {
  db?: ClaimerDbClient & ConsumerDbClient;
  registry?: PublisherRegistry;
  queues?: ClaimerQueues;
  now?: Date;
  /** Test seam: overrides the waitUntil derived from the ExecutionContext. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface QueueOptions {
  db?: ConsumerDbClient & ClaimerDbClient;
  registry?: PublisherRegistry;
}

function initWorkerDb(env: Env, optionsDb?: unknown): any {
  if (optionsDb) return optionsDb;
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || env.ENVIRONMENT === 'test') {
    return null;
  }
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as any;
}

function queuesFromEnv(env: Env, overrides?: ClaimerQueues): ClaimerQueues {
  return {
    fast: overrides?.fast ?? (env.PUBLISH_FAST_QUEUE as ClaimerQueues['fast']),
    heavy: overrides?.heavy ?? (env.PUBLISH_HEAVY_QUEUE as ClaimerQueues['heavy']),
  };
}

/**
 * Scheduled handler: heartbeat first on EVERY tick — including the
 * skip paths — then branch on `controller.cron`: the refresh cron runs
 * the token-refresh cycle (refresh.ts), anything else runs the claimer
 * (claim rounds that only claim and enqueue; the tick never publishes,
 * consumers do the publishing).
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx?: ExecutionContext,
  options?: ScheduledOptions
): Promise<void> {
  const waitUntil = options?.waitUntil ?? waitUntilFromCtx(ctx);
  const db = initWorkerDb(env, options?.db);
  const masterKey = env.TOKEN_ENCRYPTION_KEY;

  if (!masterKey) {
    console.warn('[Scheduled] TOKEN_ENCRYPTION_KEY is not configured; skipping cycle');
    await recordHeartbeat(db, {
      success: false,
      skipReason: 'missing_token_encryption_key',
    });
    return;
  }

  if (!db) {
    console.warn('[Scheduled] Database client is not configured; skipping cycle');
    await recordHeartbeat(null, { success: false, skipReason: 'db_unconfigured' });
    return;
  }

  const registry = options?.registry ?? createWorkerPublisherRegistry(env);

  // Cron routing (spec 121 Scope 9): the refresh cron runs ONLY the
  // token-refresh cycle; every other cron (the `* * * * *` claim tick)
  // runs the claimer exactly as before. The refresh cycle deliberately
  // writes no heartbeat row: the heartbeat is claimer-owned and a full
  // write from here would zero the claimer's claimed/settled counters
  // and stamp a false claim success. Refresh reports through its own
  // structured counter log line + PostHog captures (see refresh.ts);
  // the shared skip-path heartbeats above still fire for both crons.
  if (controller.cron === TOKEN_REFRESH_CRON) {
    try {
      await runRefreshCycle(
        db as unknown as RefreshDbClient,
        registry,
        env,
        options?.now ?? new Date(controller.scheduledTime)
      );
    } catch (err) {
      console.error('[Scheduled] token refresh cycle failed:', err);
      captureWorkerError(
        env,
        err,
        { site: 'handleScheduled', kind: 'refresh_cycle_failed' },
        waitUntil
      );
      throw err;
    }
    return;
  }

  // Retention cron (spec 139 residue): the daily 30-day history cleanup
  // runs ONLY the retention job (retention.ts). Like the refresh cycle
  // it writes no heartbeat row of its own — the heartbeat is
  // claimer-owned — and reports through its structured counter log line
  // + PostHog captures.
  if (controller.cron === RETENTION_CRON) {
    try {
      await runRetentionCleanup(
        db as unknown as RetentionDbClient,
        env,
        options?.now ?? new Date(controller.scheduledTime)
      );
    } catch (err) {
      console.error('[Scheduled] retention cleanup failed:', err);
      captureWorkerError(
        env,
        err,
        { site: 'handleScheduled', kind: 'retention_cleanup_failed' },
        waitUntil
      );
      throw err;
    }
    return;
  }

  // Mirror dispatcher cron (TikTok mirrors, scaled): every 10
  // minutes the dispatcher runs ONLY the dispatch job (same
  // pattern as retention) — it scans due mirrors and inserts
  // one mirror-check job per mirror into the mirror_check_jobs
  // database queue. The actual checks run in the every-minute
  // tick below (the queue consumer), never in the cron itself,
  // so one slow mirror cannot hold up the others. A
  // dispatch-level failure (scan query, enqueue RPC) is
  // captured here and rethrown like the refresh cycle;
  // per-mirror failures live in the job consumer.
  if (controller.cron === MIRROR_DISPATCH_CRON) {
    try {
      const tickDeps = buildMirrorTickDeps(db, masterKey, {
        now: options?.now ?? new Date(controller.scheduledTime),
        env,
        waitUntil,
        tikwmApiKeys: parseTikwmApiKeys(env.TIKWMAPI_KEYS, env.TIKWMAPI_KEY),
      });
      await runMirrorDispatch({
        listDueMirrorIds: tickDeps.listDueMirrorIds,
        enqueueMirrorCheckJobs: tickDeps.enqueueMirrorCheckJobs,
        advanceMirrorCheck: (mirrorId, nextCheckAt) =>
          tickDeps.updateMirror(mirrorId, { nextCheckAt }),
        now: options?.now ?? new Date(controller.scheduledTime),
      });
    } catch (err) {
      console.error('[Scheduled] mirror dispatch failed:', err);
      captureWorkerError(
        env,
        err,
        { site: 'handleScheduled', kind: 'mirror_dispatch_failed' },
        waitUntil
      );
      throw err;
    }
    return;
  }

  try {
    const result = await runClaimTick({
      db,
      registry,
      queues: queuesFromEnv(env, options?.queues),
      env,
      now: options?.now ?? new Date(controller.scheduledTime),
      waitUntil,
    });

    // Publisher-driven posting times (Facebook): due-slot claims run
    // on the same tick, isolated from the due-based claim above.
    // Per-slot failures are captured inside runSlotClaimTick; a
    // tick-level failure (list RPC, missing queue binding) is
    // captured here and must not fail the tick or its heartbeat —
    // slot claims simply retry next tick (a slot whose window has
    // passed by then is lost, exactly like a publisher outage).
    // The heartbeat still reports the due-based claim counts only;
    // slot claims report through their own log line (slot-claim.ts).
    try {
      await runSlotClaimTick({
        db,
        queues: queuesFromEnv(env, options?.queues),
        env,
        now: options?.now ?? new Date(controller.scheduledTime),
        waitUntil,
      });
    } catch (slotErr) {
      captureWorkerError(
        env,
        slotErr,
        { site: 'handleScheduled', kind: 'slot_claim_tick_failed' },
        waitUntil
      );
      console.error('[handleScheduled] slot claim tick failed; continuing:', slotErr);
    }

    // Mirror-check jobs (TikTok mirrors, database queue): the
    // every-minute tick is the consumer — it claims due jobs
    // from mirror_check_jobs and runs one mirror check per job.
    // Isolated like the slot claim: a failure here never breaks
    // the claimer, the slot claim, or the heartbeat below —
    // unclaimed jobs simply wait for the next minute, and the
    // job tick itself never throws (see runMirrorJobTick).
    try {
      const tickDeps = buildMirrorTickDeps(db, masterKey, {
        env,
        waitUntil,
        tikwmApiKeys: parseTikwmApiKeys(env.TIKWMAPI_KEYS, env.TIKWMAPI_KEY),
      });
      await runMirrorJobTick({
        check: tickDeps,
        claimJobs: tickDeps.claimMirrorCheckJobs,
        fetchMirror: tickDeps.fetchMirror,
        completeJob: tickDeps.completeMirrorCheckJob,
        failJob: tickDeps.failMirrorCheckJob,
        now: options?.now ?? new Date(controller.scheduledTime),
      });
    } catch (jobErr) {
      captureWorkerError(
        env,
        jobErr,
        { site: 'handleScheduled', kind: 'mirror_job_tick_failed' },
        waitUntil
      );
      console.error('[handleScheduled] mirror job tick failed; continuing:', jobErr);
    }

    // ADU tick: schedule intake + reel publish, isolated like slot
    // claims. A missing ADU migration returns skipped (never throws),
    // and any other failure is captured and never fails the claim
    // tick or its heartbeat — ADU jobs simply retry next minute.
    try {
      await runAduTick({
        db: db as unknown as Parameters<typeof runAduTick>[0]['db'],
        registry,
        masterKey,
        now: options?.now ?? new Date(controller.scheduledTime),
      });
    } catch (aduErr) {
      captureWorkerError(
        env,
        aduErr,
        { site: 'handleScheduled', kind: 'adu_tick_failed' },
        waitUntil
      );
      console.error('[handleScheduled] ADU tick failed; continuing:', aduErr);
    }

    await recordHeartbeat(db, {
      success: true,
      claimed: result.claimed,
      enqueuedFast: result.enqueuedFast,
      enqueuedHeavy: result.enqueuedHeavy,
    });
  } catch (err) {
    captureWorkerError(
      env,
      err,
      { site: 'handleScheduled', kind: 'claim_error' },
      waitUntil
    );
    await recordHeartbeat(db, { success: false, skipReason: 'claim_error' });
    throw err;
  }
}

/**
 * Queue handler (spec 121 consumers): dispatches by queue name to the
 * publish consumers or the DLQ consumers. See consumers.ts for the
 * ack/retry semantics. (Mirror checks no longer use Cloudflare
 * Queues — they run on the mirror_check_jobs database queue,
 * consumed by the every-minute tick in handleScheduled.)
 */
export async function handleQueue(
  batch: MessageBatch<PublishQueueMessage>,
  env: Env,
  _ctx?: ExecutionContext,
  options?: QueueOptions
): Promise<void> {
  const db = initWorkerDb(env, options?.db);
  if (!db) {
    throw new InternalError('Database client is not configured; cannot consume queue batch');
  }
  const registry = options?.registry ?? createWorkerPublisherRegistry(env);
  await handleQueueBatch(batch as MessageBatch<PublishQueueMessage>, {
    db,
    registry,
    // Audit S3: production fail-closed key rules, same as web —
    // a production dev-fallback key throws instead of decrypting.
    masterKey: resolveWorkerMasterKey(env),
    env,
  });
}

export interface WorkerHealthPayload {
  status: 'ok' | 'unhealthy';
  timestamp: string;
  worker: 'fbuploadpro-worker';
  checks: {
    database: boolean;
    config: boolean;
    heartbeat: boolean;
  };
}

const WORKER_HEALTH_TIMEOUT_MS = 2000;

/** Mirrors the web tier's rule (spec 116/139): stale when last successful tick > 180s ago. */
export const WORKER_HEARTBEAT_STALE_SECONDS = 180;

interface WorkerProbeDb {
  from: (table: string) => {
    select: (
      columns: string,
      options: { head: boolean; count: string }
    ) => Promise<{ error: unknown }>;
  };
}

async function probeWorkerDatabase(
  db: WorkerProbeDb | null,
  timeoutMs: number
): Promise<boolean> {
  if (!db || typeof db.from !== 'function') return false;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const probePromise = db
      .from('workspaces')
      .select('id', { head: true, count: 'exact' });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error('Health probe timeout exceeded budget')),
        timeoutMs
      );
    });
    const { error } = await Promise.race([probePromise, timeoutPromise]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(
      '[health] worker database probe failed:',
      err instanceof Error ? err.message : err
    );
    return false;
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

/**
 * Heartbeat-freshness check (spec 139): reads `worker_heartbeats` and
 * mirrors the web internal tier's semantics — stale when the last
 * successful tick is more than 180s old. Degrades gracefully on cold
 * start: no row yet, or a row with no `last_success_at` yet, counts as
 * healthy (the claimer has simply not completed a tick yet). A missing
 * DB is NOT graceful (the database check fails alongside it), and a
 * query error / timeout is reported unhealthy and logged server-side.
 */
export async function probeWorkerHeartbeat(
  db: unknown,
  timeoutMs = WORKER_HEALTH_TIMEOUT_MS,
  now: Date = new Date()
): Promise<boolean> {
  if (!db || typeof (db as { from?: unknown }).from !== 'function') return false;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolve = async (): Promise<unknown> => {
      const client = db as {
        from: (table: string) => Record<string, unknown>;
      };
      const table = client.from('worker_heartbeats');
      if (typeof table.select !== 'function') return { __noProbe: true };
      let query: unknown = (table.select as (cols: string) => unknown).call(
        table,
        'last_success_at'
      );
      if (query && typeof (query as { eq?: unknown }).eq === 'function') {
        query = (
          query as { eq: (col: string, val: unknown) => unknown }
        ).eq('worker_name', WORKER_HEARTBEAT_NAME);
      }
      if (query && typeof (query as { maybeSingle?: unknown }).maybeSingle === 'function') {
        return await (query as { maybeSingle: () => Promise<unknown> }).maybeSingle();
      }
      if (
        query &&
        (typeof query === 'object' || typeof query === 'function') &&
        typeof (query as { then?: unknown }).then === 'function'
      ) {
        return await (query as PromiseLike<unknown>);
      }
      // Unrecognised query shape (e.g. a minimal test double): cannot
      // probe — degrade gracefully rather than false-alarm.
      return { __noProbe: true };
    };
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error('Heartbeat probe timeout exceeded budget')),
        timeoutMs
      );
    });
    const result = (await Promise.race([resolve(), timeoutPromise])) as {
      data?: unknown;
      error?: unknown;
      __noProbe?: boolean;
    } | null;
    if (!result || result.__noProbe) return true;
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row !== 'object') return true; // cold start: no rows yet
    const lastSuccessAt = (row as { last_success_at?: unknown }).last_success_at;
    if (!lastSuccessAt || typeof lastSuccessAt !== 'string') return true;
    const parsed = new Date(lastSuccessAt).getTime();
    if (Number.isNaN(parsed)) return true;
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
    return ageSeconds <= WORKER_HEARTBEAT_STALE_SECONDS;
  } catch (err) {
    console.error(
      '[health] worker heartbeat probe failed:',
      err instanceof Error ? err.message : err
    );
    return false;
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

/**
 * Worker health probe (spec 116, extended spec 139): mirrors the web DB
 * probe (workspaces head query, 2s budget) plus env-presence booleans
 * and the heartbeat-freshness check above. Sanitized — booleans only,
 * never hosts, values, or error detail (logged server-side only).
 */
export async function probeWorkerHealth(
  env: Env,
  injectedDb?: unknown,
  timeoutMs = WORKER_HEALTH_TIMEOUT_MS,
  now: Date = new Date()
): Promise<{ statusCode: number; payload: WorkerHealthPayload }> {
  const timestamp = now.toISOString();
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  // Audit S3: the config check also refuses a production
  // dev-fallback key (resolve throws for it); the shape check
  // is kept so a missing key still reports unhealthy in
  // non-production, where the resolver would fall back.
  let keyUsable = false;
  try {
    resolveWorkerMasterKey(env);
    keyUsable = isTokenEncryptionKeyWellFormed(env.TOKEN_ENCRYPTION_KEY);
  } catch {
    keyUsable = false;
  }
  const config = Boolean(
    supabaseUrl && env.SUPABASE_SERVICE_ROLE_KEY && keyUsable
  );

  const testDb =
    env.ENVIRONMENT === 'production'
      ? null
      : ((env as unknown as { __TEST_DB__?: unknown }).__TEST_DB__ ?? null);
  const db = (initWorkerDb(env, injectedDb) ?? testDb) as WorkerProbeDb | null;
  const database = await probeWorkerDatabase(db, timeoutMs);
  const heartbeat = await probeWorkerHeartbeat(db, timeoutMs, now);

  const ok = database && config && heartbeat;
  return {
    statusCode: ok ? 200 : 503,
    payload: {
      status: ok ? 'ok' : 'unhealthy',
      timestamp,
      worker: 'fbuploadpro-worker',
      checks: { database, config, heartbeat },
    },
  };
}

/**
 * Returns the request origin if it is allowed to call this worker, else null.
 * The worker serves the FBUploadPro web app, so only its domains (apex,
 * www, *.fbuploadpro.com tenant subdomains, app.vinsmokemedia.online) plus
 * localhost in non-production are accepted. Extra origins can be added via
 * the CORS_ALLOWED_ORIGINS env var (comma-separated). Never '*': these
 * endpoints authenticate via Bearer tokens.
 */
function getAllowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const extra = (env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set([
    'fbuploadpro.com',
    'www.fbuploadpro.com',
    'app.vinsmokemedia.online',
    ...extra,
  ]);
  const isTenantSubdomain =
    hostname.endsWith('.fbuploadpro.com') || hostname.endsWith('.vinsmokemedia.online');
  const isLocalhost =
    env.ENVIRONMENT !== 'production' &&
    (hostname === 'localhost' || hostname === '127.0.0.1');
  if (allowedHosts.has(hostname) || isTenantSubdomain || isLocalhost) {
    return origin;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const allowedOrigin = getAllowedOrigin(request, env);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      const preflightHeaders: Record<string, string> = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
      if (allowedOrigin) {
        preflightHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
        preflightHeaders['Vary'] = 'Origin';
      }
      return new Response(null, { status: 204, headers: preflightHeaders });
    }

    const corsHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (allowedOrigin) {
      corsHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
      corsHeaders['Vary'] = 'Origin';
    }

    // 2. Healthcheck (spec 116: real DB probe + env-presence booleans)
    if (request.method === 'GET' && url.pathname === '/health') {
      const result = await probeWorkerHealth(env);
      return new Response(JSON.stringify(result.payload), {
        status: result.statusCode,
        headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
      });
    }

    return new Response(
      JSON.stringify({
        error: 'Not Found',
      }),
      {
        status: 404,
        headers: corsHeaders,
      }
    );
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },

  async queue(
    batch: MessageBatch<PublishQueueMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await handleQueue(batch, env, ctx);
  },
};
