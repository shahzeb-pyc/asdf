import { describe, expect, it, vi } from 'vitest';
import { handleDlqMessage, handleQueueMessage } from '../src/consumer.js';
import { FakeStore, JOB_ID, USER_ID, makeJob } from './fakes.js';

const WORKER_ID = 'cf-download-consumer';

function consumerDeps(store: FakeStore) {
  const processJob = vi.fn(async () => 'done' as const);
  return {
    store,
    workerId: WORKER_ID,
    processJob,
    processDeps: {} as never,
    log: () => undefined,
  };
}

describe('handleQueueMessage', () => {
  it('claims and processes the triggered job', async () => {
    const job = makeJob({ status: 'queued', attempts: 0 });
    const store = new FakeStore([job]);
    const deps = consumerDeps(store);
    const outcome = await handleQueueMessage({ jobId: JOB_ID, userId: USER_ID }, deps);
    expect(outcome).toEqual({ kind: 'processed', jobIds: [JOB_ID] });
    expect(deps.processJob).toHaveBeenCalledTimes(1);
    expect((await store.fetchJob(JOB_ID))?.status).toBe('resolving');
    expect((await store.fetchJob(JOB_ID))?.attempts).toBe(1);
  });

  it('acks without work when the cap is full — no retry is burned', async () => {
    const active = [1, 2, 3].map((n) =>
      makeJob({
        id: `33333333-3333-4333-a333-33333333333${n}`,
        status: 'downloading',
        attempts: 1,
      })
    );
    const queued = makeJob({ status: 'queued', attempts: 0 });
    const store = new FakeStore([...active, queued]);
    const deps = consumerDeps(store);
    const outcome = await handleQueueMessage({ jobId: JOB_ID, userId: USER_ID }, deps);
    expect(outcome).toEqual({ kind: 'acked-no-work', reason: 'cap-full-or-not-queued' });
    expect(deps.processJob).not.toHaveBeenCalled();
    // The queued job is untouched — the cron sweeper re-triggers it
    // when a slot frees, instead of the message burning a retry.
    expect((await store.fetchJob(JOB_ID))?.status).toBe('queued');
  });

  it('processes every job the claim returns, not just the triggered one', async () => {
    // Deviation from the spec sentence (§5.2): the claim is the gate,
    // and a claimed-but-unprocessed job would strand in `resolving`
    // with no owner until the 30-minute stale reclaim. Every claimed
    // job gets an owner in this invocation.
    const otherId = '66666666-6666-4666-a666-666666666666';
    const store = new FakeStore([
      makeJob({ status: 'queued', attempts: 0 }),
      makeJob({ id: otherId, status: 'queued', attempts: 0 }),
    ]);
    const deps = consumerDeps(store);
    const outcome = await handleQueueMessage({ jobId: JOB_ID, userId: USER_ID }, deps);
    expect(outcome).toEqual({ kind: 'processed', jobIds: [JOB_ID, otherId] });
    expect(deps.processJob).toHaveBeenCalledTimes(2);
  });

  it('a DB throw propagates so the Queue redelivers with backoff', async () => {
    const store = new FakeStore([makeJob({ status: 'queued', attempts: 0 })]);
    const deps = consumerDeps(store);
    const throwing = {
      ...deps,
      store: {
        ...store,
        claimJobs: async () => {
          throw new Error('database down');
        },
      } as unknown as FakeStore,
    };
    await expect(
      handleQueueMessage({ jobId: JOB_ID, userId: USER_ID }, throwing)
    ).rejects.toThrow('database down');
    expect(deps.processJob).not.toHaveBeenCalled();
  });

  it('a malformed message throws without touching any job row', async () => {
    const store = new FakeStore([makeJob({ status: 'queued', attempts: 0 })]);
    const deps = consumerDeps(store);
    await expect(
      handleQueueMessage({ jobId: 'not-a-uuid', userId: USER_ID }, deps)
    ).rejects.toThrow();
    expect(deps.processJob).not.toHaveBeenCalled();
    expect((await store.fetchJob(JOB_ID))?.status).toBe('queued');
  });

  it('the claim cap is never exceeded by concurrent claims for one user', async () => {
    const jobs = [1, 2, 3, 4, 5].map((n) =>
      makeJob({
        id: `77777777-7777-4777-a777-77777777777${n}`,
        status: 'queued',
        attempts: 0,
      })
    );
    const store = new FakeStore(jobs);
    const depsA = consumerDeps(store);
    const depsB = consumerDeps(store);
    const [a, b] = await Promise.all([
      handleQueueMessage({ jobId: jobs[0]?.id ?? '', userId: USER_ID }, depsA),
      handleQueueMessage({ jobId: jobs[1]?.id ?? '', userId: USER_ID }, depsB),
    ]);
    const processed = [
      ...(a.kind === 'processed' ? a.jobIds : []),
      ...(b.kind === 'processed' ? b.jobIds : []),
    ];
    expect(new Set(processed).size).toBeLessThanOrEqual(3);
    expect(processed).toHaveLength(new Set(processed).size);
  });
});

describe('handleDlqMessage', () => {
  it('marks an unresolved job failed, clears its checkpoint, and acks', async () => {
    const job = makeJob({
      status: 'downloading',
      attempts: 5,
      checkpoint: {
        uploadId: 'upload-dlq',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 1024,
        streamUrl: 'https://cdn.example.com/video.mp4',
      },
    });
    const store = new FakeStore([job]);
    const outcome = await handleDlqMessage(
      { jobId: JOB_ID, userId: USER_ID },
      { store, log: () => undefined }
    );
    expect(outcome).toEqual({ kind: 'acked', reason: 'marked-failed' });
    const row = await store.fetchJob(JOB_ID);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('DOWNLOAD_FAILED');
    expect(row?.checkpoint).toBeNull();
  });

  it('acks a resolved job without touching it', async () => {
    const store = new FakeStore([makeJob({ status: 'done', mediaId: 'x' })]);
    const outcome = await handleDlqMessage(
      { jobId: JOB_ID, userId: USER_ID },
      { store, log: () => undefined }
    );
    expect(outcome).toEqual({ kind: 'acked', reason: 'already-resolved' });
    expect(store.updateCalls).toHaveLength(0);
  });

  it('acks a vanished job without touching anything', async () => {
    const store = new FakeStore([]);
    const outcome = await handleDlqMessage(
      { jobId: JOB_ID, userId: USER_ID },
      { store, log: () => undefined }
    );
    expect(outcome).toEqual({ kind: 'acked', reason: 'job-vanished' });
  });

  it('acks a malformed DLQ message as unprocessable, never touching a row', async () => {
    const store = new FakeStore([makeJob({ status: 'downloading' })]);
    const outcome = await handleDlqMessage(
      { jobId: 'not-a-uuid', userId: USER_ID },
      { store, log: () => undefined }
    );
    expect(outcome).toEqual({ kind: 'acked', reason: 'unprocessable' });
    expect(store.updateCalls).toHaveLength(0);
  });
});
