/**
 * Scaled mirror checks: dispatcher + queue fan-out.
 *
 * Covers what the old single-loop tick could not prove:
 * - Due scans page in 500-row batches, so mirrors past the
 *   1,000-row PostgREST truncation are still found.
 * - NULL next_check_at counts as due; a future stamp ends the
 *   due prefix (scan stops, nothing not-yet-due is dispatched).
 * - Per-run cap (1,700) + next_check_at advancement preserve
 *   hourly cadence without re-dispatching within the hour.
 * - Dispatch pacing spreads jobs ~3/second (delaySeconds).
 * - A failed enqueue leaves that mirror due; other mirrors
 *   still dispatch.
 * - Consumer isolation: one mirror's failure never blocks
 *   other mirrors in the same batch; paused/deleted mirrors
 *   are skipped; DLQ stamps the mirror error without throwing.
 * - Claim-before-publish and the catch-up rule survive the
 *   move from loop tick to queue consumer unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMirrorTickDeps,
  handleMirrorCheckBatch,
  handleMirrorCheckDlqBatch,
  MIRROR_DISPATCH_BATCH_SIZE,
  MIRROR_DISPATCH_PER_RUN_CAP,
  processMirrorCheck,
  runMirrorDispatch,
  type MirrorCheckMessage,
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

// ---------- fake per-mirror check deps (consumer tests) ----------

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
      if (failFeedFor.has(username)) throw new Error('tikwm down');
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

function batch(ids: string[]): { messages: Array<{ body: MirrorCheckMessage }> } {
  return { messages: ids.map((mirrorId) => ({ body: { mirrorId } })) };
}

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
  it('dispatches at most the per-run cap and paces ~3 jobs/second', async () => {
    const enqueued: Array<{ id: string; delay: number }> = [];
    const advanced: Array<{ id: string; next: string }> = [];
    const ids = Array.from({ length: 2000 }, (_, i) => `m-${i}`);
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ids,
      enqueueMirrorCheck: async (id, delay) => {
        enqueued.push({ id, delay });
      },
      advanceMirrorCheck: async (id, next) => {
        advanced.push({ id, next });
      },
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    expect(result.due).toBe(2000);
    expect(result.dispatched).toBe(MIRROR_DISPATCH_PER_RUN_CAP);
    expect(result.failed).toBe(0);
    expect(enqueued).toHaveLength(MIRROR_DISPATCH_PER_RUN_CAP);
    expect(advanced).toHaveLength(MIRROR_DISPATCH_PER_RUN_CAP);
    // First three jobs go immediately, next three after 1s, etc.
    expect(enqueued.slice(0, 3).map((e) => e.delay)).toEqual([0, 0, 0]);
    expect(enqueued.slice(3, 6).map((e) => e.delay)).toEqual([1, 1, 1]);
    expect(enqueued[enqueued.length - 1]?.delay).toBe(
      Math.floor((MIRROR_DISPATCH_PER_RUN_CAP - 1) / 3)
    );
    // Next check = dispatch time + 1h, for every dispatched mirror.
    expect(new Set(advanced.map((a) => a.next))).toEqual(
      new Set(['2026-10-29T13:00:00.000Z'])
    );
  });

  it('a failed enqueue leaves that mirror due while others dispatch', async () => {
    const enqueued: string[] = [];
    const advanced: string[] = [];
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ['m-ok-1', 'm-bad', 'm-ok-2'],
      enqueueMirrorCheck: async (id) => {
        if (id === 'm-bad') throw new Error('queue full');
        enqueued.push(id);
      },
      advanceMirrorCheck: async (id) => {
        advanced.push(id);
      },
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    expect(result).toEqual({ dispatched: 2, failed: 1, due: 3 });
    expect(enqueued).toEqual(['m-ok-1', 'm-ok-2']);
    expect(advanced).toEqual(['m-ok-1', 'm-ok-2']);
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

describe('consumer isolation and skips', () => {
  it("one mirror's feed failure does not block other mirrors in the batch", async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
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
    await handleMirrorCheckBatch(batch(['m1', 'm2', 'm3']), {
      check: deps,
      fetchMirror: async (id) => mirrors[id] ?? null,
    });
    expect(state.published).toEqual([
      'https://example.com/v-b.mp4',
      'https://example.com/v-c.mp4',
    ]);
    const m1Stamp = state.mirrorUpdates.filter((u) => u.id === 'm1').pop();
    expect(m1Stamp?.patch.status).toBe('error');
  });

  it('skips paused-since-dispatch and deleted mirrors without work', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    let feedCalls = 0;
    const deps = checkDeps(state, { alice: [checkReel('v-a', 100)] });
    const counting: MirrorTickDeps = {
      ...deps,
      fetchFeed: async (username) => {
        feedCalls += 1;
        return deps.fetchFeed(username);
      },
    };
    await handleMirrorCheckBatch(batch(['m-paused', 'm-gone']), {
      check: counting,
      fetchMirror: async (id) => {
        if (id === 'm-gone') return null;
        return checkMirror({ id, status: 'paused' });
      },
    });
    expect(feedCalls).toBe(0);
    expect(state.published).toHaveLength(0);
  });

  it('a claim loss still means no publish (claim-before-publish preserved)', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(['v-a']),
    };
    await handleMirrorCheckBatch(batch(['m1']), {
      check: checkDeps(state, { alice: [checkReel('v-a', 100)] }),
      fetchMirror: async () => checkMirror({ id: 'm1' }),
    });
    expect(state.published).toHaveLength(0);
  });

  it('catch-up through the consumer posts only the newest reel', async () => {
    const state: CheckState = {
      claimed: [],
      published: [],
      mirrorUpdates: [],
      claimNullFor: new Set(),
    };
    await handleMirrorCheckBatch(batch(['m1']), {
      check: checkDeps(state, {
        alice: [checkReel('v1', 100), checkReel('v2', 200), checkReel('v3', 300)],
      }),
      fetchMirror: async () =>
        checkMirror({ id: 'm1', catchUpPending: true }),
    });
    expect(state.published).toEqual(['https://example.com/v3.mp4']);
    expect(state.claimed.filter((id) => id !== 'v3')).toEqual(['v1', 'v2']);
  });
});

describe('dead-letter consumer', () => {
  it('marks the mirror error for a poison message', async () => {
    const marked: Array<{ id: string; error: string }> = [];
    await handleMirrorCheckDlqBatch(batch(['m-poison']), {
      markMirrorError: async (id, error) => {
        marked.push({ id, error });
      },
    });
    expect(marked).toHaveLength(1);
    expect(marked[0]?.id).toBe('m-poison');
    expect(marked[0]?.error).toContain('dead-letter');
  });

  it('never throws when the error stamp itself fails', async () => {
    await expect(
      handleMirrorCheckDlqBatch(batch(['m-poison']), {
        markMirrorError: async () => {
          throw new Error('db down');
        },
      })
    ).resolves.toBeUndefined();
  });
});
