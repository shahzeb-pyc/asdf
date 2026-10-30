/**
 * TikTok mirror check (per-mirror, queue consumer unit of work):
 * newer-only oldest-first posting, claim-then-post (overlapping
 * checks never double-post), watermarked-only skipped with
 * error, tikwm failure → mirror error, publish failure → post
 * stays pending + mirror error, success clears the mirror
 * error, caption verbatim. (Paused/deleted skipping lives in
 * the consumer tests — the consumer fetches the mirror fresh
 * and skips before this runs.)
 */
import { describe, expect, it } from 'vitest';
import {
  InternalError,
  MIRROR_FACEBOOK_RESTRICTED_MESSAGE,
} from '@fbuploadpro/contracts';
import {
  processMirrorCheck,
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
    fetchFeed: async () => feed as never,
    resolveVideo: async ({ videoId }) => ({
      playUrl: `https://example.com/${videoId}.mp4`,
      title: `Caption for ${videoId}`,
    }),
    publishReel: async (params) => {
      if (state.publishFailsFor.has(params.videoUrl)) {
        throw new InternalError('Graph exploded');
      }
      state.published.push(params);
      return `fb_${params.videoUrl}`;
    },
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
    // Final stamp clears the mirror to active with next check +1h.
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('active');
    expect(stamp?.patch.nextCheckAt).toBe('2026-10-29T13:00:00.000Z');
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

  it('keeps a failed post pending, marks the mirror error, and stops that mirror', async () => {
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
    expect(postUpdate?.patch.status).toBe('pending');
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
    expect(stamp?.patch.lastError).toContain('Graph exploded');
  });

  it('shows the plain restriction message on a restricted publish failure, post still pending', async () => {
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
    expect(postUpdate?.patch.status).toBe('pending');
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

  it('keeps a resolve failure pending, marks the mirror error, and stops that mirror', async () => {
    const state = newState();
    const deps = fakeDeps(state, [reel('v1', 100), reel('v2', 200)]);
    deps.resolveVideo = async () => {
      throw new InternalError('Could not resolve video');
    };
    const result = await processMirrorCheck(deps, mirror());
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    expect(state.published).toHaveLength(0);
    // Only v1 claimed (pending with the resolve error); v2 never attempted.
    expect(state.claimed.map((c) => c.post.sourcePostId)).toEqual(['v1']);
    expect(state.claimed[0]?.post.status).toBe('pending');
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
});
