import {
  DOWNLOAD_JOB_ATTEMPTS_CAP,
  DOWNLOAD_JOB_PROGRESS_UPDATE_MIN_INTERVAL_MS,
  isTerminalDownloadErrorCode,
  type IStorageService,
} from '@fbuploadpro/contracts';
import {
  downloadAndStoreCandidate,
  JobCancelledError,
  MediaDownloaderError,
  resolveCandidates,
  ResumeUnsupportedError,
  validateAndNormalizeStreamUrl,
  type DownloadedItem,
  type MediaStreamSink,
  type ResolveCandidatesResult,
} from './engine/index.js';
import type { CheckpointPart } from './r2-sink.js';
import type {
  DownloadJobRecord,
  JobStore,
  MediaItemInsert,
} from './store.js';

/**
 * One claimed download job, end to end (spec 149 backend revision).
 *
 * Differences from the retired VPS worker, all required by the
 * Cloudflare revision:
 * - No cancel-watcher timer: cancellation is checked between parts
 *   (the sink's onPart callback re-reads the job row) and before
 *   work, and a cancelled row is never overwritten by a failure.
 * - Deterministic media id (§4.1): the consumer (or this module as
 *   a fallback) writes pending_media_id to the job row BEFORE any
 *   byte streams, the first library row uses that id, and inserts
 *   are ON CONFLICT DO NOTHING — so a crash between media insert
 *   and the done update can never create a second library copy.
 * - Checkpoint/resume (§6.3): each completed part writes its ETag
 *   to the job row; a re-claimed job resumes the same multipart
 *   upload from its checkpoint instead of re-downloading it.
 * - Attempts cap (§8.1): a job failing at or beyond 5 attempts has
 *   its checkpoint cleared with the failure — no more retries.
 */

export type ProcessJobOutcome = 'done' | 'failed' | 'cancelled';

export interface ResumableSink extends MediaStreamSink {
  currentUploadId: string | null;
  currentParts: CheckpointPart[];
  currentTotalBytes: number;
}

export interface ResumeSinkState {
  uploadId: string | null;
  parts: CheckpointPart[];
  initialBytes: number;
}

export interface ProcessJobDeps {
  store: JobStore;
  storage: IStorageService;
  createSink: (
    key: string,
    contentType: string,
    resume?: ResumeSinkState | undefined,
    onPart?: (() => Promise<void>) | undefined
  ) => ResumableSink;
  resolve?: (
    sourceUrl: string,
    fetchFn: typeof fetch,
    extractorApiUrl: string | null
  ) => Promise<ResolveCandidatesResult>;
  fetchFn?: typeof fetch | undefined;
  extractorApiUrl?: string | null | undefined;
  /** Minimum gap between progress-row writes (default 1000 ms). */
  progressUpdateMinIntervalMs?: number | undefined;
  log?: ((message: string, context?: Record<string, unknown>) => void) | undefined;
}

function resumeStateForCandidate(
  fresh: DownloadJobRecord,
  normalizedStreamUrl: string
): { streamUrl: string; bytes: number } | undefined {
  if (
    fresh.checkpoint !== null &&
    fresh.checkpoint.streamUrl === normalizedStreamUrl &&
    fresh.checkpoint.bytes > 0
  ) {
    return { streamUrl: normalizedStreamUrl, bytes: fresh.checkpoint.bytes };
  }
  return undefined;
}

type JobLogger = (message: string, context?: Record<string, unknown>) => void;

interface FinaliseArgs {
  store: JobStore;
  storage: IStorageService;
  items: DownloadedItem[];
  userId: string;
  targetFolderId: string | null;
  pendingMediaId: string;
  jobId: string;
  log: JobLogger;
  failJob: (errorCode: string, errorMessage: string) => Promise<void>;
}

// Runs after the last byte streamed: re-reads the row (the user may
// have cancelled while it streamed), then either drops the uploads,
// adopts a duplicate attempt's file, or inserts and marks done.
async function finaliseDownload(args: FinaliseArgs): Promise<ProcessJobOutcome> {
  const afterResolve = await args.store.fetchJob(args.jobId);
  if (!afterResolve) {
    args.log('job row vanished after resolve', { jobId: args.jobId });
    return 'failed';
  }
  if (afterResolve.status === 'cancelled') {
    await deleteItems(args.storage, args.items, args.log, args.jobId);
    return 'cancelled';
  }
  if (afterResolve.mediaId) {
    // A duplicate attempt already saved this file: drop ours.
    await deleteItems(args.storage, args.items, args.log, args.jobId);
    await args.store.updateJob(args.jobId, {
      status: 'done',
      progressPercent: 100,
      mediaId: afterResolve.mediaId,
    });
    return 'done';
  }

  const inserts = args.items.map((item) =>
    toMediaItemInsert(item, args.userId, args.targetFolderId)
  );
  try {
    await args.store.insertMediaItems(inserts);
  } catch (error) {
    args.log('media insert failed, deleting uploaded objects', {
      jobId: args.jobId,
      error: String(error),
    });
    await deleteItems(args.storage, args.items, args.log, args.jobId);
    await args.failJob(
      'DOWNLOAD_FAILED',
      'The download finished but could not be saved to your library.'
    );
    return 'failed';
  }

  const totalBytes = args.items.reduce((sum, item) => sum + item.fileSize, 0);
  await args.store.updateJob(args.jobId, {
    status: 'done',
    progressPercent: 100,
    downloadedBytes: totalBytes,
    totalBytes,
    mediaId: args.items[0]?.mediaId ?? args.pendingMediaId,
    checkpoint: null,
  });
  return 'done';
}

// A cancelled row is never overwritten by a failure update.
async function handleProcessingError(args: {
  error: unknown;
  store: JobStore;
  jobId: string;
  log: JobLogger;
  failJob: (errorCode: string, errorMessage: string) => Promise<void>;
}): Promise<ProcessJobOutcome> {
  const current = await args.store.fetchJob(args.jobId).catch(() => null);
  if (current?.status === 'cancelled') return 'cancelled';
  if (args.error instanceof JobCancelledError) {
    // The row was cancelled (onPart saw it); nothing to overwrite.
    return 'cancelled';
  }
  if (args.error instanceof MediaDownloaderError) {
    await args.failJob(args.error.code, args.error.message);
    return 'failed';
  }
  args.log('unexpected download error', { jobId: args.jobId, error: String(args.error) });
  await args.failJob('DOWNLOAD_FAILED', 'The download failed. Please try again.');
  return 'failed';
}

// The in-flight sink, shared between the part callback (which
// checkpoints it) and the candidate runner (which creates it).
interface SinkState {
  current: ResumableSink | null;
  streamUrl: string | null;
}

interface StreamCandidatesArgs {
  candidates: ResolveCandidatesResult['candidates'];
  prefetchedBinaryResponse: ResolveCandidatesResult['prefetchedBinaryResponse'];
  fresh: DownloadJobRecord;
  storage: IStorageService;
  fetchFn: typeof fetch;
  pendingMediaId: string;
  onProgress: (progress: { downloadedBytes: number; totalBytes: number | null }) => void;
  onPart: () => Promise<void>;
  createSink: ProcessJobDeps['createSink'];
  sinkState: SinkState;
  store: JobStore;
  jobId: string;
}

// Candidates run SEQUENTIALLY (§3.2): one invocation has 6
// simultaneous outgoing connections and 128 MB memory.
async function streamCandidates(args: StreamCandidatesArgs): Promise<DownloadedItem[]> {
  const items: DownloadedItem[] = [];
  for (let idx = 0; idx < args.candidates.length; idx += 1) {
    const candidate = args.candidates[idx];
    if (!candidate) continue;
    const normalizedStreamUrl = validateAndNormalizeStreamUrl(candidate.streamUrl);
    let resumeForCandidate = resumeStateForCandidate(args.fresh, normalizedStreamUrl);
    let restartDone = false;

    const runCandidate = async (): Promise<DownloadedItem> => {
      const createSink = (key: string, contentType: string): MediaStreamSink => {
        const sink = args.createSink(
          key,
          contentType,
          resumeForCandidate && args.fresh.checkpoint
            ? {
                uploadId: args.fresh.checkpoint.uploadId,
                parts: args.fresh.checkpoint.parts,
                initialBytes: args.fresh.checkpoint.bytes,
              }
            : undefined,
          args.onPart
        );
        args.sinkState.current = sink;
        args.sinkState.streamUrl = normalizedStreamUrl;
        return sink;
      };
      return downloadAndStoreCandidate({
        candidate,
        index: idx,
        userId: args.fresh.userId,
        storage: args.storage,
        fetchFn: args.fetchFn,
        prefetchedResponse:
          idx === 0 && !resumeForCandidate ? args.prefetchedBinaryResponse : undefined,
        forcedMediaId: idx === 0 ? args.pendingMediaId : undefined,
        resume: resumeForCandidate,
        onProgress: args.onProgress,
        createSink,
      });
    };

    let item: DownloadedItem;
    try {
      item = await runCandidate();
    } catch (error) {
      if (error instanceof ResumeUnsupportedError && !restartDone) {
        // Source refuses Range: clear the checkpoint and restart
        // this candidate from byte 0 once, in the same attempt.
        restartDone = true;
        resumeForCandidate = undefined;
        await args.store.updateJob(args.jobId, { checkpoint: null });
        args.fresh.checkpoint = null;
        args.sinkState.current = null;
        args.sinkState.streamUrl = null;
        item = await runCandidate();
      } else {
        throw error;
      }
    }
    items.push(item);
    args.sinkState.current = null;
    args.sinkState.streamUrl = null;
  }
  return items;
}

function toMediaItemInsert(
  item: DownloadedItem,
  userId: string,
  folderId: string | null
): MediaItemInsert {
  return {
    id: item.mediaId,
    userId,
    folderId,
    name: item.name,
    fileSize: item.fileSize,
    mimeType: item.mimeType,
    mediaType: item.mediaType,
    storageKey: item.storageKey,
    url: item.url,
    thumbnailKey: item.thumbnailKey,
    thumbnailUrl: item.thumbnailUrl,
    durationSeconds: item.durationSeconds,
    aspectRatio: item.aspectRatio,
    captionText: item.captionText,
  };
}

export async function processClaimedJob(
  job: DownloadJobRecord,
  deps: ProcessJobDeps
): Promise<ProcessJobOutcome> {
  const log = deps.log ?? (() => {});
  const store = deps.store;
  const resolve = deps.resolve ?? resolveCandidates;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const progressMinInterval =
    deps.progressUpdateMinIntervalMs ?? DOWNLOAD_JOB_PROGRESS_UPDATE_MIN_INTERVAL_MS;

  const fresh = await store.fetchJob(job.id);
  if (!fresh) {
    log('job row vanished before processing', { jobId: job.id });
    return 'failed';
  }
  if (fresh.status === 'cancelled') return 'cancelled';
  // Idempotent retry: a previous attempt already saved the file.
  if (fresh.mediaId) {
    await store.updateJob(job.id, {
      status: 'done',
      progressPercent: 100,
      mediaId: fresh.mediaId,
    });
    return 'done';
  }

  // §4.1: the media id is fixed BEFORE any byte streams. The
  // consumer normally writes it at claim time; this is the fallback
  // for direct calls (and keeps the invariant even if the consumer
  // path changes): the same id is reused on every retry.
  const pendingMediaId = fresh.pendingMediaId ?? crypto.randomUUID();
  if (!fresh.pendingMediaId) {
    await store.updateJob(job.id, { pendingMediaId });
  }

  let lastProgressWrite = 0;
  let lastPercent = -1;
  const sinkState: SinkState = { current: null, streamUrl: null };

  const writeCheckpoint = async (): Promise<void> => {
    if (!sinkState.current || !sinkState.streamUrl) return;
    await store.updateJob(job.id, {
      checkpoint: {
        uploadId: sinkState.current.currentUploadId,
        parts: sinkState.current.currentParts,
        bytes: sinkState.current.currentTotalBytes,
        streamUrl: sinkState.streamUrl,
      },
      lastProgressAt: new Date().toISOString(),
    });
  };

  // Cancel is observed between parts, never by a timer: after every
  // uploaded part the checkpoint is written and the row re-read.
  const onPart = async (): Promise<void> => {
    await writeCheckpoint();
    const current = await store.fetchJob(job.id);
    if (current?.status === 'cancelled') {
      throw new JobCancelledError();
    }
  };

  const onProgress = (progress: { downloadedBytes: number; totalBytes: number | null }): void => {
    const percent = progress.totalBytes
      ? Math.min(99, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
      : 0;
    const now = Date.now();
    if (now - lastProgressWrite < progressMinInterval || percent === lastPercent) return;
    lastProgressWrite = now;
    lastPercent = percent;
    void store
      .updateJob(job.id, {
        status: 'downloading',
        progressPercent: percent,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        lastProgressAt: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        // A lost progress write must never kill the download itself.
        log('progress write failed', { jobId: job.id, error: String(error) });
      });
  };

  const failJob = async (
    errorCode: string,
    errorMessage: string
  ): Promise<void> => {
    await store.updateJob(job.id, {
      status: 'failed',
      errorCode,
      errorMessage,
      // At the attempts cap there are no more retries, so a
      // checkpoint would only ever be stale state.
      ...(fresh.attempts >= DOWNLOAD_JOB_ATTEMPTS_CAP ||
      isTerminalDownloadErrorCode(errorCode)
        ? { checkpoint: null }
        : {}),
    });
  };

  try {
    const resolved = await resolve(fresh.sourceUrl, fetchFn, deps.extractorApiUrl ?? null);
    if (resolved.candidates.length === 0) {
      throw new MediaDownloaderError(
        'UNSUPPORTED_MEDIA',
        'No downloadable video or image was found at this link.',
        400
      );
    }

    const items = await streamCandidates({
      candidates: resolved.candidates,
      prefetchedBinaryResponse: resolved.prefetchedBinaryResponse,
      fresh,
      storage: deps.storage,
      fetchFn,
      pendingMediaId,
      onProgress,
      onPart,
      createSink: deps.createSink,
      sinkState,
      store,
      jobId: job.id,
    });

    if (items.length === 0) {
      throw new MediaDownloaderError(
        'DOWNLOAD_FAILED',
        'The download finished without saving any file.',
        502
      );
    }

    return finaliseDownload({
      store,
      storage: deps.storage,
      items,
      userId: fresh.userId,
      targetFolderId: fresh.targetFolderId,
      pendingMediaId,
      jobId: job.id,
      log,
      failJob,
    });
  } catch (error) {
    return handleProcessingError({ error, store, jobId: job.id, log, failJob });
  }
}

async function deleteItems(
  storage: IStorageService,
  items: DownloadedItem[],
  log: (message: string, context?: Record<string, unknown>) => void,
  jobId: string
): Promise<void> {
  for (const item of items) {
    for (const key of [item.storageKey, item.thumbnailKey]) {
      if (!key) continue;
      try {
        await storage.deleteObject(key);
      } catch (error) {
        // Best effort: an orphaned object is visible in storage and
        // never in the library; it must not fail the job outcome.
        log('cleanup delete failed', { jobId, key, error: String(error) });
      }
    }
  }
}
