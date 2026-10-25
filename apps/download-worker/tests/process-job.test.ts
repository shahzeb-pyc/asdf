/**
 * process-job behaviour tests (spec 149). The store, storage, sink,
 * and resolver are all fakes — these tests prove the job-state
 * machine (done / failed / cancelled / idempotent retry), not the
 * engine, which is covered by the web's own suites.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IStorageService } from '@fbuploadpro/contracts';
import {
  DownloadAbortedError,
  MediaDownloaderError,
  type MediaStreamSink,
  type UploadedDownloadedMediaItem,
} from '@/lib/media-downloader';
import { processClaimedJob } from '../src/process-job.js';
import type {
  DownloadJobRecord,
  JobPatch,
  JobStore,
  MediaItemInsert,
} from '../src/db.js';

function baseJob(overrides: Partial<DownloadJobRecord> = {}): DownloadJobRecord {
  return {
    id: 'job-1',
    userId: 'user-1',
    sourceUrl: 'https://example.com/clip.mp4',
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
    claimedBy: 'worker-test',
    ...overrides,
  };
}

function sampleItem(overrides: Partial<UploadedDownloadedMediaItem> = {}): UploadedDownloadedMediaItem {
  return {
    mediaId: 'media-1',
    name: 'clip.mp4',
    fileSize: 1024,
    mimeType: 'video/mp4',
    mediaType: 'video',
    storageKey: 'media/user-1/clip.mp4',
    url: 'https://cdn.example.com/media/user-1/clip.mp4',
    thumbnailKey: null,
    thumbnailUrl: null,
    durationSeconds: null,
    aspectRatio: '16:9',
    captionText: 'hello',
    ...overrides,
  };
}

class FakeStore implements JobStore {
  record: DownloadJobRecord;
  readonly updates: JobPatch[] = [];
  inserted: MediaItemInsert[] = [];
  insertError: Error | null = null;
  /** After this many fetchJob calls, report the job as cancelled. */
  cancelAfterFetches: number | null = null;
  /** After this many fetchJob calls, report an existing media_id. */
  mediaIdAfterFetches: number | null = null;
  private fetches = 0;

  constructor(record: DownloadJobRecord) {
    this.record = { ...record };
  }

  async fetchJob(): Promise<DownloadJobRecord | null> {
    this.fetches += 1;
    const copy = { ...this.record };
    if (this.cancelAfterFetches !== null && this.fetches >= this.cancelAfterFetches) {
      copy.status = 'cancelled';
    }
    if (this.mediaIdAfterFetches !== null && this.fetches >= this.mediaIdAfterFetches) {
      copy.mediaId = 'media-existing';
    }
    return copy;
  }

  async updateJob(_jobId: string, patch: JobPatch): Promise<void> {
    this.updates.push(patch);
    Object.assign(this.record, {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.mediaId !== undefined ? { mediaId: patch.mediaId } : {}),
      ...(patch.progressPercent !== undefined ? { progressPercent: patch.progressPercent } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
    });
  }

  async insertMediaItems(items: MediaItemInsert[]): Promise<void> {
    if (this.insertError) throw this.insertError;
    this.inserted = items;
  }

  async usersWithQueuedJobs(): Promise<string[]> {
    return [];
  }

  async claimJobs(): Promise<DownloadJobRecord[]> {
    return [];
  }

  async upsertHeartbeat(): Promise<void> {}

  async staleWorkerIds(): Promise<string[]> {
    return [];
  }

  async reclaimStaleClaims(): Promise<number> {
    return 0;
  }
}

function fakeStorage(): { storage: IStorageService; deleted: string[] } {
  const deleted: string[] = [];
  const storage: IStorageService = {
    getPresignedUploadUrl: async () => {
      throw new Error('not used');
    },
    putObject: async (params) => ({
      key: params.key,
      publicUrl: `https://cdn.example.com/${params.key}`,
      byteLength: params.body.byteLength,
    }),
    deleteObject: async (key: string) => {
      deleted.push(key);
    },
    getPublicUrl: (key: string) => `https://cdn.example.com/${key}`,
  };
  return { storage, deleted };
}

function fakeSink(): MediaStreamSink {
  return {
    write: async () => {},
    finish: async () => ({ key: 'k', byteLength: 0, publicUrl: '' }),
    abort: async () => {},
  };
}

describe('processClaimedJob', () => {
  it('marks done and inserts exactly one library row on success', async () => {
    const store = new FakeStore(baseJob());
    const { storage } = fakeStorage();
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      resolve: async () => ({
        sourceUrl: 'https://example.com/clip.mp4',
        platform: 'direct',
        items: [sampleItem()],
      }),
    });
    expect(outcome).toBe('done');
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]?.id).toBe('media-1');
    expect(store.inserted[0]?.userId).toBe('user-1');
    const done = store.updates.find((u) => u.status === 'done');
    expect(done?.mediaId).toBe('media-1');
    expect(done?.progressPercent).toBe(100);
  });

  it('never calls resolve when the job already has a media_id (idempotent retry)', async () => {
    const store = new FakeStore(baseJob({ mediaId: 'media-existing' }));
    const { storage } = fakeStorage();
    const resolve = vi.fn();
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      resolve: resolve as never,
    });
    expect(outcome).toBe('done');
    expect(resolve).not.toHaveBeenCalled();
    expect(store.inserted).toHaveLength(0);
    expect(store.updates.find((u) => u.status === 'done')?.mediaId).toBe('media-existing');
  });

  it('drops the fresh upload when another attempt already saved the file', async () => {
    const store = new FakeStore(baseJob());
    // First fetch (pre-resolve) sees no media_id; the post-resolve
    // fetch sees one — a duplicate attempt won the race.
    store.mediaIdAfterFetches = 2;
    const { storage, deleted } = fakeStorage();
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      resolve: async () => ({
        sourceUrl: 'https://example.com/clip.mp4',
        platform: 'direct',
        items: [sampleItem()],
      }),
    });
    expect(outcome).toBe('done');
    expect(store.inserted).toHaveLength(0);
    expect(deleted).toContain('media/user-1/clip.mp4');
    expect(store.updates.find((u) => u.status === 'done')?.mediaId).toBe('media-existing');
  });

  it('maps engine errors onto the job row', async () => {
    const store = new FakeStore(baseJob());
    const { storage } = fakeStorage();
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      resolve: async () => {
        throw new MediaDownloaderError('UNSAFE_URL', 'That link is not allowed.', 400);
      },
    });
    expect(outcome).toBe('failed');
    const failed = store.updates.find((u) => u.status === 'failed');
    expect(failed?.errorCode).toBe('UNSAFE_URL');
  });

  it('deletes partial uploads and fails when the library insert fails', async () => {
    const store = new FakeStore(baseJob());
    store.insertError = new Error('db down');
    const { storage, deleted } = fakeStorage();
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      resolve: async () => ({
        sourceUrl: 'https://example.com/clip.mp4',
        platform: 'direct',
        items: [sampleItem()],
      }),
    });
    expect(outcome).toBe('failed');
    expect(deleted).toContain('media/user-1/clip.mp4');
    expect(store.updates.find((u) => u.status === 'failed')?.errorCode).toBe('DOWNLOAD_FAILED');
  });

  it('keeps a cancelled row cancelled and saves nothing', async () => {
    const store = new FakeStore(baseJob());
    const { storage, deleted } = fakeStorage();
    // The cancel watcher polls every 10 ms; flip the row to cancelled
    // on the watcher's first read (fetch #2: #1 is the pre-resolve read).
    store.cancelAfterFetches = 2;
    const outcome = await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 10,
      resolve: async ({ signal }) => {
        // Wait until the watcher aborts, then surface the abort.
        await new Promise<void>((resolvePromise, rejectPromise) => {
          if (signal?.aborted) {
            rejectPromise(new DownloadAbortedError());
            return;
          }
          signal?.addEventListener(
            'abort',
            () => rejectPromise(new DownloadAbortedError()),
            { once: true }
          );
        });
        return {
          sourceUrl: 'https://example.com/clip.mp4',
          platform: 'direct' as const,
          items: [sampleItem()],
        };
      },
    });
    expect(outcome).toBe('cancelled');
    expect(store.inserted).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    expect(store.updates.some((u) => u.status === 'failed')).toBe(false);
  });

  it('throttles progress writes to at most one per interval', async () => {
    const store = new FakeStore(baseJob());
    const { storage } = fakeStorage();
    await processClaimedJob(store.record, {
      store,
      storage,
      createSink: fakeSink,
      cancelPollMs: 60_000,
      progressUpdateMinIntervalMs: 60_000,
      resolve: async ({ onProgress }) => {
        onProgress?.({ downloadedBytes: 100, totalBytes: 1000 });
        onProgress?.({ downloadedBytes: 200, totalBytes: 1000 });
        onProgress?.({ downloadedBytes: 300, totalBytes: 1000 });
        return {
          sourceUrl: 'https://example.com/clip.mp4',
          platform: 'direct' as const,
          items: [sampleItem()],
        };
      },
    });
    expect(store.updates.filter((u) => u.status === 'downloading')).toHaveLength(1);
  });
});
