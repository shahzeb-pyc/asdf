/**
 * Creator Finder daily cap — upstream-call counting hook.
 *
 * The cap counts actual HTTP attempts: every fetchTikwmJson
 * invocation fires onUpstreamCall once, BEFORE the attempt, so
 * key-rotation retries (each its own attempt) count too. These
 * tests fail if the hook fires per logical search instead of
 * per attempt, or if a retry slips past uncounted.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchCreatorsByKeyword,
  fetchTrendingCreators,
} from './creator-finder.js';

type JsonBody = { code: number; msg?: string; data?: unknown };

function okResponse(body: JsonBody): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

function trendingBody(): JsonBody {
  return {
    code: 0,
    data: {
      videos: [
        {
          author: { unique_id: 'alice', nickname: 'Alice' },
          title: 'first video',
          cover: 'https://example.com/cover.jpg',
        },
      ],
    },
  };
}

describe('onUpstreamCall counting', () => {
  it('fires once per successful attempt', async () => {
    const onUpstreamCall = vi.fn();
    const fetchFn = vi.fn(async () => okResponse(trendingBody()));
    const result = await fetchTrendingCreators('PK', {
      apiKeys: ['key-1'],
      fetchFn: fetchFn as unknown as typeof fetch,
      onUpstreamCall,
    });
    expect(result.creators).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onUpstreamCall).toHaveBeenCalledTimes(1);
  });

  it('fires once per key-rotation retry: a retried call counts', async () => {
    const onUpstreamCall = vi.fn();
    const calls: string[] = [];
    // First attempt (key-1) gets an invalid-key code, so the
    // fetcher retries on key-2; both attempts must be counted.
    let attempt = 0;
    const rotatingFetch = async () => {
      attempt += 1;
      calls.push(`attempt-${attempt}`);
      if (attempt === 1) {
        return okResponse({ code: 10401, msg: 'invalid key' });
      }
      return okResponse(trendingBody());
    };
    const result = await fetchTrendingCreators('PK', {
      apiKeys: ['key-1', 'key-2'],
      fetchFn: rotatingFetch as unknown as typeof fetch,
      onUpstreamCall,
    });
    expect(result.creators).toHaveLength(1);
    expect(calls).toEqual(['attempt-1', 'attempt-2']);
    expect(onUpstreamCall).toHaveBeenCalledTimes(2);
  });

  it('counts every parallel call of a niche search', async () => {
    const onUpstreamCall = vi.fn();
    const fetchFn = async (url: string) => {
      if (url.includes('/challenge/search')) {
        return okResponse({ code: 0, data: { challenges: [] } });
      }
      return okResponse({
        code: 0,
        data: {
          videos: [
            {
              author: { unique_id: 'bob', nickname: 'Bob' },
              title: 'niche video',
              cover: null,
            },
          ],
        },
      });
    };
    const result = await fetchCreatorsByKeyword('fitness', {
      apiKeys: ['key-1'],
      fetchFn: fetchFn as unknown as typeof fetch,
      onUpstreamCall,
    });
    expect(result.creators).toHaveLength(1);
    // challenge/search + feed/search; no hashtag posts (no
    // hashtags returned), so exactly 2 attempts.
    expect(onUpstreamCall).toHaveBeenCalledTimes(2);
  });

  it('a counting failure aborts before the upstream call, unmasked', async () => {
    const fetchFn = vi.fn(async () => okResponse(trendingBody()));
    const onUpstreamCall = vi.fn(async () => {
      throw new Error('counter unavailable');
    });
    await expect(
      fetchTrendingCreators('PK', {
        apiKeys: ['key-1'],
        fetchFn: fetchFn as unknown as typeof fetch,
        onUpstreamCall,
      }),
    ).rejects.toThrow('counter unavailable');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
