import { describe, expect, it, vi } from 'vitest';
import { runCron } from '../src/heartbeat.js';
import { FakeStore, JOB_ID, USER_ID, makeJob } from './fakes.js';

describe('runCron', () => {
  it('heartbeats, sweeps only free-slot jobs, and reclaims nothing fresh', async () => {
    const busyUser = '88888888-8888-4888-a888-888888888888';
    const jobs = [
      // Busy user: 3 active, 2 queued — the sweep must skip both.
      ...[1, 2, 3].map((n) =>
        makeJob({
          id: `99999999-9999-4999-a999-99999999999${n}`,
          userId: busyUser,
          status: 'downloading',
        })
      ),
      makeJob({
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
        userId: busyUser,
        status: 'queued',
      }),
      makeJob({
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
        userId: busyUser,
        status: 'queued',
      }),
      // Free user: 1 queued job — the only sweep.
      makeJob({ userId: USER_ID, status: 'queued' }),
    ];
    const store = new FakeStore(jobs);
    const sent: Array<{ jobId: string; userId: string }> = [];
    const result = await runCron({
      store,
      queue: {
        send: async (message) => {
          sent.push(message);
          return true;
        },
      },
      log: () => undefined,
    });
    expect(result.heartbeated).toBe(true);
    expect(store.heartbeatIds).toEqual(['cf-download-consumer']);
    expect(result.swept).toBe(1);
    expect(sent).toEqual([{ jobId: JOB_ID, userId: USER_ID }]);
    expect(result.reclaimed).toBe(0);
  });

  it('reclaims a job with no progress for 30 minutes, keeps its checkpoint, and spares a live one', async () => {
    const stale = makeJob({
      id: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbb1',
      status: 'downloading',
      lastProgressAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      claimedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      checkpoint: {
        uploadId: 'upload-stale',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
        bytes: 1024,
        streamUrl: 'https://cdn.example.com/video.mp4',
      },
    });
    const live = makeJob({
      id: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbb2',
      status: 'downloading',
      lastProgressAt: new Date().toISOString(),
    });
    const store = new FakeStore([stale, live]);
    const result = await runCron({
      store,
      queue: { send: async () => true },
      log: () => undefined,
    });
    expect(result.reclaimed).toBe(1);
    const staleRow = await store.fetchJob(stale.id);
    expect(staleRow?.status).toBe('queued');
    expect(staleRow?.checkpoint).not.toBeNull();
    expect((await store.fetchJob(live.id))?.status).toBe('downloading');
  });

  it('asks the sweeper for at most 50 jobs per run', async () => {
    const store = new FakeStore([makeJob({ status: 'queued' })]);
    const spy = vi.spyOn(store, 'sweepQueuedJobs');
    await runCron({
      store,
      queue: { send: async () => true },
      log: () => undefined,
    });
    expect(spy).toHaveBeenCalledWith(50);
  });

  it('a failing heartbeat never blocks the sweep', async () => {
    const store = new FakeStore([makeJob({ status: 'queued' })]);
    vi.spyOn(store, 'upsertHeartbeat').mockRejectedValue(new Error('heartbeat down'));
    const sent: Array<{ jobId: string; userId: string }> = [];
    const result = await runCron({
      store,
      queue: {
        send: async (message) => {
          sent.push(message);
          return true;
        },
      },
      log: () => undefined,
    });
    expect(result.heartbeated).toBe(false);
    expect(result.swept).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
