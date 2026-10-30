import { z } from 'zod';
import {
  TikwmUserInfoResponseSchema,
  TikwmUserPostsResponseSchema,
  type TikwmVideoItem,
} from './tiktok-mirror.js';

// ==========================================
// tikwmapi (paid) feed/profile + tikwm (free) video resolve
// ==========================================
//
// Auto Repost's TikTok data source, split across two endpoints by
// owner decision (2026-10-29):
//
// - Feed discovery + profile: PAID tikwmapi, base
//   https://api.tikwmapi.com, keyed per request with the
//   `x-tikwmapi-key` header. Same {code, msg, data} response
//   shape as the old free feed endpoints, so the existing
//   TikwmUserPosts/TikwmUserInfo response schemas are reused.
//   GET /user/posts?unique_id=<username>&count=<n> (max 30)
//   GET /user/info?unique_id=<username>
// - Single-video resolution: FREE tikwm, POST
//   https://www.tikwm.com/api/ with form data {url, hd: 1}.
//   Returns {code: 0, data: {hdplay | play, title}} — the
//   no-watermark URL + verbatim caption for one known video.
//
// The free tikwm FEED endpoints (GET /api/user/posts,
// GET /api/user/info on www.tikwm.com) are deliberately NOT used
// anywhere: they return a Cloudflare JS-challenge page (HTTP 403)
// to server fetches. There is no fallback to them, silent or
// otherwise — a feed failure fails loud.
//
// Multi-key rotation (owner decision 2026-10-29): keys come from
// the environment as a list (TIKWMAPI_KEYS, comma-separated, plus
// TIKWMAPI_KEY appended when set). Each feed/profile call uses
// the first non-paused key in list order; a key failure moves to
// the next key. A key is paused for 30 days only when the paid
// API says the key itself is spent or invalid (10401 invalid key,
// 10430 period quota exhausted). A per-minute throttle (10429)
// moves to the next key with only a brief backoff and no pause
// row, and network/5xx failures move to the next key with no
// pause either — both clear on their own. Pause state lives in
// the database (tikwmapi_key_pauses), keyed by a SHA-256 hex
// fingerprint of the key — never the key itself — so pauses
// survive serverless invocations and worker ticks, and an
// expired pause automatically re-eligibilizes the key.

export const TIKWMAPI_BASE_URL = 'https://api.tikwmapi.com';
export const TIKWM_RESOLVE_BASE_URL = 'https://www.tikwm.com/api/';
const TIKWMAPI_FETCH_TIMEOUT_MS = 30_000;
const TIKWM_RESOLVE_TIMEOUT_MS = 25_000;
/** Paid feed page size bound (the paid API caps count at 30). */
export const TIKWMAPI_FEED_COUNT_MAX = 30;
/** Key pause length: 30 days (owner rule: "1 month"). */
export const TIKWMAPI_KEY_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;
/** Brief backoff before trying the next key after a 10429 throttle. */
export const TIKWMAPI_THROTTLE_BACKOFF_MS = 1000;

export class TikwmApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TikwmApiError';
    this.code = code;
  }
}

/**
 * Parse the paid-API key list from the environment. TIKWMAPI_KEYS
 * is comma-separated (whitespace trimmed, empties ignored);
 * TIKWMAPI_KEY (singular) is appended as one more key when set,
 * so a single-key setup keeps working. Duplicates collapse.
 * The returned values are never logged by any caller.
 */
export function parseTikwmApiKeys(keysEnv?: string, singularKey?: string): string[] {
  const keys: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    for (const part of value.split(',')) {
      const key = part.trim();
      if (key && !keys.includes(key)) keys.push(key);
    }
  };
  push(keysEnv);
  push(singularKey);
  return keys;
}

/** One-way SHA-256 hex fingerprint of a key — never the key itself. */
export async function tikwmApiKeyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Pause store for rotated keys. Implementations live per runtime
 * (web Supabase/legacy clients, worker Supabase client) over the
 * tikwmapi_key_pauses table; a null store means pauses cannot be
 * persisted, which the rotation logs loudly but never crashes on.
 */
export interface TikwmApiKeyPauseStore {
  /** Paused-until instant, or null when the key is not paused. */
  getPausedUntil(fingerprint: string): Promise<Date | null>;
  setPaused(fingerprint: string, pausedUntil: Date, reason: string): Promise<void>;
}

type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TikwmApiRotationOptions<T> {
  keys: string[];
  pauseStore?: TikwmApiKeyPauseStore | null | undefined;
  callWithKey: (key: string) => Promise<T>;
  now?: Date | undefined;
  sleep?: SleepFn | undefined;
}

/**
 * Run one paid-API call with key rotation. Keys are tried in list
 * order, skipping paused ones. Only key-spent failures (10401,
 * 10430) earn a 30-day pause row; throttles (10429) and transient
 * failures just move to the next key. Failures that are not about
 * the key at all (unknown user, malformed response, resolve
 * failure) throw immediately — rotating keys cannot fix them.
 * When every key is paused or fails, the last error (or an
 * all-paused error) is thrown: never a silent empty result.
 */
export async function callWithTikwmApiKeyRotation<T>(
  options: TikwmApiRotationOptions<T>
): Promise<T> {
  const { keys, pauseStore = null, callWithKey } = options;
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? defaultSleep;
  if (keys.length === 0) {
    throw new TikwmApiError(
      'NO_KEYS_CONFIGURED',
      'No TikTok feed API key is configured. Set TIKWMAPI_KEYS (or TIKWMAPI_KEY) in the environment.'
    );
  }
  let lastError: unknown = null;
  let attempted = false;
  for (const key of keys) {
    const fingerprint = await tikwmApiKeyFingerprint(key);
    if (pauseStore) {
      try {
        const pausedUntil = await pauseStore.getPausedUntil(fingerprint);
        if (pausedUntil && pausedUntil.getTime() > now.getTime()) continue;
      } catch (err) {
        console.error(
          `[tikwmapi] pause lookup failed for key ${fingerprint}; treating key as unpaused:`,
          err
        );
      }
    }
    attempted = true;
    try {
      return await callWithKey(key);
    } catch (err) {
      lastError = err;
      if (!(err instanceof TikwmApiError)) {
        // Unknown failure shape: transient until proven otherwise.
        continue;
      }
      if (err.code === 'KEY_INVALID' || err.code === 'QUOTA_EXHAUSTED') {
        const pausedUntil = new Date(now.getTime() + TIKWMAPI_KEY_PAUSE_MS);
        const reason = err.code === 'KEY_INVALID' ? 'invalid_key' : 'quota_exhausted';
        if (pauseStore) {
          try {
            await pauseStore.setPaused(fingerprint, pausedUntil, reason);
          } catch (storeErr) {
            console.error(
              `[tikwmapi] could not persist ${reason} pause for key ${fingerprint}; pause not recorded:`,
              storeErr
            );
          }
        } else {
          console.error(
            `[tikwmapi] no pause store; ${reason} pause for key ${fingerprint} could not be persisted.`
          );
        }
        continue;
      }
      if (err.code === 'RATE_LIMITED') {
        // Throttles clear within a minute: brief backoff, next key,
        // deliberately NO 30-day pause row.
        await sleep(TIKWMAPI_THROTTLE_BACKOFF_MS);
        continue;
      }
      if (err.code === 'HTTP_ERROR' || err.code === 'UNREACHABLE') {
        continue;
      }
      // Not a key problem (unknown user, malformed response, ...):
      // rotating cannot fix it, so fail loud immediately.
      throw err;
    }
  }
  if (!attempted) {
    throw new TikwmApiError(
      'ALL_KEYS_PAUSED',
      'All TikTok feed API keys are currently paused (invalid or quota-exhausted). They become eligible again automatically when their pause expires.'
    );
  }
  if (lastError instanceof Error) throw lastError;
  throw new TikwmApiError(
    'TIKWMAPI_CALL_FAILED',
    'TikTok feed API call failed on every configured key.'
  );
}

type FetchFn = typeof fetch;

async function fetchPaidJson(
  path: string,
  key: string,
  fetchFn: FetchFn
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${TIKWMAPI_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(TIKWMAPI_FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'x-tikwmapi-key': key },
    });
  } catch {
    throw new TikwmApiError(
      'UNREACHABLE',
      'Could not reach the TikTok feed service. Please try again.'
    );
  }
  if (!res.ok) {
    throw new TikwmApiError(
      'HTTP_ERROR',
      `TikTok feed service returned HTTP ${res.status}. Please try again.`
    );
  }
  try {
    return await res.json();
  } catch {
    throw new TikwmApiError(
      'BAD_RESPONSE',
      'TikTok feed service returned an unreadable response.'
    );
  }
}

function paidCodeToError(code: number, msg: string | undefined, kind: 'feed' | 'profile'): TikwmApiError {
  if (code === 10401) {
    return new TikwmApiError(
      'KEY_INVALID',
      'The TikTok feed API key is invalid. Check the configured key and try again.'
    );
  }
  if (code === 10429) {
    return new TikwmApiError(
      'RATE_LIMITED',
      'TikTok feed service is rate-limited right now. Please try again shortly.'
    );
  }
  if (code === 10430) {
    return new TikwmApiError(
      'QUOTA_EXHAUSTED',
      'The TikTok feed API quota for this period is exhausted.'
    );
  }
  const detail = msg?.trim();
  return new TikwmApiError(
    'FEED_UNAVAILABLE',
    kind === 'feed'
      ? detail
        ? `Could not fetch that TikTok account's feed: ${detail}`
        : "Could not fetch that TikTok account's feed. Check the username and try again."
      : 'Could not fetch that TikTok account’s profile.'
  );
}

export interface TikwmApiCallOptions {
  count?: number | undefined;
  fetchFn?: FetchFn | undefined;
  apiKeys?: string[] | undefined;
  pauseStore?: TikwmApiKeyPauseStore | null | undefined;
  now?: Date | undefined;
  sleep?: SleepFn | undefined;
}

/**
 * Fetch a username's posts from the PAID tikwmapi feed endpoint,
 * with key rotation. Throws TikwmApiError when the feed cannot be
 * fetched (unknown/private username, key/quota failure, service
 * error, bad shape) — the add flow treats this as "feed
 * unavailable" and creates nothing. A fetchable feed with zero
 * videos is valid (a new account with no posts yet mirrors future
 * reels).
 */
export async function fetchTikwmApiUserPosts(
  username: string,
  options: TikwmApiCallOptions = {}
): Promise<TikwmVideoItem[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const count = Math.max(1, Math.min(options.count ?? 30, TIKWMAPI_FEED_COUNT_MAX));
  const raw = await callWithTikwmApiKeyRotation({
    keys: options.apiKeys ?? [],
    pauseStore: options.pauseStore ?? null,
    now: options.now,
    sleep: options.sleep,
    callWithKey: async (key) => {
      const body = await fetchPaidJson(
        `/user/posts?unique_id=${encodeURIComponent(username)}&count=${count}`,
        key,
        fetchFn
      );
      const parsed = TikwmUserPostsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new TikwmApiError(
          'BAD_RESPONSE',
          'TikTok feed service returned an unexpected response.'
        );
      }
      if (parsed.data.code !== 0 || !parsed.data.data) {
        throw paidCodeToError(parsed.data.code, parsed.data.msg, 'feed');
      }
      return parsed.data.data.videos;
    },
  });
  return raw;
}

/** Display info for a username (avatar/nickname). Display-only: a
 *  failure returns null instead of throwing, and callers fall back
 *  to the feed's author fields. */
export async function fetchTikwmApiUserInfo(
  username: string,
  options: TikwmApiCallOptions = {}
): Promise<{ nickname: string | null; avatar: string | null } | null> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const user = await callWithTikwmApiKeyRotation({
      keys: options.apiKeys ?? [],
      pauseStore: options.pauseStore ?? null,
      now: options.now,
      sleep: options.sleep,
      callWithKey: async (key) => {
        const body = await fetchPaidJson(
          `/user/info?unique_id=${encodeURIComponent(username)}`,
          key,
          fetchFn
        );
        const parsed = TikwmUserInfoResponseSchema.safeParse(body);
        if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data?.user) {
          return null;
        }
        const profile = parsed.data.data.user;
        return {
          nickname: profile.nickname ?? null,
          avatar: profile.avatar ?? null,
        };
      },
    });
    return user;
  } catch {
    return null;
  }
}

// --- Free tikwm single-video resolve ---

export const TikwmResolveResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      play: z.string().optional(),
      hdplay: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
});
export type TikwmResolveResponse = z.infer<typeof TikwmResolveResponseSchema>;

/**
 * Resolve one known TikTok video via the FREE tikwm POST endpoint
 * (form {url, hd: 1}) to its no-watermark URL (hdplay preferred,
 * play fallback) + verbatim title. No key is involved. Throws
 * TikwmApiError on any failure — callers treat a resolve failure
 * like a publish failure (post stays pending, mirror errors).
 */
export async function resolveTikwmVideo(
  videoUrl: string,
  options: { fetchFn?: FetchFn | undefined } = {}
): Promise<{ playUrl: string; title: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(TIKWM_RESOLVE_BASE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIKWM_RESOLVE_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({ url: videoUrl, hd: '1' }).toString(),
    });
  } catch {
    throw new TikwmApiError(
      'UNREACHABLE',
      'Could not reach the TikTok video service. Please try again.'
    );
  }
  if (!res.ok) {
    throw new TikwmApiError(
      'HTTP_ERROR',
      `TikTok video service returned HTTP ${res.status}. Please try again.`
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new TikwmApiError(
      'BAD_RESPONSE',
      'TikTok video service returned an unreadable response.'
    );
  }
  const parsed = TikwmResolveResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) {
    const detail = parsed.success ? parsed.data.msg?.trim() : undefined;
    throw new TikwmApiError(
      'RESOLVE_FAILED',
      detail
        ? `Could not resolve that TikTok video: ${detail}`
        : 'Could not resolve that TikTok video.'
    );
  }
  const playUrl = parsed.data.data.hdplay ?? parsed.data.data.play;
  if (!playUrl) {
    throw new TikwmApiError(
      'RESOLVE_FAILED',
      'Could not resolve that TikTok video: no playable version was returned.'
    );
  }
  return { playUrl, title: parsed.data.data.title ?? '' };
}
