import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIKWMAPI_BASE_URL,
  fetchTikwmFeedPage,
  fetchTikwmFeedVideos,
  getTikwmScraperKeys,
  logTikwmPrimaryStatus,
  parseTikwmScraperKeys,
  redactTikwmKeys,
  resetTikwmKeyRotationForTests,
  resolveSecUidWithTikwm,
} from './tikwm.js';

// Fake keys (TEST values, not real credentials). The module must never
// log them; the fake fetch below records them only in its own call log,
// which is test instrumentation in memory.
const FAKE_KEY_A = 'test-fake-key-alpha-001';
const FAKE_KEY_B = 'test-fake-key-beta-002';
const FAKE_SECUID = 'MS4wLjABAAAA-FAKE-SECUID-VALUE-USED-ONLY-IN-THIS-TEST-0123456789abcdef';

async function withCapturedConsole(fn) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'warn', 'error']) {
    originals[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    for (const method of ['log', 'warn', 'error']) {
      console[method] = originals[method];
    }
  }
}

// Fake fetch: answers from a queue, one entry per call. Each entry is
// either { status, body } (a Response-shaped stub) or an Error to throw.
// Records every call's url + headers so tests can assert the key header
// and that no proxy is involved (fetch takes no proxy option — the call
// is direct by construction).
function stubFetch(queue) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next?.body,
    };
  };
  return { fetchFn, calls };
}

function userInfoBody(overrides = {}) {
  return {
    code: 0,
    msg: 'success',
    data: {
      user: {
        unique_id: 'courtroom62',
        uniqueId: 'courtroom62',
        nickname: 'Courtroom 62',
        secUid: FAKE_SECUID,
        id: 123456789,
        ...overrides,
      },
    },
  };
}

test('parseTikwmScraperKeys: commas, spaces, trailing comma, duplicates', () => {
  assert.deepEqual(parseTikwmScraperKeys(` ${FAKE_KEY_A} , ${FAKE_KEY_B} , `), [
    FAKE_KEY_A,
    FAKE_KEY_B,
  ]);
  assert.deepEqual(parseTikwmScraperKeys(`${FAKE_KEY_A},, ${FAKE_KEY_A} ,`), [FAKE_KEY_A]);
  assert.deepEqual(parseTikwmScraperKeys(''), []);
  assert.deepEqual(parseTikwmScraperKeys(undefined), []);
  assert.deepEqual(parseTikwmScraperKeys('   ,  , '), []);
});

test('parseTikwmScraperKeys: a single key with no comma works', () => {
  assert.deepEqual(parseTikwmScraperKeys(FAKE_KEY_A), [FAKE_KEY_A]);
  assert.deepEqual(parseTikwmScraperKeys(`  ${FAKE_KEY_A}  `), [FAKE_KEY_A]);
});

test('getTikwmScraperKeys reads TIKWMAPI_KEYS_SCRAPER only, never TIKWMAPI_KEYS', () => {
  const savedScraper = process.env.TIKWMAPI_KEYS_SCRAPER;
  const savedShared = process.env.TIKWMAPI_KEYS;
  try {
    process.env.TIKWMAPI_KEYS = FAKE_KEY_A;
    delete process.env.TIKWMAPI_KEYS_SCRAPER;
    assert.deepEqual(getTikwmScraperKeys(), []);

    process.env.TIKWMAPI_KEYS_SCRAPER = `${FAKE_KEY_A}, ${FAKE_KEY_B}`;
    assert.deepEqual(getTikwmScraperKeys(), [FAKE_KEY_A, FAKE_KEY_B]);
  } finally {
    if (savedScraper === undefined) delete process.env.TIKWMAPI_KEYS_SCRAPER;
    else process.env.TIKWMAPI_KEYS_SCRAPER = savedScraper;
    if (savedShared === undefined) delete process.env.TIKWMAPI_KEYS;
    else process.env.TIKWMAPI_KEYS = savedShared;
  }
});

test('resolveSecUidWithTikwm: success returns the camelCase secUid, one direct call', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([{ status: 200, body: userInfoBody() }]);
  const { result, lines } = await withCapturedConsole(() =>
    resolveSecUidWithTikwm('courtroom62', { keys: [FAKE_KEY_A], fetchFn }),
  );
  assert.deepEqual(result, { ok: true, secUid: FAKE_SECUID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TIKWMAPI_BASE_URL}/user/info?unique_id=courtroom62`);
  assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_KEY_A);
  assert.ok(!lines.some((line) => line.includes(FAKE_KEY_A)), 'key leaked into logs');
});

test('resolveSecUidWithTikwm: key rotation — first key fails, second succeeds', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: { code: 10401, msg: 'invalid key' } },
    { status: 200, body: userInfoBody() },
  ]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
  });
  assert.deepEqual(result, { ok: true, secUid: FAKE_SECUID });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_KEY_A);
  assert.equal(calls[1].headers['x-tikwmapi-key'], FAKE_KEY_B);
});

test('resolveSecUidWithTikwm: rotation on HTTP failure — first key 403, second succeeds', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 403, body: { code: 0 } },
    { status: 200, body: userInfoBody() },
  ]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
  });
  assert.deepEqual(result, { ok: true, secUid: FAKE_SECUID });
  assert.equal(calls.length, 2);
});

test('resolveSecUidWithTikwm: all keys exhausted returns the last failure reason', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: { code: 10401, msg: 'invalid key' } },
    { status: 200, body: { code: 10430, msg: 'quota exhausted' } },
  ]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
  });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_nonzero_code' });
  assert.equal(calls.length, 2);
});

test('resolveSecUidWithTikwm: snake_case sec_uid only is a lookup failure (camelCase pinned)', async () => {
  const { fetchFn, calls } = stubFetch([
    {
      status: 200,
      body: {
        code: 0,
        data: { user: { unique_id: 'courtroom62', sec_uid: FAKE_SECUID } },
      },
    },
  ]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A],
    fetchFn,
  });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_missing_sec_uid' });
  assert.equal(calls.length, 1);
});

test('resolveSecUidWithTikwm: code 0 but no secUid is a lookup failure', async () => {
  const { fetchFn } = stubFetch([{ status: 200, body: userInfoBody({ secUid: undefined }) }]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A],
    fetchFn,
  });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_missing_sec_uid' });
});

test('resolveSecUidWithTikwm: non-200 is a failure, not a crash', async () => {
  const { fetchFn, calls } = stubFetch([{ status: 500, body: { code: 0 } }]);
  const result = await resolveSecUidWithTikwm('courtroom62', {
    keys: [FAKE_KEY_A],
    fetchFn,
  });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_http_500' });
  assert.equal(calls.length, 1);
});

test('resolveSecUidWithTikwm: fetch throw (timeout) is a failure, no crash, no key in logs', async () => {
  const { fetchFn } = stubFetch([new Error(`request timed out after 30000ms for key ${FAKE_KEY_A}`)]);
  const { result, lines } = await withCapturedConsole(() =>
    resolveSecUidWithTikwm('courtroom62', { keys: [FAKE_KEY_A], fetchFn }),
  );
  assert.deepEqual(result, { ok: false, reason: 'tikwm_unreachable' });
  assert.ok(
    lines.every((line) => !line.includes(FAKE_KEY_A)),
    `key leaked into logs: ${lines.join(' | ')}`,
  );
});

test('resolveSecUidWithTikwm: no keys configured never calls fetch', async () => {
  const { fetchFn, calls } = stubFetch([{ status: 200, body: userInfoBody() }]);
  const result = await resolveSecUidWithTikwm('courtroom62', { keys: [], fetchFn });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_no_keys_configured' });
  assert.equal(calls.length, 0);
});

test('redactTikwmKeys: an error string containing a key value is scrubbed', () => {
  const scrubbed = redactTikwmKeys(
    `request failed for key ${FAKE_KEY_A} and also ${FAKE_KEY_B} end`,
    [FAKE_KEY_A, FAKE_KEY_B],
  );
  assert.equal(scrubbed, 'request failed for key [tikwm-key] and also [tikwm-key] end');
  assert.ok(!scrubbed.includes(FAKE_KEY_A) && !scrubbed.includes(FAKE_KEY_B));
  // No keys: nothing is scrubbed (and nothing can leak).
  assert.equal(redactTikwmKeys('plain text', []), 'plain text');
});

test('resolveSecUidWithTikwm: sequential lookups rotate the starting key (round-robin)', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: userInfoBody() },
    { status: 200, body: userInfoBody() },
    { status: 200, body: userInfoBody() },
  ]);
  const keys = [FAKE_KEY_A, FAKE_KEY_B];
  for (let i = 0; i < 3; i += 1) {
    const result = await resolveSecUidWithTikwm('courtroom62', { keys, fetchFn });
    assert.deepEqual(result, { ok: true, secUid: FAKE_SECUID });
  }
  assert.equal(calls.length, 3);
  // Starts rotate A, B, A — no lookup always starts at key 1.
  assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_KEY_A);
  assert.equal(calls[1].headers['x-tikwmapi-key'], FAKE_KEY_B);
  assert.equal(calls[2].headers['x-tikwmapi-key'], FAKE_KEY_A);
});

test('resolveSecUidWithTikwm: parallel lookups start on different keys (round-robin under concurrency)', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: userInfoBody() },
    { status: 200, body: userInfoBody() },
  ]);
  const keys = [FAKE_KEY_A, FAKE_KEY_B];
  const [first, second] = await Promise.all([
    resolveSecUidWithTikwm('courtroom62', { keys, fetchFn }),
    resolveSecUidWithTikwm('otherhandle', { keys, fetchFn }),
  ]);
  assert.deepEqual(first, { ok: true, secUid: FAKE_SECUID });
  assert.deepEqual(second, { ok: true, secUid: FAKE_SECUID });
  assert.equal(calls.length, 2);
  const usedKeys = calls.map((call) => call.headers['x-tikwmapi-key']).sort();
  assert.deepEqual(usedKeys, [FAKE_KEY_A, FAKE_KEY_B]);
});

test('logTikwmPrimaryStatus: no keys logs ONE loud ERROR and returns false', async () => {
  const saved = process.env.TIKWMAPI_KEYS_SCRAPER;
  try {
    delete process.env.TIKWMAPI_KEYS_SCRAPER;
    const { result, lines } = await withCapturedConsole(() => logTikwmPrimaryStatus());
    assert.equal(result, false);
    const warnings = lines.filter((line) => line.includes('TIKWMAPI_KEYS_SCRAPER'));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('DISABLED'));
    assert.ok(warnings[0].includes('PRIMARY'));
  } finally {
    if (saved === undefined) delete process.env.TIKWMAPI_KEYS_SCRAPER;
    else process.env.TIKWMAPI_KEYS_SCRAPER = saved;
  }
});

test('logTikwmPrimaryStatus: keys configured logs the count, never a key value', async () => {
  const saved = process.env.TIKWMAPI_KEYS_SCRAPER;
  try {
    process.env.TIKWMAPI_KEYS_SCRAPER = `${FAKE_KEY_A}, ${FAKE_KEY_B}`;
    const { result, lines } = await withCapturedConsole(() => logTikwmPrimaryStatus());
    assert.equal(result, true);
    assert.ok(lines.some((line) => line.includes('2 key(s) configured')));
    assert.ok(lines.every((line) => !line.includes(FAKE_KEY_A) && !line.includes(FAKE_KEY_B)));
  } finally {
    if (saved === undefined) delete process.env.TIKWMAPI_KEYS_SCRAPER;
    else process.env.TIKWMAPI_KEYS_SCRAPER = saved;
  }
});

// --- TikWM /user/posts feed (spec 203 ranking) ---
//
// Two pages of 30 via cursor for up to 60 videos with view counts.
// Same keys, same rotation discipline, same never-log-key-material
// rule as the /user/info lookup.

function feedVideo(videoId, playCount) {
  const item = { video_id: videoId, play: 'https://example.invalid/no-wm.mp4' };
  if (playCount !== undefined) item.play_count = playCount;
  return item;
}

function feedPageBody(videos, cursor, hasMore) {
  return {
    code: 0,
    msg: 'success',
    data: { videos, cursor: cursor ?? undefined, hasMore: hasMore ?? false },
  };
}

function feedPageCalls(calls) {
  return calls.filter((call) => call.url.includes('/user/posts'));
}

test('fetchTikwmFeedPage: one page returns videos + cursor + hasMore, count=30, keyed, no cursor on page 1', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: feedPageBody([feedVideo('v1', 100), feedVideo('v2', 50)], 'cursor-1', true) },
  ]);
  const result = await fetchTikwmFeedPage('courtroom62', {
    keys: [FAKE_KEY_A],
    fetchFn,
  });
  assert.deepEqual(result, {
    ok: true,
    videos: [
      { video_id: 'v1', play_count: 100 },
      { video_id: 'v2', play_count: 50 },
    ],
    cursor: 'cursor-1',
    hasMore: true,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(`${TIKWMAPI_BASE_URL}/user/posts?unique_id=courtroom62&count=30`));
  assert.ok(!calls[0].url.includes('cursor='));
  assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_KEY_A);
});

test('fetchTikwmFeedPage: cursor is sent on page 2', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: feedPageBody([feedVideo('v3', 7)], null, false) },
  ]);
  const result = await fetchTikwmFeedPage('courtroom62', {
    keys: [FAKE_KEY_A],
    fetchFn,
    cursor: 'cursor-1',
  });
  assert.equal(result.ok, true);
  assert.ok(calls[0].url.includes('cursor=cursor-1'));
});

test('fetchTikwmFeedVideos: two pages combine 60, deduped, stops when hasMore is false', async () => {
  resetTikwmKeyRotationForTests();
  const page1 = Array.from({ length: 30 }, (_, i) => feedVideo(`p1-${i}`, 1000 - i));
  const page2 = [
    ...Array.from({ length: 29 }, (_, i) => feedVideo(`p2-${i}`, 500 - i)),
    feedVideo('p1-0', 9999), // duplicate of page 1: first occurrence wins
  ];
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: feedPageBody(page1, 'cursor-1', true) },
    { status: 200, body: feedPageBody(page2, 'cursor-2', true) },
  ]);
  const result = await fetchTikwmFeedVideos('courtroom62', { keys: [FAKE_KEY_A], fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.videos.length, 59);
  assert.equal(result.videos[0].video_id, 'p1-0');
  assert.equal(result.videos[0].play_count, 1000);
  assert.equal(feedPageCalls(calls).length, 2);
  assert.ok(calls[1].url.includes('cursor=cursor-1'));
});

test('fetchTikwmFeedVideos: one page only when hasMore is false', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: feedPageBody([feedVideo('v1', 10)], null, false) },
  ]);
  const result = await fetchTikwmFeedVideos('courtroom62', { keys: [FAKE_KEY_A], fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.videos.length, 1);
  assert.equal(feedPageCalls(calls).length, 1);
});

test('fetchTikwmFeedVideos: page-2 failure fails the whole feed (no partial ranking)', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: feedPageBody([feedVideo('v1', 10)], 'cursor-1', true) },
    { status: 200, body: { code: 10430, msg: 'quota exhausted' } },
  ]);
  const result = await fetchTikwmFeedVideos('courtroom62', { keys: [FAKE_KEY_A], fetchFn });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tikwm_quota_exhausted');
  assert.equal(feedPageCalls(calls).length, 2);
});

test('fetchTikwmFeedPage: 10429 throttles to the next key with a backoff', async () => {
  resetTikwmKeyRotationForTests();
  const sleeps = [];
  const sleepFn = async (ms) => {
    sleeps.push(ms);
  };
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: { code: 10429, msg: 'slow down' } },
    { status: 200, body: feedPageBody([feedVideo('v1', 10)], null, false) },
  ]);
  const result = await fetchTikwmFeedPage('courtroom62', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
    sleepFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.videos.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_KEY_A);
  assert.equal(calls[1].headers['x-tikwmapi-key'], FAKE_KEY_B);
  assert.deepEqual(sleeps, [1000]);
});

test('fetchTikwmFeedPage: 10430 moves to the next key and succeeds', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: { code: 10430, msg: 'quota exhausted' } },
    { status: 200, body: feedPageBody([feedVideo('v1', 10)], null, false) },
  ]);
  const result = await fetchTikwmFeedPage('courtroom62', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
    sleepFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['x-tikwmapi-key'], FAKE_KEY_B);
});

test('fetchTikwmFeedPage: unknown-user failure does NOT rotate (one key tried)', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn, calls } = stubFetch([
    { status: 200, body: { code: 10001, msg: 'user not found' } },
  ]);
  const result = await fetchTikwmFeedPage('ghost', {
    keys: [FAKE_KEY_A, FAKE_KEY_B],
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tikwm_feed_unavailable');
  assert.equal(calls.length, 1);
});

test('fetchTikwmFeedPage: no keys fails without fetching', async () => {
  const { fetchFn, calls } = stubFetch([]);
  const result = await fetchTikwmFeedPage('courtroom62', { keys: [], fetchFn });
  assert.deepEqual(result, { ok: false, reason: 'tikwm_no_keys_configured' });
  assert.equal(calls.length, 0);
});

test('fetchTikwmFeedPage: missing play_count is kept as undefined; items without video_id are skipped', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn } = stubFetch([
    {
      status: 200,
      body: feedPageBody(
        [feedVideo('v1'), { play: 'https://example.invalid/x.mp4' }, feedVideo('v2', 5)],
        null,
        false,
      ),
    },
  ]);
  const result = await fetchTikwmFeedPage('courtroom62', { keys: [FAKE_KEY_A], fetchFn });
  assert.deepEqual(result.videos, [
    { video_id: 'v1', play_count: undefined },
    { video_id: 'v2', play_count: 5 },
  ]);
});

test('fetchTikwmFeedPage: key value never appears in logs', async () => {
  resetTikwmKeyRotationForTests();
  const { fetchFn } = stubFetch([
    new Error(`request timed out after 30000ms for key ${FAKE_KEY_A}`),
  ]);
  const { result, lines } = await withCapturedConsole(() =>
    fetchTikwmFeedPage('courtroom62', { keys: [FAKE_KEY_A], fetchFn }),
  );
  assert.equal(result.ok, false);
  assert.ok(lines.every((line) => !line.includes(FAKE_KEY_A)));
});
