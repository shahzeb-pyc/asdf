import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  parseDownloadJobRow,
  type DownloadJobStatus,
} from '@fbuploadpro/contracts';
import type { CheckpointPart } from './r2-sink.js';

/**
 * Download-job persistence for the Cloudflare consumer (spec 149
 * backend revision §4.4). The consumer talks to Supabase with the
 * service key (it owns jobs for every user); the web API's
 * admin-scoped reads are a separate path and are untouched.
 *
 * Every Supabase call is bounded at 15 s: a hung DB call degrades to
 * a logged failure and a Queue redelivery, never a stuck invocation.
 * Job-row parsing still goes through the contracts row parser; a
 * malformed row is logged loudly by the caller and never silently
 * skipped into a wrong outcome.
 */

export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

export interface CheckpointState {
  uploadId: string | null;
  parts: CheckpointPart[];
  bytes: number;
  streamUrl: string | null;
}

export interface DownloadJobRecord {
  id: string;
  userId: string;
  sourceUrl: string;
  sourcePlatform: string;
  targetFolderId: string | null;
  status: DownloadJobStatus;
  progressPercent: number;
  totalBytes: number | null;
  downloadedBytes: number;
  mediaId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  claimedAt: string | null;
  claimedBy: string | null;
  pendingMediaId: string | null;
  checkpoint: CheckpointState | null;
  lastProgressAt: string | null;
}

export interface MediaItemInsert {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  fileSize: number;
  mimeType: string;
  mediaType: string;
  storageKey: string;
  url: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  captionText: string | null;
}

export interface JobPatch {
  status?: DownloadJobStatus | undefined;
  progressPercent?: number | undefined;
  totalBytes?: number | null | undefined;
  downloadedBytes?: number | undefined;
  mediaId?: string | null | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  claimedAt?: string | null | undefined;
  claimedBy?: string | null | undefined;
  pendingMediaId?: string | null | undefined;
  /** Checkpoint to write; null clears it. */
  checkpoint?: CheckpointState | null | undefined;
  lastProgressAt?: string | null | undefined;
}

export interface JobStore {
  fetchJob(jobId: string): Promise<DownloadJobRecord | null>;
  updateJob(jobId: string, patch: JobPatch): Promise<void>;
  /** Insert with ON CONFLICT DO NOTHING on id (idempotent retry, §4.1). */
  insertMediaItems(items: MediaItemInsert[]): Promise<void>;
  claimJobs(workerId: string, userId: string, limit: number): Promise<DownloadJobRecord[]>;
  upsertHeartbeat(workerId: string): Promise<void>;
  /** Queued jobs, oldest first, capped — the Cron sweeper's input. */
  sweepQueuedJobs(limit: number): Promise<Array<{ id: string; userId: string }>>;
  /** Active (resolving/downloading/processing) jobs for one user. */
  countActiveJobs(userId: string): Promise<number>;
  /**
   * Requeue jobs stuck in resolving/downloading with no progress
   * update for staleMinutes. Checkpoint is KEPT so the next attempt
   * resumes (§7). Returns the number requeued.
   */
  reclaimStaleJobs(staleMinutes: number): Promise<number>;
}

function toRecord(row: Record<string, unknown>): DownloadJobRecord | null {
  const parsed = parseDownloadJobRow(row);
  if (!parsed) return null;
  const attempts = row['attempts'];
  const claimedAt = row['claimed_at'];
  const claimedBy = row['claimed_by'];
  const pendingMediaId = row['pending_media_id'];
  const r2UploadId = row['r2_upload_id'];
  const checkpointParts = row['checkpoint_parts'];
  const checkpointBytes = row['checkpoint_bytes'];
  const checkpointStreamUrl = row['checkpoint_stream_url'];
  const lastProgressAt = row['last_progress_at'];
  const parts: CheckpointPart[] = Array.isArray(checkpointParts)
    ? (checkpointParts as Array<Record<string, unknown>>)
        .filter(
          (part) =>
            typeof part['partNumber'] === 'number' && typeof part['etag'] === 'string'
        )
        .map((part) => ({
          partNumber: part['partNumber'] as number,
          etag: part['etag'] as string,
        }))
    : [];
  const hasCheckpoint =
    typeof r2UploadId === 'string' ||
    parts.length > 0 ||
    (typeof checkpointBytes === 'number' && checkpointBytes > 0);
  return {
    id: parsed.id,
    userId: parsed.userId,
    sourceUrl: parsed.sourceUrl,
    sourcePlatform: parsed.sourcePlatform,
    targetFolderId: parsed.targetFolderId,
    status: parsed.status,
    progressPercent: parsed.progressPercent,
    totalBytes: parsed.totalBytes,
    downloadedBytes: parsed.downloadedBytes,
    mediaId: parsed.mediaId,
    errorCode: parsed.errorCode,
    errorMessage: parsed.errorMessage,
    attempts: typeof attempts === 'number' ? attempts : 0,
    claimedAt: typeof claimedAt === 'string' ? claimedAt : null,
    claimedBy: typeof claimedBy === 'string' ? claimedBy : null,
    pendingMediaId: typeof pendingMediaId === 'string' ? pendingMediaId : null,
    checkpoint: hasCheckpoint
      ? {
          uploadId: typeof r2UploadId === 'string' ? r2UploadId : null,
          parts,
          bytes: typeof checkpointBytes === 'number' ? checkpointBytes : 0,
          streamUrl: typeof checkpointStreamUrl === 'string' ? checkpointStreamUrl : null,
        }
      : null,
    lastProgressAt: typeof lastProgressAt === 'string' ? lastProgressAt : null,
  };
}

function toRowPatch(patch: JobPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row['status'] = patch.status;
  if (patch.progressPercent !== undefined) row['progress_percent'] = patch.progressPercent;
  if (patch.totalBytes !== undefined) row['total_bytes'] = patch.totalBytes;
  if (patch.downloadedBytes !== undefined) row['downloaded_bytes'] = patch.downloadedBytes;
  if (patch.mediaId !== undefined) row['media_id'] = patch.mediaId;
  if (patch.errorCode !== undefined) row['error_code'] = patch.errorCode;
  if (patch.errorMessage !== undefined) row['error_message'] = patch.errorMessage;
  if (patch.claimedAt !== undefined) row['claimed_at'] = patch.claimedAt;
  if (patch.claimedBy !== undefined) row['claimed_by'] = patch.claimedBy;
  if (patch.pendingMediaId !== undefined) row['pending_media_id'] = patch.pendingMediaId;
  if (patch.checkpoint !== undefined) {
    if (patch.checkpoint === null) {
      row['r2_upload_id'] = null;
      row['checkpoint_parts'] = [];
      row['checkpoint_bytes'] = 0;
      row['checkpoint_stream_url'] = null;
    } else {
      row['r2_upload_id'] = patch.checkpoint.uploadId;
      row['checkpoint_parts'] = patch.checkpoint.parts;
      row['checkpoint_bytes'] = patch.checkpoint.bytes;
      row['checkpoint_stream_url'] = patch.checkpoint.streamUrl;
    }
  }
  if (patch.lastProgressAt !== undefined) row['last_progress_at'] = patch.lastProgressAt;
  return row;
}

function fetchWithTimeout(
  url: string | URL | Request,
  options?: RequestInit
): Promise<Response> {
  const timeout = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  let signal = timeout;
  if (options?.signal && typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([options.signal, timeout]);
  }
  return fetch(url, { ...options, signal });
}

export function createSupabaseClient(
  supabaseUrl: string,
  serviceRoleKey: string
): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // No PostgREST retries: supabase-js retries idempotent GETs on
    // network errors with 1s+2s+4s backoff (~7s per call), which
    // burns Worker CPU time on a dead DB. The Queue's own
    // redelivery is the retry mechanism; a failed call must surface
    // fast so the message can be redelivered with backoff instead.
    db: { retry: false },
    global: { fetch: fetchWithTimeout },
  });
}

export class SupabaseJobStore implements JobStore {
  constructor(private readonly client: SupabaseClient) {}

  async fetchJob(jobId: string): Promise<DownloadJobRecord | null> {
    const { data, error } = await this.client
      .from('media_download_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();
    if (error) throw new Error(`fetchJob failed: ${error.message}`);
    if (!data) return null;
    return toRecord(data as Record<string, unknown>);
  }

  async updateJob(jobId: string, patch: JobPatch): Promise<void> {
    const { error } = await this.client
      .from('media_download_jobs')
      .update(toRowPatch(patch))
      .eq('id', jobId);
    if (error) throw new Error(`updateJob failed: ${error.message}`);
  }

  async insertMediaItems(items: MediaItemInsert[]): Promise<void> {
    if (items.length === 0) return;
    const rows = items.map((item) => ({
      id: item.id,
      user_id: item.userId,
      folder_id: item.folderId,
      name: item.name,
      file_size: item.fileSize,
      mime_type: item.mimeType,
      media_type: item.mediaType,
      storage_key: item.storageKey,
      url: item.url,
      thumbnail_key: item.thumbnailKey,
      thumbnail_url: item.thumbnailUrl,
      duration_seconds: item.durationSeconds,
      aspect_ratio: item.aspectRatio,
      caption_text: item.captionText,
    }));
    const { error } = await this.client
      .from('media_items')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error(`insertMediaItems failed: ${error.message}`);
  }

  async claimJobs(
    workerId: string,
    userId: string,
    limit: number
  ): Promise<DownloadJobRecord[]> {
    const { data, error } = await this.client.rpc('claim_download_jobs', {
      p_worker_id: workerId,
      p_user_id: userId,
      p_limit: limit,
    });
    if (error) throw new Error(`claim_download_jobs failed: ${error.message}`);
    const records: DownloadJobRecord[] = [];
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const record = toRecord(row);
      if (record) records.push(record);
    }
    return records;
  }

  async upsertHeartbeat(workerId: string): Promise<void> {
    const { error } = await this.client
      .from('download_worker_heartbeats')
      .upsert({ worker_id: workerId, heartbeat_at: new Date().toISOString() });
    if (error) throw new Error(`upsertHeartbeat failed: ${error.message}`);
  }

  async sweepQueuedJobs(limit: number): Promise<Array<{ id: string; userId: string }>> {
    const { data, error } = await this.client
      .from('media_download_jobs')
      .select('id,user_id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`sweepQueuedJobs failed: ${error.message}`);
    const jobs: Array<{ id: string; userId: string }> = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row['id'];
      const userId = row['user_id'];
      if (typeof id === 'string' && typeof userId === 'string') {
        jobs.push({ id, userId });
      }
    }
    return jobs;
  }

  async countActiveJobs(userId: string): Promise<number> {
    const { count, error } = await this.client
      .from('media_download_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['resolving', 'downloading', 'processing']);
    if (error) throw new Error(`countActiveJobs failed: ${error.message}`);
    return count ?? 0;
  }

  async reclaimStaleJobs(staleMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    let total = 0;
    // Jobs that wrote progress, then went silent.
    const withProgress = await this.client
      .from('media_download_jobs')
      .update({ status: 'queued', claimed_at: null, claimed_by: null })
      .in('status', ['resolving', 'downloading'])
      .lt('last_progress_at', cutoff)
      .select('id');
    if (withProgress.error) {
      throw new Error(`reclaimStaleJobs failed: ${withProgress.error.message}`);
    }
    total += withProgress.data?.length ?? 0;
    // Jobs that died during resolve before any progress write: their
    // claim timestamp is the only liveness signal available.
    const withoutProgress = await this.client
      .from('media_download_jobs')
      .update({ status: 'queued', claimed_at: null, claimed_by: null })
      .in('status', ['resolving', 'downloading'])
      .is('last_progress_at', null)
      .lt('claimed_at', cutoff)
      .select('id');
    if (withoutProgress.error) {
      throw new Error(`reclaimStaleJobs failed: ${withoutProgress.error.message}`);
    }
    total += withoutProgress.data?.length ?? 0;
    return total;
  }
}
