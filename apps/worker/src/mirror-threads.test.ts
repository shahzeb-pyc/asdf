/**
 * Threads Auto Repost tick behaviour: the tick passes the mirror's
 * target platform through to publishReel (so the built deps can
 * dispatch Threads → Threads publisher, Facebook → Facebook client),
 * an over-long Threads caption is skipped with the plain reason and
 * never posted (later reels are still tried), and the Facebook path
 * is unchanged.
 */
import { describe, expect, it } from 'vitest';
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
    targetPlatform: 'threads',
    targetExternalId: 'threads_123',
    targetFound: true,
    targetToken: 'threads-token',
    status: 'active',
    lastCheckedAt: '2026-10-29T11:30:00.000Z',
    catchUpPending: false,
    lastPostedSourceId: null,
    lastPostedCreateTime: null,
    ...overrides,
  };
}

function reel(videoId: string, createTime: number, title: string) {
  return {
    video_id: videoId,
    play: `https://example.com/${videoId}.mp4`,
    wmplay: `https://example.com/${videoId}-wm.mp4`,
    title,
    cover: `https://example.com/${videoId}.jpg`,
    create_time: createTime,
  };
}

interface FakeState {
  claimed: Array<{ mirrorId: string; post: Parameters<MirrorTickDeps['claimPost']>[1] }>;
  published: Array<Parameters<MirrorTickDeps['publishReel']>[0]>;
}

function fakeDeps(
  state: FakeState,
  feed: unknown[],
  titles: Record<string, string>
): MirrorTickDeps {
  return {
    listKnownSourceIds: async () => new Set(),
    claimPost: async (mirrorId, post) => {
      state.claimed.push({ mirrorId, post });
      return `post-${post.sourcePostId}`;
    },
    updatePost: async () => {},
    updateMirror: async () => {},
    fetchFeed: async () => feed as never,
    resolveVideo: async ({ videoId }) => ({
      playUrl: `https://example.com/${videoId}.mp4`,
      title: titles[videoId] ?? `Caption for ${videoId}`,
    }),
    publishReel: async (params) => {
      state.published.push(params);
      return `threads_${params.videoUrl}`;
    },
    now: new Date('2026-10-29T12:00:00.000Z'),
  };
}

describe('processMirrorCheck for Threads targets', () => {
  it('passes targetPlatform through to publishReel and posts the reel', async () => {
    const state: FakeState = { claimed: [], published: [] };
    const result = await processMirrorCheck(
      fakeDeps(state, [reel('v1', 100, 'Hello')], { v1: 'Hello' }),
      mirror()
    );
    expect(result.posted).toBe(1);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]?.targetPlatform).toBe('threads');
    expect(state.published[0]?.pageId).toBe('threads_123');
    expect(state.published[0]?.caption).toBe('Hello');
  });

  it('skips an over-long Threads caption with the plain reason and still posts later reels', async () => {
    const state: FakeState = { claimed: [], published: [] };
    const longTitle = 'x'.repeat(600);
    const feed = [reel('v1', 100, longTitle), reel('v2', 200, 'Short')];
    const result = await processMirrorCheck(
      fakeDeps(state, feed, { v1: longTitle, v2: 'Short' }),
      mirror()
    );
    expect(result.skipped).toBe(1);
    expect(result.posted).toBe(1);
    expect(state.published.map((p) => p.videoUrl)).toEqual(['https://example.com/v2.mp4']);
    const skipped = state.claimed.find((c) => c.post.sourcePostId === 'v1');
    expect(skipped?.post.status).toBe('skipped');
    expect(skipped?.post.error).toContain('500');
  });

  it('keeps the Facebook path passing its own platform through', async () => {
    const state: FakeState = { claimed: [], published: [] };
    const result = await processMirrorCheck(
      fakeDeps(state, [reel('v1', 100, 'Hello')], { v1: 'Hello' }),
      mirror({ targetPlatform: 'facebook', targetExternalId: 'fb_123', targetToken: 'page-token' })
    );
    expect(result.posted).toBe(1);
    expect(state.published[0]?.targetPlatform).toBe('facebook');
  });
});
