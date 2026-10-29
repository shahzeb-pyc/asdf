/**
 * TikTok mirror tick (hourly): newer-only oldest-first posting,
 * claim-then-post (overlapping ticks never double-post), paused
 * mirrors skipped, watermarked-only skipped with error, tikwm
 * failure → mirror error, publish failure → post stays pending +
 * mirror error, success clears the mirror error, caption verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runMirrorTick,
  type MirrorTickDeps,
  type MirrorTickMirror,
} from './mirror-tick.js';

function mirror(overrides: Partial<MirrorTickMirror> = {}): MirrorTickMirror {
  return {
    id: 'mirror-1',
    workspaceId: 'ws_1',
    destinationId: 'dest-1',
    fbPageId: 'fb_123',
    destinationToken: 'page-token',
    tiktokUsername: 'alice',
    status: 'active',
    lastPostedVideoId: null,
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

function fakeDeps(state: FakeState, feed: unknown[], mirrors: MirrorTickMirror[]): MirrorTickDeps {
  return {
    listMirrors: async () => mirrors,
    listKnownVideoIds: async () => new Set(),
    claimPost: async (mirrorId, post) => {
      if (state.claimReturnsNullFor.has(post.tiktokVideoId)) return null;
      state.claimed.push({ mirrorId, post });
      return `post-${post.tiktokVideoId}`;
    },
    updatePost: async (id, patch) => {
      state.postUpdates.push({ id, patch });
    },
    updateMirror: async (id, patch) => {
      state.mirrorUpdates.push({ id, patch });
    },
    fetchFeed: async () => feed as never,
    publishReel: async (params) => {
      if (state.publishFailsFor.has(params.videoUrl)) {
        throw new Error('Graph exploded');
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

describe('runMirrorTick', () => {
  it('posts new reels oldest-first with the caption verbatim', async () => {
    const state = newState();
    const feed = [reel('v3', 300), reel('v1', 100), reel('v2', 200)];
    const result = await runMirrorTick(fakeDeps(state, feed, [mirror()]));
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
    const result = await runMirrorTick(
      fakeDeps(state, feed, [
        mirror({ lastPostedVideoId: 'v2', lastPostedCreateTime: 200 }),
      ])
    );
    expect(result.posted).toBe(1);
    expect(state.published[0]?.videoUrl).toContain('v3');
  });

  it('skips an overlapping-tick claim (claim returns null) without publishing', async () => {
    const state = newState();
    state.claimReturnsNullFor.add('v1');
    const result = await runMirrorTick(fakeDeps(state, [reel('v1', 100)], [mirror()]));
    expect(result.posted).toBe(0);
    expect(state.published).toHaveLength(0);
  });

  it('keeps a failed post pending, marks the mirror error, and stops that mirror', async () => {
    const state = newState();
    state.publishFailsFor.add('https://example.com/v1.mp4');
    const feed = [reel('v1', 100), reel('v2', 200)];
    const result = await runMirrorTick(fakeDeps(state, feed, [mirror()]));
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    // v2 never attempted: the loop stops after the first failure.
    expect(state.published).toHaveLength(0);
    expect(state.claimed.map((c) => c.post.tiktokVideoId)).toEqual(['v1']);
    const postUpdate = state.postUpdates.find((u) => u.id === 'post-v1');
    expect(postUpdate?.patch.status).toBe('pending');
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('error');
    expect(stamp?.patch.lastError).toContain('Graph exploded');
  });

  it('skips watermarked-only items with a skipped row + mirror error, never posting them', async () => {
    const state = newState();
    const feed = [
      reel('v_wm', 100, { play: '' }),
      reel('v_ok', 200),
    ];
    const result = await runMirrorTick(fakeDeps(state, feed, [mirror()]));
    expect(result.skipped).toBe(1);
    expect(result.posted).toBe(1);
    expect(state.published[0]?.videoUrl).toContain('v_ok');
    const skippedClaim = state.claimed.find((c) => c.post.tiktokVideoId === 'v_wm');
    expect(skippedClaim?.post.status).toBe('skipped');
    expect(skippedClaim?.post.videoUrl).toBeNull();
  });

  it('marks the mirror error and continues when tikwm fails', async () => {
    const state = newState();
    const deps = fakeDeps(state, [], [mirror({ id: 'm1' }), mirror({ id: 'm2' })]);
    deps.fetchFeed = async (username: string) => {
      if (username === 'alice') throw new Error('tikwm down');
      return [];
    };
    // Second mirror has a different username so its feed succeeds.
    const mirrors = [mirror({ id: 'm1' }), mirror({ id: 'm2', tiktokUsername: 'bob' })];
    const result = await runMirrorTick({ ...deps, listMirrors: async () => mirrors });
    expect(result.mirrorsChecked).toBe(2);
    const m1Stamp = state.mirrorUpdates.filter((u) => u.id === 'm1').pop();
    expect(m1Stamp?.patch.status).toBe('error');
    const m2Stamp = state.mirrorUpdates.filter((u) => u.id === 'm2').pop();
    expect(m2Stamp?.patch.status).toBe('active');
  });

  it('clears a prior error on a clean tick', async () => {
    const state = newState();
    await runMirrorTick(fakeDeps(state, [], [mirror({ status: 'error' })]));
    const stamp = state.mirrorUpdates[state.mirrorUpdates.length - 1];
    expect(stamp?.patch.status).toBe('active');
    expect(stamp?.patch.lastError).toBeNull();
  });

  it('never fetches paused mirrors (listMirrors is the gate)', async () => {
    const state = newState();
    const fetchFeed = vi.fn(async () => []);
    const deps = fakeDeps(state, [], []);
    deps.fetchFeed = fetchFeed;
    deps.listMirrors = async () => [];
    await runMirrorTick(deps);
    expect(fetchFeed).not.toHaveBeenCalled();
  });
});
