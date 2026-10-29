/**
 * tikwm feed client (TikTok mirrors): feed parsing, reel-only
 * filter, watermarked-only detection, username normalization, and
 * latest/new selection (oldest-first, newer-only).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isTikwmReelItem,
  isTikwmWatermarkedOnlyItem,
  normalizeTikTokUsername,
  TikTokUsernameSchema,
} from '@fbuploadpro/contracts';
import {
  fetchTikwmUserPosts,
  selectLatestReel,
  selectNewReels,
  TikwmError,
} from '../../src/lib/server/tikwm';

function video(overrides: Record<string, unknown> = {}) {
  return {
    video_id: 'v1',
    play: 'https://example.com/no-wm.mp4',
    wmplay: 'https://example.com/wm.mp4',
    title: 'hello world',
    cover: 'https://example.com/cover.jpg',
    create_time: 1700000000,
    author: { unique_id: 'alice', nickname: 'Alice', avatar: 'https://example.com/a.jpg' },
    ...overrides,
  };
}

describe('normalizeTikTokUsername', () => {
  it('trims, strips a leading @, and lowercases', () => {
    expect(normalizeTikTokUsername('  @Alice_99 ')).toBe('alice_99');
  });

  it('normalizes to empty for empty input; validity is the schema’s job', () => {
    expect(normalizeTikTokUsername('')).toBe('');
    expect(normalizeTikTokUsername('has space')).toBe('has space');
    expect(TikTokUsernameSchema.safeParse('').success).toBe(false);
    expect(TikTokUsernameSchema.safeParse('has space').success).toBe(false);
    expect(TikTokUsernameSchema.safeParse('a'.repeat(25)).success).toBe(false);
    expect(TikTokUsernameSchema.safeParse('@Alice_99')?.data).toBe('alice_99');
  });
});

describe('reel filter', () => {
  it('treats a video with a no-watermark URL as a reel', () => {
    expect(isTikwmReelItem(video())).toBe(true);
  });

  it('excludes photo posts (images array present)', () => {
    expect(isTikwmReelItem(video({ images: ['https://example.com/1.jpg'] }))).toBe(false);
  });

  it('excludes items with no playable URL at all', () => {
    expect(isTikwmReelItem(video({ play: '', wmplay: '' }))).toBe(false);
  });

  it('flags watermarked-only items for skip-with-error, never post', () => {
    expect(isTikwmWatermarkedOnlyItem(video({ play: '' }))).toBe(true);
    expect(isTikwmWatermarkedOnlyItem(video())).toBe(false);
    expect(isTikwmWatermarkedOnlyItem(video({ images: ['x'] }))).toBe(false);
  });
});

describe('selection', () => {
  it('picks the newest reel as latest', () => {
    const feed = [
      video({ video_id: 'old', create_time: 100 }),
      video({ video_id: 'new', create_time: 300 }),
      video({ video_id: 'mid', create_time: 200 }),
    ];
    expect(selectLatestReel(feed)?.video_id).toBe('new');
  });

  it('returns null when the feed has no reels', () => {
    expect(selectLatestReel([video({ images: ['x'] })])).toBeNull();
  });

  it('selects newer-only, oldest-first, excluding known ids', () => {
    const feed = [
      video({ video_id: 'v3', create_time: 300 }),
      video({ video_id: 'v1', create_time: 100 }),
      video({ video_id: 'v2', create_time: 200 }),
      video({ video_id: 'v0', create_time: 50 }),
    ];
    const selected = selectNewReels(feed, {
      lastPostedSourceId: 'v1',
      lastPostedCreateTime: 100,
      knownSourceIds: new Set(['v2']),
    });
    // v0 is older than the last post; v2 is already recorded.
    expect(selected.map((v) => v.video_id)).toEqual(['v3']);
  });
});

describe('fetchTikwmUserPosts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFeedResponse(body: unknown, ok = true, status = 200) {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      json: async () => body,
    });
  }

  it('parses a feed and hits the user/posts endpoint', async () => {
    mockFeedResponse({
      code: 0,
      msg: 'success',
      data: { videos: [video()], cursor: '0', hasMore: false },
    });
    const videos = await fetchTikwmUserPosts('alice');
    expect(videos).toHaveLength(1);
    expect(videos[0]?.video_id).toBe('v1');
    const url = String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(url).toContain('tikwm.com/api/user/posts');
    expect(url).toContain('unique_id=alice');
  });

  it('throws TikwmError on a nonzero code and on HTTP errors', async () => {
    mockFeedResponse({ code: -1, msg: 'user not found', data: null });
    await expect(fetchTikwmUserPosts('ghost')).rejects.toBeInstanceOf(TikwmError);
    mockFeedResponse(null, false, 500);
    await expect(fetchTikwmUserPosts('alice')).rejects.toBeInstanceOf(TikwmError);
  });

  it('throws TikwmError on malformed payloads', async () => {
    mockFeedResponse({ nope: true });
    await expect(fetchTikwmUserPosts('alice')).rejects.toBeInstanceOf(TikwmError);
  });
});
