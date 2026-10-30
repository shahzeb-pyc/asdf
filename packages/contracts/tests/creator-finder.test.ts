import { describe, expect, it, vi } from 'vitest';
import {
  CreatorFinderError,
  dedupeCreators,
  fetchCreatorsByKeyword,
  fetchRegionList,
  fetchSimilarCreators,
  fetchTrendingCreators,
  parseCreatorFinderKeys,
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
  it('resolves a username to a numeric id, then lists who they follow', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { user: { id: '107955', unique_id: 'seed', nickname: 'Seed' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            followings: [
              { unique_id: 'alice', nickname: 'Alice' },
              { unique_id: 'bob', nickname: 'Bob' },
            ],
          },
        }),
      );
    const result = await fetchSimilarCreators('@seed', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.username).toBe('seed');
    expect(result.creators.map((c) => c.handle)).toEqual(['alice', 'bob']);
    expect(fetchFn.mock.calls[1]?.[0]).toContain(
      '/user/following?user_id=107955&count=200',
    );
  });

  it('passes following-entry avatar variants through to the creator', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { user: { id: '107955', unique_id: 'seed', nickname: 'Seed' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            followings: [
              {
                unique_id: 'alice',
                nickname: 'Alice',
                avatarMedium: 'https://cdn.example/alice-medium.jpg',
              },
              { unique_id: 'bob', nickname: 'Bob' },
            ],
          },
        }),
      );
    const result = await fetchSimilarCreators('@seed', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.creators[0]?.avatarUrl).toBe(
      'https://cdn.example/alice-medium.jpg',
    );
    expect(result.creators[1]?.avatarUrl).toBeNull();
  });

  it('tries the next key on an invalid key, then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 10401, msg: 'invalid key' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { user: { id: '1', unique_id: 'seed' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { followings: [] } }),
      );
    const result = await fetchSimilarCreators('seed', {
      fetchFn,
      apiKeys: ['bad', 'good'],
    });
    expect(result.creators).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
