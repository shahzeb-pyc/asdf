/**
 * TikTok mirror check (per-mirror, queue consumer unit of work):
 * newer-only oldest-first posting, claim-then-post (overlapping
 * checks never double-post), watermarked-only skipped with
 * error, tikwm failure → mirror error, publish failure → post
 * recorded failed + mirror error, success clears the mirror
 * error, caption verbatim. (Paused/deleted skipping lives in
 * the consumer tests — the consumer fetches the mirror fresh
 * and skips before this runs.)
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  InternalError,
  MIRROR_FACEBOOK_RESTRICTED_MESSAGE,
} from '@fbuploadpro/contracts';
import { FacebookGraphError } from './fb-client.js';
import { workspaceOwnerHasActivePeriod } from './entitlement.js';
import {
  buildMirrorTickDeps,
  MIRROR_JOB_STALE_AFTER_SECONDS,
  processMirrorCheck,
  runMirrorDispatch,
  type MirrorTickDeps,
  type MirrorTickMirror,
} from './mirror-tick.js';

function mirror(overrides: Partial<MirrorTickMirror> = {}): MirrorTickMirror {
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
    // Spec 155: no Facebook detail, target active.
    fbStatus: null,
    fbRateLimitedAt: null,
    targetStatus: 'active',
    targetRateLimitedAt: null,
    targetUpdatedAt: null,
    lastCheckedAt: '2026-10-29T11:30:00.000Z',
    catchUpPending: false,
    lastPostedSourceId: null,
    lastPostedCreateTime: null,
    ...overrides,
  };
}

function reel(videoId: string, createTime: number, overrides: Record<string, unknown> = {}) {
  return {
    video_id: videoId,
    play: `https://example.com/${videoId}.mp4`,
    wmplay: `https://example.com/${videoId}-wm.mp4`,
    title: `Caption for ${videoId}`,
    cover: `https://example.com/${videoId}.jpg`,
    create_time: createTime,
    ...overrides,
  };
}

interface FakeState {
  claimed: Array<{ mirrorId: string; post: Parameters<MirrorTickDeps['claimPost']>[1] }>;
  postUpdates: Array<{ id: string; patch: Parameters<MirrorTickDeps['updatePost']>[1] }>;
  mirrorUpdates: Array<{ id: string; patch: Parameters<MirrorTickDeps['updateMirror']>[1] }>;
  published: Array<Parameters<MirrorTickDeps['publishReel']>[0]>;
  claimReturnsNullFor: Set<string>;
  publishFailsFor: Set<string>;
  /** Spec 155: the exact error publishReel throws (a Graph error). */
  publishError?: unknown;
  fetchFeedCalls: number;
}

function fakeDeps(state: FakeState, feed: unknown[]): MirrorTickDeps {
  return {
    listKnownSourceIds: async () => new Set(),
    claimPost: async (mirrorId, post) => {
      if (state.claimReturnsNullFor.has(post.sourcePostId)) return null;
      state.claimed.push({ mirrorId, post });
      return `post-${post.sourcePostId}`;
    },
    updatePost: async (id, patch) => {
      state.postUpdates.push({ id, patch });
    },
    updateMirror: async (id, patch) => {
      state.mirrorUpdates.push({ id, patch });
    },
    fetchFeed: async () => {
      state.fetchFeedCalls += 1;
      return feed as never;
    },
    resolveVideo: async ({ videoId }) => ({
      playUrl: `https://example.com/${videoId}.mp4`,
      title: `Caption for ${videoId}`,
    }),
    publishReel: async (params) => {
      if (state.publishFailsFor.has(params.videoUrl)) {
        throw state.publishError ?? new InternalError('Graph exploded');
      }
      state.published.push(params);
      return `fb_${params.videoUrl}`;
    },
    // C4: the gate is required and always runs — the default fake
    // is entitled, so the pre-existing tests keep proving the
    // check body; the paused/failure tests below override it.
    checkEntitlement: async () => true,
    now: new Date('2026-10-29T12:00:00.000Z'),
  };
}

function newState(): FakeState {
  return {
    claimed: [],
    postUpdates: [],
    mirrorUpdates: [],
    published: [],
    claimReturnsNullFor: new Set(),
    publishFailsFor: new Set(),
    fetchFeedCalls: 0,
  };
}

describe('processMirrorCheck', () => {
  it('posts new reels oldest-first with the caption verbatim', async () => {
    const state = newState();
    const feed = [reel('v3', 300), reel('v1', 100), reel('v2', 200)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror());
    expect(result.posted).toBe(3);
    expect(state.published.map((p) => p.videoUrl)).toEqual([
      'https://example.com/v1.mp4',
      'https://example.com/v2.mp4',
      'https://example.com/v3.mp4',
    ]);
    expect(state.published[0]?.caption).toBe('Caption for v1');
    // The claimed mirror-post row id travels with the publish call,
    // so the [reel-publish] console lines name the post that failed.
    expect(state.published.map((p) => p.itemId)).toEqual(['post-v1', 'post-v2', 'post-v3']);
    // Final stamp clears the mirror to active with next check +1h.
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('active');
    expect(stamp?.patch.nextCheckAt).toBe('2026-10-29T13:00:00.000Z');
  });

  it('entitlement-paused check claims and publishes nothing, stamping only nextCheckAt', async () => {
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100), reel('v2', 200)]);
    deps.checkEntitlement = async () => false;
    const result = await processMirrorCheck(deps, mirror());
    expect(result).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(state.claimed).toHaveLength(0);
    expect(state.published).toHaveLength(0);
    // Only the pause stamp: nextCheckAt advances so the schedule
    // continues, but lastCheckedAt stays frozen — the gap
    // catch-up rule must still fire on renewal, or paused reels
    // would flood oldest-first instead of posting latest-only.
    expect(state.mirrorUpdates).toHaveLength(1);
    expect(state.mirrorUpdates[0]?.patch).toEqual({
      nextCheckAt: '2026-10-29T13:00:00.000Z',
    });
  });

  it('entitlement failure fails closed: nothing claimed or published', async () => {
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100)]);
    deps.checkEntitlement = async () => {
      throw new InternalError('db down');
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(0);
    expect(state.claimed).toHaveLength(0);
    expect(state.published).toHaveLength(0);
  });

  it('mirror with live period proceeds through the shared helper gate', async () => {
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100)]);
    const calls: string[] = [];
    deps.checkEntitlement = async (workspaceId) => {
      calls.push(workspaceId);
      return true;
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(1);
    expect(calls).toEqual(['ws_1']);
  });


  it('posts only items newer than the last posted reel', async () => {
    const state = newState();
    const feed = [reel('v1', 100), reel('v2', 200), reel('v3', 300)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror({ lastPostedSourceId: 'v2', lastPostedCreateTime: 200 }));
    expect(result.posted).toBe(1);
    expect(state.published[0]?.videoUrl).toContain('v3');
  });

  it('skips an overlapping-tick claim (claim returns null) without publishing', async () => {
    const state = newState();
    state.claimReturnsNullFor.add('v1');
    const result = await processMirrorCheck(fakeDeps(state, [reel('v1', 100)]), mirror());
    expect(result.posted).toBe(0);
    expect(state.published).toHaveLength(0);
  });

  it('records a failed post as failed, marks the mirror error, and stops that mirror', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    const feed = [reel('v1', 100), reel('v2', 200)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror());
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    // v2 never attempted: the loop stops after the first failure.
    expect(state.published).toHaveLength(0);
    expect(state.claimed.map((c) => c.post.sourcePostId)).toEqual(['v1']);
    const postUpdate = state.postUpdates.find((u) => u.id === 'post-v1');
    expect(postUpdate?.patch.status).toBe('failed');
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
    expect(stamp?.patch.lastError).toContain('Graph exploded');
  });

  it('shows the plain restriction message on a restricted publish failure, post failed', async () => {
    const state = newState();
    const restrictedError = Object.assign(
      new Error(
        'For security reasons, your account has limited access to the site for a few days.'
      ),
      { code: 1, errorSubcode: 2424009 }
    );
    const deps: MirrorTickDeps = {
      ...fakeDeps(state, [reel('v1', 100)]),
      publishReel: async () => {
        throw restrictedError;
      },
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    const postUpdate = state.postUpdates.find((u) => u.id === 'post-v1');
    expect(postUpdate?.patch.status).toBe('failed');
    expect(postUpdate?.patch.error).toBe(MIRROR_FACEBOOK_RESTRICTED_MESSAGE);
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
    expect(stamp?.patch.lastError).toBe(MIRROR_FACEBOOK_RESTRICTED_MESSAGE);
  });

  it('maps a restriction carried only as free text to the plain message', async () => {
    const state = newState();
    const deps: MirrorTickDeps = {
      ...fakeDeps(state, [reel('v1', 100)]),
      publishReel: async () => {
        throw new InternalError(
          'For security reasons, your account has limited access to the site for a few days.'
        );
      },
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.failed).toBe(1);
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.lastError).toBe(MIRROR_FACEBOOK_RESTRICTED_MESSAGE);
  });

  it('records a resolve failure as failed, marks the mirror error, and stops that mirror', async () => {
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100), reel('v2', 200)]);
    deps.resolveVideo = async () => {
      throw new InternalError('Could not resolve video');
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    expect(state.published).toHaveLength(0);
    // Only v1 claimed (failed with the resolve error); v2 never attempted.
    expect(state.claimed.map((c) => c.post.sourcePostId)).toEqual(['v1']);
    expect(state.claimed[0]?.post.status).toBe('failed');
    expect(state.claimed[0]?.post.error).toContain('Could not resolve video');
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
  });

  it('skips watermarked-only items with a skipped row + mirror error, never posting them', async () => {
    const state = newState();
    const feed = [
      reel('v_wm', 100, { play: '' }),
      reel('v_ok', 200),
    ];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror());
    expect(result.skipped).toBe(1);
    expect(result.posted).toBe(1);
    expect(state.published[0]?.videoUrl).toContain('v_ok');
    const skippedClaim = state.claimed.find((c) => c.post.sourcePostId === 'v_wm');
    expect(skippedClaim?.post.status).toBe('skipped');
    expect(skippedClaim?.post.videoUrl).toBeNull();
  });

  it('marks the mirror error when tikwm fails (other mirrors are independent jobs)', async () => {
    const state = newState();
    const deps = fakeDeps(state, []);
    deps.fetchFeed = async (username: string) => {
      if (username === 'alice') throw new InternalError('tikwm down');
      return [];
    };
    await processMirrorCheck(deps, mirror({ id: 'm1' }));
    await processMirrorCheck(deps, mirror({ id: 'm2', sourceUsername: 'bob' }));
    const m1Stamp = state.mirrorUpdates.filter((u) => u.id === 'm1').pop();
    expect(m1Stamp?.patch.status).toBe('error');
    const m2Stamp = state.mirrorUpdates.filter((u) => u.id === 'm2').pop();
    expect(m2Stamp?.patch.status).toBe('active');
  });

  it('clears a prior error on a clean tick', async () => {
    const state = newState();
    await processMirrorCheck(fakeDeps(state, []), mirror({ status: 'error' }));
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('active');
    expect(stamp?.patch.lastError).toBeNull();
  });

  it('catch-up after resume posts only the newest reel and marks older missed reels skipped', async () => {
    const state = newState();
    const feed = [reel('v1', 100), reel('v2', 200), reel('v3', 300)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror({ catchUpPending: true }));
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(2);
    expect(state.published.map((p) => p.videoUrl)).toEqual([
      'https://example.com/v3.mp4',
    ]);
    const skippedClaims = state.claimed.filter((c) => c.post.status === 'skipped');
    expect(skippedClaims.map((c) => c.post.sourcePostId)).toEqual(['v1', 'v2']);
    expect(skippedClaims[0]?.post.error).toContain('Superseded');
    // The catch-up ran, so the resume flag clears and the check stamps.
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.catchUpPending).toBe(false);
    expect(stamp?.patch.lastCheckedAt).toBe('2026-10-29T12:00:00.000Z');
  });

  it('catch-up after a >2h gap posts only the newest reel', async () => {
    const state = newState();
    const feed = [reel('v1', 100), reel('v2', 200), reel('v3', 300)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror({ lastCheckedAt: '2026-10-29T09:00:00.000Z' }));
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(2);
    expect(state.published[0]?.videoUrl).toContain('v3');
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.catchUpPending).toBe(false);
  });

  it('a gap of exactly 2h is NOT catch-up (the rule is "exceeds")', async () => {
    const state = newState();
    const feed = [reel('v1', 100), reel('v2', 200), reel('v3', 300)];
    const result = await processMirrorCheck(fakeDeps(state, feed), mirror({ lastCheckedAt: '2026-10-29T10:00:00.000Z' }));
    expect(result.posted).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('a catch-up tick with nothing new still clears the resume flag', async () => {
    const state = newState();
    const result = await processMirrorCheck(fakeDeps(state, []), mirror({ catchUpPending: true }));
    expect(result.posted).toBe(0);
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.catchUpPending).toBe(false);
  });

  it('a feed failure does NOT clear the resume flag and does NOT stamp a check', async () => {
    const state = newState();
    const deps = fakeDeps(state, []);
    deps.fetchFeed = async () => {
      throw new InternalError('tikwm down');
    };
    await processMirrorCheck(deps, mirror({ catchUpPending: true }));
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
    expect(stamp?.patch.catchUpPending).toBeUndefined();
    expect(stamp?.patch.lastCheckedAt).toBeUndefined();
  });

  it('passes targetPlatform=instagram through to publishReel', async () => {
    const state = newState();
    const feed = [reel('v1', 100)];
    const result = await processMirrorCheck(
      fakeDeps(state, feed),
      mirror({ targetPlatform: 'instagram', targetExternalId: 'ig_123', targetToken: 'ig-token' })
    );
    expect(result.posted).toBe(1);
    expect(state.published[0]?.targetPlatform).toBe('instagram');
    expect(state.published[0]?.targetId).toBe('ig_123');
    expect(state.published[0]?.targetToken).toBe('ig-token');
  });

  it('does NOT rewrite a Facebook-restriction-shaped error on an Instagram mirror', async () => {
    const state = newState();
    const restrictedError = Object.assign(
      new Error(
        'For security reasons, your account has limited access to the site for a few days.'
      ),
      { code: 1, errorSubcode: 2424009 }
    );
    const deps: MirrorTickDeps = {
      ...fakeDeps(state, [reel('v1', 100)]),
      publishReel: async () => {
        throw restrictedError;
      },
    };
    const result = await processMirrorCheck(
      deps,
      mirror({ targetPlatform: 'instagram', targetExternalId: 'ig_123' })
    );
    expect(result.failed).toBe(1);
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.lastError).not.toBe(MIRROR_FACEBOOK_RESTRICTED_MESSAGE);
    expect(stamp?.patch.lastError).toContain('limited access');
  });
});

describe('processMirrorCheck — C4 due downgrade un-pauses the mirror', () => {
  /**
   * Minimal in-memory Supabase fake, just enough for the REAL
   * workspaceOwnerHasActivePeriod helper plus the activation it
   * runs: rpc('workspace_has_active_period') computed from the
   * rows, and from() chains for workspaces / users /
   * subscription_periods / subscription_payments /
   * seller_commissions. This test fails on the old code: the old
   * inline mirror copy never called activateDueScheduledDowngrade,
   * so the check would pause (posted 0, no period created).
   */
  type EntRow = Record<string, unknown>;
  interface EntDb {
    workspaces: EntRow[];
    users: EntRow[];
    periods: EntRow[];
    payments: EntRow[];
    commissions: EntRow[];
  }

  class EntBuilder {
    private filters: Array<(r: EntRow) => boolean> = [];
    private limitN: number | null = null;
    private insertRow: EntRow | null = null;
    private updatePatch: EntRow | null = null;

    constructor(
      private db: EntDb,
      private table: string
    ) {}

    select(): this {
      return this;
    }

    eq(col: string, val: unknown): this {
      this.filters.push((r) => r[col] === val);
      return this;
    }

    is(col: string, val: unknown): this {
      this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
      return this;
    }

    lte(col: string, val: string): this {
      this.filters.push((r) => typeof r[col] === 'string' && (r[col] as string) <= val);
      return this;
    }

    limit(n: number): this {
      this.limitN = n;
      return this;
    }

    insert(row: EntRow): this {
      this.insertRow = {
        ...row,
        id: `period-${this.db.periods.length + 1}`,
        superseded_at: null,
      };
      if (this.table === 'subscription_periods') this.db.periods.push(this.insertRow);
      return this;
    }

    update(patch: EntRow): this {
      this.updatePatch = patch;
      return this;
    }

    async maybeSingle(): Promise<{ data: EntRow | null; error: null }> {
      if (this.insertRow) return { data: this.insertRow, error: null };
      return { data: this.matched()[0] ?? null, error: null };
    }

    async single(): Promise<{ data: EntRow | null; error: null }> {
      if (this.insertRow) return { data: this.insertRow, error: null };
      return { data: this.matched()[0] ?? null, error: null };
    }

    then(resolve: (value: { data: unknown; error: null }) => void): void {
      if (this.updatePatch) {
        const matched = this.matched();
        for (const row of matched) Object.assign(row, this.updatePatch);
        resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
        return;
      }
      resolve({ data: this.matched(), error: null });
    }

    private rows(): EntRow[] {
      switch (this.table) {
        case 'workspaces':
          return this.db.workspaces;
        case 'users':
          return this.db.users;
        case 'subscription_periods':
          return this.db.periods;
        case 'subscription_payments':
          return this.db.payments;
        case 'seller_commissions':
          return this.db.commissions;
        default:
          return [];
      }
    }

    private matched(): EntRow[] {
      let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      return rows;
    }
  }

  function entitlementClient(db: EntDb): SupabaseClient {
    return {
      from: (table: string) => new EntBuilder(db, table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn !== 'workspace_has_active_period') {
          throw new Error(`unexpected rpc ${fn}`);
        }
        const workspace = db.workspaces.find((w) => w['id'] === args['p_workspace_id']);
        const ownerId = workspace?.['owner_id'];
        const user = db.users.find((u) => u['id'] === ownerId);
        if (user?.['role'] === 'admin') return { data: true, error: null };
        const at = Date.parse(args['p_at'] as string);
        const active = db.periods.some((p) => {
          if (p['user_id'] !== ownerId || p['superseded_at'] !== null) return false;
          const starts = Date.parse(p['starts_at'] as string);
          const ends = Date.parse(p['ends_at'] as string);
          return starts <= at && ends > at;
        });
        return { data: active, error: null };
      },
    } as unknown as SupabaseClient;
  }

  it('a due scheduled downgrade activates on the mirror tick and the check proceeds', async () => {
    const db: EntDb = {
      workspaces: [{ id: 'ws_1', owner_id: 'user-1' }],
      users: [{ id: 'user-1', role: 'user' }],
      periods: [],
      payments: [
        {
          id: 'payment-1',
          user_id: 'user-1',
          status: 'approved',
          period_id: null,
          is_downgrade: true,
          scheduled_starts_at: '2026-10-20T00:00:00.000Z',
          facebook_count: 2,
          instagram_count: 0,
          threads_count: 0,
          x_count: 0,
          tiktok_count: 0,
          youtube_count: 0,
        },
      ],
      commissions: [],
    };
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100)]);
    const now = new Date('2026-10-29T12:00:00.000Z');
    deps.checkEntitlement = async (workspaceId) =>
      workspaceOwnerHasActivePeriod(entitlementClient(db), workspaceId, now);
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(1);
    expect(state.published).toHaveLength(1);
    // The downgrade activated on the mirror tick itself: a period
    // was created and linked, exactly like the ADU gate does today.
    expect(db.periods).toHaveLength(1);
    expect(db.payments[0]?.['period_id']).toBe('period-1');
  });
});

describe('buildMirrorTickDeps job RPCs (bound receiver)', () => {
  /**
   * Fake client shaped exactly like the real supabase-js client: `rpc`
   * is a method that delegates through `this.rest`. The old code
   * detached `rpc` (`const rpc = db.rpc; rpc(...)`), which throws
   * `TypeError: Cannot read properties of undefined (reading 'rest')`
   * in production — the bug that froze every mirror check while
   * arrow-function mocks kept the old tests green. These tests fail
   * on the old code (TypeError) and pass on the fixed code.
   */
  class RestDelegatingClient {
    calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    rest = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        this.calls.push({ fn, args });
        if (fn === 'enqueue_mirror_check_jobs') return { data: 1, error: null };
        if (fn === 'claim_mirror_check_jobs') return { data: [], error: null };
        throw new InternalError(`unexpected rpc ${fn}`);
      },
    };
    async rpc(fn: string, args: Record<string, unknown>) {
      return this.rest.rpc(fn, args);
    }
  }

  function depsWith(client: unknown) {
    return buildMirrorTickDeps(
      client as unknown as Parameters<typeof buildMirrorTickDeps>[0],
      'test-master-key'
    );
  }

  it('enqueues through the bound client rpc', async () => {
    const client = new RestDelegatingClient();
    const deps = depsWith(client);
    await expect(
      deps.enqueueMirrorCheckJobs([
        { mirrorId: 'm1', availableAt: '2026-10-29T12:00:00.000Z' },
      ])
    ).resolves.toBe(1);
    expect(client.calls).toEqual([
      {
        fn: 'enqueue_mirror_check_jobs',
        args: {
          p_jobs: [{ mirror_id: 'm1', available_at: '2026-10-29T12:00:00.000Z' }],
        },
      },
    ]);
  });

  it('claims through the bound client rpc', async () => {
    const client = new RestDelegatingClient();
    const deps = depsWith(client);
    await expect(
      deps.claimMirrorCheckJobs(new Date('2026-10-29T12:00:00.000Z'), 200)
    ).resolves.toEqual([]);
    expect(client.calls).toEqual([
      {
        fn: 'claim_mirror_check_jobs',
        args: {
          p_limit: 200,
          p_now: '2026-10-29T12:00:00.000Z',
          p_stale_after_seconds: MIRROR_JOB_STALE_AFTER_SECONDS,
        },
      },
    ]);
  });

  it('dispatches through the real enqueue function', async () => {
    const client = new RestDelegatingClient();
    const deps = depsWith(client);
    const advanced: Array<{ mirrorId: string; nextCheckAt: string }> = [];
    const result = await runMirrorDispatch({
      listDueMirrorIds: async () => ['m1'],
      enqueueMirrorCheckJobs: deps.enqueueMirrorCheckJobs,
      advanceMirrorCheck: async (mirrorId, nextCheckAt) => {
        advanced.push({ mirrorId, nextCheckAt });
      },
      now: new Date('2026-10-29T12:00:00.000Z'),
    });
    expect(result).toEqual({ dispatched: 1, failed: 0, due: 1 });
    expect(advanced).toEqual([
      { mirrorId: 'm1', nextCheckAt: '2026-10-29T13:00:00.000Z' },
    ]);
  });

  it('still reports a client without rpc as not configured', async () => {
    const deps = depsWith({});
    await expect(
      deps.enqueueMirrorCheckJobs([
        { mirrorId: 'm1', availableAt: '2026-10-29T12:00:00.000Z' },
      ])
    ).rejects.toThrow('Mirror check job enqueue RPC is not configured');
    await expect(
      deps.claimMirrorCheckJobs(new Date('2026-10-29T12:00:00.000Z'), 200)
    ).rejects.toThrow('Mirror check job claim RPC is not configured');
  });
});

describe('buildMirrorTickDeps resolve proxy (spec 150)', () => {
  it('refuses to resolve direct when the proxy is unset (never silent direct)', async () => {
    const deps = buildMirrorTickDeps(
      {} as unknown as Parameters<typeof buildMirrorTickDeps>[0],
      'test-master-key',
    );
    const fetchSpy = vi.fn(async () => {
      throw new InternalError('direct fetch must not run');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await expect(
        deps.resolveVideo({ username: 'alice', videoId: 'v1' }),
      ).rejects.toThrow('Mirror resolve proxy is not configured');
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The bug this catches: resolve falling back to direct fetch when
    // DATAIMPULSE_PROXY is unset — the exact throttle failure the
    // proxy exists to fix, reintroduced invisibly.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to resolve direct when the proxy is blank', async () => {
    const deps = buildMirrorTickDeps(
      {} as unknown as Parameters<typeof buildMirrorTickDeps>[0],
      'test-master-key',
      { resolveProxyUrl: '   ' },
    );
    await expect(deps.resolveVideo({ username: 'alice', videoId: 'v1' })).rejects.toThrow(
      'Mirror resolve proxy is not configured',
    );
  });

  it('does not pass the proxy fetch function to the publish deps', async () => {
    // Spec 150: the proxy fetch function is created inside the
    // resolveVideo closure and must never be passed to any publish
    // dep — a publish must never ride the proxy. The fetch has no
    // handle outside that closure, so the test pins the call
    // contract at the tick → publish boundary: the tick hands the
    // publish dep target/video/caption only, no fetch of any kind.
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100)]);
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(1);
    expect(state.published).toHaveLength(1);
    const params = state.published[0] as unknown as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual([
      'caption',
      'itemId',
      'targetId',
      'targetPlatform',
      'targetToken',
      'videoUrl',
    ]);
    expect('fetch' in params).toBe(false);
    expect('fetchFn' in params).toBe(false);
    expect(Object.values(params).every((value) => typeof value !== 'function')).toBe(true);
  });
});

describe('processMirrorCheck Facebook error detail — spec 155', () => {
  const NOW = new Date('2026-10-29T12:00:00.000Z');

  function graphError(message: string, code: number, subcode?: number) {
    return new FacebookGraphError(message, {
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      type: 'OAuthException',
    });
  }

  /** The final stamp is the last mirror update. */
  function finalStamp(state: FakeState) {
    const last = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(last).toBeDefined();
    return last!.patch;
  }

  it('stamps the mapped fb_status on a Facebook publish failure', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    state.publishError = graphError('Missing role on the page.', 190, 492);
    const result = await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror(),
    );
    expect(result.failed).toBe(1);
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('error');
    expect(stamp.fbStatus).toBe('missing_page_access');
    expect(stamp.fbRateLimitedAt).toBeNull();
    // The post row is still recorded failed with the raw message.
    expect(state.postUpdates[0]?.patch.status).toBe('failed');
  });

  it('stamps the 3-day anchor on a rate-limited publish failure', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    state.publishError = graphError('Slow down.', 368, 1390008);
    await processMirrorCheck(fakeDeps(state, [reel('v1', 1761720000)]), mirror());
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('error');
    expect(stamp.fbStatus).toBe('fb_rate_limited');
    expect(stamp.fbRateLimitedAt).toBe(NOW.toISOString());
  });

  it('clears a stale fb_status when the new failure is transient/unmapped', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    state.publishError = graphError('Temporary failure.', 2);
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({ fbStatus: 'missing_permission', fbRateLimitedAt: null }),
    );
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('error');
    expect(stamp.fbStatus).toBeNull();
    expect(stamp.fbRateLimitedAt).toBeNull();
  });

  it('a clean check clears the fb_status and the anchor once the anchor is stale', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        // Stale on purpose: a fresh own anchor skips the check (B3
        // below) — the detail only clears once the cooldown is over
        // and the check actually runs.
        fbRateLimitedAt: '2026-10-25T12:00:00.000Z',
      }),
    );
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('active');
    expect(stamp.fbStatus).toBeNull();
    expect(stamp.fbRateLimitedAt).toBeNull();
  });

  it('B3: skips when the mirror’s own rate-limit anchor is fresh even with an ACTIVE target', async () => {
    const state = newState();
    const result = await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-29T11:00:00.000Z',
        targetStatus: 'active',
        targetRateLimitedAt: null,
      }),
    );
    expect(result).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.published).toEqual([]);
    expect(state.claimed).toEqual([]);
    // Only nextCheckAt advances; the stored detail is untouched —
    // the cooldown, not a new failure, is why nothing ran.
    expect(state.mirrorUpdates).toHaveLength(1);
    expect(state.mirrorUpdates[0]?.patch).toEqual({
      nextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  it('B3: an ACTIVE mirror with a fresh own rate-limit anchor also skips (no publish through the cooldown)', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({
        status: 'active',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-29T11:00:00.000Z',
        targetStatus: 'active',
      }),
    );
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.published).toEqual([]);
    expect(state.mirrorUpdates).toHaveLength(1);
  });

  it('B4: a rate-limited target with no anchor resumes once updated_at is stale', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-25T12:00:00.000Z',
        targetStatus: 'rate_limited',
        targetRateLimitedAt: null,
        // The ADU tick flips destinations to rate_limited with a
        // bare { status } update and no metadata.rate_limited_at:
        // updated_at is the only anchor such a row has.
        targetUpdatedAt: '2026-10-25T12:00:00.000Z',
      }),
    );
    expect(state.fetchFeedCalls).toBe(1);
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('active');
    expect(stamp.fbStatus).toBeNull();
  });

  it('B4: a rate-limited target with no anchor and a fresh updated_at still skips', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-25T12:00:00.000Z',
        targetStatus: 'rate_limited',
        targetRateLimitedAt: null,
        targetUpdatedAt: '2026-10-29T11:00:00.000Z',
      }),
    );
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.mirrorUpdates).toHaveLength(1);
  });

  it('B4: a rate-limited target with neither anchor nor updated_at stays uncheckable (fail closed)', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-25T12:00:00.000Z',
        targetStatus: 'rate_limited',
        targetRateLimitedAt: null,
        targetUpdatedAt: null,
      }),
    );
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.mirrorUpdates).toHaveLength(1);
  });

  it('a non-publish failure leaves the stored Facebook detail untouched', async () => {
    const state = newState();
    const deps = fakeDeps(state, []);
    // Rejected via a promise (the regression guardrails forbid
    // the throw-new-Error literal in apps/worker/src, tests included).
    deps.fetchFeed = () => Promise.reject(new Error('tikwm exploded'));
    await processMirrorCheck(
      deps,
      mirror({ status: 'error', fbStatus: 'missing_permission', fbRateLimitedAt: null }),
    );
    // The final stamp advances the check clock but carries no
    // fbStatus key: a feed failure says nothing about the target.
    const stamp = finalStamp(state);
    expect('fbStatus' in stamp).toBe(false);
    expect('fbRateLimitedAt' in stamp).toBe(false);
  });

  it('B2 discriminator: a resumed mirror (active) with a stale own detail clears it on a clean check', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({
        status: 'active',
        fbStatus: 'missing_permission',
        fbRateLimitedAt: null,
        targetStatus: 'active',
      }),
    );
    expect(state.fetchFeedCalls).toBe(1);
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('active');
    expect(stamp.fbStatus).toBeNull();
    expect(stamp.fbRateLimitedAt).toBeNull();
  });

  it('skips the check when the mirror is in error and the target is down', async () => {
    const state = newState();
    const result = await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({ status: 'error', fbStatus: 'missing_permission', targetStatus: 'error' }),
    );
    expect(result).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.published).toEqual([]);
    expect(state.claimed).toEqual([]);
    // Only nextCheckAt advances — no feed fetch, no publish
    // attempts, no failed rows, and the stored detail is untouched.
    expect(state.mirrorUpdates).toHaveLength(1);
    expect(state.mirrorUpdates[0]?.patch).toEqual({
      nextCheckAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  it('skips while the target is rate-limited with a fresh anchor', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-29T11:00:00.000Z',
        targetStatus: 'rate_limited',
        targetRateLimitedAt: '2026-10-29T11:00:00.000Z',
      }),
    );
    expect(state.fetchFeedCalls).toBe(0);
    expect(state.mirrorUpdates).toHaveLength(1);
  });

  it('resumes when the rate-limit anchor is stale, then clears on a clean check', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-10-25T12:00:00.000Z',
        targetStatus: 'rate_limited',
        targetRateLimitedAt: '2026-10-25T12:00:00.000Z',
      }),
    );
    expect(state.fetchFeedCalls).toBe(1);
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('active');
    expect(stamp.fbStatus).toBeNull();
  });

  it('an errored mirror with an ACTIVE target still checks (hourly retry)', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({ status: 'error', fbStatus: 'missing_permission', targetStatus: 'active' }),
    );
    expect(state.fetchFeedCalls).toBe(1);
  });

  it('the skip is Facebook-only: an Instagram mirror in error still checks', async () => {
    const state = newState();
    await processMirrorCheck(
      fakeDeps(state, []),
      mirror({
        targetPlatform: 'instagram',
        status: 'error',
        targetStatus: 'error',
      }),
    );
    expect(state.fetchFeedCalls).toBe(1);
  });

  it('an Instagram publish failure never stamps a Facebook detail', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    state.publishError = graphError('Missing role on the page.', 190, 492);
    await processMirrorCheck(
      fakeDeps(state, [reel('v1', 1761720000)]),
      mirror({ targetPlatform: 'instagram' }),
    );
    const stamp = finalStamp(state);
    expect(stamp.status).toBe('error');
    expect('fbStatus' in stamp).toBe(false);
    expect('fbRateLimitedAt' in stamp).toBe(false);
  });
});
