import { describe, expect, it, vi } from 'vitest';
import {
  CreatorFinderError,
  CreatorSchema,
  dedupeCreators,
  fetchCreatorsByKeyword,
  fetchRegionList,
  fetchSimilarCreators,
  fetchTrendingCreators,
  filterSavedCreators,
  NicheSearchFiltersQuerySchema,
  paginateSavedCreators,
  parseCreatorFinderKeys,
  savedCreatorFromRow,
  savedCreatorsToCsv,
  savedCreatorUpsertRow,
  SavedCreatorListQuerySchema,
  TrendingResponseSchema,
  type SavedCreator,
} from '../src/domain/creator-finder.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseCreatorFinderKeys', () => {
  it('parses a comma-separated list plus the singular key, deduped', () => {
    expect(parseCreatorFinderKeys(' a , b ,,', 'b')).toEqual(['a', 'b']);
  });
  it('returns an empty list when nothing is configured', () => {
    expect(parseCreatorFinderKeys(undefined, undefined)).toEqual([]);
  });
});

describe('dedupeCreators', () => {
  it('keeps the first video per handle and drops videos without a handle', () => {
    const creators = dedupeCreators([
      {
        author: { unique_id: 'alice', nickname: 'Alice', avatar: null },
        title: 'First',
      },
      {
        author: { unique_id: 'alice', nickname: 'Alice', avatar: null },
        title: 'Second',
      },
      { title: 'No author at all' },
      {
        author: { unique_id: 'bob', nickname: null, avatar: null },
        title: 'Bob video',
      },
    ]);
    expect(creators.map((c) => c.handle)).toEqual(['alice', 'bob']);
    expect(creators[0]?.latestVideoTitle).toBe('First');
    expect(creators[0]?.profileUrl).toBe('https://www.tiktok.com/@alice');
    // Nothing is fabricated: no follower count or bio on a creator.
    expect(creators[0]).not.toHaveProperty('followers');
    expect(creators[0]).not.toHaveProperty('bio');
  });

  it('passes the author avatar through, preferring avatar over variants', () => {
    const creators = dedupeCreators([
      {
        author: {
          unique_id: 'alice',
          nickname: 'Alice',
          avatar: 'https://cdn.example/alice.jpg',
          avatar_thumb: 'https://cdn.example/alice-thumb.jpg',
        },
        title: 'First',
      },
      {
        author: {
          unique_id: 'bob',
          nickname: 'Bob',
          avatarThumb: 'https://cdn.example/bob-thumb.jpg',
        },
        title: 'Bob video',
      },
      {
        author: {
          unique_id: 'carol',
          nickname: 'Carol',
          avatarMedium: 'https://cdn.example/carol-medium.jpg',
        },
        title: 'Carol video',
      },
    ]);
    expect(creators[0]?.avatarUrl).toBe('https://cdn.example/alice.jpg');
    expect(creators[1]?.avatarUrl).toBe('https://cdn.example/bob-thumb.jpg');
    expect(creators[2]?.avatarUrl).toBe('https://cdn.example/carol-medium.jpg');
  });

  it('keeps avatarUrl null when the author has no avatar field', () => {
    const creators = dedupeCreators([
      { author: { unique_id: 'alice', nickname: 'Alice' }, title: 'First' },
    ]);
    expect(creators[0]?.avatarUrl).toBeNull();
  });
});

describe('fetchRegionList', () => {
  it('maps the region record to sorted regions with PK as default', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        msg: 'success',
        data: { US: 'United States', PK: 'Pakistan' },
      }),
    );
    const result = await fetchRegionList({ fetchFn, apiKeys: ['key-1'] });
    expect(result.regions).toEqual([
      { code: 'PK', name: 'Pakistan' },
      { code: 'US', name: 'United States' },
    ]);
    expect(result.defaultRegion).toBe('PK');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.tikwmapi.com/region',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tikwmapi-key': 'key-1' }),
      }),
    );
  });

  it('fails loud when no key is configured', async () => {
    await expect(fetchRegionList({ apiKeys: [] })).rejects.toBeInstanceOf(
      CreatorFinderError,
    );
  });

  it('maps a quota code to QUOTA_EXHAUSTED', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ code: 10430, msg: 'quota exhausted' }),
    );
    await expect(
      fetchRegionList({ fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  });
});

describe('fetchTrendingCreators', () => {
  it('dedupes trending video authors for a region, max 20', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          items: [
            { author: { unique_id: 'alice', nickname: 'Alice' }, title: 'A' },
            { author: { unique_id: 'alice', nickname: 'Alice' }, title: 'A2' },
            { author: { unique_id: 'bob' }, title: 'B' },
          ],
        },
      }),
    );
    const result = await fetchTrendingCreators('pk', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.region).toBe('PK');
    expect(result.videosSeen).toBe(3);
    expect(result.creators.map((c) => c.handle)).toEqual(['alice', 'bob']);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      '/feed/list?region=PK&count=20',
    );
  });

  it('passes the trending author avatar through to the creator', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          items: [
            {
              author: {
                unique_id: 'alice',
                nickname: 'Alice',
                avatar: 'https://cdn.example/alice.jpg',
              },
              title: 'A',
            },
          ],
        },
      }),
    );
    const result = await fetchTrendingCreators('pk', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators[0]?.avatarUrl).toBe('https://cdn.example/alice.jpg');
  });

  it('rejects a malformed region instead of calling the API', async () => {
    const fetchFn = vi.fn();
    await expect(
      fetchTrendingCreators('PAK', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toBeInstanceOf(CreatorFinderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('fetchCreatorsByKeyword', () => {
  function video(handle: string, title: string) {
    return { author: { unique_id: handle, nickname: handle }, title };
  }

  it('searches hashtags and videos in parallel, then merges video creators first, deduped', async () => {
    const fetchFn = vi
      .fn()
      // 1. challenge/search, 2. feed/search (parallel, initiated in this order)
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            challenges: [
              { id: '111', cha_name: 'fitness' },
              { id: '222', cha_name: 'gym' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { videos: [video('alice', 'A'), video('bob', 'B')] },
        }),
      )
      // 3. posts for hashtag 111, 4. posts for hashtag 222
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { videos: [video('bob', 'B2'), video('carol', 'C')] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { videos: [video('dave', 'D')] },
        }),
      );
    const result = await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.keyword).toBe('fitness');
    // Video-search order first (bob found both ways comes first via
    // the video side), then hashtag-only creators in hashtag order.
    expect(result.creators.map((c) => c.handle)).toEqual([
      'alice',
      'bob',
      'carol',
      'dave',
    ]);
    expect(result.videosSeen).toBe(5);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      '/challenge/search?keywords=fitness&count=30',
    );
    expect(fetchFn.mock.calls[1]?.[0]).toContain(
      '/feed/search?keywords=fitness&count=30',
    );
    expect(fetchFn.mock.calls[2]?.[0]).toContain(
      '/challenge/posts?challenge_id=111&count=30',
    );
    expect(fetchFn.mock.calls[3]?.[0]).toContain(
      '/challenge/posts?challenge_id=222&count=30',
    );
    // No info call: both search items already carried an id.
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('caps hashtag posts at the top 3 hashtags', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            challenges: [
              { id: '1', cha_name: 'a' },
              { id: '2', cha_name: 'b' },
              { id: '3', cha_name: 'c' },
              { id: '4', cha_name: 'd' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('one', '1')] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('two', '2')] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('three', '3')] } }),
      );
    const result = await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators.map((c) => c.handle)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(fetchFn.mock.calls.map((call) => call[0])).not.toContain(
      expect.stringContaining('challenge_id=4'),
    );
  });

  it('skips one failing hashtag and keeps the others', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            challenges: [
              { id: '111', cha_name: 'fitness' },
              { id: '222', cha_name: 'gone' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('alice', 'A')] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: -1, msg: 'challenge not found' }),
      );
    const result = await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators.map((c) => c.handle)).toEqual(['alice']);
  });

  it('uses challenge/info only when a search item carries no id', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { challenges: [{ cha_name: 'fitness' }] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { challenge: { id: '33380' } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('alice', 'A')] } }),
      );
    const result = await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators.map((c) => c.handle)).toEqual(['alice']);
    expect(fetchFn.mock.calls[2]?.[0]).toContain(
      '/challenge/info?challenge_name=fitness',
    );
    expect(fetchFn.mock.calls[3]?.[0]).toContain(
      '/challenge/posts?challenge_id=33380&count=30',
    );
  });

  it('fails the whole search loudly on a quota error', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { challenges: [] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 10430, msg: 'quota exhausted' }),
      );
    await expect(
      fetchCreatorsByKeyword('fitness', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  });

  it('rejects an empty keyword instead of calling the API', async () => {
    const fetchFn = vi.fn();
    await expect(
      fetchCreatorsByKeyword('   ', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toBeInstanceOf(CreatorFinderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('fetchSimilarCreators', () => {
  const profile = {
    code: 0,
    data: { user: { id: '107955', unique_id: 'seed', nickname: 'Seed' } },
  };
  // Full flow mocks, in call order: profile, following, followers,
  // user search, seed posts, info+posts per top hashtag.
  function fullFlow(fetchFn: ReturnType<typeof vi.fn>) {
    fetchFn
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            followings: [
              { unique_id: 'alice', nickname: 'Alice', follower_count: 12400, verified: true },
              { unique_id: 'bob', nickname: 'Bob' },
              { unique_id: 'seed', nickname: 'Seed' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            followers: [
              { unique_id: 'bob', nickname: 'Bob', follower_count: 850, verified: false },
              { unique_id: 'carol', nickname: 'Carol' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            user_list: [
              {
                user: {
                  uniqueId: 'dave',
                  nickname: 'Dave',
                  avatarThumb: 'https://cdn.example/dave.jpg',
                  verified: true,
                },
                stats: { followerCount: 5 },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            videos: [
              { title: 'Morning run #fitness and #yoga', author: { unique_id: 'seed', nickname: 'Seed' } },
              { title: 'Evening stretch #yoga', author: { unique_id: 'seed', nickname: 'Seed' } },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { id: '1', cha_name: 'fitness' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            videos: [
              { author: { unique_id: 'erin', nickname: 'Erin' } },
              { author: { unique_id: 'alice', nickname: 'Alice' } },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { id: '2', cha_name: 'yoga' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { videos: [{ author: { unique_id: 'frank', nickname: 'Frank' } }] },
        }),
      );
  }

  it('merges following, followers, hashtag creators, and search matches, more sources first, seed excluded', async () => {
    const fetchFn = vi.fn();
    fullFlow(fetchFn);
    const result = await fetchSimilarCreators('@seed', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.username).toBe('seed');
    // alice: following + hashtag (2 sources), bob: following + followers (2),
    // then carol, erin, frank, dave in first-appearance order.
    expect(result.creators.map((c) => c.handle)).toEqual([
      'alice',
      'bob',
      'carol',
      'erin',
      'frank',
      'dave',
    ]);
    expect(result.creators.find((c) => c.handle === 'dave')?.avatarUrl).toBe(
      'https://cdn.example/dave.jpg',
    );
    // Similar-only fields, mapped from the data actually returned:
    // alice from following, bob filled in from followers (his
    // following entry carried neither field), dave from search stats.
    expect(result.creators.find((c) => c.handle === 'alice')).toMatchObject({
      followerCount: 12400,
      verified: true,
    });
    expect(result.creators.find((c) => c.handle === 'bob')).toMatchObject({
      followerCount: 850,
      verified: false,
    });
    expect(result.creators.find((c) => c.handle === 'dave')).toMatchObject({
      followerCount: 5,
      verified: true,
    });
    // Hashtag-only creators carry neither field — never fabricated.
    expect(result.creators.find((c) => c.handle === 'erin')?.followerCount).toBeUndefined();
    expect(result.creators.find((c) => c.handle === 'erin')?.verified).toBeUndefined();
    expect(result.creators.find((c) => c.handle === 'frank')?.followerCount).toBeUndefined();
    expect(result.creators.find((c) => c.handle === 'carol')?.followerCount).toBeUndefined();
    const urls = fetchFn.mock.calls.map((call) => String(call[0]));
    // The code calls full URLs (TIKWMAPI_BASE_URL + path), so assert
    // against the full URLs the code actually produces.
    expect(urls).toContain('https://api.tikwmapi.com/user/following?user_id=107955&count=200');
    expect(urls).toContain('https://api.tikwmapi.com/user/followers?user_id=107955&count=200');
    expect(urls).toContain('https://api.tikwmapi.com/user/search?keywords=Seed&count=30');
    expect(urls).toContain('https://api.tikwmapi.com/user/posts?unique_id=seed&count=30');
    expect(urls).toContain('https://api.tikwmapi.com/challenge/info?challenge_name=fitness');
    expect(urls).toContain('https://api.tikwmapi.com/challenge/posts?challenge_id=1&count=30');
  });

  it('keeps followerCount and verified optional: trending/niche-style creators parse without them', async () => {
    const base = {
      handle: 'plain',
      displayName: 'Plain',
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: 'https://www.tiktok.com/@plain',
    };
    expect(CreatorSchema.safeParse(base).success).toBe(true);
    expect(CreatorSchema.safeParse({ ...base, followerCount: 12400, verified: true }).success).toBe(true);
    expect(CreatorSchema.safeParse({ ...base, followerCount: -1 }).success).toBe(false);
    // Trending creators carry neither field: dedupe of feed videos
    // must not invent them.
    const [creator] = dedupeCreators([
      { author: { unique_id: 'plain', nickname: 'Plain' } },
    ]);
    expect(creator?.followerCount).toBeUndefined();
    expect(creator?.verified).toBeUndefined();
  });

  it('skips a private followers source and still shows the rest', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { followings: [{ unique_id: 'alice', nickname: 'Alice' }] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: -1, msg: 'followers are private' }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { user_list: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }));
    const result = await fetchSimilarCreators('seed', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators.map((c) => c.handle)).toEqual(['alice']);
  });

  it('fails the whole search loudly on a quota error in a parallel source', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(
        jsonResponse({ code: 10430, msg: 'quota exhausted' }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { followers: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { user_list: [] } }));
    await expect(
      fetchSimilarCreators('seed', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  });

  it('fails the whole search loudly when the profile lookup fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: -1, msg: 'no such user' }));
    await expect(
      fetchSimilarCreators('ghost', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toBeInstanceOf(CreatorFinderError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('tries the next key on an invalid key, then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 10401, msg: 'invalid key' }))
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { followings: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { followers: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { user_list: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }));
    const result = await fetchSimilarCreators('seed', {
      fetchFn,
      apiKeys: ['bad', 'good'],
    });
    expect(result.creators).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('rejects an empty username instead of calling the API', async () => {
    const fetchFn = vi.fn();
    await expect(
      fetchSimilarCreators('  @ ', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toBeInstanceOf(CreatorFinderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('saved creators', () => {
  const baseCreator = {
    handle: 'alice',
    displayName: 'Alice, "The" Creator\nSecond line',
    avatarUrl: 'https://example.com/a.jpg',
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: 'https://www.tiktok.com/@alice',
  };

  it('upsert row fills only undefined fields and never overwrites with null', () => {
    const row = savedCreatorUpsertRow(
      'ws-1',
      'user-1',
      { ...baseCreator, followerCount: undefined, verified: undefined },
      'similar',
      'seed',
      { followerCount: 850, verified: false },
      '2026-10-30T08:00:00.000Z',
    );
    expect(row.follower_count).toBe(850);
    expect(row.verified).toBe(false);
    expect(row.updated_at).toBe('2026-10-30T08:00:00.000Z');
    const fresh = savedCreatorUpsertRow(
      'ws-1',
      'user-1',
      { ...baseCreator, followerCount: 1200, verified: true },
      'niche',
      'fitness',
      { followerCount: 850, verified: false },
      '2026-10-30T09:00:00.000Z',
    );
    expect(fresh.follower_count).toBe(1200);
    expect(fresh.verified).toBe(true);
    expect(fresh.source).toBe('niche');
  });

  it('maps a database row back to a saved creator, and skips unusable rows', () => {
    const creator = savedCreatorFromRow({
      handle: 'alice',
      display_name: 'Alice',
      avatar_url: 'https://example.com/a.jpg',
      profile_url: 'https://www.tiktok.com/@alice',
      follower_count: 850,
      verified: true,
      source: 'similar',
      search_term: 'seed',
      updated_at: '2026-10-30T08:00:00.000Z',
    });
    expect(creator).toMatchObject({
      handle: 'alice',
      followerCount: 850,
      verified: true,
      source: 'similar',
      searchTerm: 'seed',
      savedAt: '2026-10-30T08:00:00.000Z',
    });
    expect(savedCreatorFromRow({ handle: '', source: 'similar', search_term: 'x', updated_at: 't' })).toBeNull();
    expect(savedCreatorFromRow({ handle: 'bob', source: 'bogus', search_term: 'x', updated_at: 't' })).toBeNull();
  });

  it('CSV uses the fixed column order and RFC 4180 escaping', () => {
    const csv = savedCreatorsToCsv([
      {
        ...baseCreator,
        source: 'niche',
        searchTerm: 'fitness',
        savedAt: '2026-10-30T08:00:00.000Z',
      },
      {
        handle: 'bob',
        displayName: null,
        avatarUrl: null,
        latestVideoTitle: null,
        latestVideoCover: null,
        profileUrl: 'https://www.tiktok.com/@bob',
        source: 'trending',
        searchTerm: 'PK',
        savedAt: '2026-10-30T08:01:00.000Z',
      },
    ]);
    // Note: the first creator's display name itself contains a
    // newline, so the CSV is asserted on the raw string, not split
    // into lines — a split would cut inside the quoted field.
    expect(csv).toContain(
      'handle,display_name,avatar_url,profile_url,follower_count,verified,source,search_term,saved_at\n',
    );
    expect(csv).toContain(
      'alice,"Alice, ""The"" Creator\nSecond line",https://example.com/a.jpg,https://www.tiktok.com/@alice,,,niche,fitness,2026-10-30T08:00:00.000Z',
    );
    expect(csv).toContain(
      'bob,,,https://www.tiktok.com/@bob,,,trending,PK,2026-10-30T08:01:00.000Z',
    );
  });

  it('search responses accept an optional saveFailed flag', () => {
    expect(
      TrendingResponseSchema.parse({
        region: 'PK',
        creators: [],
        videosSeen: 0,
        saveFailed: true,
      }).saveFailed,
    ).toBe(true);
  });
});

describe('filterSavedCreators', () => {
  const creators: SavedCreator[] = [
    {
      handle: 'alice',
      displayName: 'Alice Fit',
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: 'https://www.tiktok.com/@alice',
      source: 'niche',
      searchTerm: 'fitness',
      savedAt: '2026-10-30T08:00:00.000Z',
    },
    {
      handle: 'bob',
      displayName: 'Bob Daily',
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: 'https://www.tiktok.com/@bob',
      source: 'trending',
      searchTerm: 'PK',
      savedAt: '2026-10-30T08:01:00.000Z',
    },
  ];

  it('matches display name or handle, case-insensitively, ignoring a leading @', () => {
    expect(filterSavedCreators(creators, { q: 'FIT' }).map((c) => c.handle)).toEqual(['alice']);
    expect(filterSavedCreators(creators, { q: '@bob' }).map((c) => c.handle)).toEqual(['bob']);
    expect(filterSavedCreators(creators, { q: 'zzz' })).toEqual([]);
  });

  it('combines search and source: both must match', () => {
    // 'fit' matches Alice Fit, but Alice was saved from niche, not trending.
    expect(
      filterSavedCreators(creators, { q: 'fit', source: 'trending' }).map((c) => c.handle),
    ).toEqual([]);
    expect(
      filterSavedCreators(creators, { q: '', source: 'trending' }).map((c) => c.handle),
    ).toEqual(['bob']);
    expect(filterSavedCreators(creators, { source: 'all' }).map((c) => c.handle)).toEqual([
      'alice',
      'bob',
    ]);
  });
});

describe('paginateSavedCreators', () => {
  function saved(handle: string): SavedCreator {
    return {
      handle,
      displayName: handle,
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: `https://www.tiktok.com/@${handle}`,
      source: 'trending',
      searchTerm: 'PK',
      savedAt: '2026-10-30T08:00:00.000Z',
    };
  }

  it('slices 30 per page and clamps an out-of-range page', () => {
    const creators = Array.from({ length: 65 }, (_, i) => saved(`user${i}`));
    const page1 = paginateSavedCreators(creators, 1);
    expect(page1.creators).toHaveLength(30);
    expect(page1.total).toBe(65);
    expect(page1.totalPages).toBe(3);
    expect(paginateSavedCreators(creators, 3).creators).toHaveLength(5);
    // A page past the end lands on the last page instead of empty.
    expect(paginateSavedCreators(creators, 99).page).toBe(3);
    expect(paginateSavedCreators([], 1).totalPages).toBe(0);
  });
});

describe('SavedCreatorListQuerySchema', () => {
  it('defaults source to all and page to 1', () => {
    expect(SavedCreatorListQuerySchema.parse({})).toEqual({
      source: 'all',
      page: 1,
    });
    expect(SavedCreatorListQuerySchema.parse({ page: '2' }).page).toBe(2);
  });

  it('rejects an invalid source or page', () => {
    expect(
      SavedCreatorListQuerySchema.safeParse({ source: 'other' }).success,
    ).toBe(false);
    expect(SavedCreatorListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

describe('fetchCreatorsByKeyword filters', () => {
  function video(handle: string) {
    return { author: { unique_id: handle, nickname: handle }, title: 'T' };
  }

  it('sends region to feed/search and challenge/posts, and time/sort to feed/search only', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { challenges: [{ id: '111', cha_name: 'fitness' }] } }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [video('alice')] } }))
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { videos: [video('bob')] } }),
      );
    await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
      filters: { region: 'PK', publishTime: 7, sortType: 1 },
    });
    const urls = fetchFn.mock.calls.map((call) => String(call[0]));
    // The mock receives full URLs (base + path), so assert on fragments.
    expect(urls[0]).toContain('/challenge/search?keywords=fitness&count=30');
    expect(urls[0]).not.toContain('region=');
    expect(urls[1]).toContain(
      '/feed/search?keywords=fitness&count=30&region=PK&publish_time=7&sort_type=1',
    );
    expect(urls[2]).toContain(
      '/challenge/posts?challenge_id=111&count=30&region=PK',
    );
  });

  it('sends no filter params at all when filters are at their defaults', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { challenges: [] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { videos: [] } }));
    await fetchCreatorsByKeyword('fitness', {
      fetchFn,
      apiKeys: ['key-1'],
      filters: { publishTime: 0, sortType: 0 },
    });
    const urls = fetchFn.mock.calls.map((call) => String(call[0]));
    expect(urls[1]).toContain('/feed/search?keywords=fitness&count=30');
    expect(urls[1]).not.toContain('publish_time');
    expect(urls[1]).not.toContain('sort_type');
    expect(urls[1]).not.toContain('region');
  });

  it('rejects invalid filter values at the route schema', () => {
    expect(
      NicheSearchFiltersQuerySchema.safeParse({ publish_time: '2' }).success,
    ).toBe(false);
    expect(
      NicheSearchFiltersQuerySchema.safeParse({ sort_type: '2' }).success,
    ).toBe(false);
    expect(
      NicheSearchFiltersQuerySchema.parse({ publish_time: '30', sort_type: '3' }),
    ).toEqual({ publish_time: '30', sort_type: '3' });
  });
});
