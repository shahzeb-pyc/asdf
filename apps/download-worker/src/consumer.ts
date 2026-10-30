import {
  DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY,
  DownloadQueueMessageSchema,
  type DownloadQueueMessage,
} from '@fbuploadpro/contracts';
import {
  processClaimedJob,
  type ProcessJobDeps,
  type ProcessJobOutcome,
} from './process-job.js';
import type { JobStore } from './store.js';

/**
 * Queue consumer (spec 149 backend revision §5, §8).
 *
 * Delivery semantics, stated plainly because they are the whole
 * design:
 * - A malformed message is a throw: Cloudflare retries it, then the
 *   DLQ drains it as unprocessable — it never touches a job row.
 * - A claim that throws (DB down) is a throw: the Queue redelivers
 *   with backoff.
 * - A claim that returns nothing (cap full, or the job is no longer
 *   queued) is an ACK without work: the job stays queued in
 *   Supabase and the Cron sweeper re-triggers it when a slot frees.
 *   Cap-full messages are NEVER retried: retries count against
 *   max_retries and a busy user would burn them just by waiting.
 * - A claim that returns jobs processes ALL of them, sequentially.
 *   This is a deliberate deviation from §5.2's letter ("claim
 *   returns other jobs but not this one → ack without work"):
 *   following that sentence literally would strand the other jobs
 *   in 'resolving' with no owner until the 30-minute stale reclaim,
 *   because their own trigger messages would find them already
 *   claimed. Processing every job this invocation claimed is the
 *   only reading under which every claim leads to work.
 */

export interface ConsumerDeps {
  store: JobStore;
  workerId: string;
  processJob: (
    job: Parameters<typeof processClaimedJob>[0],
    deps: ProcessJobDeps
  ) => Promise<ProcessJobOutcome>;
  processDeps: Omit<ProcessJobDeps, 'store'>;
  log?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
}

export type ConsumerOutcome =
  | { kind: 'processed'; jobIds: string[] }
  | { kind: 'acked-no-work'; reason: 'cap-full-or-not-queued' };

export async function handleQueueMessage(
  body: unknown,
  deps: ConsumerDeps
): Promise<ConsumerOutcome> {
  const log = deps.log ?? (() => {});
  const parsed = DownloadQueueMessageSchema.safeParse(body);
  if (!parsed.success) {
    // Malformed: throw so the Queue retries into the DLQ; the DLQ
    // handler acks it as unprocessable without touching any row.
    throw new Error(`Malformed download queue message: ${parsed.error.message}`);
  }
  const message: DownloadQueueMessage = parsed.data;

  // Claim throws on DB failure → caller rethrows → Queue redelivers.
  const claimed = await deps.store.claimJobs(
    deps.workerId,
    message.userId,
    DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY
  );

  if (claimed.length === 0) {
    return { kind: 'acked-no-work', reason: 'cap-full-or-not-queued' };
  }

  const jobIds: string[] = [];
  for (const job of claimed) {
    const outcome = await deps.processJob(job, {
      ...deps.processDeps,
      store: deps.store,
    });
    log('download job finished', {
      jobId: job.id,
      outcome,
      triggeredBy: message.jobId,
    });
    jobIds.push(job.id);
  }
  return { kind: 'processed', jobIds };
}

/**
 * DLQ consumer (§8.2): the DLQ is a terminal holding pen, never a
 * second retry loop. An unresolved job is marked failed (checkpoint
 * cleared) and acked; an already-resolved job is just acked; a
 * malformed message is acked as unprocessable, logged loudly, and
 * never touches a job row.
 */
export async function handleDlqMessage(
  body: unknown,
  deps: { store: JobStore; log?: ((message: string, context?: Record<string, unknown>) => void) | undefined }
): Promise<{ kind: 'acked'; reason: string }> {
  const log = deps.log ?? (() => {});
  const parsed = DownloadQueueMessageSchema.safeParse(body);
  if (!parsed.success) {
    log('DLQ message unprocessable, acked without touching any job row', {
      error: parsed.error.message,
    });
    return { kind: 'acked', reason: 'unprocessable' };
  }
  const job = await deps.store.fetchJob(parsed.data.jobId);
  if (!job) {
    log('DLQ message for vanished job, acked', { jobId: parsed.data.jobId });
    return { kind: 'acked', reason: 'job-vanished' };
  }
  if (job.status === 'queued' || job.status === 'resolving' || job.status === 'downloading') {
    await deps.store.updateJob(job.id, {
      status: 'failed',
      errorCode: 'DOWNLOAD_FAILED',
      errorMessage: 'The download failed after several tries. Please try again.',
      checkpoint: null,
    });
    log('DLQ drained: job marked failed', { jobId: job.id, attempts: job.attempts });
    return { kind: 'acked', reason: 'marked-failed' };
  }
  return { kind: 'acked', reason: 'already-resolved' };
}
