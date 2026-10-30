import { z } from 'zod';

import { DownloaderSourcePlatformSchema } from './downloader.js';

/**
 * Persistent download jobs (spec 149). One row per pasted link in the
 * pre-existing `media_download_jobs` table — this module is the wire
 * truth for the submit / status / retry / cancel API and for the
 * Cloudflare Queue consumer that claims and processes the rows
 * (backend revision: cloudflare-backend-spec.md). It does not create
 * a second jobs model: the table already existed (spec 140), and the
 * spec-149 migrations only extend it (claim lease, attempts, the
 * `resolving` state, `done` replacing the legacy `completed` label,
 * and the Cloudflare checkpoint columns).
 */

// ---------------------------------------------------------------------------
// Constants (spec 149 — single source, no magic numbers in consumers)
// ---------------------------------------------------------------------------

/** Downloads running at once per workspace (per user in this repo's model). */
export const DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY = 3;

/** Links accepted in one submit batch. */
export const DOWNLOAD_JOBS_MAX_LINKS_PER_SUBMIT = 50;

/** Minimum gap between progress writes for one job (consumer-side throttle). */
export const DOWNLOAD_JOB_PROGRESS_UPDATE_MIN_INTERVAL_MS = 1000;

/** Hard cap enforced mid-stream by the consumer (500 MB). */
export const DOWNLOAD_JOB_MAX_BYTES = 524_288_000;

/** R2 multipart part size for the Cloudflare consumer (8 MB). */
export const DOWNLOAD_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

/** Cap on a single resolve body (HTML page / JSON payload, §3.4). */
export const DOWNLOAD_RESOLVE_BODY_MAX_BYTES = 10 * 1024 * 1024;

/** Cloudflare Queue consumer: messages per batch (sequential processing). */
export const DOWNLOAD_QUEUE_MAX_BATCH_SIZE = 5;

/** Cloudflare Queue consumer: deliveries before a message goes to the DLQ. */
export const DOWNLOAD_QUEUE_MAX_RETRIES = 3;

/** Job attempts cap: a job failing this many times is marked failed. */
export const DOWNLOAD_JOB_ATTEMPTS_CAP = 5;

/** Cron sweeper: jobs triggered per run at most. */
export const DOWNLOAD_CRON_SWEEP_LIMIT = 50;

/** A job with no progress update for this long is reclaimed (checkpoint kept). */
export const DOWNLOAD_STALE_PROGRESS_MINUTES = 30;

/** Worker id written to the download_worker_heartbeats table by the Cron handler. */
export const DOWNLOAD_CONSUMER_WORKER_ID = 'cf-download-consumer';

/** A heartbeat younger than this counts the consumer as healthy. */
export const DOWNLOAD_CONSUMER_HEALTHY_MINUTES = 5;

/**
 * Error codes for which resuming a download is pointless: the stream
 * itself is rejected, so a retry must start clean (checkpoint cleared).
 * Every other failure keeps its checkpoint so the next attempt resumes.
 */
export const DOWNLOAD_TERMINAL_ERROR_CODES = [
  'UNSAFE_URL',
  'UNSUPPORTED_MEDIA',
  'FILE_TOO_LARGE',
] as const;

export function isTerminalDownloadErrorCode(code: string | null): boolean {
  if (!code) return false;
  return (DOWNLOAD_TERMINAL_ERROR_CODES as readonly string[]).includes(code);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const DownloadJobStatusValues = [
  'queued',
  'resolving',
  'downloading',
  'done',
  'failed',
  'cancelled',
] as const;

export const DownloadJobStatusSchema = z.enum(DownloadJobStatusValues);

export type DownloadJobStatus = z.infer<typeof DownloadJobStatusSchema>;

/**
 * Legacy database labels mapped to wire statuses. `completed` was renamed
 * to `done` by the spec-149 migration and `processing` was retired; rows
 * written before the migration may still carry either label. Returns null
 * for any label that is neither current nor legacy — callers log and skip
 * such rows instead of failing the whole status response.
 */
export function toWireDownloadJobStatus(dbStatus: string): DownloadJobStatus | null {
  if (dbStatus === 'completed') return 'done';
  if (dbStatus === 'processing') return 'downloading';
  const parsed = DownloadJobStatusSchema.safeParse(dbStatus);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Row (database snake_case) → wire (camelCase) mapping
// ---------------------------------------------------------------------------

export const DownloadJobRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  source_url: z.string(),
  source_platform: DownloaderSourcePlatformSchema,
  target_folder_id: z.string().uuid().nullable(),
  status: z.string(),
  progress_percent: z.number().int().min(0).max(100),
  total_bytes: z.number().int().min(0).nullable(),
  downloaded_bytes: z.number().int().min(0),
  media_id: z.string().uuid().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempts: z.number().int().min(0),
  claimed_at: z.string().nullable(),
  claimed_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type DownloadJobRow = z.infer<typeof DownloadJobRowSchema>;

export const DownloadJobSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sourceUrl: z.string(),
  sourcePlatform: DownloaderSourcePlatformSchema,
  targetFolderId: z.string().uuid().nullable(),
  status: DownloadJobStatusSchema,
  progressPercent: z.number().int().min(0).max(100),
  totalBytes: z.number().int().min(0).nullable(),
  downloadedBytes: z.number().int().min(0),
  mediaId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DownloadJob = z.infer<typeof DownloadJobSchema>;

/**
 * Parse one database row into its wire shape. Returns null when the row
 * is malformed or carries an unrecognized status — the caller logs the
 * skip; one bad row must never break the tray for all other jobs.
 */
export function parseDownloadJobRow(row: unknown): DownloadJob | null {
  const parsed = DownloadJobRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const status = toWireDownloadJobStatus(parsed.data.status);
  if (!status) return null;
  return {
    id: parsed.data.id,
    userId: parsed.data.user_id,
    sourceUrl: parsed.data.source_url,
    sourcePlatform: parsed.data.source_platform,
    targetFolderId: parsed.data.target_folder_id,
    status,
    progressPercent: parsed.data.progress_percent,
    totalBytes: parsed.data.total_bytes,
    downloadedBytes: parsed.data.downloaded_bytes,
    mediaId: parsed.data.media_id,
    errorCode: parsed.data.error_code,
    errorMessage: parsed.data.error_message,
    createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
  };
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export const SubmitDownloadJobsRequestSchema = z.object({
  links: z
    .array(z.string().trim().min(1).max(2048))
    .min(1, 'Please paste at least one link.')
    .max(
      DOWNLOAD_JOBS_MAX_LINKS_PER_SUBMIT,
      `At most ${DOWNLOAD_JOBS_MAX_LINKS_PER_SUBMIT} links per batch.`
    ),
  folderId: z.string().uuid().nullable().optional(),
});

export type SubmitDownloadJobsRequest = z.infer<typeof SubmitDownloadJobsRequestSchema>;

export const SubmitDownloadJobsResponseSchema = z.object({
  jobs: z.array(DownloadJobSchema),
  skippedDuplicates: z.number().int().min(0),
  invalidLinks: z.array(z.string()),
});

export type SubmitDownloadJobsResponse = z.infer<typeof SubmitDownloadJobsResponseSchema>;

export const DownloadJobsStatusResponseSchema = z.object({
  jobs: z.array(DownloadJobSchema),
  /**
   * Cloudflare consumer health (spec 149 backend revision §7.1):
   * true when the consumer heartbeat is fresh, false when it is stale
   * or has never been written. Omitted when the heartbeat cannot be
   * read at all — the tray treats a missing value as unknown, never
   * as a paused state.
   */
  consumerHealthy: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Cloudflare Queue message contract (spec 149 backend revision §5.1)
// ---------------------------------------------------------------------------

/**
 * Queue message — the ONLY payload the consumer trusts blindly is the
 * id. Everything else is re-read from the job row. Validated with Zod
 * at the consumer boundary; a malformed message goes to the DLQ
 * without touching any job row.
 */
export const DownloadQueueMessageSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
});

export type DownloadQueueMessage = z.infer<typeof DownloadQueueMessageSchema>;

/** Web → Worker /enqueue request: job ids to trigger (best-effort). */
export const DownloadEnqueueRequestSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(50),
});

export type DownloadEnqueueRequest = z.infer<typeof DownloadEnqueueRequestSchema>;

export type DownloadJobsStatusResponse = z.infer<typeof DownloadJobsStatusResponseSchema>;

export const RetryDownloadJobRequestSchema = z.object({
  jobId: z.string().uuid(),
});

export type RetryDownloadJobRequest = z.infer<typeof RetryDownloadJobRequestSchema>;

export const CancelDownloadJobRequestSchema = z.object({
  jobId: z.string().uuid(),
});

export type CancelDownloadJobRequest = z.infer<typeof CancelDownloadJobRequestSchema>;

export const DownloadJobActionResponseSchema = z.object({
  job: DownloadJobSchema,
});

export type DownloadJobActionResponse = z.infer<typeof DownloadJobActionResponseSchema>;
