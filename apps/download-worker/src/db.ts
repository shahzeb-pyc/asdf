import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  parseDownloadJobRow,
  type DownloadJobStatus,
} from '@fbuploadpro/contracts';

/**
 * Download-job persistence for the worker (spec 149). The worker talks
 * to Supabase with the service key (it owns jobs for every user); the
 * web API's RLS-scoped reads are a separate path and are untouched.
 *
 * All reads go through the contracts row parser, so a malformed row
 * is skipped loudly (logged by the caller) instead of crashing the
 * loop. The `JobStore` interface keeps process-job unit-testable
 * without a database.
 */

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
  status?: DownloadJobStatus;
  progressPercent?: number;
  totalBytes?: number | null;
  downloadedBytes?: number;
  mediaId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  claimedAt?: string | null;
  claimedBy?: string | null;
}

export interface JobStore {
  fetchJob(jobId: string): Promise<DownloadJobRecord | null>;
  updateJob(jobId: string, patch: JobPatch): Promise<void>;
  insertMediaItems(items: MediaItemInsert[]): Promise<void>;
  usersWithQueuedJobs(limit: number): Promise<string[]>;
  claimJobs(workerId: string, userId: string, limit: number): Promise<DownloadJobRecord[]>;
  upsertHeartbeat(workerId: string): Promise<void>;
  staleWorkerIds(staleMinutes: number): Promise<string[]>;
  reclaimStaleClaims(staleWorkerIds: string[], staleClaimMinutes: number): Promise<number>;
}

function toRecord(row: Record<string, unknown>): DownloadJobRecord | null {
  const parsed = parseDownloadJobRow(row);
  if (!parsed) return null;
  const attempts = row['attempts'];
  const claimedAt = row['claimed_at'];
  const claimedBy = row['claimed_by'];
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
  return row;
}

/**
 * Supabase's JS client ships no request timeout: a hung database call
 * would stall the worker's tick — and a SIGTERM during that stall
 * would wait minutes instead of seconds. Every request is therefore
 * bounded at 15 s (the same budget as the web app's R2 calls), so a
 * dead database degrades to logged tick failures, never a stuck loop.
 */
export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

function fetchWithTimeout(
  url: string | URL | Request,
  options?: RequestInit
): Promise<Response> {
  const timeout = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  return fetch(url, { ...options, signal });
}

export function createSupabaseClient(
  supabaseUrl: string,
  serviceRoleKey: string
): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
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
    const { error } = await this.client.from('media_items').insert(rows);
    if (error) throw new Error(`insertMediaItems failed: ${error.message}`);
  }

  async usersWithQueuedJobs(limit: number): Promise<string[]> {
    const { data, error } = await this.client
      .from('media_download_jobs')
      .select('user_id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw new Error(`usersWithQueuedJobs failed: ${error.message}`);
    const users: string[] = [];
    const seen = new Set<string>();
    for (const row of data ?? []) {
      const userId = (row as { user_id?: unknown })['user_id'];
      if (typeof userId === 'string' && !seen.has(userId)) {
        seen.add(userId);
        users.push(userId);
        if (users.length >= limit) break;
      }
    }
    return users;
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

  async staleWorkerIds(staleMinutes: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const { data, error } = await this.client
      .from('download_worker_heartbeats')
      .select('worker_id')
      .lt('heartbeat_at', cutoff);
    if (error) throw new Error(`staleWorkerIds failed: ${error.message}`);
    return (data ?? [])
      .map((row) => (row as { worker_id?: unknown })['worker_id'])
      .filter((id): id is string => typeof id === 'string');
  }

  async reclaimStaleClaims(
    staleWorkerIds: string[],
    staleClaimMinutes: number
  ): Promise<number> {
    if (staleWorkerIds.length === 0) return 0;
    const cutoff = new Date(Date.now() - staleClaimMinutes * 60_000).toISOString();
    const { data, error } = await this.client
      .from('media_download_jobs')
      .update({ status: 'queued', claimed_at: null, claimed_by: null })
      .in('claimed_by', staleWorkerIds)
      .in('status', ['resolving', 'downloading'])
      .lt('claimed_at', cutoff)
      .select('id');
    if (error) throw new Error(`reclaimStaleClaims failed: ${error.message}`);
    return data?.length ?? 0;
  }
}
