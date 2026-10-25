import type { IStorageService } from '@fbuploadpro/contracts';
import {
  DownloadAbortedError,
  MediaDownloaderError,
  resolveAndUploadMediaFromUrl,
  type MediaStreamSink,
  type UploadedDownloadedMediaItem,
} from '@/lib/media-downloader';
import type {
  DownloadJobRecord,
  JobStore,
  MediaItemInsert,
} from './db.js';

/**
 * One claimed download job, end to end (spec 149).
 *
 * - Streams through the web engine's resolver by import — the worker
 *   owns scheduling and persistence, never download logic.
 * - Idempotent: a job that already has a media_id (a previous attempt
 *   inserted rows but crashed before marking done) never inserts a
 *   second copy; a retry after insert marks done with the existing id.
 * - Cancellation is honoured at every boundary: the watcher polls the
 *   job row, aborts the stream, and a cancelled row is never
 *   overwritten by a later failure update.
 * - Partial uploads are deleted on every failure path, so a failed or
 *   cancelled job leaves nothing in the library or in storage.
 */

export type ProcessJobOutcome = 'done' | 'failed' | 'cancelled';

export interface ProcessJobDeps {
  store: JobStore;
  storage: IStorageService;
  createSink: (key: string, contentType: string) => MediaStreamSink;
  resolve?: typeof resolveAndUploadMediaFromUrl;
  extractorApiUrl?: string | null;
  /** Minimum gap between progress-row writes (default 1000 ms). */
  progressUpdateMinIntervalMs?: number;
  /** How often the cancel watcher re-reads the job row (default 1000 ms). */
  cancelPollMs?: number;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

function toMediaItemInsert(
  item: UploadedDownloadedMediaItem,
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
  const resolve = deps.resolve ?? resolveAndUploadMediaFromUrl;
  const progressMinInterval = deps.progressUpdateMinIntervalMs ?? 1000;
  const cancelPollMs = deps.cancelPollMs ?? 1000;

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

  const controller = new AbortController();
  let watcherInFlight = false;
  const watcher = setInterval(() => {
    if (watcherInFlight) return;
    watcherInFlight = true;
    void store
      .fetchJob(job.id)
      .then((current) => {
        if (current?.status === 'cancelled') controller.abort();
      })
      .catch((error: unknown) => {
        log('cancel watcher read failed', { jobId: job.id, error: String(error) });
      })
      .finally(() => {
        watcherInFlight = false;
      });
  }, cancelPollMs);

  let lastProgressWrite = 0;
  const onProgress = (progress: { downloadedBytes: number; totalBytes: number | null }) => {
    const now = Date.now();
    if (now - lastProgressWrite < progressMinInterval) return;
    lastProgressWrite = now;
    void store
      .updateJob(job.id, {
        status: 'downloading',
        progressPercent: progress.totalBytes
          ? Math.min(99, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
          : 0,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
      })
      .catch((error: unknown) => {
        // A lost progress write must never kill the download itself.
        log('progress write failed', { jobId: job.id, error: String(error) });
      });
  };

  try {
    const result = await resolve({
      sourceUrl: fresh.sourceUrl,
      userId: fresh.userId,
      storage: deps.storage,
      extractorApiUrl: deps.extractorApiUrl ?? null,
      onProgress,
      signal: controller.signal,
      createSink: deps.createSink,
    });

    if (result.items.length === 0) {
      throw new MediaDownloaderError(
        'DOWNLOAD_FAILED',
        'The download finished without saving any file.',
        502
      );
    }

    // The user may have cancelled while the last bytes streamed.
    const afterResolve = await store.fetchJob(job.id);
    if (!afterResolve) {
      log('job row vanished after resolve', { jobId: job.id });
      return 'failed';
    }
    if (afterResolve.status === 'cancelled') {
      await deleteItems(deps.storage, result.items, log, job.id);
      return 'cancelled';
    }
    if (afterResolve.mediaId) {
      // A duplicate attempt already saved this file: drop ours.
      await deleteItems(deps.storage, result.items, log, job.id);
      await store.updateJob(job.id, {
        status: 'done',
        progressPercent: 100,
        mediaId: afterResolve.mediaId,
      });
      return 'done';
    }

    const inserts = result.items.map((item) =>
      toMediaItemInsert(item, fresh.userId, fresh.targetFolderId)
    );
    try {
      await store.insertMediaItems(inserts);
    } catch (error) {
      log('media insert failed, deleting uploaded objects', {
        jobId: job.id,
        error: String(error),
      });
      await deleteItems(deps.storage, result.items, log, job.id);
      await store.updateJob(job.id, {
        status: 'failed',
        errorCode: 'DOWNLOAD_FAILED',
        errorMessage: 'The download finished but could not be saved to your library.',
      });
      return 'failed';
    }

    const totalBytes = result.items.reduce((sum, item) => sum + item.fileSize, 0);
    await store.updateJob(job.id, {
      status: 'done',
      progressPercent: 100,
      downloadedBytes: totalBytes,
      totalBytes,
      mediaId: result.items[0]?.mediaId ?? null,
    });
    return 'done';
  } catch (error) {
    // A cancelled row is never overwritten by a failure update.
    const current = await store.fetchJob(job.id).catch(() => null);
    if (current?.status === 'cancelled') return 'cancelled';

    if (error instanceof DownloadAbortedError) {
      await store.updateJob(job.id, {
        status: 'failed',
        errorCode: 'DOWNLOAD_FAILED',
        errorMessage: 'The download was interrupted.',
      });
      return 'failed';
    }
    if (error instanceof MediaDownloaderError) {
      await store.updateJob(job.id, {
        status: 'failed',
        errorCode: error.code,
        errorMessage: error.message,
      });
      return 'failed';
    }
    log('unexpected download error', { jobId: job.id, error: String(error) });
    await store.updateJob(job.id, {
      status: 'failed',
      errorCode: 'DOWNLOAD_FAILED',
      errorMessage: 'The download failed. Please try again.',
    });
    return 'failed';
  } finally {
    clearInterval(watcher);
  }
}

async function deleteItems(
  storage: IStorageService,
  items: UploadedDownloadedMediaItem[],
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
