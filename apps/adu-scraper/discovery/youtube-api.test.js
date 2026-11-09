import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverYoutubeShorts,
  isYoutubeShort,
  parseIso8601DurationToSeconds,
  resolveYoutubeChannel,
  uploadsPlaylistIdForChannel,
} from './youtube-api.js';

const CHANNEL_ID = 'UC0DZj1PNa_Fp0MU6uPSKv5w';
const UPLOADS_PLAYLIST_ID = 'UU0DZj1PNa_Fp0MU6uPSKv5w';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// Routes fake fetches by URL path. `calls` records every URL fetched, so
// tests can prove which endpoints were (and were not) hit.
function fakeFetchFactory(handler) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return handler(new URL(url), calls);
  };
  return { fetchFn, calls };
}

function channelsResponse() {
  return jsonResponse({
    items: [{
      id: CHANNEL_ID,
      snippet: { title: 'Cloud Codes' },
      contentDetails: { relatedPlaylists: { uploads: UPLOADS_PLAYLIST_ID } },
    }],
  });
}

function playlistResponse(items, nextPageToken) {
  return jsonResponse({
    items: items.map(([videoId, publishedAt]) => ({
      snippet: { resourceId: { videoId }, publishedAt },
    })),
    ...(nextPageToken ? { nextPageToken } : {}),
  });
}

function durationsResponse(entries) {
  return jsonResponse({
    items: entries.map(([id, duration]) => ({ id, contentDetails: { duration } })),
  });
}

test('parseIso8601DurationToSeconds reads hours, minutes and seconds', () => {
  assert.equal(parseIso8601DurationToSeconds('PT1M30S'), 90);
  assert.equal(parseIso8601DurationToSeconds('PT45S'), 45);
  assert.equal(parseIso8601DurationToSeconds('PT3M'), 180);
  assert.equal(parseIso8601DurationToSeconds('PT0S'), 0);
  assert.equal(parseIso8601DurationToSeconds('PT2H5M'), 7500);
  assert.equal(parseIso8601DurationToSeconds('P1DT2H'), 93600);
});

test('parseIso8601DurationToSeconds rejects garbage', () => {
  assert.equal(parseIso8601DurationToSeconds(''), null);
  assert.equal(parseIso8601DurationToSeconds('garbage'), null);
  assert.equal(parseIso8601DurationToSeconds(null), null);
});

test('isYoutubeShort accepts 60 seconds or less at any date', () => {
  assert.equal(isYoutubeShort('PT45S', '2023-01-01T00:00:00Z'), true);
  assert.equal(isYoutubeShort('PT1M', '2020-06-01T00:00:00Z'), true);
});

test('isYoutubeShort accepts 61 to 180 seconds only after 15 Oct 2024', () => {
  assert.equal(isYoutubeShort('PT1M30S', '2024-10-14T23:59:59Z'), false);
  assert.equal(isYoutubeShort('PT1M30S', '2024-10-15T00:00:00Z'), true);
  assert.equal(isYoutubeShort('PT3M', '2025-01-01T00:00:00Z'), true);
});

test('isYoutubeShort rejects long, zero and malformed durations', () => {
  assert.equal(isYoutubeShort('PT3M1S', '2025-01-01T00:00:00Z'), false);
  assert.equal(isYoutubeShort('PT10M', '2025-01-01T00:00:00Z'), false);
  assert.equal(isYoutubeShort('PT0S', '2025-01-01T00:00:00Z'), false);
  assert.equal(isYoutubeShort(null, '2025-01-01T00:00:00Z'), false);
  assert.equal(isYoutubeShort('PT1M30S', 'not-a-date'), false);
});

test('uploadsPlaylistIdForChannel swaps the UC prefix for UU', () => {
  assert.equal(uploadsPlaylistIdForChannel(CHANNEL_ID), UPLOADS_PLAYLIST_ID);
  assert.equal(uploadsPlaylistIdForChannel('bad'), null);
  assert.equal(uploadsPlaylistIdForChannel(''), null);
});

test('discoverYoutubeShorts lists Shorts across pages and counts quota', async () => {
  const { fetchFn, calls } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/channels')) return channelsResponse();
    if (url.pathname.endsWith('/playlistItems')) {
      if (url.searchParams.get('pageToken') === 'tok') {
        return playlistResponse([['v4', '2025-02-01T00:00:00Z']]);
      }
      return playlistResponse(
        [
          ['v1', '2025-01-01T00:00:00Z'],
          ['v2', '2025-01-02T00:00:00Z'],
          ['v3', '2023-01-03T00:00:00Z'],
        ],
        'tok',
      );
    }
    if (url.pathname.endsWith('/videos')) {
      return durationsResponse([['v1', 'PT45S'], ['v2', 'PT10M'], ['v3', 'PT30S'], ['v4', 'PT2M']]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  let resolvedChannelId = null;
  const result = await discoverYoutubeShorts({
    sourceUsername: '@Cloud-Codes',
    apiKey: 'test-key',
    fetchFn,
    onChannelResolved: async (channelId) => { resolvedChannelId = channelId; },
  });
  // v1 (45s) and v3 (30s, old) are Shorts; v2 (10m) is not; v4 (2m, 2025) is.
  assert.deepEqual(result, {
    ok: true,
    ids: ['v1', 'v3', 'v4'],
    channelId: CHANNEL_ID,
    resolvedFromCache: false,
    quotaUnits: 5,
  });
  assert.equal(resolvedChannelId, CHANNEL_ID);
  assert.equal(calls.some((url) => url.includes('/search')), false);
});

test('discoverYoutubeShorts skips the resolve when a channel ID is cached', async () => {
  const { fetchFn, calls } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/playlistItems')) {
      return playlistResponse([['v1', '2025-01-01T00:00:00Z']]);
    }
    if (url.pathname.endsWith('/videos')) {
      return durationsResponse([['v1', 'PT20S']]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  let resolvedCalls = 0;
  const result = await discoverYoutubeShorts({
    sourceUsername: 'Cloud-Codes',
    cachedChannelId: CHANNEL_ID,
    apiKey: 'test-key',
    fetchFn,
    onChannelResolved: async () => { resolvedCalls += 1; },
  });
  assert.deepEqual(result.ids, ['v1']);
  assert.equal(result.resolvedFromCache, true);
  assert.equal(result.quotaUnits, 2);
  assert.equal(resolvedCalls, 0);
  assert.equal(calls.some((url) => url.includes('/channels')), false);
});

test('discoverYoutubeShorts re-resolves when the cached channel ID is malformed', async () => {
  const { fetchFn } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/channels')) return channelsResponse();
    if (url.pathname.endsWith('/playlistItems')) {
      return playlistResponse([['v1', '2025-01-01T00:00:00Z']]);
    }
    if (url.pathname.endsWith('/videos')) {
      return durationsResponse([['v1', 'PT20S']]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const result = await discoverYoutubeShorts({
    sourceUsername: 'Cloud-Codes',
    cachedChannelId: 'not-a-channel-id',
    apiKey: 'test-key',
    fetchFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedFromCache, false);
  assert.equal(result.channelId, CHANNEL_ID);
});

test('discoverYoutubeShorts stops at the cap without fetching more pages', async () => {
  const { fetchFn, calls } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/channels')) return channelsResponse();
    if (url.pathname.endsWith('/playlistItems')) {
      return playlistResponse(
        [
          ['v1', '2025-01-01T00:00:00Z'],
          ['v2', '2025-01-02T00:00:00Z'],
          ['v3', '2025-01-03T00:00:00Z'],
        ],
        'tok',
      );
    }
    if (url.pathname.endsWith('/videos')) {
      return durationsResponse([['v1', 'PT10S'], ['v2', 'PT20S'], ['v3', 'PT30S']]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const result = await discoverYoutubeShorts({
    sourceUsername: 'Cloud-Codes',
    maxCount: 2,
    apiKey: 'test-key',
    fetchFn,
  });
  assert.deepEqual(result.ids, ['v1', 'v2']);
  assert.equal(calls.filter((url) => url.includes('/playlistItems')).length, 1);
});

test('discoverYoutubeShorts surfaces quota exhaustion without a fallback', async () => {
  const { fetchFn } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/channels')) return channelsResponse();
    if (url.pathname.endsWith('/playlistItems')) {
      return jsonResponse(
        { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota exceeded' } },
        { ok: false, status: 403 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const result = await discoverYoutubeShorts({
    sourceUsername: 'Cloud-Codes',
    apiKey: 'test-key',
    fetchFn,
  });
  assert.deepEqual(result, { ok: false, reason: 'quotaExceeded', quotaExceeded: true });
});

test('resolveYoutubeChannel reports a missing channel instead of throwing', async () => {
  const { fetchFn } = fakeFetchFactory(() => jsonResponse({ items: [] }));
  const result = await resolveYoutubeChannel('no-such-channel', { apiKey: 'test-key', fetchFn });
  assert.deepEqual(result, { ok: false, reason: 'channel_not_found' });
});

test('discoverYoutubeShorts throws before any fetch when the key is missing', async () => {
  const saved = process.env.YOUTUBE_DATA_API_KEY;
  delete process.env.YOUTUBE_DATA_API_KEY;
  let fetchCalls = 0;
  try {
    await assert.rejects(
      discoverYoutubeShorts({
        sourceUsername: 'Cloud-Codes',
        fetchFn: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      }),
      /YOUTUBE_DATA_API_KEY is not set/,
    );
  } finally {
    if (saved !== undefined) {
      process.env.YOUTUBE_DATA_API_KEY = saved;
    }
  }
  assert.equal(fetchCalls, 0);
});

test('discoverYoutubeShorts lets a failing cache write abort loudly', async () => {
  const { fetchFn } = fakeFetchFactory((url) => {
    if (url.pathname.endsWith('/channels')) return channelsResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
  await assert.rejects(
    discoverYoutubeShorts({
      sourceUsername: 'Cloud-Codes',
      apiKey: 'test-key',
      fetchFn,
      onChannelResolved: async () => { throw new Error('cache write failed'); },
    }),
    /cache write failed/,
  );
});

test('discoverYoutubeShorts rejects an empty handle without fetching', async () => {
  let fetchCalls = 0;
  const result = await discoverYoutubeShorts({
    sourceUsername: '   ',
    apiKey: 'test-key',
    fetchFn: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_source_username' });
  assert.equal(fetchCalls, 0);
});
