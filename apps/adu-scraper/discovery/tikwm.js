// TikWM /user/info secUid lookup — the TikTok discovery PRIMARY
// (spec scraper-tikwm-first-concurrency, owner order 2026-11-12).
// Runs FIRST on every TikTok claim (see discovery/ytdlp.js): the paid
// TikWM API resolves the profile ID as camelCase `secUid`, and the
// caller then attempts the `tiktokuser:{secUid}` direct feed, exactly
// as the old Countik path did. Only when the whole paid path fails
// does the caller fall back to the yt-dlp profile-URL attempts.
// Countik is dead from every egress; this replaces it.
//
// Keys: TIKWMAPI_KEYS_SCRAPER ONLY — a comma-separated list, exactly
// like the shared TIKWMAPI_KEYS (split on commas, trim whitespace,
// drop empties, try in order until one succeeds, one request per key,
// no retry loop per key). A single key with no comma works too. The
// shared TIKWMAPI_KEYS is NEVER read here. No hardcoded keys anywhere:
// keys come only from the env var, read at call time (not import time)
// so tests can set/unset it freely. Under concurrency the starting
// key rotates round-robin per lookup (module-level counter below),
// so parallel lookups do not all start on key 1.
//
// No proxy: api.tikwmapi.com works direct from the VPS (live-tested
// 2026-11-08). Node's global fetch does not honour proxy env vars,
// so the call stays direct. Never log, print, or store any key value,
// key prefix, or the full request URL: every error detail is scrubbed
// with redactTikwmKeys before it is logged or returned (same pattern
// as the proxy redaction in discovery/ytdlp.js).
//
// This module must stay dependency-free (node builtins only) so the
// standalone CI scraper test step (which runs without npm install)
// can import it — same constraint as discovery/ytdlp.js. The runtime
// validation below mirrors the shared TikwmUserInfoResponseSchema in
// packages/contracts (which the scraper cannot import): code === 0
// and data.user.secUid a non-empty string. Snake_case `sec_uid` is
// NOT a TikWM field and is never read — a response carrying only
// sec_uid is a lookup failure.

export const TIKWMAPI_BASE_URL = 'https://api.tikwmapi.com';
// Same 30s timeout as the paid-API fetch in packages/contracts.
export const TIKWM_USER_INFO_TIMEOUT_MS = 30_000;

// Round-robin start index for key selection (spec
// scraper-tikwm-first-concurrency §3): each lookup starts on the next
// key in turn, so parallel lookups spread across keys instead of all
// hammering key 1. A slow lookup blocks only its own worker slot —
// there is no lock and no serialisation around lookups.
let tikwmKeyStartIndex = 0;

/** Test-only reset for the round-robin counter above. */
export function resetTikwmKeyRotationForTests() {
  tikwmKeyStartIndex = 0;
}

/**
 * Parse the scraper's TikWM key list from one env-var value:
 * comma-separated, whitespace trimmed, empties dropped, duplicates
 * collapsed, order preserved. A single key with no comma works too.
 */
export function parseTikwmScraperKeys(keysEnv) {
  const keys = [];
  if (!keysEnv) return keys;
  for (const part of String(keysEnv).split(',')) {
    const key = part.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Keys for this process, from TIKWMAPI_KEYS_SCRAPER only. */
export function getTikwmScraperKeys() {
  return parseTikwmScraperKeys(process.env.TIKWMAPI_KEYS_SCRAPER);
}

/**
 * Scrub every configured key value out of a string before it is
 * logged or returned. Keys are replaced with a fixed placeholder —
 * never a prefix or a fingerprint — so a log line can never carry
 * key material even when the underlying error text does.
 */
export function redactTikwmKeys(text, keys) {
  let out = String(text ?? '');
  for (const key of keys ?? []) {
    const value = String(key ?? '').trim();
    if (value) out = out.split(value).join('[tikwm-key]');
  }
  return out;
}

// Log-safe username (same allowlist as discovery/ytdlp.js): nothing
// interpolated into a log line can forge a line or carry control chars.
function logSafeUsername(username) {
  return String(username ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 128);
}

/**
 * Validate one /user/info response body against the shape the
 * scraper needs. Returns { ok: true, secUid } only when code is 0
 * and data.user.secUid is a non-empty string; every other shape is
 * a lookup failure with a fixed-token reason (never provider text,
 * never key material).
 */
function parseUserInfoBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'tikwm_bad_response' };
  }
  if (body.code !== 0) {
    return { ok: false, reason: 'tikwm_nonzero_code' };
  }
  const user = body.data?.user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    return { ok: false, reason: 'tikwm_missing_sec_uid' };
  }
  // camelCase ONLY — snake_case `sec_uid` is never read (it is not a
  // TikWM field; the live test's first check missed the ID exactly
  // by looking for it).
  const secUid = user.secUid;
  if (typeof secUid !== 'string' || !secUid) {
    return { ok: false, reason: 'tikwm_missing_sec_uid' };
  }
  return { ok: true, secUid };
}

/**
 * One /user/info request with one key. Never throws: every failure
 * is returned as { ok: false, reason } with a fixed token, and the
 * raw detail is logged once, redacted. `fetchFn` is injectable for
 * tests; production uses the global fetch, direct, no proxy.
 */
async function tryUserInfoWithKey(username, key, fetchFn) {
  const url = `${TIKWMAPI_BASE_URL}/user/info?unique_id=${encodeURIComponent(username)}`;
  let res;
  try {
    res = await fetchFn(url, {
      signal: AbortSignal.timeout(TIKWM_USER_INFO_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'x-tikwmapi-key': key },
    });
  } catch (err) {
    // fetch threw (timeout, DNS, network): the error message could
    // in principle carry request detail, so it is scrubbed before
    // it reaches the log — and it never reaches the returned reason.
    const detail = redactTikwmKeys(err instanceof Error ? err.message : String(err), [key]);
    return { ok: false, reason: 'tikwm_unreachable', detail };
  }
  if (!res.ok) {
    return { ok: false, reason: `tikwm_http_${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'tikwm_bad_response' };
  }
  const parsed = parseUserInfoBody(body);
  if (!parsed.ok) return parsed;
  return { ok: true, secUid: parsed.secUid };
}

/**
 * Resolve a TikTok username to its secUid via paid TikWM /user/info.
 * Keys are tried in rotated order starting from the round-robin start
 * index — one request per key, no retry loop per key. Returns
 * { ok: true, secUid } on the first success, otherwise
 * { ok: false, reason } with the last failure's fixed-token reason.
 * Never throws, never logs key material.
 *
 * @param {string} username
 * @param {{ keys?: string[], fetchFn?: typeof fetch }} [options]
 *   keys defaults to getTikwmScraperKeys(); fetchFn defaults to the
 *   global fetch. Both are injectable for tests.
 */
export async function resolveSecUidWithTikwm(username, options = {}) {
  const keys = options.keys ?? getTikwmScraperKeys();
  const fetchFn = options.fetchFn ?? fetch;
  const logUser = logSafeUsername(username);
  if (keys.length === 0) {
    return { ok: false, reason: 'tikwm_no_keys_configured' };
  }
  const startIndex = tikwmKeyStartIndex++ % keys.length;
  let lastReason = 'tikwm_no_keys_configured';
  for (let i = 0; i < keys.length; i += 1) {
    const keyIndex = (startIndex + i) % keys.length;
    const result = await tryUserInfoWithKey(username, keys[keyIndex], fetchFn);
    if (result.ok) {
      console.log(`✅ TikWM resolved secUid for @${logUser} (key ${keyIndex + 1} of ${keys.length}).`);
      return result;
    }
    lastReason = result.reason;
    // The raw detail was already scrubbed at creation (see
    // tryUserInfoWithKey) — it is logged verbatim here, and the
    // returned reason is a fixed token, so neither path can carry
    // key material.
    const detail = result.detail ? `: ${result.detail}` : '';
    console.warn(
      `⚠️ TikWM /user/info failed for @${logUser} (key ${keyIndex + 1} of ${keys.length}): ${result.reason}${detail}`,
    );
  }
  return { ok: false, reason: lastReason };
}

/**
 * Startup check, called ONCE from index.js main(): TikWM is the
 * PRIMARY discovery path now, so when no keys are configured this is
 * a loud ERROR — the primary is disabled and TikTok discovery runs on
 * the yt-dlp profile-URL backup for every claim. The scraper keeps
 * running; other platforms are unaffected. When keys are configured,
 * log a quiet confirmation (key COUNT only, never values). Returns
 * true when the primary is enabled.
 */
export function logTikwmPrimaryStatus() {
  const keys = getTikwmScraperKeys();
  if (keys.length === 0) {
    console.error(
      '❌ TIKWMAPI_KEYS_SCRAPER is not set — the TikWM PRIMARY is DISABLED; ' +
        'TikTok discovery runs on the yt-dlp profile-URL backup for every claim. ' +
        'Set TIKWMAPI_KEYS_SCRAPER in the scraper .env to enable the primary.',
    );
    return false;
  }
  console.log(`✅ TikWM primary enabled (${keys.length} key(s) configured).`);
  return true;
}

// ==========================================
// TikWM /user/posts feed (spec 203 ranking)
// ==========================================
//
// The ADU TikTok ranking enrichment: after normal discovery (up to
// 1000 IDs), the scraper fetches the newest 60 feed videos with
// view counts (2 pages of 30 via cursor) and sorts them by views,
// so the most-viewed reels download and post first. Same keys as
// the /user/info lookup (TIKWMAPI_KEYS_SCRAPER only), same
// never-log-key-material discipline, same dependency-free
// constraint (node builtins only) — the runtime validation below
// mirrors the shared TikwmUserPostsResponseSchema in
// packages/contracts (which the scraper cannot import).
//
// Key rotation mirrors the contracts helper
// (callWithTikwmApiKeyRotation) as far as this runtime allows:
// 10429 throttle -> brief backoff, next key, no pause; 10430 quota
// exhausted / 10401 invalid key -> next key (the scraper has no
// pause store, so no 30-day pause row is persisted here — the
// contracts/web rotation owns persistence); transient HTTP/unreachable
// -> next key. Non-key failures (unknown user, malformed response)
// fail immediately: rotating keys cannot fix them. Never throws:
// every failure is returned as { ok: false, reason } with a
// fixed-token reason, so the caller can fall back to discovery
// order loudly instead of failing the sync.

/** Paid feed page size (the paid API caps count at 30). */
export const TIKWM_FEED_PAGE_SIZE = 30;
/** How many feed pages the ranking fetches (2 pages = 60 videos). */
export const TIKWM_FEED_PAGE_COUNT = 2;
/** Brief backoff before trying the next key after a 10429 throttle. */
const TIKWM_FEED_THROTTLE_BACKOFF_MS = 1000;

/**
 * Validate one /user/posts response body against the shape the
 * ranking needs. Returns { ok: true, videos, cursor, hasMore } only
 * when code is 0 and data.videos is an array; items without a
 * non-empty video_id are skipped (they cannot be ranked or deduped);
 * a missing/invalid play_count becomes undefined and ranks as 0
 * downstream. A non-zero code carries the code through so the
 * caller can map it to a key outcome; every other shape is a
 * lookup failure with a fixed-token reason (never provider text,
 * never key material).
 */
function parseFeedPageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'tikwm_bad_response' };
  }
  if (body.code !== 0) {
    return { ok: false, reason: 'tikwm_nonzero_code', code: body.code };
  }
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.videos)) {
    return { ok: false, reason: 'tikwm_bad_response' };
  }
  const videos = [];
  for (const item of data.videos) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const videoId = typeof item.video_id === 'string' ? item.video_id.trim() : '';
    if (!videoId) continue;
    const playCount =
      typeof item.play_count === 'number' &&
      Number.isFinite(item.play_count) &&
      item.play_count >= 0
        ? Math.floor(item.play_count)
        : undefined;
    videos.push({ video_id: videoId, play_count: playCount });
  }
  const cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
  return { ok: true, videos, cursor, hasMore: data.hasMore === true };
}

/** Map a non-zero paid-API code to a fixed-token reason + whether rotating to the next key can help. */
function feedCodeOutcome(code) {
  if (code === 10401) return { reason: 'tikwm_key_invalid', keyFailure: true };
  if (code === 10429) return { reason: 'tikwm_rate_limited', keyFailure: true, throttle: true };
  if (code === 10430) return { reason: 'tikwm_quota_exhausted', keyFailure: true };
  return { reason: 'tikwm_feed_unavailable', keyFailure: false };
}

/**
 * One /user/posts request with one key. Never throws: every failure
 * is returned as { ok: false, reason } with a fixed token, and the
 * raw detail is logged once, redacted. `fetchFn` is injectable for
 * tests; production uses the global fetch, direct, no proxy.
 */
async function tryFeedPageWithKey(username, key, fetchFn, cursor) {
  const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
  const url =
    `${TIKWMAPI_BASE_URL}/user/posts?unique_id=${encodeURIComponent(username)}` +
    `&count=${TIKWM_FEED_PAGE_SIZE}${cursorParam}`;
  let res;
  try {
    res = await fetchFn(url, {
      signal: AbortSignal.timeout(TIKWM_USER_INFO_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'x-tikwmapi-key': key },
    });
  } catch (err) {
    const detail = redactTikwmKeys(err instanceof Error ? err.message : String(err), [key]);
    return { ok: false, reason: 'tikwm_unreachable', keyFailure: true, detail };
  }
  if (!res.ok) {
    return { ok: false, reason: `tikwm_http_${res.status}`, keyFailure: true };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'tikwm_bad_response', keyFailure: false };
  }
  const parsed = parseFeedPageBody(body);
  if (!parsed.ok) {
    if (parsed.code !== undefined) {
      return { ok: false, ...feedCodeOutcome(parsed.code) };
    }
    return { ok: false, reason: parsed.reason, keyFailure: false };
  }
  return { ok: true, videos: parsed.videos, cursor: parsed.cursor, hasMore: parsed.hasMore };
}

/**
 * Fetch one /user/posts page with key rotation (same discipline as
 * resolveSecUidWithTikwm: keys tried in rotated order starting from
 * the round-robin start index, one request per key). Returns
 * { ok: true, videos, cursor, hasMore } on the first success,
 * otherwise { ok: false, reason } with the last failure's
 * fixed-token reason. Never throws, never logs key material.
 *
 * @param {string} username
 * @param {{ keys?: string[], fetchFn?: typeof fetch, cursor?: string | null, sleepFn?: (ms: number) => Promise<void> }} [options]
 *   keys defaults to getTikwmScraperKeys(); fetchFn defaults to the
 *   global fetch; cursor fetches page 2+; sleepFn defaults to a real
 *   1s backoff after a 10429 throttle. All are injectable for tests.
 */
export async function fetchTikwmFeedPage(username, options = {}) {
  const keys = options.keys ?? getTikwmScraperKeys();
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn =
    options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logUser = logSafeUsername(username);
  if (keys.length === 0) {
    return { ok: false, reason: 'tikwm_no_keys_configured' };
  }
  const startIndex = tikwmKeyStartIndex++ % keys.length;
  let lastReason = 'tikwm_no_keys_configured';
  for (let i = 0; i < keys.length; i += 1) {
    const keyIndex = (startIndex + i) % keys.length;
    const result = await tryFeedPageWithKey(username, keys[keyIndex], fetchFn, options.cursor ?? null);
    if (result.ok) {
      return result;
    }
    lastReason = result.reason;
    const detail = result.detail ? `: ${result.detail}` : '';
    console.warn(
      `⚠️ TikWM /user/posts failed for @${logUser} (key ${keyIndex + 1} of ${keys.length}): ${result.reason}${detail}`,
    );
    // A non-key failure (unknown user, malformed response) cannot
    // be fixed by rotating: fail immediately, like the contracts
    // rotation does.
    if (!result.keyFailure) {
      return { ok: false, reason: result.reason };
    }
    if (result.throttle) {
      await sleepFn(TIKWM_FEED_THROTTLE_BACKOFF_MS);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * Fetch the ranking feed: two /user/posts pages (30 + 30 via cursor)
 * for up to 60 videos with view counts. Page 2 runs only when page 1
 * reports hasMore with a cursor. A page-2 failure fails the whole
 * feed — the caller falls back to discovery order instead of ranking
 * a partial set. Videos are deduped by video_id across pages
 * (first occurrence wins). Never throws.
 *
 * @param {string} username
 * @param {{ keys?: string[], fetchFn?: typeof fetch, sleepFn?: (ms: number) => Promise<void> }} [options]
 *   Same injection as fetchTikwmFeedPage.
 */
export async function fetchTikwmFeedVideos(username, options = {}) {
  const first = await fetchTikwmFeedPage(username, options);
  if (!first.ok) {
    return first;
  }
  const videos = [...first.videos];
  const seen = new Set(videos.map((video) => video.video_id));
  let cursor = first.cursor;
  let hasMore = first.hasMore;
  for (let page = 2; page <= TIKWM_FEED_PAGE_COUNT && hasMore && cursor; page += 1) {
    const next = await fetchTikwmFeedPage(username, { ...options, cursor });
    if (!next.ok) {
      return { ok: false, reason: next.reason };
    }
    for (const video of next.videos) {
      if (!seen.has(video.video_id)) {
        seen.add(video.video_id);
        videos.push(video);
      }
    }
    cursor = next.cursor;
    hasMore = next.hasMore;
  }
  return { ok: true, videos };
}
