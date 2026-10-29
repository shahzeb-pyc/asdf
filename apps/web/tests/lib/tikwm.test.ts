/**
 * TikTok data client (TikTok mirrors): paid tikwmapi feed/profile
 * with key rotation, free tikwm single-video resolve, reel-only
 * filter, watermarked-only detection, username normalization, and
 * latest/new selection (oldest-first, newer-only). All HTTP is
 * mocked — no live calls.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isTikwmReelItem,
  isTikwmWatermarkedOnlyItem,
  normalizeTikTokUsername,
  TikTokUsernameSchema,
} from '@fbuploadpro/contracts';
import {
  fetchTikwmUserInfo,
  fetchTikwmUserPosts,
  getTikwmApiKeys,
  resolveTikwmVideo,
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

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

function fakePauseStore() {
  const rows = new Map<string, Date>();
  return {
    rows,
    getPausedUntil: async (fingerprint: string) => rows.get(fingerprint) ?? null,
    setPaused: async (fingerprint: string, pausedUntil: Date) => {
      rows.set(fingerprint, pausedUntil);
    },
  };
}

describe('getTikwmApiKeys', () => {
  it('parses the list env and appends the singular key', () => {
    const prevList = process.env.TIKWMAPI_KEYS;
    const prevSingle = process.env.TIKWMAPI_KEY;
    process.env.TIKWMAPI_KEYS = ' a ,b ';
    process.env.TIKWMAPI_KEY = 'c';
    try {
      expect(getTikwmApiKeys()).toEqual(['a', 'b', 'c']);
    } finally {
      if (prevList === undefined) delete process.env.TIKWMAPI_KEYS;
      else process.env.TIKWMAPI_KEYS = prevList;
      if (prevSingle === undefined) delete process.env.TIKWMAPI_KEY;
      else process.env.TIKWMAPI_KEY = prevSingle;
    }
  });
});

describe('fetchTikwmUserPosts (paid tikwmapi)', () => {
  it('parses a feed and hits the paid user/posts endpoint with the key header', async () => {
    const fetchFn = mockFetch({
      code: 0,
      msg: 'success',
      data: { videos: [video()], cursor: '0', hasMore: false },
    });
    const videos = await fetchTikwmUserPosts('alice', {
      fetchFn: fetchFn as never,
      apiKeys: ['key-1'],
    });
    expect(videos).toHaveLength(1);
    expect(videos[0]?.video_id).toBe('v1');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain('api.tikwmapi.com/user/posts');
    expect(url).toContain('unique_id=alice');
    expect(init.headers['x-tikwmapi-key']).toBe('key-1');
    expect(url).not.toContain('www.tikwm.com/api/user/posts');
  });

  it('throws TikwmError on a nonzero code and on HTTP errors', async () => {
    await expect(
      fetchTikwmUserPosts('ghost', {
        fetchFn: mockFetch({ code: -1, msg: 'user not found', data: null }) as never,
        apiKeys: ['key-1'],
      })
    ).rejects.toBeInstanceOf(TikwmError);
    await expect(
      fetchTikwmUserPosts('alice', {
        fetchFn: mockFetch(null, false, 500) as never,
        apiKeys: ['key-1'],
      })
    ).rejects.toBeInstanceOf(TikwmError);
  });

  it('throws TikwmError on malformed payloads', async () => {
    await expect(
      fetchTikwmUserPosts('alice', {
        fetchFn: mockFetch({ nope: true }) as never,
        apiKeys: ['key-1'],
      })
    ).rejects.toBeInstanceOf(TikwmError);
  });

  it('throws NO_KEYS_CONFIGURED without keys', async () => {
    await expect(
      fetchTikwmUserPosts('alice', { fetchFn: mockFetch({}) as never, apiKeys: [] })
    ).rejects.toMatchObject({ code: 'NO_KEYS_CONFIGURED' });
  });

  it('rotates past an invalid key and pauses it', async () => {
    const store = fakePauseStore();
    const fetchFn = vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
      init.headers['x-tikwmapi-key'] === 'bad-key'
        ? { ok: true, status: 200, json: async () => ({ code: 10401, msg: 'bad key' }) }
        : {
            ok: true,
            status: 200,
            json: async () => ({ code: 0, data: { videos: [video()] } }),
          }
    );
    const videos = await fetchTikwmUserPosts('alice', {
      fetchFn: fetchFn as never,
      apiKeys: ['bad-key', 'good-key'],
      pauseStore: store,
    });
    expect(videos).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });
});

describe('fetchTikwmUserInfo (paid tikwmapi, best effort)', () => {
  it('returns profile fields, and null on failure', async () => {
    await expect(
      fetchTikwmUserInfo('alice', {
        fetchFn: mockFetch({
          code: 0,
          data: { user: { nickname: 'Alice', avatar: 'https://x/a.jpg' } },
        }) as never,
        apiKeys: ['key-1'],
      })
    ).resolves.toEqual({ nickname: 'Alice', avatar: 'https://x/a.jpg' });
    await expect(
      fetchTikwmUserInfo('ghost', {
        fetchFn: mockFetch({ code: -1, msg: 'nope' }) as never,
        apiKeys: ['key-1'],
      })
    ).resolves.toBeNull();
  });
});

describe('resolveTikwmVideo (free tikwm POST)', () => {
  it('POSTs form data and prefers hdplay', async () => {
    const fetchFn = mockFetch({
      code: 0,
      data: { play: 'https://x/play.mp4', hdplay: 'https://x/hd.mp4', title: 'Cap' },
    });
    const resolved = await resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
      fetchFn: fetchFn as never,
    });
    expect(resolved).toEqual({ playUrl: 'https://x/hd.mp4', title: 'Cap' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe('https://www.tikwm.com/api/');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('hd=1');
  });

  it('fails loud on a nonzero resolve code', async () => {
    await expect(
      resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: mockFetch({ code: -1, msg: 'Url parsing is failed!' }) as never,
      })
    ).rejects.toBeInstanceOf(TikwmError);
  });
});
