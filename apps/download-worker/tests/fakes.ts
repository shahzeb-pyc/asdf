import type { IStorageService } from '@fbuploadpro/contracts';
import type {
  DownloadJobRecord,
  JobPatch,
  JobStore,
  MediaItemInsert,
} from '../src/store.js';

/**
 * Test fakes for the download consumer. The FakeStore replicates the
 * claim RPC's semantics faithfully (active cap, oldest-first,
 * attempts increment) so cap tests prove the real rule, not a stub.
 * The FakeBucket replicates the R2 binding's multipart surface.
 */

export const USER_ID = '11111111-1111-4111-a111-111111111111';
export const JOB_ID = '22222222-2222-4222-a222-222222222222';

// Scalar job fields copied verbatim from a patch (checkpoint is special:
// it deep-copies its parts, so it is handled separately in updateJob).
const SCALAR_JOB_FIELDS = [
  'status',
  'progressPercent',
  'totalBytes',
  'downloadedBytes',
  'mediaId',
  'errorCode',
  'errorMessage',
  'claimedAt',
  'claimedBy',
  'pendingMediaId',
  'lastProgressAt',
] as const;

// Mirrors the real store's stale rule: an active job is stale when its
// last progress write is older than the cutoff, or when it never wrote
// progress and its claim is older than the cutoff.
function isStaleJob(job: DownloadJobRecord, cutoff: number): boolean {
  if (job.status !== 'resolving' && job.status !== 'downloading') return false;
  const progressTime = job.lastProgressAt ? new Date(job.lastProgressAt).getTime() : Number.NaN;
  const claimTime = job.claimedAt ? new Date(job.claimedAt).getTime() : Number.NaN;
  const progressStale = !Number.isNaN(progressTime) && progressTime < cutoff;
  const claimStale =
    Number.isNaN(progressTime) && !Number.isNaN(claimTime) && claimTime < cutoff;
  return progressStale || claimStale;
}

export function makeJob(overrides: Partial<DownloadJobRecord> = {}): DownloadJobRecord {
  return {
    id: JOB_ID,
    userId: USER_ID,
    sourceUrl: 'https://example.com/video.mp4',
    sourcePlatform: 'direct',
    targetFolderId: null,
    status: 'resolving',
    progressPercent: 0,
    totalBytes: null,
    downloadedBytes: 0,
    mediaId: null,
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    claimedAt: new Date().toISOString(),
    claimedBy: 'cf-download-consumer',
    pendingMediaId: null,
    checkpoint: null,
    lastProgressAt: new Date().toISOString(),
    ...overrides,
  };
}

export class FakeStore implements JobStore {
  readonly jobs = new Map<string, DownloadJobRecord>();
  readonly mediaItems: MediaItemInsert[] = [];
  readonly updateCalls: Array<{ jobId: string; patch: JobPatch }> = [];
  heartbeatIds: string[] = [];
  /** Override fetchJob per call index (e.g. cancel-after-first-part). */
  fetchJobOverride: ((jobId: string, call: number) => DownloadJobRecord | null) | null = null;
  private fetchCalls = 0;

  constructor(jobs: DownloadJobRecord[] = []) {
    for (const job of jobs) this.jobs.set(job.id, { ...job });
  }

  async fetchJob(jobId: string): Promise<DownloadJobRecord | null> {
    this.fetchCalls += 1;
    if (this.fetchJobOverride) {
      return this.fetchJobOverride(jobId, this.fetchCalls);
    }
    const job = this.jobs.get(jobId);
    return job ? { ...job, checkpoint: job.checkpoint ? { ...job.checkpoint, parts: [...job.checkpoint.parts] } : null } : null;
  }

  async updateJob(jobId: string, patch: JobPatch): Promise<void> {
    this.updateCalls.push({ jobId, patch });
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const field of SCALAR_JOB_FIELDS) {
      const value = patch[field];
      if (value !== undefined) {
        // Union-keyed writes resolve to never (field value types differ),
        // so assign through a record view; the value comes from the typed patch.
        (job as unknown as Record<(typeof SCALAR_JOB_FIELDS)[number], unknown>)[field] = value;
      }
    }
    if (patch.checkpoint !== undefined) {
      job.checkpoint =
        patch.checkpoint === null
          ? null
          : { ...patch.checkpoint, parts: [...patch.checkpoint.parts] };
    }
  }

  async insertMediaItems(items: MediaItemInsert[]): Promise<void> {
    for (const item of items) {
      // ON CONFLICT DO NOTHING on id (spec §4.1).
      if (!this.mediaItems.some((row) => row.id === item.id)) {
        this.mediaItems.push({ ...item });
      }
    }
  }

  async claimJobs(
    workerId: string,
    userId: string,
    limit: number
  ): Promise<DownloadJobRecord[]> {
    const active = [...this.jobs.values()].filter(
      (job) =>
        job.userId === userId &&
        (job.status === 'resolving' || job.status === 'downloading')
    ).length;
    const slots = Math.max(0, limit - active);
    const queued = [...this.jobs.values()]
      .filter((job) => job.userId === userId && job.status === 'queued')
      .slice(0, slots);
    const claimed: DownloadJobRecord[] = [];
    for (const job of queued) {
      job.status = 'resolving';
      job.claimedAt = new Date().toISOString();
      job.claimedBy = workerId;
      job.attempts += 1;
      claimed.push({ ...job });
    }
    return claimed;
  }

  async upsertHeartbeat(workerId: string): Promise<void> {
    this.heartbeatIds.push(workerId);
  }

  async sweepQueuedJobs(limit: number): Promise<Array<{ id: string; userId: string }>> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'queued')
      .slice(0, limit)
      .map((job) => ({ id: job.id, userId: job.userId }));
  }

  async countActiveJobs(userId: string): Promise<number> {
    return [...this.jobs.values()].filter(
      (job) =>
        job.userId === userId &&
        (job.status === 'resolving' || job.status === 'downloading')
    ).length;
  }

  async reclaimStaleJobs(staleMinutes: number): Promise<number> {
    const cutoff = Date.now() - staleMinutes * 60_000;
    let count = 0;
    for (const job of this.jobs.values()) {
      if (isStaleJob(job, cutoff)) {
        job.status = 'queued';
        job.claimedAt = null;
        job.claimedBy = null;
        count += 1;
      }
    }
    return count;
  }
}

interface FakeUploadState {
  key: string;
  parts: Map<number, { etag: string; bytes: number }>;
  aborted: boolean;
  completed: { partNumbers: number[]; totalBytes: number } | null;
}

export class FakeBucket {
  readonly uploads = new Map<string, FakeUploadState>();
  readonly objects = new Map<string, Uint8Array>();
  readonly deletedKeys: string[] = [];
  private uploadCounter = 0;

  private uploadObject(uploadId: string): {
    uploadId: string;
    uploadPart: (partNumber: number, value: unknown) => Promise<{ partNumber: number; etag: string }>;
    complete: (parts: Array<{ partNumber: number; etag: string }>) => Promise<unknown>;
    abort: () => Promise<void>;
  } {
    const state = this.uploads.get(uploadId);
    if (!state) throw new Error(`unknown upload ${uploadId}`);
    return {
      uploadId,
      uploadPart: async (partNumber: number, value: unknown) => {
        const bytes = toBytes(value);
        const etag = `etag-${partNumber}`;
        state.parts.set(partNumber, { etag, bytes: bytes.byteLength });
        return { partNumber, etag };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        let total = 0;
        for (const part of parts) {
          total += state.parts.get(part.partNumber)?.bytes ?? 0;
        }
        state.completed = { partNumbers: parts.map((p) => p.partNumber), totalBytes: total };
        return { key: state.key };
      },
      abort: async () => {
        state.aborted = true;
      },
    };
  }

  async createMultipartUpload(key: string): Promise<ReturnType<FakeBucket['uploadObject']>> {
    this.uploadCounter += 1;
    const uploadId = `upload-${this.uploadCounter}`;
    this.uploads.set(uploadId, { key, parts: new Map(), aborted: false, completed: null });
    return this.uploadObject(uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): ReturnType<FakeBucket['uploadObject']> {
    if (!this.uploads.has(uploadId)) {
      this.uploads.set(uploadId, { key, parts: new Map(), aborted: false, completed: null });
    }
    return this.uploadObject(uploadId);
  }

  async put(key: string, value: unknown): Promise<unknown> {
    this.objects.set(key, toBytes(value));
    return { key };
  }

  async delete(key: string | string[]): Promise<void> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      this.objects.delete(k);
      this.deletedKeys.push(k);
    }
  }

  async head(_key: string): Promise<null> {
    return null;
  }

  async get(_key: string): Promise<null> {
    return null;
  }

  async list(): Promise<{ objects: unknown[] }> {
    return { objects: [] };
  }
}

export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Blob) throw new Error('Blob values are not supported by the test fake');
  throw new Error(`Unsupported fake bucket value type: ${typeof value}`);
}

export class FakeStorage implements IStorageService {
  readonly putKeys: string[] = [];
  readonly deletedKeys: string[] = [];
  constructor(private readonly publicUrlBase: string) {}

  async getPresignedUploadUrl(): Promise<never> {
    throw new Error('not supported in tests');
  }

  async putObject(params: { key: string; body: Uint8Array; contentType: string }): Promise<{
    key: string;
    publicUrl: string;
    byteLength: number;
  }> {
    this.putKeys.push(params.key);
    return {
      key: params.key,
      publicUrl: `${this.publicUrlBase}/${params.key}`,
      byteLength: params.body.byteLength,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }

  getPublicUrl(key: string): string {
    return `${this.publicUrlBase}/${key}`;
  }
}

export interface MediaFetchOptions {
  rangeSupported?: boolean | undefined;
  contentType?: string | undefined;
  chunkSize?: number | undefined;
  servedBytes?: { total: number } | undefined;
  requestedUrls?: string[] | undefined;
  requestedRanges?: Array<string | null> | undefined;
  status?: number | undefined;
  /** Omit content-length: exercises the mid-stream cap, not the declared one. */
  omitContentLength?: boolean | undefined;
}

/**
 * Fake fetch serving one media file. Records every URL and Range
 * header so tests can prove a resume fetched only the remaining
 * bytes (Range) or restarted (no Range).
 */
function readRangeHeader(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get('Range');
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === 'range');
    return entry ? entry[1] : null;
  }
  if (headers && typeof headers === 'object') {
    const record = headers as Record<string, string>;
    const key = Object.keys(record).find((k) => k.toLowerCase() === 'range');
    return key ? (record[key] ?? null) : null;
  }
  return null;
}

export function makeMediaFetch(
  totalBytes: number,
  options: MediaFetchOptions = {}
): typeof fetch {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  const rangeSupported = options.rangeSupported ?? true;
  const contentType = options.contentType ?? 'video/mp4';
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    options.requestedUrls?.push(url);
    const rangeHeader = readRangeHeader(init);
    options.requestedRanges?.push(rangeHeader);

    let start = 0;
    let status = options.status ?? 200;
    if (rangeHeader && rangeSupported) {
      const match = /bytes=(\d+)-/.exec(rangeHeader);
      start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      status = 206;
    }
    const remaining = totalBytes - start;
    const responseHeaders = new Headers({ 'content-type': contentType });
    if (!options.omitContentLength) {
      responseHeaders.set('content-length', String(remaining));
    }
    if (status === 206) {
      responseHeaders.set('content-range', `bytes ${start}-${totalBytes - 1}/${totalBytes}`);
    }
    // Pull-based: one chunk per read, so a 500 MB test stream never
    // buffers in memory (a start()-enqueueing stream would).
    let offset = start;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, totalBytes - offset);
        controller.enqueue(new Uint8Array(size));
        if (options.servedBytes) options.servedBytes.total += size;
        offset += size;
      },
    });
    return new Response(stream, { status, headers: responseHeaders });
  }) as unknown as typeof fetch;
}

export const MB = 1024 * 1024;
