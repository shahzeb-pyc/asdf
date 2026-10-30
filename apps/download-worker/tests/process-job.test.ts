import { describe, expect, it } from 'vitest';
import { processClaimedJob } from '../src/process-job.js';
import { R2MultipartSink } from '../src/r2-sink.js';
import type { ResolveCandidatesResult } from '../src/engine/index.js';
import {
  FakeBucket,
  FakeStorage,
  FakeStore,
  JOB_ID,
  MB,
  USER_ID,
  makeJob,
  makeMediaFetch,
} from './fakes.js';

const BASE = 'https://media.example.test';
const STREAM_URL = 'https://cdn.example.com/video.mp4';

function resolveFake(streamUrl: string = STREAM_URL) {
  return async (): Promise<ResolveCandidatesResult> => ({
    sourceUrl: 'https://example.com/video.mp4',
    platform: 'direct',
    candidates: [{ streamUrl }],
    prefetchedBinaryResponse: undefined,
  });
}

function depsFor(store: FakeStore, bucket: FakeBucket, fetchFn: typeof fetch) {
  const storage = new FakeStorage(BASE);
  return {
    store,
    storage,
    createSink: (key: string, contentType: string, resume: unknown, onPart: unknown) =>
      new R2MultipartSink(bucket as unknown as R2Bucket, key, contentType, BASE, {
        resumeUploadId: (resume as { uploadId?: string | null } | undefined)?.uploadId ?? undefined,
        resumeParts: (resume as { parts?: Array<{ partNumber: number; etag: string }> } | undefined)?.parts ?? undefined,
        initialBytes: (resume as { initialBytes?: number } | undefined)?.initialBytes ?? undefined,
        onPart: onPart as ((info: {
          partNumber: number;
          etag: string;
          totalBytes: number;
          parts: Array<{ partNumber: number; etag: string }>;
        }) => Promise<void>) | undefined,
      }),
    resolve: resolveFake(),
    fetchFn,
    progressUpdateMinIntervalMs: 0,
    log: () => undefined,
  };
}

describe('processClaimedJob', () => {
  it('streams a job to done with the pending media id as the library id', async () => {
    const pendingId = '33333333-3333-4333-a333-333333333333';
    const job = makeJob({ pendingMediaId: pendingId, attempts: 1 });
    const store = new FakeStore([job]);
    const bucket = new FakeBucket();
    const outcome = await processClaimedJob(
      job,
      depsFor(store, bucket, makeMediaFetch(20 * MB))
    );
    expect(outcome).toBe('done');
    const row = await store.fetchJob(JOB_ID);
    expect(row?.status).toBe('done');
    expect(row?.progressPercent).toBe(100);
    expect(row?.mediaId).toBe(pendingId);
    expect(row?.checkpoint).toBeNull();
    expect(store.mediaItems).toHaveLength(1);
    expect(store.mediaItems[0]?.id).toBe(pendingId);
    const upload = [...bucket.uploads.values()][0];
    expect(upload?.completed?.partNumbers).toEqual([1, 2, 3]);
  });

  it('a job that already has a media id marks done without streaming again', async () => {
    const mediaId = '44444444-4444-4444-a444-444444444444';
    const job = makeJob({ mediaId, status: 'downloading' });
    const store = new FakeStore([job]);
    const bucket = new FakeBucket();
    let resolveCalls = 0;
    const deps = depsFor(store, bucket, makeMediaFetch(20 * MB));
    const outcome = await processClaimedJob(job, {
      ...deps,
      resolve: async () => {
        resolveCalls += 1;
        return resolveFake()();
      },
    });
    expect(outcome).toBe('done');
    expect(resolveCalls).toBe(0);
    expect(bucket.uploads.size).toBe(0);
    expect((await store.fetchJob(JOB_ID))?.mediaId).toBe(mediaId);
  });

  it('a crash between media insert and done-marking still yields exactly one library row', async () => {
    const pendingId = '55555555-5555-4555-a555-555555555555';
    const job = makeJob({ pendingMediaId: pendingId, mediaId: null, attempts: 2 });
    const store = new FakeStore([job]);
    // The previous attempt already inserted the row, then crashed.
    store.mediaItems.push({
      id: pendingId,
      userId: USER_ID,
      folderId: null,
      name: 'file.mp4',
      fileSize: 20 * MB,
      mimeType: 'video/mp4',
      mediaType: 'video',
      storageKey: 'users/x/media/y/file.mp4',
      url: `${BASE}/users/x/media/y/file.mp4`,
      thumbnailKey: null,
      thumbnailUrl: null,
      durationSeconds: null,
      aspectRatio: 'unknown',
      captionText: null,
    });
    const bucket = new FakeBucket();
    const outcome = await processClaimedJob(job, depsFor(store, bucket, makeMediaFetch(20 * MB)));
    expect(outcome).toBe('done');
    expect(store.mediaItems).toHaveLength(1);
    expect(store.mediaItems[0]?.id).toBe(pendingId);
    expect((await store.fetchJob(JOB_ID))?.mediaId).toBe(pendingId);
  });

  it('cancel between parts aborts the upload, keeps cancelled, saves nothing', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    // Call 1 = initial read (resolving). Every later read = cancelled.
    store.fetchJobOverride = (_jobId, call) =>
      call === 1 ? { ...job } : { ...job, status: 'cancelled' };
    const bucket = new FakeBucket();
    const outcome = await processClaimedJob(job, depsFor(store, bucket, makeMediaFetch(20 * MB)));
    expect(outcome).toBe('cancelled');
    const upload = [...bucket.uploads.values()][0];
    expect(upload?.aborted).toBe(true);
    expect(upload?.completed).toBeNull();
    expect(store.mediaItems).toHaveLength(0);
    // The row was cancelled by the user path; the processor must not
    // overwrite it with a failure. (The fake's override keeps it
    // cancelled; the assertion that matters is no failed update.)
    expect(store.updateCalls.some((call) => call.patch.status === 'failed')).toBe(false);
  });

  it('a declared over-cap file fails before streaming, with nothing saved', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const bucket = new FakeBucket();
    const fetchFn = makeMediaFetch(600 * MB, { chunkSize: MB });
    // The fake media fetch would serve 600 MB if asked; the cap must
    // fire on the declared content-length before any part uploads.
    // Guard: serve the header but an empty body stream is enough —
    // the cap check runs on the header first.
    const outcome = await processClaimedJob(job, depsFor(store, bucket, fetchFn));
    expect(outcome).toBe('failed');
    const row = await store.fetchJob(JOB_ID);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('FILE_TOO_LARGE');
    expect(bucket.uploads.size).toBe(0);
    expect(store.mediaItems).toHaveLength(0);
  });

  it('an unsafe source URL fails as UNSAFE_URL before any byte streams', async () => {
    const job = makeJob({ sourceUrl: 'http://127.0.0.1/secret.mp4', attempts: 1 });
    const store = new FakeStore([job]);
    const bucket = new FakeBucket();
    const outcome = await processClaimedJob(job, {
      ...depsFor(store, bucket, makeMediaFetch(10 * MB)),
      // Real resolver: unsafe validation must fire before fetch.
      resolve: undefined as never,
    });
    expect(outcome).toBe('failed');
    expect((await store.fetchJob(JOB_ID))?.errorCode).toBe('UNSAFE_URL');
    expect(bucket.uploads.size).toBe(0);
  });

  it('a tampered checkpoint URL is never fetched (non-match means no resume)', async () => {
    const job = makeJob({
      attempts: 1,
      checkpoint: {
        uploadId: 'upload-99',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: 'http://169.254.1.1/evil.mp4',
      },
    });
    const store = new FakeStore([job]);
    const bucket = new FakeBucket();
    const requestedUrls: string[] = [];
    const fetchFn = makeMediaFetch(20 * MB, { requestedUrls });
    const outcome = await processClaimedJob(job, depsFor(store, bucket, fetchFn));
    expect(outcome).toBe('done');
    expect(requestedUrls).toEqual([STREAM_URL]);
    expect(requestedUrls.some((url) => url.includes('169.254'))).toBe(false);
  });

  it('resume with a Range-supporting source uploads only the remaining parts', async () => {
    const bucket = new FakeBucket();
    // Seed part 1 (8 MB) under upload-1 in the fake bucket.
    const seed = new R2MultipartSink(bucket as unknown as R2Bucket, 'k', 'video/mp4', BASE);
    await seed.write(new Uint8Array(8 * MB));
    const uploadId = seed.currentUploadId;
    expect(uploadId).not.toBeNull();

    const job = makeJob({
      attempts: 2,
      checkpoint: {
        uploadId,
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: STREAM_URL,
      },
    });
    const store = new FakeStore([job]);
    const served = { total: 0 };
    const requestedRanges: Array<string | null> = [];
    const fetchFn = makeMediaFetch(20 * MB, {
      rangeSupported: true,
      servedBytes: served,
      requestedRanges,
    });
    const outcome = await processClaimedJob(job, depsFor(store, bucket, fetchFn));
    expect(outcome).toBe('done');
    expect(requestedRanges).toEqual([`bytes=${8 * MB}-`]);
    expect(served.total).toBe(12 * MB);
    const upload = bucket.uploads.get(uploadId ?? '');
    expect(upload?.completed?.partNumbers).toEqual([1, 2, 3]);
    expect((await store.fetchJob(JOB_ID))?.checkpoint).toBeNull();
  });

  it('a Range-refusing source restarts cleanly from byte 0 once', async () => {
    const bucket = new FakeBucket();
    const job = makeJob({
      attempts: 2,
      checkpoint: {
        uploadId: 'upload-stale',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: STREAM_URL,
      },
    });
    const store = new FakeStore([job]);
    const requestedRanges: Array<string | null> = [];
    const fetchFn = makeMediaFetch(12 * MB, {
      rangeSupported: false,
      requestedRanges,
    });
    const outcome = await processClaimedJob(job, depsFor(store, bucket, fetchFn));
    expect(outcome).toBe('done');
    // First attempt carried a Range header, the restart did not.
    expect(requestedRanges).toEqual([`bytes=${8 * MB}-`, null]);
    // The stale upload was abandoned; the finished object is a fresh one.
    const completed = [...bucket.uploads.values()].filter((u) => u.completed !== null);
    expect(completed).toHaveLength(1);
    expect((await store.fetchJob(JOB_ID))?.checkpoint).toBeNull();
  });

  it('at the attempts cap a failure clears the checkpoint; below it, it is kept', async () => {
    const failingFetch = (async (): Promise<Response> =>
      new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;

    const atCap = makeJob({
      attempts: 5,
      checkpoint: {
        uploadId: 'upload-cap',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: STREAM_URL,
      },
    });
    const storeCap = new FakeStore([atCap]);
    const outcomeCap = await processClaimedJob(
      atCap,
      depsFor(storeCap, new FakeBucket(), failingFetch)
    );
    expect(outcomeCap).toBe('failed');
    expect((await storeCap.fetchJob(JOB_ID))?.checkpoint).toBeNull();

    const belowCap = makeJob({
      attempts: 2,
      checkpoint: {
        uploadId: 'upload-keep',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: STREAM_URL,
      },
    });
    const storeBelow = new FakeStore([belowCap]);
    const outcomeBelow = await processClaimedJob(
      belowCap,
      depsFor(storeBelow, new FakeBucket(), failingFetch)
    );
    expect(outcomeBelow).toBe('failed');
    expect((await storeBelow.fetchJob(JOB_ID))?.checkpoint).not.toBeNull();
  });

  it('a terminal failure clears the checkpoint even below the attempts cap', async () => {
    const job = makeJob({
      attempts: 1,
      checkpoint: {
        uploadId: 'upload-term',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 8 * MB,
        streamUrl: STREAM_URL,
      },
    });
    const store = new FakeStore([job]);
    const overCap = makeMediaFetch(600 * MB, { chunkSize: MB });
    const outcome = await processClaimedJob(job, depsFor(store, new FakeBucket(), overCap));
    expect(outcome).toBe('failed');
    expect((await store.fetchJob(JOB_ID))?.errorCode).toBe('FILE_TOO_LARGE');
    expect((await store.fetchJob(JOB_ID))?.checkpoint).toBeNull();
  });
});

describe('processClaimedJob edge paths', () => {
  it('fails when the job row vanishes before processing', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    store.fetchJobOverride = () => null;
    const outcome = await processClaimedJob(
      job,
      depsFor(store, new FakeBucket(), makeMediaFetch(MB))
    );
    expect(outcome).toBe('failed');
  });

  it('returns cancelled when the initial read already shows cancelled', async () => {
    const job = makeJob({ attempts: 1, status: 'cancelled' });
    const store = new FakeStore([job]);
    const outcome = await processClaimedJob(
      job,
      depsFor(store, new FakeBucket(), makeMediaFetch(MB))
    );
    expect(outcome).toBe('cancelled');
    expect(store.updateCalls.some((call) => call.patch.status === 'failed')).toBe(false);
  });

  it('fails with UNSUPPORTED_MEDIA when resolution yields no candidates', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const deps = depsFor(store, new FakeBucket(), makeMediaFetch(MB));
    deps.resolve = (async () => ({
      sourceUrl: 'https://example.com/video.mp4',
      platform: 'direct' as const,
      candidates: [],
      prefetchedBinaryResponse: undefined,
    })) as never;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('failed');
    expect(store.updateCalls.some((call) => call.patch.errorCode === 'UNSUPPORTED_MEDIA')).toBe(
      true
    );
  });

  it('a lost progress write never kills the download', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const realUpdate = store.updateJob.bind(store);
    store.updateJob = async (jobId: string, patch: never) => {
      if ((patch as { status?: string }).status === 'downloading') {
        throw new Error('progress db down');
      }
      return realUpdate(jobId, patch as never);
    };
    const outcome = await processClaimedJob(
      job,
      depsFor(store, new FakeBucket(), makeMediaFetch(2 * MB))
    );
    expect(outcome).toBe('done');
  });

  it('throttles progress writes to the configured interval', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const deps = depsFor(store, new FakeBucket(), makeMediaFetch(20 * MB));
    deps.progressUpdateMinIntervalMs = 3_600_000;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('done');
    const progressWrites = store.updateCalls.filter(
      (call) => call.patch.status === 'downloading'
    );
    expect(progressWrites.length).toBe(1);
  });

  it('cancels after resolve without saving, and tolerates a failing cleanup delete', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    // 1-part file: call 1 = initial read, call 2 = onPart re-read,
    // call 3 = after-resolve read, which now shows cancelled.
    store.fetchJobOverride = (_jobId, call) =>
      call >= 3 ? { ...job, status: 'cancelled' } : { ...job };
    const bucket = new FakeBucket();
    const storage = new FakeStorage(BASE);
    storage.deleteObject = async () => {
      throw new Error('r2 down');
    };
    const deps = depsFor(store, bucket, makeMediaFetch(MB));
    deps.storage = storage as never;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('cancelled');
    expect(store.mediaItems).toHaveLength(0);
    expect(store.updateCalls.some((call) => call.patch.status === 'failed')).toBe(false);
  });

  it('drops our upload and finishes with the pre-existing media id', async () => {
    const existingId = '44444444-4444-4444-8444-444444444444';
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    store.fetchJobOverride = (_jobId, call) =>
      call >= 3 ? { ...job, mediaId: existingId } : { ...job };
    const outcome = await processClaimedJob(
      job,
      depsFor(store, new FakeBucket(), makeMediaFetch(MB))
    );
    expect(outcome).toBe('done');
    expect(store.mediaItems).toHaveLength(0);
    expect(
      store.updateCalls.some(
        (call) => call.patch.status === 'done' && call.patch.mediaId === existingId
      )
    ).toBe(true);
  });

  it('fails when the job row vanishes after resolve', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    store.fetchJobOverride = (_jobId, call) => (call >= 3 ? null : { ...job });
    const outcome = await processClaimedJob(
      job,
      depsFor(store, new FakeBucket(), makeMediaFetch(MB))
    );
    expect(outcome).toBe('failed');
  });

  it('deletes uploads and fails when the library insert fails', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    store.insertMediaItems = async () => {
      throw new Error('db down');
    };
    const storage = new FakeStorage(BASE);
    const deps = depsFor(store, new FakeBucket(), makeMediaFetch(MB));
    deps.storage = storage as never;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('failed');
    expect(store.mediaItems).toHaveLength(0);
    expect(storage.deletedKeys.length).toBeGreaterThan(0);
    expect(
      store.updateCalls.some(
        (call) =>
          call.patch.status === 'failed' &&
          call.patch.errorMessage === 'The download finished but could not be saved to your library.'
      )
    ).toBe(true);
  });

  it('treats a JobCancelledError from resolution as cancelled, not failed', async () => {
    const { JobCancelledError } = await import('../src/engine/index.js');
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const deps = depsFor(store, new FakeBucket(), makeMediaFetch(MB));
    deps.resolve = (async () => {
      throw new JobCancelledError();
    }) as never;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('cancelled');
    expect(store.updateCalls.some((call) => call.patch.status === 'failed')).toBe(false);
  });

  it('fails with DOWNLOAD_FAILED on an unexpected resolution error', async () => {
    const job = makeJob({ attempts: 1 });
    const store = new FakeStore([job]);
    const deps = depsFor(store, new FakeBucket(), makeMediaFetch(MB));
    deps.resolve = (async () => {
      throw new Error('weird');
    }) as never;
    const outcome = await processClaimedJob(job, deps);
    expect(outcome).toBe('failed');
    expect(
      store.updateCalls.some(
        (call) =>
          call.patch.status === 'failed' &&
          call.patch.errorCode === 'DOWNLOAD_FAILED' &&
          call.patch.errorMessage === 'The download failed. Please try again.'
      )
    ).toBe(true);
  });
});
