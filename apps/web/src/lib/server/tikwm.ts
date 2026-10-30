import {
  fetchTikwmApiUserInfo as fetchPaidUserInfo,
  fetchTikwmApiUserPosts as fetchPaidUserPosts,
  parseTikwmApiKeys,
  resolveTikwmVideo as resolvePaidVideo,
  TikwmApiError,
  type TikwmApiKeyPauseStore,
  type TikwmVideoItem,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';

export {
  selectLatestReel,
  selectNewReels,
} from '@fbuploadpro/contracts';
export { TikwmApiError as TikwmError };

/**
 * TikTok data client (server-only) for Auto Repost mirrors.
 *
 * Split by owner decision (2026-10-29):
 * - Feed discovery + profile: PAID tikwmapi
 *   (https://api.tikwmapi.com), keyed with `x-tikwmapi-key`.
 *   Keys come from TIKWMAPI_KEYS (comma-separated) plus
 *   TIKWMAPI_KEY (singular, appended) — see getTikwmApiKeys.
 *   Key rotation with DB-persisted 30-day pauses lives in the
 *   contracts tikwmapi module; the pause store below is built
 *   from the route's database handle.
 * - Single-video resolution: FREE tikwm POST
 *   (https://www.tikwm.com/api/, form {url, hd: 1}) — no key.
 *
 * The free tikwm FEED endpoints (GET /api/user/posts,
 * GET /api/user/info on www.tikwm.com) are NOT used anywhere:
 * they return a Cloudflare JS-challenge page (HTTP 403) to
 * server fetches. There is no fallback to them.
 *
 * Every failure throws a TikwmError with a plain message; callers
 * surface it loudly (mirror error status / inline add-dialog
 * error), never as silent missing posts. Key values are never
 * logged, stored, or included in errors — only SHA-256
 * fingerprints reach the pause table.
 */

type FetchFn = typeof fetch;

/** Parse the paid-API key list from the process environment. */
export function getTikwmApiKeys(): string[] {
  return parseTikwmApiKeys(process.env.TIKWMAPI_KEYS, process.env.TIKWMAPI_KEY);
}

/**
 * Build a pause store over the tikwmapi_key_pauses table from a
 * database handle. `legacy` selects the raw-SQL (pg) path;
 * otherwise the Supabase path. Construction performs no I/O;
 * failures surface from get/set and are handled by the rotation
 * (logged loudly, rotation continues, pauses unpersisted).
 */
export function buildTikwmPauseStore(
  db: SupabaseClient | DatabaseClient,
  legacy: boolean
): TikwmApiKeyPauseStore {
  if (legacy) {
    const client = db as DatabaseClient;
    return {
      getPausedUntil: async (fingerprint: string) => {
        const rows = await client.query<{ paused_until: string }>(
          'SELECT paused_until FROM tikwmapi_key_pauses WHERE key_fingerprint = $1',
          [fingerprint]
        );
        const value = rows[0]?.paused_until;
        if (typeof value !== 'string') return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
      },
      setPaused: async (fingerprint: string, pausedUntil: Date, reason: string) => {
        await client.query(
          `INSERT INTO tikwmapi_key_pauses (key_fingerprint, paused_until, reason, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (key_fingerprint) DO UPDATE SET
             paused_until = EXCLUDED.paused_until,
             reason = EXCLUDED.reason,
             updated_at = now()`,
          [fingerprint, pausedUntil.toISOString(), reason]
        );
      },
    };
  }
  const client = db as SupabaseClient;
  return {
    getPausedUntil: async (fingerprint: string) => {
      const { data, error } = await client
        .from('tikwmapi_key_pauses')
        .select('paused_until')
        .eq('key_fingerprint', fingerprint)
        .maybeSingle();
      if (error) throw new Error(`Failed to read key pause: ${error.message}`);
      const value = (data as { paused_until?: unknown } | null)?.paused_until;
      if (typeof value !== 'string') return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    },
    setPaused: async (fingerprint: string, pausedUntil: Date, reason: string) => {
      const { error } = await client.from('tikwmapi_key_pauses').upsert(
        {
          key_fingerprint: fingerprint,
          paused_until: pausedUntil.toISOString(),
          reason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key_fingerprint' }
      );
      if (error) throw new Error(`Failed to persist key pause: ${error.message}`);
    },
  };
}

export interface TikwmFetchOptions {
  count?: number | undefined;
  fetchFn?: FetchFn | undefined;
  apiKeys?: string[] | undefined;
  pauseStore?: TikwmApiKeyPauseStore | null | undefined;
}

/**
 * Fetch a username's posts from the PAID tikwmapi feed endpoint,
 * with key rotation. Throws TikwmError when the feed cannot be
 * fetched (unknown/private username, key/quota failure, service
 * error, bad shape) — the add flow treats this as "feed
 * unavailable" and creates nothing. A fetchable feed with zero
 * videos is valid (a new account with no posts yet mirrors future
 * reels).
 */
export async function fetchTikwmUserPosts(
  username: string,
  options: TikwmFetchOptions = {}
): Promise<TikwmVideoItem[]> {
  return fetchPaidUserPosts(username, {
    count: options.count,
    fetchFn: options.fetchFn,
    apiKeys: options.apiKeys ?? getTikwmApiKeys(),
    pauseStore: options.pauseStore ?? null,
  });
}

/** Display info for a username (avatar/nickname). Display-only: a
 *  failure returns null instead of throwing, and callers fall back
 *  to the feed's author fields. */
export async function fetchTikwmUserInfo(
  username: string,
  options: TikwmFetchOptions = {}
): Promise<{ nickname: string | null; avatar: string | null } | null> {
  return fetchPaidUserInfo(username, {
    fetchFn: options.fetchFn,
    apiKeys: options.apiKeys ?? getTikwmApiKeys(),
    pauseStore: options.pauseStore ?? null,
  });
}

/**
 * Resolve one known TikTok video via the FREE tikwm POST endpoint
 * to its no-watermark URL + verbatim title. Throws TikwmError on
 * any failure — callers treat a resolve failure like a publish
 * failure (post stays pending, mirror errors).
 */
export async function resolveTikwmVideo(
  videoUrl: string,
  options: { fetchFn?: FetchFn } = {}
): Promise<{ playUrl: string; title: string }> {
  return resolvePaidVideo(videoUrl, { fetchFn: options.fetchFn });
}
