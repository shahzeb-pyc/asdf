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
