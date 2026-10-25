/**
 * Download worker entrypoint (spec 149).
 *
 * Polls `media_download_jobs` for queued work, claims at most 3 jobs
 * per user (the per-workspace concurrency cap, enforced atomically by
 * the `claim_download_jobs` RPC — not by counting in this process),
 * and streams each claimed job to R2 through the web engine.
 *
 * This is a plain Node service for the kept VPS server — NOT a
 * Cloudflare Worker, and it uses no queues: the jobs table IS the
 * queue. A job whose worker dies mid-download is reclaimed once its
 * owner's heartbeat goes stale (see the claim migration), so work is
 * never silently lost.
 *
 * Run: `pnpm --filter @fbuploadpro/download-worker start`
 * (env from a file the operator owns, never from the repo).
 */

import { loadConfig } from './config.js';
import {
  createSupabaseClient,
  SupabaseJobStore,
} from './db.js';
import { processClaimedJob } from './process-job.js';
import {
  createR2Client,
  R2StorageService,
  S3MultipartSink,
} from './r2.js';
import {
  DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY,
  DOWNLOAD_WORKER_HEARTBEAT_STALE_MINUTES,
  DOWNLOAD_WORKER_STALE_CLAIM_MINUTES,
} from '@fbuploadpro/contracts';

function log(message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: 'download-worker',
    message,
    ...(context ?? {}),
  });
  process.stdout.write(`${line}\n`);
}

function logError(message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: 'download-worker',
    level: 'error',
    message,
    ...(context ?? {}),
  });
  process.stderr.write(`${line}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const workerId = config.workerId;

  const supabase = createSupabaseClient(
    config.supabaseUrl,
    config.supabaseServiceRoleKey
  );
  const store = new SupabaseJobStore(supabase);
  const r2Client = createR2Client(config);
  const storage = new R2StorageService(config, r2Client);

  log('download worker starting', {
    workerId,
    pollIntervalMs: config.pollIntervalMs,
    maxConcurrentJobs: config.maxConcurrentJobs,
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // In-flight jobs run to completion; claimed-but-unstarted jobs
    // are left for stale-claim reclaim once this heartbeat goes stale.
    log('shutdown requested, in-flight jobs finish, unstarted claims reclaimed later', { workerId });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    try {
      await store.upsertHeartbeat(workerId);

      const staleWorkers = await store.staleWorkerIds(
        DOWNLOAD_WORKER_HEARTBEAT_STALE_MINUTES
      );
      if (staleWorkers.length > 0) {
        const reclaimed = await store.reclaimStaleClaims(
          staleWorkers,
          DOWNLOAD_WORKER_STALE_CLAIM_MINUTES
        );
        if (reclaimed > 0) {
          log('reclaimed stale claims', { workerId, reclaimed, staleWorkers });
        }
      }

      const users = await store.usersWithQueuedJobs(50);
      const claimed: { jobId: string; userId: string }[] = [];
      for (const userId of users) {
        if (stopping) break;
        const jobs = await store.claimJobs(
          workerId,
          userId,
          DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY
        );
        for (const job of jobs) claimed.push({ jobId: job.id, userId });
      }

      // Bounded pool: never more than maxConcurrentJobs in flight.
      // Each claimed job re-reads its own row before doing work.
      let index = 0;
      const runNext = async (): Promise<void> => {
        while (index < claimed.length && !stopping) {
          const next = claimed[index];
          index += 1;
          if (!next) continue;
          try {
            const job = await store.fetchJob(next.jobId);
            if (!job) continue;
            const outcome = await processClaimedJob(job, {
              store,
              storage,
              createSink: (key, contentType) =>
                new S3MultipartSink(
                  r2Client,
                  config.r2BucketName,
                  key,
                  contentType,
                  config.r2PublicUrl
                ),
              extractorApiUrl: config.extractorApiUrl,
              log,
            });
            log('job finished', { workerId, jobId: next.jobId, outcome });
          } catch (error) {
            // One job's crash must never kill the loop or other jobs.
            logError('job processing threw', {
              workerId,
              jobId: next.jobId,
              error: String(error),
            });
          }
        }
      };
      const poolSize = Math.min(config.maxConcurrentJobs, claimed.length);
      const workers: Promise<void>[] = [];
      for (let i = 0; i < poolSize; i++) workers.push(runNext());
      await Promise.all(workers);
    } catch (error) {
      // A tick-level failure (DB blip, heartbeat loss) is logged and
      // retried next tick — the loop itself never exits on it.
      logError('worker tick failed', { workerId, error: String(error) });
    }

    if (!stopping) await sleep(config.pollIntervalMs);
  }

  log('download worker stopped', { workerId });
}

main().catch((error: unknown) => {
  logError('download worker fatal', { error: String(error) });
  process.exitCode = 1;
});
