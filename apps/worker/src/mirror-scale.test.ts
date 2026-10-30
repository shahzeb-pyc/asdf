/**
 * Scaled mirror checks: dispatcher + database queue.
 *
 * Covers what the old single-loop tick could not prove:
 * - Due scans page in 500-row batches, so mirrors past the
 *   1,000-row PostgREST truncation are still found.
 * - NULL next_check_at counts as due; a future stamp ends the
 *   due prefix (scan stops, nothing not-yet-due is dispatched).
 * - Per-run cap (1,700) + next_check_at advancement preserve
 *   hourly cadence without re-dispatching within the hour.
 * - Dispatch pacing spreads jobs ~3/second via available_at.
 * - A failed insert chunk leaves its mirrors due; a re-dispatch
 *   inserts nothing new (one live job per mirror) but still
 *   advances — the already-queued mirrors are dispatched.
 * - Job-tick isolation: one mirror's failure never blocks other
 *   jobs in the same tick; paused/deleted mirrors complete
 *   without work; retries back off (60s, 120s) and exhaustion
 *   stamps the mirror error (the database dead-letter queue).
 * - Atomic claim: two concurrent ticks never process the same
 *   job (the fake store claims synchronously, mirroring the
 *   single UPDATE ... FOR UPDATE SKIP LOCKED statement in the
 *   claim RPC — Postgres guarantees the same disjointness).
 * - Claim-before-publish and the catch-up rule survive the
 *   move from loop tick to job consumer unchanged.
 */
import { describe, expect, it } from 'vitest';
import { InternalError } from '@fbuploadpro/contracts';
import {
  buildMirrorTickDeps,
  MIRROR_DISPATCH_BATCH_SIZE,
  MIRROR_DISPATCH_JOBS_PER_SECOND,
  MIRROR_DISPATCH_PER_RUN_CAP,
  MIRROR_JOB_MAX_ATTEMPTS,
  processMirrorCheck,
  runMirrorDispatch,
  runMirrorJobTick,
  type MirrorCheckJob,
  type MirrorTickDeps,
  type MirrorTickMirror,
} from './mirror-tick.js';

// ---------- fake Supabase chain for the due scan ----------

interface DueRow {
  id: string;
  next_check_at: string | null;
}

class FakeDueQuery {
  ranges: Array<[number, number]> = [];
  private page: DueRow[] = [];
  constructor(private rows: DueRow[]) {}
  select(): this {
    return this;
  }
  in(): this {
    return this;
  }
  order(): this {
    return this;
  }
  range(from: number, to: number): this {
    this.ranges.push([from, to]);
    // Mirror the production ordering: next_check_at ASC NULLS
    // FIRST, id ASC — applied here so the scan logic under test
    // sees rows in the same order the real query returns them.
    const sorted = [...this.rows].sort((a, b) => {
      if (a.next_check_at === null && b.next_check_at !== null) return -1;
      if (a.next_check_at !== null && b.next_check_at === null) return 1;
      if (a.next_check_at !== null && b.next_check_at !== null) {
        const byTime = Date.parse(a.next_check_at) - Date.parse(b.next_check_at);
        if (byTime !== 0) return byTime;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    this.page = sorted.slice(from, to + 1);
    return this;
  }
  then<T>(resolve: (value: { data: DueRow[]; error: null }) => T): Promise<T> {
    return Promise.resolve(resolve({ data: this.page, error: null }));
  }
}

function fakeDueDb(rows: DueRow[]) {
  const query = new FakeDueQuery(rows);
  return {
    query,
    db: { from: () => query } as never,
  };
}

function pastIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

// ---------- fake per-mirror check deps (job-tick tests) ----------

function checkMirror(overrides: Partial<MirrorTickMirror> = {}): MirrorTickMirror {
  return {
    id: 'mirror-1',
    workspaceId: 'ws_1',
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    targetPlatform: 'facebook',
    targetExternalId: 'fb_123',
    targetFound: true,
    targetToken: 'page-token',
    status: 'active',
    lastCheckedAt: '2026-10-29T11:30:00.000Z',
    catchUpPending: false,
    lastPostedSourceId: null,
    lastPostedCreateTime: null,
    ...overrides,
  };
}

function checkReel(videoId: string, createTime: number) {
  return {
    video_id: videoId,
    play: `https://example.com/${videoId}.mp4`,
    wmplay: `https://example.com/${videoId}-wm.mp4`,
    title: `Caption for ${videoId}`,
    cover: `https://example.com/${videoId}.jpg`,
    create_time: createTime,
  };
}

interface CheckState {
  claimed: string[];
  published: string[];
  mirrorUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
  claimNullFor: Set<string>;
}

function checkDeps(
  state: CheckState,
  feedByUsername: Record<string, unknown[]>,
  failFeedFor: Set<string> = new Set()
): MirrorTickDeps {
  return {
    listKnownSourceIds: async () => new Set(),
    claimPost: async (_mirrorId, post) => {
      if (state.claimNullFor.has(post.sourcePostId)) return null;
      state.claimed.push(post.sourcePostId);
      return `post-${post.sourcePostId}`;
    },
    updatePost: async () => {},
    updateMirror: async (id, patch) => {
      state.mirrorUpdates.push({ id, patch: patch as Record<string, unknown> });
    },
    fetchFeed: async (username: string) => {
      if (failFeedFor.has(username)) throw new InternalError('tikwm down');
      return (feedByUsername[username] ?? []) as never;
    },
    resolveVideo: async ({ videoId }) => ({
      playUrl: `https://example.com/${videoId}.mp4`,
      title: `Caption for ${videoId}`,
    }),
    publishReel: async (params) => {
      state.published.push(params.videoUrl);
      return `fb_${params.videoUrl}`;
    },
    now: new Date('2026-10-29T12:00:00.000Z'),
  };
}

// ---------- in-memory job store (mirrors the RPC semantics) ----------

interface FakeJob {
  id: string;
  mirrorId: string;
  attempts: number;
  availableAt: number;
  claimedAt: number | null;
  status: 'pending' | 'processing' | 'exhausted';
  error: string | null;
}

const STALE_MS = 30 * 60 * 1000;

class FakeJobStore {
  jobs: FakeJob[] = [];
  completed: string[] = [];
  exhausted: Array<{ mirrorId: string; error: string }> = [];
  failCompleteFor = new Set<string>();

  enqueue(jobs: Array<{ mirrorId: string; availableAt: string }>): number {
    let inserted = 0;
    for (const job of jobs) {
      if (
        this.jobs.some(
          (j) =>
            j.mirrorId === job.mirrorId &&
            (j.status === 'pending' || j.status === 'processing')
        )
      ) {
        continue;
      }
      this.jobs.push({
        id: `job-${job.mirrorId}`,
        mirrorId: job.mirrorId,
        attempts: 0,
        availableAt: Date.parse(job.availableAt),
        claimedAt: null,
        status: 'pending',
        error: null,
      });
      inserted += 1;
    }
    return inserted;
  }

  claim(now: Date, limit: number): MirrorCheckJob[] {
    const nowMs = now.getTime();
    for (const job of this.jobs) {
      if (
        job.status === 'processing' &&
        job.attempts >= MIRROR_JOB_MAX_ATTEMPTS &&
        (job.claimedAt ?? 0) < nowMs - STALE_MS
      ) {
        job.status = 'exhausted';
        job.error = 'Mirror check worker did not report back after the final attempt.';
        this.exhausted.push({ mirrorId: job.mirrorId, error: job.error });
      }
    }
    const due = this.jobs
      .filter(
        (job) =>
          job.availableAt <= nowMs &&
          (job.status === 'pending' ||
            (job.status === 'processing' &&
              (job.claimedAt ?? 0) < nowMs - STALE_MS &&
              job.attempts < MIRROR_JOB_MAX_ATTEMPTS))
      )
      .sort((a, b) => a.availableAt - b.availableAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
    for (const job of due) {
      job.status = 'processing';
      job.claimedAt = nowMs;
      job.attempts += 1;
    }
    return due.map((job) => ({ id: job.id, mirrorId: job.mirrorId, attempts: job.attempts }));
  }

  complete(jobId: string): void {
    if (this.failCompleteFor.has(jobId)) throw new InternalError('completion write down');
    this.jobs = this.jobs.filter((job) => job.id !== jobId);
    this.completed.push(jobId);
  }

  fail(job: MirrorCheckJob, error: string, now: Date): 'retried' | 'exhausted' {
    const row = this.jobs.find((j) => j.id === job.id);
    if (!row) throw new InternalError('job not found');
    if (job.attempts >= MIRROR_JOB_MAX_ATTEMPTS) {
      row.status = 'exhausted';
      row.error = error;
      this.exhausted.push({ mirrorId: job.mirrorId, error });
      return 'exhausted';
    }
    const backoffSeconds = 60 * 2 ** (job.attempts - 1);
    row.status = 'pending';
    row.availableAt = now.getTime() + backoffSeconds * 1000;
    row.error = error;
    return 'retried';
  }
}

function jobTickDeps(
  store: FakeJobStore,
  mirrors: Record<string, MirrorTickMirror>,
  check: MirrorTickDeps,
  failFetchFor: Set<string> = new Set()
) {
  return {
    check,
    claimJobs: async (now: Date, limit: number) => store.claim(now, limit),
    fetchMirror: async (mirrorId: string) => {
      if (failFetchFor.has(mirrorId)) throw new InternalError('db down');
      return mirrors[mirrorId] ?? null;
    },
    completeJob: async (jobId: string) => {
      store.complete(jobId);
    },
    failJob: async (job: MirrorCheckJob, error: string, now: Date) =>
      store.fail(job, error, now),
  };
}

const TICK_NOW = new Date('2026-10-29T12:00:00.000Z');

describe('due scan pagination (no 1,000-row cut-off)', () => {
  it('finds all 2,500 due mirrors across 500-row pages', async () => {
    const rows: DueRow[] = [{ id: 'm-null', next_check_at: null }];
    for (let i = 0; i < 2499; i++) {
      rows.push({ id: `m-${i}`, next_check_at: pastIso(60 + i) });
    }
    // Future rows sort after every due row and must stop the scan.
    for (let i = 0; i < 5; i++) {
      rows.push({ id: `m-future-${i}`, next_check_at: pastIso(-60 - i) });
    }
    const { query, db } = fakeDueDb(rows);
    const deps = buildMirrorTickDeps(db, 'master-key');
    const ids = await deps.listDueMirrorIds(new Date(), 100000);
    expect(ids).toHaveLength(2500);
    expect(ids[0]).toBe('m-null');
    expect(ids).not.toContain('m-future-0');
    // Pages of exactly 500 until the final partial page.
    expect(query.ranges[0]).toEqual([0, MIRROR_DISPATCH_BATCH_SIZE - 1]);
    expect(query.ranges[1]).toEqual([
      MIRROR_DISPATCH_BATCH_SIZE,
      2 * MIRROR_DISPATCH_BATCH_SIZE - 1,
    ]);
    expect(query.ranges.length).toBe(6);
  });

  it('stops at the first not-yet-due row', async () => {
    const rows: DueRow[] = [
      { id: 'm-due', next_check_at: pastIso(10) },
      { id: 'm-future', next_check_at: pastIso(-10) },
      { id: 'm-due-2', next_check_at: pastIso(20) },
    ];
    const { query, db } = fakeDueDb(rows);
    const deps = buildMirrorTickDeps(db, 'master-key');
    const ids = await deps.listDueMirrorIds(new Date(), 100000);
    // Due order is by stamp, so m-due-2 (older) comes first and
    // the future row ends the prefix — m-due sorts between them.
    expect(ids).toEqual(['m-due-2', 'm-due']);
    expect(query.ranges.length).toBe(1);
  });
});

describe('dispatcher pacing, cap, and cadence', () => {
  it('dispatches at most the per-run cap and paces ~3 jobs/second via available_at', async () => {
    const inserted: Array<{ mirrorId: string; availableAt: string }> = [];
    const advanced: Array<{ id: string; next: string }> = [];
    const ids = Array.from({ length: 2000 }, (_, i) => `m-${i}`);
    const dispatchAt = new Date('2026-10-29T12:00:00.000Z');
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ids,
      enqueueMirrorCheckJobs: async (jobs) => {
        inserted.push(...jobs);
        return jobs.length;
      },
      advanceMirrorCheck: async (id, next) => {
        advanced.push({ id, next });
      },
      now: dispatchAt,
    });
    expect(result.due).toBe(2000);
    expect(result.dispatched).toBe(MIRROR_DISPATCH_PER_RUN_CAP);
    expect(result.failed).toBe(0);
    expect(inserted).toHaveLength(MIRROR_DISPATCH_PER_RUN_CAP);
    expect(advanced).toHaveLength(MIRROR_DISPATCH_PER_RUN_CAP);
    // First three jobs go immediately, next three after 1s, etc.
    expect(inserted.slice(0, 3).map((j) => j.availableAt)).toEqual([
      '2026-10-29T12:00:00.000Z',
      '2026-10-29T12:00:00.000Z',
      '2026-10-29T12:00:00.000Z',
    ]);
    expect(inserted.slice(3, 6).map((j) => j.availableAt)).toEqual([
      '2026-10-29T12:00:01.000Z',
      '2026-10-29T12:00:01.000Z',
      '2026-10-29T12:00:01.000Z',
    ]);
    expect(inserted[inserted.length - 1]?.availableAt).toBe(
      new Date(
        dispatchAt.getTime() +
          Math.floor((MIRROR_DISPATCH_PER_RUN_CAP - 1) / MIRROR_DISPATCH_JOBS_PER_SECOND) * 1000
      ).toISOString()
    );
    // Next check = dispatch time + 1h, for every dispatched mirror.
    expect(new Set(advanced.map((a) => a.next))).toEqual(
      new Set(['2026-10-29T13:00:00.000Z'])
    );
  });

  it('a failed insert chunk leaves its mirrors due while earlier chunks dispatch', async () => {
    const advanced: string[] = [];
    const ids = Array.from({ length: 600 }, (_, i) => `m-${i}`);
    let calls = 0;
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ids,
      enqueueMirrorCheckJobs: async (jobs) => {
        calls += 1;
        if (calls === 2) throw new InternalError('insert down');
        return jobs.length;
      },
      advanceMirrorCheck: async (id) => {
        advanced.push(id);
      },
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    // Chunk 1 (500) dispatched; chunk 2 (100) failed, left due.
    expect(result).toEqual({ dispatched: 500, failed: 100, due: 600 });
    expect(advanced).toHaveLength(500);
  });

  it('a re-dispatch inserts nothing new but still advances the already-queued mirrors', async () => {
    const advanced: string[] = [];
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ['m-1', 'm-2', 'm-3'],
      enqueueMirrorCheckJobs: async () => 0, // All already hold a live job.
      advanceMirrorCheck: async (id) => {
        advanced.push(id);
      },
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    expect(result).toEqual({ dispatched: 3, failed: 0, due: 3 });
    expect(advanced).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('an advanced next_check_at is not re-dispatched within the hour', async () => {
    const now = new Date();
    const rows: DueRow[] = [
      { id: 'm-1', next_check_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString() },
    ];
    const { db } = fakeDueDb(rows);
    const deps = buildMirrorTickDeps(db, 'master-key');
    const first = await deps.listDueMirrorIds(now, MIRROR_DISPATCH_PER_RUN_CAP);
    expect(first).toEqual(['m-1']);
    // Simulate the dispatcher's advance: the mirror's next check
    // is now an hour out, so a run 10 minutes later finds nothing.
    rows[0]!.next_check_at = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const second = await deps.listDueMirrorIds(
      new Date(now.getTime() + 10 * 60 * 1000),
      MIRROR_DISPATCH_PER_RUN_CAP
    );
    expect(second).toEqual([]);
  });
});

describe('job-tick isolation, retries, and exhaustion', () => {
  it("one mirror's fetch failure does not block other jobs in the tick", async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    const store = new FakeJobStore();
    store.enqueue([
      { mirrorId: 'm1', availableAt: TICK_NOW.toISOString() },
      { mirrorId: 'm2', availableAt: TICK_NOW.toISOString() },
      { mirrorId: 'm3', availableAt: TICK_NOW.toISOString() },
    ]);
    const mirrors: Record<string, MirrorTickMirror> = {
      m1: checkMirror({ id: 'm1', sourceUsername: 'alice' }),
      m2: checkMirror({ id: 'm2', sourceUsername: 'bob' }),
      m3: checkMirror({ id: 'm3', sourceUsername: 'carol' }),
    };
    const deps = checkDeps(
      state,
      { bob: [checkReel('v-b', 100)], carol: [checkReel('v-c', 100)] },
      new Set(['alice'])
    );
    const result = await runMirrorJobTick({
      ...jobTickDeps(store, mirrors, deps, new Set(['m1'])),
      now: TICK_NOW,
    });
    expect(state.published).toEqual([
      'https://example.com/v-b.mp4',
      'https://example.com/v-c.mp4',
    ]);
    expect(result).toMatchObject({ claimed: 3, completed: 2, retried: 1, exhausted: 0 });
    // The failed job is pending again with a 60s backoff, not lost.
    const failed = store.jobs.find((j) => j.mirrorId === 'm1');
    expect(failed?.status).toBe('pending');
    expect(failed?.availableAt).toBe(TICK_NOW.getTime() + 60 * 1000);
  });

  it('retries back off (60s, 120s) and the third failure exhausts + stamps the mirror error', async () => {
    const store = new FakeJobStore();
    store.enqueue([{ mirrorId: 'm1', availableAt: TICK_NOW.toISOString() }]);
    const mirrors: Record<string, MirrorTickMirror> = {
      m1: checkMirror({ id: 'm1' }),
    };
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    const deps = jobTickDeps(store, mirrors, checkDeps(state, {}), new Set(['m1']));
    const r1 = await runMirrorJobTick({ ...deps, now: TICK_NOW });
    expect(r1).toMatchObject({ claimed: 1, retried: 1 });
    const t2 = new Date(TICK_NOW.getTime() + 61 * 1000);
    const r2 = await runMirrorJobTick({ ...deps, now: t2 });
    expect(r2).toMatchObject({ claimed: 1, retried: 1 });
    const failed = store.jobs.find((j) => j.mirrorId === 'm1');
    expect(failed?.availableAt).toBe(t2.getTime() + 120 * 1000);
    const t3 = new Date(t2.getTime() + 121 * 1000);
    const r3 = await runMirrorJobTick({ ...deps, now: t3 });
    expect(r3).toMatchObject({ claimed: 1, exhausted: 1, completed: 0 });
    expect(store.exhausted).toHaveLength(1);
    expect(store.exhausted[0]?.mirrorId).toBe('m1');
  });

  it('skips paused-since-dispatch and deleted mirrors without work', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    let feedCalls = 0;
    const store = new FakeJobStore();
    store.enqueue([
      { mirrorId: 'm-paused', availableAt: TICK_NOW.toISOString() },
      { mirrorId: 'm-gone', availableAt: TICK_NOW.toISOString() },
    ]);
    const deps = checkDeps(state, { alice: [checkReel('v-a', 100)] });
    const counting: MirrorTickDeps = {
      ...deps,
      fetchFeed: async (username) => {
        feedCalls += 1;
        return deps.fetchFeed(username);
      },
    };
    const result = await runMirrorJobTick({
      ...jobTickDeps(
        store,
        { 'm-paused': checkMirror({ id: 'm-paused', status: 'paused' }) },
        counting
      ),
      now: TICK_NOW,
    });
    // Both jobs complete (deleted) without any feed call.
    expect(feedCalls).toBe(0);
    expect(state.published).toHaveLength(0);
    expect(result).toMatchObject({ claimed: 2, completed: 2 });
    expect([...store.completed].sort()).toEqual(['job-m-gone', 'job-m-paused']);
  });

  it('a claim loss still means no publish (claim-before-publish preserved)', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(['v-a']),
    };
    const store = new FakeJobStore();
    store.enqueue([{ mirrorId: 'm1', availableAt: TICK_NOW.toISOString() }]);
    await runMirrorJobTick({
      ...jobTickDeps(
        store,
        { m1: checkMirror({ id: 'm1' }) },
        checkDeps(state, { alice: [checkReel('v-a', 100)] })
      ),
      now: TICK_NOW,
    });
    expect(state.published).toHaveLength(0);
  });

  it('catch-up through the job tick posts only the newest reel', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    const store = new FakeJobStore();
    store.enqueue([{ mirrorId: 'm1', availableAt: TICK_NOW.toISOString() }]);
    await runMirrorJobTick({
      ...jobTickDeps(
        store,
        { m1: checkMirror({ id: 'm1', catchUpPending: true }) },
        checkDeps(state, {
          alice: [checkReel('v1', 100), checkReel('v2', 200), checkReel('v3', 300)],
        })
      ),
      now: TICK_NOW,
    });
    expect(state.published).toEqual(['https://example.com/v3.mp4']);
    expect(state.claimed.filter((id) => id !== 'v3')).toEqual(['v1', 'v2']);
  });

  it('two concurrent ticks never process the same job', async () => {
    const processed: string[] = [];
    const store = new FakeJobStore();
    const mirrors: Record<string, MirrorTickMirror> = {};
    for (let i = 0; i < 120; i++) {
      const id = `m-${i}`;
      store.enqueue([{ mirrorId: id, availableAt: TICK_NOW.toISOString() }]);
      mirrors[id] = checkMirror({ id, sourceUsername: `user-${i}` });
    }
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    const base = checkDeps(state, {});
    const counting: MirrorTickDeps = {
      ...base,
      fetchFeed: async (username) => {
        processed.push(username);
        return [];
      },
    };
    const deps = jobTickDeps(store, mirrors, counting);
    const [r1, r2] = await Promise.all([
      runMirrorJobTick({ ...deps, now: TICK_NOW }),
      runMirrorJobTick({ ...deps, now: TICK_NOW }),
    ]);
    expect(r1.claimed + r2.claimed).toBe(120);
    expect(processed).toHaveLength(120);
    expect(new Set(processed).size).toBe(120);
    expect(store.completed).toHaveLength(120);
  });

  it('production failMirrorCheckJob backs off (60s, 120s) then exhausts with a mirror stamp', async () => {
    const updates: Array<{ table: string; values: Record<string, unknown>; id: string }> = [];
    const db = {
      from: (table: string) => ({
        update: (values: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            updates.push({ table, values, id });
            return { error: null };
          },
        }),
        delete: () => ({
          eq: async () => ({ error: null }),
        }),
      }),
    } as never;
    const deps = buildMirrorTickDeps(db, 'master-key');
    const now = new Date('2026-10-29T12:00:00.000Z');
    const r1 = await deps.failMirrorCheckJob(
      { id: 'j1', mirrorId: 'm1', attempts: 1 },
      'db down',
      now
    );
    expect(r1).toBe('retried');
    const jobUpdate1 = updates.find((u) => u.table === 'mirror_check_jobs');
    expect(jobUpdate1?.values.status).toBe('pending');
    expect(jobUpdate1?.values.available_at).toBe('2026-10-29T12:01:00.000Z');
    updates.length = 0;
    const r2 = await deps.failMirrorCheckJob(
      { id: 'j1', mirrorId: 'm1', attempts: 2 },
      'db down',
      now
    );
    expect(r2).toBe('retried');
    expect(
      updates.find((u) => u.table === 'mirror_check_jobs')?.values.available_at
    ).toBe('2026-10-29T12:02:00.000Z');
    updates.length = 0;
    const r3 = await deps.failMirrorCheckJob(
      { id: 'j1', mirrorId: 'm1', attempts: 3 },
      'db down',
      now
    );
    expect(r3).toBe('exhausted');
    expect(
      updates.find((u) => u.table === 'mirror_check_jobs')?.values.status
    ).toBe('exhausted');
    const mirrorStamp = updates.find((u) => u.table === 'mirrors');
    expect(mirrorStamp?.id).toBe('m1');
    expect(mirrorStamp?.values.status).toBe('error');
    expect(mirrorStamp?.values.last_error).toBe('db down');
  });

  it('a claim failure aborts the tick with zeros and throws nothing', async () => {
    const result = await runMirrorJobTick({
      check: checkDeps(
        { claimed: [], published: [], mirrorUpdates: [], claimNullFor: new Set() },
        {}
      ),
      claimJobs: async () => {
        throw new InternalError('claim RPC down');
      },
      fetchMirror: async () => null,
      completeJob: async () => {},
      failJob: async () => 'retried' as const,
      now: TICK_NOW,
    });
    expect(result).toEqual({
      claimed: 0,
      completed: 0,
      retried: 0,
      exhausted: 0,
      stuck: 0,
    });
  });

  it('a failed completion write leaves the job processing; a later tick reclaims it when stale', async () => {
    const store = new FakeJobStore();
    store.enqueue([{ mirrorId: 'm1', availableAt: TICK_NOW.toISOString() }]);
    store.failCompleteFor.add('job-m1');
    const mirrors: Record<string, MirrorTickMirror> = {
      m1: checkMirror({ id: 'm1', sourceUsername: 'alice' }),
    };
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    const deps = jobTickDeps(
      store,
      mirrors,
      checkDeps(state, { alice: [checkReel('v-a', 100)] })
    );
    const r1 = await runMirrorJobTick({ ...deps, now: TICK_NOW });
    expect(r1).toMatchObject({ claimed: 1, stuck: 1, completed: 0 });
    // Not yet stale: the next minute does not reclaim it.
    const r2 = await runMirrorJobTick({
      ...deps,
      now: new Date(TICK_NOW.getTime() + 60 * 1000),
    });
    expect(r2.claimed).toBe(0);
    // Past the 30-minute stale bound, with the write fixed, the
    // job is reclaimed (second attempt) and completes.
    store.failCompleteFor.clear();
    const r3 = await runMirrorJobTick({
      ...deps,
      now: new Date(TICK_NOW.getTime() + 31 * 60 * 1000),
    });
    expect(r3).toMatchObject({ claimed: 1, completed: 1 });
  });
});
