import { describe, expect, it, vi } from 'vitest';
import {
  CreatorFinderError,
  dedupeCreators,
  fetchCreatorsByHashtag,
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

  it('rejects a malformed region instead of calling the API', async () => {
    const fetchFn = vi.fn();
    await expect(
      fetchTrendingCreators('PAK', { fetchFn, apiKeys: ['key-1'] }),
    ).rejects.toBeInstanceOf(CreatorFinderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('fetchCreatorsByHashtag', () => {
  it('resolves a hashtag name to an id, then dedupes its video authors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, data: { challenge: { id: '33380' } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            videos: [
              {
                author: { unique_id: 'alice' },
                title: 'morning workout',
                content_desc: '',
              },
              {
                author: { unique_id: 'bob' },
                title: 'cooking show',
                content_desc: '',
              },
            ],
          },
        }),
      );
    const result = await fetchCreatorsByHashtag('fitness', 'workout', {
      fetchFn,
      apiKeys: ['key-1'],
    });
    expect(result.hashtag).toBe('fitness');
    expect(result.creators.map((c) => c.handle)).toEqual(['alice']);
    expect(fetchFn.mock.calls[0]?.[0]).toContain(
      '/challenge/info?challenge_name=fitness',
    );
    expect(fetchFn.mock.calls[1]?.[0]).toContain(
      '/challenge/posts?challenge_id=33380&count=30',
    );
  });

  it('fails loud with NOT_FOUND when the hashtag has no id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, data: {} }),
    );
    await expect(
      fetchCreatorsByHashtag('nosuchhashtag', null, { fetchFn, apiKeys: ['k'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
