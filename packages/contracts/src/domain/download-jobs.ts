import { z } from 'zod';

import { DownloaderSourcePlatformSchema } from './downloader.js';

/**
 * Persistent download jobs (spec 149). One row per pasted link in the
 * pre-existing `media_download_jobs` table — this module is the wire
 * truth for the submit / status / retry / cancel API and for the VPS
 * worker that claims and processes the rows. It does not create a
 * second jobs model: the table already existed (spec 140), and the
 * spec-149 migration only extends it (claim lease, attempts, the
 * `resolving` state, `done` replacing the legacy `completed` label).
 */

// ---------------------------------------------------------------------------
// Constants (spec 149 — single source, no magic numbers in consumers)
// ---------------------------------------------------------------------------

/** Downloads running at once per workspace (per user in this repo's model). */
export const DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY = 3;

/** Links accepted in one submit batch. */
export const DOWNLOAD_JOBS_MAX_LINKS_PER_SUBMIT = 50;

/** Minimum gap between progress writes for one job (worker-side throttle). */
export const DOWNLOAD_JOB_PROGRESS_UPDATE_MIN_INTERVAL_MS = 1000;

/** Worker poll interval for new / stale work. */
export const DOWNLOAD_WORKER_POLL_INTERVAL_MS = 5000;

/** A claim older than this with no live worker heartbeat may be reclaimed. */
export const DOWNLOAD_WORKER_STALE_CLAIM_MINUTES = 10;

/** A worker heartbeat older than this counts the worker as down. */
export const DOWNLOAD_WORKER_HEARTBEAT_STALE_MINUTES = 2;

/** Hard cap enforced mid-stream by the worker (500 MB). */
export const DOWNLOAD_JOB_MAX_BYTES = 524_288_000;

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
});

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
