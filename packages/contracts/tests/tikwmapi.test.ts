/**
 * Paid tikwmapi feed/profile + free tikwm resolve + multi-key
 * rotation: key parsing, SHA-256 fingerprints (never the raw
 * key), 30-day pauses only for spent/invalid keys, throttles
 * moving to the next key without a pause, expiry re-eligibility,
 * and fail-loud when every key is paused or fails. All HTTP is
 * mocked — no live TikTok/tikwmapi calls.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  callWithTikwmApiKeyRotation,
  fetchTikwmApiUserInfo,
  fetchTikwmApiUserPosts,
  parseTikwmApiKeys,
  resolveTikwmVideo,
  tikwmApiKeyFingerprint,
  TikwmApiError,
  TIKWMAPI_KEY_PAUSE_MS,
  type TikwmApiKeyPauseStore,
} from '../src/domain/tikwmapi';

function fakeStore(): TikwmApiKeyPauseStore & { rows: Map<string, Date> } {
  const rows = new Map<string, Date>();
  return {
    rows,
    getPausedUntil: async (fingerprint: string) => rows.get(fingerprint) ?? null,
    setPaused: async (fingerprint: string, pausedUntil: Date) => {
      rows.set(fingerprint, pausedUntil);
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

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

describe('parseTikwmApiKeys', () => {
  it('splits, trims, drops empties, appends the singular key, dedupes', () => {
    expect(parseTikwmApiKeys(' key-a , ,key-b ', 'key-c')).toEqual([
      'key-a',
      'key-b',
      'key-c',
    ]);
    expect(parseTikwmApiKeys('key-a, key-a', 'key-a')).toEqual(['key-a']);
    expect(parseTikwmApiKeys(undefined, 'only')).toEqual(['only']);
    expect(parseTikwmApiKeys('', undefined)).toEqual([]);
  });
});

describe('tikwmApiKeyFingerprint', () => {
  it('is the SHA-256 hex of the key, never the key itself', async () => {
    expect(await tikwmApiKeyFingerprint('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    const fp = await tikwmApiKeyFingerprint('sk-live-secret-key');
    expect(fp).not.toContain('sk-live-secret-key');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('callWithTikwmApiKeyRotation', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const noSleep = async () => {};

  it('pauses a 10401 key for 30 days and uses the next key', async () => {
    const store = fakeStore();
    const calls: string[] = [];
    const result = await callWithTikwmApiKeyRotation({
      keys: ['bad-key', 'good-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
      callWithKey: async (key) => {
        calls.push(key);
        if (key === 'bad-key') throw new TikwmApiError('KEY_INVALID', 'invalid');
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(calls).toEqual(['bad-key', 'good-key']);
    const fp = await tikwmApiKeyFingerprint('bad-key');
    expect(store.rows.get(fp)?.getTime()).toBe(now.getTime() + TIKWMAPI_KEY_PAUSE_MS);
  });

  it('pauses a 10430 key the same way', async () => {
    const store = fakeStore();
    await callWithTikwmApiKeyRotation({
      keys: ['spent-key', 'good-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
      callWithKey: async (key) => {
        if (key === 'spent-key') throw new TikwmApiError('QUOTA_EXHAUSTED', 'spent');
        return 'ok';
      },
    });
    const fp = await tikwmApiKeyFingerprint('spent-key');
    expect(store.rows.has(fp)).toBe(true);
  });

  it('moves to the next key on 10429 WITHOUT a pause row', async () => {
    const store = fakeStore();
    const result = await callWithTikwmApiKeyRotation({
      keys: ['throttled-key', 'good-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
      callWithKey: async (key) => {
        if (key === 'throttled-key') throw new TikwmApiError('RATE_LIMITED', 'slow down');
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(store.rows.size).toBe(0);
  });

  it('moves to the next key on transient failures without a pause row', async () => {
    const store = fakeStore();
    const result = await callWithTikwmApiKeyRotation({
      keys: ['flaky-key', 'good-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
      callWithKey: async (key) => {
        if (key === 'flaky-key') throw new TikwmApiError('UNREACHABLE', 'down');
        return 'ok';
      },
    });
    expect(result).toBe('ok');
    expect(store.rows.size).toBe(0);
  });

  it('throws immediately for non-key failures without rotating', async () => {
    const calls: string[] = [];
    await expect(
      callWithTikwmApiKeyRotation({
        keys: ['key-a', 'key-b'],
        pauseStore: fakeStore(),
        now,
        sleep: noSleep,
        callWithKey: async (key) => {
          calls.push(key);
          throw new TikwmApiError('FEED_UNAVAILABLE', 'no such account');
        },
      })
    ).rejects.toMatchObject({ code: 'FEED_UNAVAILABLE' });
    expect(calls).toEqual(['key-a']);
  });

  it('fails loud when every key fails', async () => {
    await expect(
      callWithTikwmApiKeyRotation({
        keys: ['k1', 'k2'],
        pauseStore: fakeStore(),
        now,
        sleep: noSleep,
        callWithKey: async () => {
          throw new TikwmApiError('KEY_INVALID', 'invalid');
        },
      })
    ).rejects.toMatchObject({ code: 'KEY_INVALID' });
  });

  it('fails loud with ALL_KEYS_PAUSED when every key is paused', async () => {
    const store = fakeStore();
    const fp = await tikwmApiKeyFingerprint('paused-key');
    store.rows.set(fp, new Date(now.getTime() + 24 * 60 * 60 * 1000));
    await expect(
      callWithTikwmApiKeyRotation({
        keys: ['paused-key'],
        pauseStore: store,
        now,
        sleep: noSleep,
        callWithKey: async () => 'never',
      })
    ).rejects.toMatchObject({ code: 'ALL_KEYS_PAUSED' });
  });

  it('re-eligibilizes a key after its pause expires', async () => {
    const store = fakeStore();
    const fp = await tikwmApiKeyFingerprint('old-key');
    store.rows.set(fp, new Date(now.getTime() - 1000));
    const result = await callWithTikwmApiKeyRotation({
      keys: ['old-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
      callWithKey: async () => 'ok-again',
    });
    expect(result).toBe('ok-again');
  });

  it('throws NO_KEYS_CONFIGURED with no keys', async () => {
    await expect(
      callWithTikwmApiKeyRotation({
        keys: [],
        pauseStore: fakeStore(),
        now,
        sleep: noSleep,
        callWithKey: async () => 'never',
      })
    ).rejects.toMatchObject({ code: 'NO_KEYS_CONFIGURED' });
  });

  it('still rotates when the pause store throws (pauses unpersisted, call survives)', async () => {
    const brokenStore: TikwmApiKeyPauseStore = {
      getPausedUntil: async () => {
        throw new Error('relation "tikwmapi_key_pauses" does not exist');
      },
      setPaused: async () => {
        throw new Error('relation "tikwmapi_key_pauses" does not exist');
      },
    };
    const result = await callWithTikwmApiKeyRotation({
      keys: ['bad-key', 'good-key'],
      pauseStore: brokenStore,
      now,
      sleep: noSleep,
      callWithKey: async (key) => {
        if (key === 'bad-key') throw new TikwmApiError('KEY_INVALID', 'invalid');
        return 'ok';
      },
    });
    expect(result).toBe('ok');
  });
});

describe('fetchTikwmApiUserPosts', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const noSleep = async () => {};

  it('hits the paid endpoint with the key header and parses videos', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ code: 0, msg: 'success', data: { videos: [video()], cursor: '0' } })
    );
    const videos = await fetchTikwmApiUserPosts('alice', {
      fetchFn: fetchFn as never,
      apiKeys: ['key-1'],
      pauseStore: fakeStore(),
      now,
      sleep: noSleep,
    });
    expect(videos).toHaveLength(1);
    expect(videos[0]?.video_id).toBe('v1');
    const [url, init] = fetchFn.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.tikwmapi.com/user/posts');
    expect(url).toContain('unique_id=alice');
    expect(init.headers['x-tikwmapi-key']).toBe('key-1');
    expect(url).not.toContain('tikwm.com/api');
  });

  it('rotates on 10401 and records the pause, then succeeds', async () => {
    const store = fakeStore();
    const fetchFn = vi.fn(async (_url: string, init: { headers: Record<string, string> }) =>
      init.headers['x-tikwmapi-key'] === 'bad-key'
        ? jsonResponse({ code: 10401, msg: 'Missing API key.' })
        : jsonResponse({ code: 0, data: { videos: [video()] } })
    );
    const videos = await fetchTikwmApiUserPosts('alice', {
      fetchFn: fetchFn as never,
      apiKeys: ['bad-key', 'good-key'],
      pauseStore: store,
      now,
      sleep: noSleep,
    });
    expect(videos).toHaveLength(1);
    const fp = await tikwmApiKeyFingerprint('bad-key');
    expect(store.rows.has(fp)).toBe(true);
  });

  it('maps 10429/10430 to rate/quota errors', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ code: 10429, msg: 'slow' }));
    await expect(
      fetchTikwmApiUserPosts('alice', {
        fetchFn: fetchFn as never,
        apiKeys: ['only-key'],
        pauseStore: fakeStore(),
        now,
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const fetchFn2 = vi.fn(async () => jsonResponse({ code: 10430, msg: 'spent' }));
    await expect(
      fetchTikwmApiUserPosts('alice', {
        fetchFn: fetchFn2 as never,
        apiKeys: ['only-key'],
        pauseStore: fakeStore(),
        now,
        sleep: noSleep,
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  });

  it('throws NO_KEYS_CONFIGURED without keys', async () => {
    await expect(
      fetchTikwmApiUserPosts('alice', { apiKeys: [], pauseStore: fakeStore(), now })
    ).rejects.toMatchObject({ code: 'NO_KEYS_CONFIGURED' });
  });
});

describe('fetchTikwmApiUserInfo', () => {
  it('returns profile fields, and null on any failure (best effort)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ code: 0, data: { user: { nickname: 'Alice', avatar: 'https://x/a.jpg' } } })
    );
    await expect(
      fetchTikwmApiUserInfo('alice', { fetchFn: fetchFn as never, apiKeys: ['k'] })
    ).resolves.toEqual({ nickname: 'Alice', avatar: 'https://x/a.jpg' });
    const failing = vi.fn(async () => jsonResponse({ code: -1, msg: 'nope' }));
    await expect(
      fetchTikwmApiUserInfo('ghost', { fetchFn: failing as never, apiKeys: ['k'] })
    ).resolves.toBeNull();
  });
});

describe('resolveTikwmVideo', () => {
  it('POSTs form data to the free endpoint and prefers hdplay', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: { play: 'https://x/play.mp4', hdplay: 'https://x/hd.mp4', title: 'Cap' },
      })
    );
    const resolved = await resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
      fetchFn: fetchFn as never,
    });
    expect(resolved).toEqual({ playUrl: 'https://x/hd.mp4', title: 'Cap' });
    const [url, init] = fetchFn.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://www.tikwm.com/api/');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('url=');
    expect(init.body).toContain('hd=1');
  });

  it('falls back to play, and fails loud on nonzero code or missing URL', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ code: 0, data: { play: 'https://x/play.mp4', title: 'T' } })
    );
    await expect(
      resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).resolves.toEqual({ playUrl: 'https://x/play.mp4', title: 'T' });
    const bad = vi.fn(async () => jsonResponse({ code: -1, msg: 'Url parsing is failed!' }));
    await expect(
      resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: bad as never,
      })
    ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    const empty = vi.fn(async () => jsonResponse({ code: 0, data: {} }));
    await expect(
      resolveTikwmVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: empty as never,
      })
    ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
  });
});
