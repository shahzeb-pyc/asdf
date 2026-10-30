import {
  DOWNLOAD_CONSUMER_WORKER_ID,
  DOWNLOAD_CRON_SWEEP_LIMIT,
  DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY,
  DOWNLOAD_STALE_PROGRESS_MINUTES,
  type DownloadQueueMessage,
} from '@fbuploadpro/contracts';
import type { JobStore } from './store.js';

/**
 * Cron trigger (spec 149 backend revision §7), every 60 seconds, in
 * order: heartbeat, sweep, stale reclaim. Each step logs its own
 * failure and continues — a failed heartbeat must never block the
 * sweep that keeps jobs moving, and a failed sweep must never block
 * reclaim. The handler itself never throws: a throwing scheduled
 * handler would be retried by Cloudflare and could double-send
 * triggers (harmless by the claim gate, but still noise).
 */

export interface CronDeps {
  store: JobStore;
  queue: {
    send(message: DownloadQueueMessage): Promise<unknown>;
  };
  log?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
}

export interface CronResult {
  heartbeated: boolean;
  swept: number;
  reclaimed: number;
}

export async function runCron(deps: CronDeps): Promise<CronResult> {
  const log = deps.log ?? (() => {});
  const result: CronResult = { heartbeated: false, swept: 0, reclaimed: 0 };

  try {
    await deps.store.upsertHeartbeat(DOWNLOAD_CONSUMER_WORKER_ID);
    result.heartbeated = true;
  } catch (error) {
    log('cron heartbeat failed', { error: String(error) });
  }

  try {
    const queued = await deps.store.sweepQueuedJobs(DOWNLOAD_CRON_SWEEP_LIMIT);
    // Active counts cached per user within this run: a job we just
    // triggered counts against the user's free slots immediately,
    // so one sweep never floods a user past the 3-at-once cap.
    const activeByUser = new Map<string, number>();
    for (const job of queued) {
      let active = activeByUser.get(job.userId);
      if (active === undefined) {
        active = await deps.store.countActiveJobs(job.userId);
        activeByUser.set(job.userId, active);
      }
      if (active >= DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY) continue;
      await deps.queue.send({ jobId: job.id, userId: job.userId });
      activeByUser.set(job.userId, active + 1);
      result.swept += 1;
    }
  } catch (error) {
    log('cron sweep failed', { error: String(error) });
  }

  try {
    result.reclaimed = await deps.store.reclaimStaleJobs(DOWNLOAD_STALE_PROGRESS_MINUTES);
    if (result.reclaimed > 0) {
      log('cron reclaimed stale jobs', { reclaimed: result.reclaimed });
    }
  } catch (error) {
    log('cron stale reclaim failed', { error: String(error) });
  }

  return result;
}
