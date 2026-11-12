import { describe, it, expect, vi } from 'vitest';
import {
  checkCountikVideo,
  enrichCreators,
  fetchCountikEnrichment,
  generateCountikHashtags,
  savedCreatorFromRow,
  savedCreatorUpsertRow,
  savedCreatorsToCsv,
  type Creator,
  type SavedCreator,
} from './creator-finder.js';

type StubBody = unknown;

function stubFetch(
  handler: (
    url: string,
    init?: { method?: string | undefined; body?: string | undefined },
  ) => {
    ok: boolean;
    body: StubBody;
  },
): typeof fetch {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const result = handler(url, {
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      ok: result.ok,
      json: async () => result.body,
    } as Response;
  });
  return fn as unknown as typeof fetch;
}

function makeCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    handle: 'alice',
    displayName: 'Alice Fit',
    avatarUrl: null,
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: 'https://www.tiktok.com/@alice',
    ...overrides,
  };
}

const EXIST_BODY = {
  sec_uid: 'SEC123',
  // Deliberately wrong: exist.verified must NEVER feed the tick.
  verified: true,
};

const ANALYZE_BODY = {
  author: {
    nickname: 'Alice Fit',
    signature: 'Making short videos about everyday life.',
    follower_count: 1_200_000,
    following_count: 850,
    total_heart: 42_000_000,
    video_count: 480,
    verified: true,
  },
  engagement_rates: { total: 8.4, likes: 6.1, comments: 1.4, shares: 0.9 },
  performance: {
    average_views: 2_100_000,
    average_likes: 180_000,
    average_comments: 9500,
    average_shares: 12_000,
  },
  hashtags: ['fitness', 'morningroutine'],
  mentions: [{ username: 'bob' }],
};

describe('fetchCountikEnrichment', () => {
  it('chains exist -> analyze and reads the tick only from analyze', async () => {
    const urls: string[] = [];
    const fetchFn = stubFetch((url) => {
      urls.push(url);
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    const enrichment = await fetchCountikEnrichment('alice', { fetchFn });
    expect(urls[0]).toBe('https://countik.com/api/exist/alice');
    expect(urls[1]).toBe(
      'https://countik.com/api/analyze/?sec_user_id=SEC123&username=alice',
    );
    expect(enrichment.verified).toBe(true);
    expect(enrichment.bio).toBe('Making short videos about everyday life.');
    expect(enrichment.followerCount).toBe(1_200_000);
    expect(enrichment.followingCount).toBe(850);
    expect(enrichment.heartsCount).toBe(42_000_000);
    expect(enrichment.videoCount).toBe(480);
    expect(enrichment.engagementTotal).toBe(8.4);
    expect(enrichment.averageViews).toBe(2_100_000);
    expect(enrichment.hashtags).toEqual(['fitness', 'morningroutine']);
    expect(enrichment.mentions).toEqual(['bob']);
  });

  it('ignores exist.verified when analyze says not verified', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return {
        ok: true,
        body: { author: { verified: false } },
      };
    });
    const enrichment = await fetchCountikEnrichment('alice', { fetchFn });
    expect(enrichment.verified).toBe(false);
  });

  it('leaves verified unknown when analyze carries no boolean', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: { author: { nickname: 'Alice' } } };
    });
    const enrichment = await fetchCountikEnrichment('alice', { fetchFn });
    expect(enrichment.verified).toBeUndefined();
  });

  it('throws when exist returns no sec_uid', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, body: { foo: 1 } }));
    await expect(
      fetchCountikEnrichment('alice', { fetchFn }),
    ).rejects.toThrow();
  });

  it('never fabricates a missing field', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: { author: { nickname: 'Alice' } } };
    });
    const enrichment = await fetchCountikEnrichment('alice', { fetchFn });
    expect(enrichment.followerCount).toBeUndefined();
    expect(enrichment.bio).toBeNull();
    expect(enrichment.hashtags).toEqual([]);
  });
});

describe('enrichCreators', () => {
  it('isolates a per-creator failure and preserves order', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.includes('/exist/alice')) return { ok: true, body: EXIST_BODY };
      if (url.includes('/exist/bob')) {
        return { ok: false, body: { message: 'user not found' } };
      }
      return { ok: true, body: ANALYZE_BODY };
    });
    const result = await enrichCreators(
      [makeCreator(), makeCreator({ handle: 'bob' })],
      { fetchFn },
    );
    expect(result[0]?.enrichment?.verified).toBe(true);
    expect(result[0]?.countikUnavailable).toBeUndefined();
    expect(result[1]?.enrichment).toBeUndefined();
    expect(result[1]?.countikUnavailable).toBe(true);
    // The failed creator keeps its TikWM fields for Similar fallback.
    const withTikwm = await enrichCreators(
      [makeCreator({ handle: 'bob', followerCount: 500, verified: true })],
      { fetchFn },
    );
    expect(withTikwm[0]?.followerCount).toBe(500);
    expect(withTikwm[0]?.verified).toBe(true);
  });
});

/**
 * Signal-aware stub: resolves after delayMs, but rejects as soon as the
 * passed AbortSignal fires — the way real fetch behaves under
 * AbortSignal.timeout. The plain stubFetch above ignores the signal, so it
 * cannot prove a timeout at all.
 */
function delayedFetch(
  delayMs: number,
  handler: (url: string) => { ok: boolean; body: StubBody },
): typeof fetch {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        },
        { once: true },
      );
    });
    const result = handler(url);
    return {
      ok: result.ok,
      json: async () => result.body,
    } as Response;
  });
  return fn as unknown as typeof fetch;
}

describe('enrichCreators deadline (spec 169)', () => {
  it('returns in ~budget, not ~30s, when every creator hangs', async () => {
    const fetchFn = delayedFetch(60_000, (url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    const start = Date.now();
    const result = await enrichCreators(
      [makeCreator(), makeCreator({ handle: 'bob' })],
      { fetchFn, budgetMs: 100 },
    );
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result).toHaveLength(2);
    expect(result[0]?.countikUnavailable).toBe(true);
    expect(result[1]?.countikUnavailable).toBe(true);
    expect(result[0]?.enrichment).toBeUndefined();
  });

  it('a slow leg times out at the leg timeout instead of the old 30s', async () => {
    const fetchFn = delayedFetch(1_000, (url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return { ok: true, body: ANALYZE_BODY };
    });
    const start = Date.now();
    const result = await enrichCreators([makeCreator()], {
      fetchFn,
      timeoutMs: 50,
      budgetMs: 5_000,
    });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result[0]?.countikUnavailable).toBe(true);
  });

  it('a fast creator still enriches while a slow one hangs', async () => {
    const fetchFn = delayedFetch(60_000, (url) => {
      // Only alice answers: bob's calls hang until the budget aborts them.
      if (url.includes('alice')) return { ok: true, body: url.includes('/exist/') ? EXIST_BODY : ANALYZE_BODY };
      return { ok: true, body: EXIST_BODY };
    });
    // Alice's calls must resolve fast: override the delay for her URLs.
    const fastForAlice = (async (url: string, init?: RequestInit) => {
      if (url.includes('alice')) {
        const result =
          url.includes('/exist/') ? EXIST_BODY : ANALYZE_BODY;
        return { ok: true, json: async () => result } as Response;
      }
      return fetchFn(url, init);
    }) as unknown as typeof fetch;
    const start = Date.now();
    const result = await enrichCreators(
      [makeCreator(), makeCreator({ handle: 'bob' })],
      { fetchFn: fastForAlice, budgetMs: 200 },
    );
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result[0]?.enrichment?.verified).toBe(true);
    expect(result[0]?.countikUnavailable).toBeUndefined();
    expect(result[1]?.countikUnavailable).toBe(true);
    expect(result[1]?.enrichment).toBeUndefined();
  });
});

describe('checkCountikVideo', () => {
  it('posts to video/exist then reads videoinfo, download from download_link', async () => {
    const seen: Array<{ url: string; method?: string | undefined; body?: string | undefined }> = [];
    const fetchFn = stubFetch((url, init) => {
      seen.push({ url, method: init?.method, body: init?.body });
      if (url.endsWith('/video/exist')) {
        return { ok: true, body: { video_id: 'VID1' } };
      }
      return {
        ok: true,
        body: {
          cover_url: 'https://example.com/cover.jpg',
          author: { unique_id: 'alice', nickname: 'Alice Fit' },
          desc: 'Morning routine',
          create_time: 1700000000,
          play_count: 2_700_000,
          digg_count: 190_000,
          comment_count: 6100,
          share_count: 2000,
          collect_count: 7800,
          music: { title: 'Song Title', author: 'Artist' },
          download_link: 'https://example.com/video.mp4',
        },
      };
    });
    const result = await checkCountikVideo(
      'https://www.tiktok.com/@alice/video/123',
      { fetchFn },
    );
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(
      JSON.stringify({ url: 'https://www.tiktok.com/@alice/video/123' }),
    );
    expect(seen[1]?.url).toBe('https://countik.com/api/videoinfo/VID1');
    expect(result.video.downloadUrl).toBe('https://example.com/video.mp4');
    expect(result.video.plays).toBe(2_700_000);
    expect(result.video.saves).toBe(7800);
    expect(result.video.musicTitle).toBe('Song Title');
    expect(result.video.postedAt).toBe(
      new Date(1700000000 * 1000).toISOString(),
    );
  });

  it('fails loud when exist returns no video id', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, body: {} }));
    await expect(
      checkCountikVideo('https://www.tiktok.com/@alice/video/123', { fetchFn }),
    ).rejects.toThrow();
  });
});

describe('generateCountikHashtags', () => {
  it('posts the query and returns bare tags', async () => {
    const seen: Array<{ method?: string | undefined; body?: string | undefined }> = [];
    const fetchFn = stubFetch((_url, init) => {
      seen.push({ method: init?.method, body: init?.body });
      return { ok: true, body: { hashtags: ['#viral', 'fitness'] } };
    });
    const result = await generateCountikHashtags('viral', { fetchFn });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify({ query: 'viral' }));
    expect(result.hashtags).toEqual(['viral', 'fitness']);
  });

  it('fails loud when no hashtags come back', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, body: {} }));
    await expect(generateCountikHashtags('viral', { fetchFn })).rejects.toThrow();
  });
});

describe('saved enrichment round-trip and CSV', () => {
  it('maps a stored enriched row back to enrichment, old rows stay plain', () => {
    const enriched = savedCreatorFromRow({
      handle: 'alice',
      display_name: 'Alice Fit',
      avatar_url: null,
      profile_url: 'https://www.tiktok.com/@alice',
      follower_count: null,
      verified: null,
      bio: 'Bio here',
      countik_enriched: true,
      countik_follower_count: 1_200_000,
      following_count: 850,
      hearts_count: 42_000_000,
      video_count: 480,
      countik_verified: true,
      engagement_total: 8.4,
      engagement_likes: 6.1,
      engagement_comments: 1.4,
      engagement_shares: 0.9,
      average_views: 2_100_000,
      average_likes: 180_000,
      average_comments: 9500,
      average_shares: 12_000,
      hashtags: ['fitness'],
      mentions: ['bob'],
      source: 'trending',
      search_term: 'PK',
      updated_at: '2026-11-03T00:00:00.000Z',
    });
    expect(enriched?.enrichment?.bio).toBe('Bio here');
    expect(enriched?.enrichment?.verified).toBe(true);
    expect(enriched?.enrichment?.hashtags).toEqual(['fitness']);

    const old = savedCreatorFromRow({
      handle: 'old',
      display_name: null,
      avatar_url: null,
      profile_url: 'https://www.tiktok.com/@old',
      follower_count: 500,
      verified: true,
      source: 'similar',
      search_term: 'alice',
      updated_at: '2026-10-30T00:00:00.000Z',
    });
    expect(old?.enrichment).toBeUndefined();
    expect(old?.followerCount).toBe(500);
    expect(old?.verified).toBe(true);
  });

  it('upsert keeps stored enrichment when the new save has none', () => {
    const existing = savedCreatorFromRow({
      handle: 'alice',
      display_name: 'Alice',
      avatar_url: null,
      profile_url: 'https://www.tiktok.com/@alice',
      follower_count: null,
      verified: null,
      bio: 'Old bio',
      countik_enriched: true,
      countik_follower_count: 100,
      following_count: 10,
      hearts_count: 20,
      video_count: 30,
      countik_verified: false,
      engagement_total: null,
      engagement_likes: null,
      engagement_comments: null,
      engagement_shares: null,
      average_views: null,
      average_likes: null,
      average_comments: null,
      average_shares: null,
      hashtags: [],
      mentions: [],
      source: 'trending',
      search_term: 'PK',
      updated_at: '2026-11-03T00:00:00.000Z',
    });
    const row = savedCreatorUpsertRow(
      'ws',
      'user',
      makeCreator(),
      'trending',
      'PK',
      {
        enrichment: existing?.enrichment ?? null,
      },
      '2026-11-03T01:00:00.000Z',
    );
    expect(row.countik_enriched).toBe(true);
    expect(row.bio).toBe('Old bio');
  });

  it('CSV expands to the Countik columns and leaves old rows blank there', () => {
    const enriched: SavedCreator = {
      ...makeCreator(),
      enrichment: {
        bio: 'Bio, with a comma',
        followerCount: 1_200_000,
        followingCount: 850,
        heartsCount: 42_000_000,
        videoCount: 480,
        verified: true,
        engagementTotal: 8.4,
        engagementLikes: 6.1,
        engagementComments: 1.4,
        engagementShares: 0.9,
        averageViews: 2_100_000,
        averageLikes: 180_000,
        averageComments: 9500,
        averageShares: 12_000,
        hashtags: ['fitness', 'morning'],
        mentions: ['bob'],
      },
      source: 'trending',
      searchTerm: 'PK',
      savedAt: '2026-11-03T00:00:00.000Z',
    };
    const old: SavedCreator = {
      ...makeCreator({ handle: 'old' }),
      source: 'similar',
      searchTerm: 'alice',
      savedAt: '2026-10-30T00:00:00.000Z',
    };
    const csv = savedCreatorsToCsv([enriched, old]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('bio,following_count,hearts_count,video_count');
    expect(lines[0]).toContain('engagement_total');
    expect(lines[0]).toContain('average_views');
    expect(lines[0]).toContain('hashtags,mentions');
    expect(lines[1]).toContain('"Bio, with a comma"');
    expect(lines[1]).toContain('850,42000000,480');
    expect(lines[1]).toContain('#fitness #morning');
    expect(lines[1]).toContain('@bob');
    // Old row: original columns present, Countik columns empty.
    expect(lines[2]?.startsWith('old,')).toBe(true);
    expect(lines[2]?.endsWith(',,,,,,,,,,,,,,')).toBe(true);
  });
});

describe('proxy + generic messages (countik-proxy fix)', () => {
  it('picks the live analyze keys: *_rate engagement and avg* averages', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.includes('/exist/')) return { ok: true, body: EXIST_BODY };
      return {
        ok: true,
        body: {
          author: { nickname: 'Alice Fit', verified: true },
          engagement_rates: {
            total_rate: 14.32,
            likes_rate: 11.1,
            comments_rate: 2.2,
            shares_rate: 1.0,
          },
          performance: {
            avgViews: 64_441_655,
            avgLikes: 180_000,
            avgComments: 9500,
            avgShares: 12_000,
          },
        },
      };
    });
    const enrichment = await fetchCountikEnrichment('alice', { fetchFn });
    expect(enrichment.engagementTotal).toBe(14.32);
    expect(enrichment.engagementLikes).toBe(11.1);
    expect(enrichment.engagementComments).toBe(2.2);
    expect(enrichment.engagementShares).toBe(1.0);
    expect(enrichment.averageViews).toBe(64_441_655);
    expect(enrichment.averageLikes).toBe(180_000);
    expect(enrichment.averageComments).toBe(9500);
    expect(enrichment.averageShares).toBe(12_000);
  });

  it('never passes an upstream reason through: non-200 gives the fixed generic message', async () => {
    const fetchFn = stubFetch(() => ({
      ok: false,
      body: { message: 'upstream internal wording that must not surface' },
    }));
    await expect(fetchCountikEnrichment('alice', { fetchFn })).rejects.toThrow(
      'Details could not be loaded. Please try again.',
    );
    try {
      await fetchCountikEnrichment('alice', { fetchFn });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('upstream internal wording');
    }
  });

  it('sends a browser User-Agent and routes through the proxy base with its secret', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.includes('/exist/')) {
        return { ok: true, json: async () => EXIST_BODY } as Response;
      }
      return { ok: true, json: async () => ANALYZE_BODY } as Response;
    }) as unknown as typeof fetch;
    await fetchCountikEnrichment('alice', {
      fetchFn,
      baseUrl: 'https://proxy.example',
      proxySecret: 'test-secret',
    });
    expect(seen[0]?.url).toBe('https://proxy.example/exist/alice');
    expect(seen[0]?.headers['User-Agent']).toContain('Chrome/');
    expect(seen[0]?.headers['x-countik-proxy-secret']).toBe('test-secret');
    expect(seen[1]?.url).toBe(
      'https://proxy.example/analyze/?sec_user_id=SEC123&username=alice',
    );
  });

  it('sends no proxy secret header on the direct path', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      if (url.includes('/exist/')) {
        return { ok: true, json: async () => EXIST_BODY } as Response;
      }
      return { ok: true, json: async () => ANALYZE_BODY } as Response;
    }) as unknown as typeof fetch;
    await fetchCountikEnrichment('alice', { fetchFn });
    expect(seen[0]?.['x-countik-proxy-secret']).toBeUndefined();
  });
});
