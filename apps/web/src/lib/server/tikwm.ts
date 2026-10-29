import {
  selectLatestReel as selectLatestReelFromContracts,
  selectNewReels as selectNewReelsFromContracts,
  TikwmUserInfoResponseSchema,
  TikwmUserPostsResponseSchema,
  type TikwmVideoItem,
} from '@fbuploadpro/contracts';

export { selectLatestReelFromContracts as selectLatestReel };
export { selectNewReelsFromContracts as selectNewReels };

/**
 * tikwm client (server-only): https://www.tikwm.com/api/ — free, no
 * key, unofficial. Every failure throws a TikwmError with a plain
 * message; callers surface it loudly (mirror error status / inline
 * add-dialog error), never as silent missing posts.
 *
 * Verified response shapes (2026-10-29, from tikwm client sources):
 * - GET /api/user/posts?unique_id=<username>&count=<n>
 *   -> { code: 0, msg, data: { videos: [...], cursor, hasMore } }
 * - Video item: video_id, play (NO-watermark URL), wmplay
 *   (watermarked URL), hdplay, title (caption), cover, create_time
 *   (unix seconds), images (photo posts only),
 *   author: { unique_id, nickname, avatar }.
 * - A feed item is a reel iff it has a non-empty `play` URL and no
 *   non-empty `images` array (see contracts isTikwmReelItem).
 */

export const TIKWM_API_BASE_URL = 'https://www.tikwm.com/api';
const TIKWM_FETCH_TIMEOUT_MS = 30_000;

export class TikwmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TikwmError';
    this.code = code;
  }
}

type FetchFn = typeof fetch;

async function fetchTikwmJson(
  path: string,
  fetchFn: FetchFn
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${TIKWM_API_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(TIKWM_FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new TikwmError('TIKWM_UNREACHABLE', 'Could not reach TikTok feed service. Please try again.');
  }
  if (!res.ok) {
    throw new TikwmError(
      'TIKWM_HTTP_ERROR',
      `TikTok feed service returned HTTP ${res.status}. Please try again.`
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new TikwmError('TIKWM_BAD_RESPONSE', 'TikTok feed service returned an unreadable response.');
  }
  return raw;
}

/**
 * Fetch a username's posts. Throws TikwmError when the feed cannot
 * be fetched (unknown/private username, service error, bad shape) —
 * the add flow treats this as "feed unavailable" and creates nothing.
 * A fetchable feed with zero videos is valid (a new account with no
 * posts yet mirrors future reels).
 */
export async function fetchTikwmUserPosts(
  username: string,
  options?: { count?: number; fetchFn?: FetchFn }
): Promise<TikwmVideoItem[]> {
  const fetchFn = options?.fetchFn ?? fetch;
  const count = options?.count ?? 30;
  const raw = await fetchTikwmJson(
    `/user/posts?unique_id=${encodeURIComponent(username)}&count=${count}`,
    fetchFn
  );
  const parsed = TikwmUserPostsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TikwmError('TIKWM_BAD_RESPONSE', 'TikTok feed service returned an unexpected response.');
  }
  if (parsed.data.code !== 0 || !parsed.data.data) {
    throw new TikwmError(
      'TIKWM_FEED_UNAVAILABLE',
      parsed.data.msg?.trim()
        ? `Could not fetch that TikTok account's feed: ${parsed.data.msg.trim()}`
        : "Could not fetch that TikTok account's feed. Check the username and try again."
    );
  }
  return parsed.data.data.videos;
}

/** Display info for a username (avatar/nickname). Display-only: a
 *  failure returns null instead of throwing, and callers fall back
 *  to the feed's author fields. */
export async function fetchTikwmUserInfo(
  username: string,
  options?: { fetchFn?: FetchFn }
): Promise<{ nickname: string | null; avatar: string | null } | null> {
  const fetchFn = options?.fetchFn ?? fetch;
  try {
    const raw = await fetchTikwmJson(
      `/user/info?unique_id=${encodeURIComponent(username)}`,
      fetchFn
    );
    const parsed = TikwmUserInfoResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data?.user) {
      return null;
    }
    const user = parsed.data.data.user;
    return {
      nickname: user.nickname ?? null,
      avatar: user.avatar ?? null,
    };
  } catch {
    return null;
  }
}


