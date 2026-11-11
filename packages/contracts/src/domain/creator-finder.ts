import { z } from 'zod';
import { TIKWMAPI_BASE_URL } from './tikwmapi.js';

/**
 * Creator Finder — TikTok creator discovery via the paid tikwmapi
 * service (https://api.tikwmapi.com), server-side only.
 *
 * Verified endpoints (docs, Trending API group + user/challenge):
 * - GET /region — no params, 242 region codes to names.
 * - GET /feed/list — region required, count optional, max 20.
 * - GET /user/info — unique_id or user_id.
 * - GET /user/following — user_id required, count optional, max 200.
 * - GET /user/followers — user_id required, count optional, max 200.
 * - GET /user/search — keywords required, count optional, max 30.
 * - GET /user/posts — unique_id or user_id, count optional, max 30.
 * There is no similar/related/recommended-creator endpoint: the
 * similar tab merges following, followers, hashtag creators from
 * the seed's own posts, and name-search matches, ranked by how
 * many sources each creator appears in.
 * - GET /challenge/info — challenge_id or challenge_name.
 * - GET /challenge/posts — challenge_id required, count optional, max 30.
 * - GET /challenge/search — keywords required, count optional, max 30.
 * - GET /feed/search — keywords required, count optional, max 30;
 *   region, publish_time, and sort_type are optional and are sent
 *   only when the niche tab's filters are set away from defaults.
 * Every call sends `x-tikwmapi-key` and returns {code, msg, data}.
 * Codes: 0 success, 10401 invalid/missing key, 10429 rate limit,
 * 10430 quota exhausted. There is no fallback to the free tikwm
 * service or any other source: a failed call fails loud.
 *
 * Creator fields are only what the API returns. Follower count
 * and verified are optional and carried ONLY by similar sources
 * (following/followers items and user-search items), which actually
 * return them; trending and niche creators carry neither field, so
 * their cards look exactly as before. Bios and other fields are
 * deliberately not in the schema: a field that is not returned is
 * omitted, never fabricated.
 */

export const TRENDING_COUNT_MAX = 20;
/**
 * Daily cap on upstream provider calls in Creator Finder, per user,
 * across all discovery methods (trending, niche, similar, regions).
 * A "call" is one actual HTTP request to the provider, including
 * key-rotation retries: each attempt consumes budget. The gate is
 * checked at the start of a discovery request only — a request
 * that starts under the cap is never aborted mid-flight, even if
 * its calls push the count past the cap; only the next request
 * is blocked. Admins bypass the cap entirely (never gated, never
 * counted). The usage day is a calendar day in Asia/Karachi.
 */
export const CREATOR_FINDER_DAILY_LIMIT = 100;
export const CHALLENGE_COUNT_MAX = 30;
export const SEARCH_COUNT_MAX = 30;
export const FOLLOWING_COUNT_MAX = 200;
export const FOLLOWERS_COUNT_MAX = 200;
export const USER_SEARCH_COUNT_MAX = 30;
export const USER_POSTS_COUNT_MAX = 30;
/** Niche search fetches posts for at most this many top hashtags. */
export const NICHE_HASHTAG_TOP = 3;
/** Similar search fetches posts for at most this many top hashtags
 *  taken from the seed creator's own posts. */
export const SIMILAR_HASHTAG_TOP = 3;
const FETCH_TIMEOUT_MS = 30_000;

export type CreatorFinderErrorCode =
  | 'NO_KEYS_CONFIGURED'
  | 'KEY_INVALID'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'NOT_FOUND'
  | 'FEED_UNAVAILABLE'
  | 'BAD_RESPONSE'
  | 'HTTP_ERROR'
  | 'UPSTREAM_ERROR'
  | 'UNREACHABLE';

export class CreatorFinderError extends Error {
  readonly code: CreatorFinderErrorCode;
  constructor(code: CreatorFinderErrorCode, message: string) {
    super(message);
    this.name = 'CreatorFinderError';
    this.code = code;
  }
}

/** Keys come from env only, comma-separated list plus singular. */
export function parseCreatorFinderKeys(
  keysEnv?: string,
  singularKey?: string,
): string[] {
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

/**
 * Countik user data for one creator, as saved at search time.
 * Every field is optional except bio/hashtags/mentions defaults:
 * Countik responses are untrusted and field shapes vary, so a
 * missing field is omitted, never fabricated — the card renders
 * only the groups that actually carry a value. `verified` here
 * comes ONLY from the analyze response's author.verified: the
 * exist response's verified field is known-unreliable and is
 * never read. Engagement rates are stored exactly as Countik
 * returns them (percent or fraction); the card normalises for
 * display (a value in (0, 1] renders as a percent).
 */
export const CreatorEnrichmentSchema = z.object({
  bio: z.string().nullable(),
  followerCount: z.number().int().nonnegative().optional(),
  followingCount: z.number().int().nonnegative().optional(),
  heartsCount: z.number().int().nonnegative().optional(),
  videoCount: z.number().int().nonnegative().optional(),
  /** From analyze author.verified only. Absent means unknown. */
  verified: z.boolean().optional(),
  engagementTotal: z.number().nonnegative().optional(),
  engagementLikes: z.number().nonnegative().optional(),
  engagementComments: z.number().nonnegative().optional(),
  engagementShares: z.number().nonnegative().optional(),
  averageViews: z.number().int().nonnegative().optional(),
  averageLikes: z.number().int().nonnegative().optional(),
  averageComments: z.number().int().nonnegative().optional(),
  averageShares: z.number().int().nonnegative().optional(),
  hashtags: z.array(z.string()),
  mentions: z.array(z.string()),
});
export type CreatorEnrichment = z.infer<typeof CreatorEnrichmentSchema>;

export const CreatorSchema = z.object({
  handle: z.string().min(1),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  latestVideoTitle: z.string().nullable(),
  latestVideoCover: z.string().nullable(),
  profileUrl: z.string().url(),
  /** Similar sources only; absent for trending/niche creators. */
  followerCount: z.number().int().nonnegative().optional(),
  /** Similar sources only; absent for trending/niche creators. */
  verified: z.boolean().optional(),
  /**
   * Countik enrichment for this creator, or null when Countik
   * had no data for them. Absent (undefined) means the creator
   * predates enrichment entirely (an old saved row) — the card
   * renders it as it always did. Present-but-empty enrichment
   * (countik_enriched in the database) still counts as enriched.
   */
  enrichment: CreatorEnrichmentSchema.nullable().optional(),
  /**
   * True when this search's Countik enrichment failed for this
   * creator. Search responses only — never persisted: the Saved
   * tab derives the same rendering from the stored row (stored
   * enrichment absent + no TikWM follower/verified = no-data
   * variant; stored TikWM fields present = fallback rendering).
   */
  countikUnavailable: z.boolean().optional(),
});
export type Creator = z.infer<typeof CreatorSchema>;

export const RegionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
});
export type Region = z.infer<typeof RegionSchema>;

export const RegionListResponseSchema = z.object({
  regions: z.array(RegionSchema),
  defaultRegion: z.string().nullable(),
});
export type RegionListResponse = z.infer<typeof RegionListResponseSchema>;

/** Today's Creator Finder usage for one user: calls made out of
 *  the daily cap, on the Asia/Karachi calendar date. Served by the
 *  usage endpoint, which is itself never counted and never gated. */
export const CreatorFinderUsageResponseSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CreatorFinderUsageResponse = z.infer<
  typeof CreatorFinderUsageResponseSchema
>;

/**
 * Error body for a discovery request blocked by the daily cap
 * (HTTP 429, no upstream call made). The `dailyLimitExceeded`
 * flag is the machine-readable signal — the page keys its
 * "Daily limit exceeded" message off the flag, not the string —
 * following the emailRateLimited pattern in the auth errors.
 */
export const CreatorFinderDailyLimitExceededBodySchema = z.object({
  error: z.literal('DAILY_LIMIT_EXCEEDED'),
  message: z.literal('Daily limit exceeded'),
  dailyLimitExceeded: z.literal(true),
});
export type CreatorFinderDailyLimitExceededBody = z.infer<
  typeof CreatorFinderDailyLimitExceededBodySchema
>;

export const CreatorListResponseSchema = z.object({
  creators: z.array(CreatorSchema),
  videosSeen: z.number().int().nonnegative(),
  /**
   * True when the search succeeded but its automatic save to the
   * database failed. Results still render; the page shows a
   * warning banner. Never silently dropped, never a search error.
   */
  saveFailed: z.boolean().optional(),
});
export type CreatorListResponse = z.infer<typeof CreatorListResponseSchema>;

/** A creator as saved in the database, with where it came from. */
export const SavedCreatorSchema = CreatorSchema.extend({
  source: z.enum(['trending', 'niche', 'similar']),
  searchTerm: z.string().min(1),
  /** Last saved time (the row's updated_at), ISO timestamp. */
  savedAt: z.string().min(1),
});
export type SavedCreator = z.infer<typeof SavedCreatorSchema>;

/** Saved tab page size — the repo's list-pagination pattern, 30 per page. */
export const SAVED_PAGE_SIZE = 30;

/** Query params for the Saved list: server-side search, source filter, page. */
export const SavedCreatorListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  source: z.enum(['all', 'trending', 'niche', 'similar']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
});
export type SavedCreatorListQuery = z.infer<typeof SavedCreatorListQuerySchema>;

export const SavedCreatorListResponseSchema = z.object({
  creators: z.array(SavedCreatorSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().nonnegative(),
});
export type SavedCreatorListResponse = z.infer<
  typeof SavedCreatorListResponseSchema
>;

export const SavedCreatorDeleteResponseSchema = z.object({
  removed: z.boolean(),
});
export type SavedCreatorDeleteResponse = z.infer<
  typeof SavedCreatorDeleteResponseSchema
>;

export type SavedCreatorSource = SavedCreator['source'];

export const TrendingResponseSchema = CreatorListResponseSchema.extend({
  region: z.string().min(1),
});
export type TrendingResponse = z.infer<typeof TrendingResponseSchema>;

export const NicheResponseSchema = CreatorListResponseSchema.extend({
  keyword: z.string().min(1),
});
export type NicheResponse = z.infer<typeof NicheResponseSchema>;

export const SimilarResponseSchema = CreatorListResponseSchema.extend({
  username: z.string().min(1),
  displayName: z.string().nullable(),
});
export type SimilarResponse = z.infer<typeof SimilarResponseSchema>;

/**
 * Enrichment cap (spec 169): one enrich call carries at most this many
 * creators. No search can legitimately return more — Similar caps at ~520
 * by construction — so anything above this is an abusive or mistaken caller.
 */
export const ENRICH_MAX_CREATORS = 600;

/**
 * Return-first enrichment (spec 169): the page POSTs the creators a search
 * just returned, with where they came from so the endpoint can save the
 * enriched versions. The save reuses the search-time merge semantics.
 */
export const CreatorEnrichRequestSchema = z.object({
  source: z.enum(['trending', 'niche', 'similar']),
  searchTerm: z.string().trim().min(1).max(200),
  creators: z.array(CreatorSchema).min(1).max(ENRICH_MAX_CREATORS),
});
export type CreatorEnrichRequest = z.infer<typeof CreatorEnrichRequestSchema>;

/** Enriched creators in request order, plus whether their save failed. */
export const CreatorEnrichResponseSchema = z.object({
  creators: z.array(CreatorSchema),
  saveFailed: z.boolean().optional(),
});
export type CreatorEnrichResponse = z.infer<typeof CreatorEnrichResponseSchema>;

const NullableString = z.string().nullable().optional();

const RawAuthorSchema = z
  .object({
    unique_id: NullableString,
    nickname: NullableString,
    avatar: NullableString,
    avatar_thumb: NullableString,
    avatarThumb: NullableString,
    avatarMedium: NullableString,
    avatarLarger: NullableString,
  })
  .passthrough();

const RawVideoSchema = z.object({}).passthrough();

const RawFollowingEntrySchema = z.object({}).passthrough();

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Avatar URL from a record, accepting the field variants the API
 * uses across endpoints. Preference order: avatar, avatar_thumb,
 * avatarThumb, avatarMedium, avatarLarger.
 */
function pickAvatar(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  return (
    asString(record.avatar) ??
    asString(record.avatar_thumb) ??
    asString(record.avatarThumb) ??
    asString(record.avatarMedium) ??
    asString(record.avatarLarger)
  );
}

function asNonnegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Follower count from a people/search record, accepting the field
 * variants the API uses: follower_count (following/followers
 * items) and followerCount (user-search stats). Returns undefined
 * when the record carries no usable count — never a fabricated 0.
 */
function pickFollowerCount(
  record: Record<string, unknown> | null,
): number | undefined {
  if (!record) return undefined;
  return (
    asNonnegativeInt(record.follower_count) ??
    asNonnegativeInt(record.followerCount)
  );
}

function pickVerified(
  record: Record<string, unknown> | null,
): boolean | undefined {
  if (!record) return undefined;
  return asBoolean(record.verified);
}

function creatorFromAuthor(
  author: Record<string, unknown> | null,
  video: Record<string, unknown> | null,
): Creator | null {
  const handle =
    asString(author?.unique_id) ??
    asString(author?.uniqueId) ??
    asString(video?.author_unique_id) ??
    asString(video?.unique_id);
  if (!handle) return null;
  const displayName = asString(author?.nickname) ?? asString(video?.nickname);
  const avatarUrl = pickAvatar(author) ?? pickAvatar(video);
  const title =
    asString(video?.title) ?? asString(video?.content_desc) ?? null;
  const cover = asString(video?.cover) ?? null;
  return {
    handle,
    displayName,
    avatarUrl,
    latestVideoTitle: title,
    latestVideoCover: cover,
    profileUrl: `https://www.tiktok.com/@${handle}`,
  };
}

/** Dedupe by handle, keeping the first (most recent) video per creator. */
export function dedupeCreators(
  videos: ReadonlyArray<Record<string, unknown>>,
): Creator[] {
  const byHandle = new Map<string, Creator>();
  for (const video of videos) {
    const author = asRecord(video.author);
    const creator = creatorFromAuthor(author, video);
    if (creator && !byHandle.has(creator.handle)) {
      byHandle.set(creator.handle, creator);
    }
  }
  return [...byHandle.values()];
}

export function creatorFromFollowingEntry(
  entry: Record<string, unknown>,
): Creator | null {
  const handle = asString(entry.unique_id);
  if (!handle) return null;
  const creator: Creator = {
    handle,
    displayName: asString(entry.nickname),
    avatarUrl: pickAvatar(entry),
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: `https://www.tiktok.com/@${handle}`,
  };
  const followerCount = pickFollowerCount(entry);
  if (followerCount !== undefined) creator.followerCount = followerCount;
  const verified = pickVerified(entry);
  if (verified !== undefined) creator.verified = verified;
  return creator;
}

type FetchFn = typeof fetch;

async function fetchTikwmJson(
  path: string,
  key: string,
  fetchFn: FetchFn,
  onUpstreamCall?: (() => Promise<void> | void) | undefined,
): Promise<unknown> {
  // Counted before the attempt, outside the try below: a
  // counting failure must surface as itself, never as UNREACHABLE.
  await onUpstreamCall?.();
  let res: Response;
  try {
    res = await fetchFn(`${TIKWMAPI_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'x-tikwmapi-key': key },
    });
  } catch {
    throw new CreatorFinderError(
      'UNREACHABLE',
      'Creator search could not be completed. Please try again.',
    );
  }
  if (!res.ok) {
    // A 5xx (including non-standard ones like the 531 the trending
    // feed returned for region PK on 2026-10-31 while niche search
    // on the same key kept working) is the provider's own trouble,
    // not a bad request from us: say so plainly instead of quoting
    // a meaningless status number, and never invent results to fill
    // the gap. The page's Find button is the retry path.
    if (res.status >= 500) {
      throw new CreatorFinderError(
        'UPSTREAM_ERROR',
        'Creator search could not be completed. Please try again.',
      );
    }
    throw new CreatorFinderError(
      'HTTP_ERROR',
      'Creator search could not be completed. Please try again.',
    );
  }
  try {
    return await res.json();
  } catch {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Creator search could not be completed. Please try again.',
    );
  }
}

function codeToError(code: number, _msg: string | undefined): CreatorFinderError {
  // All provider codes map to one generic user-facing sentence.
  // The provider's own message is never passed through to the UI.
  if (code === 10401) {
    return new CreatorFinderError(
      'KEY_INVALID',
      'Creator search could not be completed. Please try again.',
    );
  }
  if (code === 10429) {
    return new CreatorFinderError(
      'RATE_LIMITED',
      'Creator search could not be completed. Please try again.',
    );
  }
  if (code === 10430) {
    return new CreatorFinderError(
      'QUOTA_EXHAUSTED',
      'Creator search could not be completed. Please try again.',
    );
  }
  return new CreatorFinderError(
    'FEED_UNAVAILABLE',
    'Creator search could not be completed. Please try again.',
  );
}

function unwrapData(body: unknown): Record<string, unknown> {
  const root = asRecord(body);
  if (!root) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Creator search could not be completed. Please try again.',
    );
  }
  const code = typeof root.code === 'number' ? root.code : -1;
  if (code !== 0) {
    throw codeToError(code, asString(root.msg) ?? undefined);
  }
  const data = root.data;
  if (Array.isArray(data)) {
    return { items: data };
  }
  const record = asRecord(data);
  if (!record) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Creator search could not be completed. Please try again.',
    );
  }
  return record;
}

async function callWithKeys<T>(
  keys: string[],
  callWithKey: (key: string) => Promise<T>,
): Promise<T> {
  if (keys.length === 0) {
    throw new CreatorFinderError(
      'NO_KEYS_CONFIGURED',
      'Creator search is not available right now. Please try again.',
    );
  }
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return await callWithKey(key);
    } catch (err) {
      lastError = err;
      // Only key-level failures are worth retrying on the next key;
      // anything else (unknown hashtag, bad shape) cannot be fixed
      // by rotating keys, so it fails loud immediately.
      if (
        err instanceof CreatorFinderError &&
        (err.code === 'KEY_INVALID' ||
          err.code === 'RATE_LIMITED' ||
          err.code === 'QUOTA_EXHAUSTED')
      ) {
        continue;
      }
      throw err;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new CreatorFinderError(
    'FEED_UNAVAILABLE',
    'Creator search could not be completed. Please try again.',
  );
}

export interface CreatorFinderCallOptions {
  fetchFn?: FetchFn | undefined;
  apiKeys?: string[] | undefined;
  /**
   * Called once per actual upstream HTTP attempt, BEFORE the
   * attempt is made — including key-rotation retries, each of
   * which is its own attempt. The daily-cap counter hooks in
   * here: the callback increments the caller's per-user daily
   * count, and if the increment fails it throws, which aborts
   * the discovery request loudly instead of proceeding
   * uncounted. It is awaited outside fetchTikwmJson's own
   * try/catch so a counting failure is never masked as an
   * upstream reachability error.
   */
  onUpstreamCall?: (() => Promise<void> | void) | undefined;
}

export async function fetchRegionList(
  options: CreatorFinderCallOptions = {},
): Promise<RegionListResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const onUpstreamCall = options.onUpstreamCall;
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson('/region', key, fetchFn, onUpstreamCall);
    return unwrapData(body);
  });
  const regions: Region[] = [];
  for (const [code, name] of Object.entries(data)) {
    if (typeof name === 'string' && name.length > 0) {
      regions.push({ code, name });
    }
  }
  if (regions.length === 0) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Creator search could not be completed. Please try again.',
    );
  }
  regions.sort((a, b) => a.name.localeCompare(b.name));
  const defaultRegion =
    regions.find((r) => r.code === 'PK')?.code ?? regions[0]?.code ?? null;
  return { regions, defaultRegion };
}

function videosFromData(data: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ['videos', 'items', 'list', 'feed']) {
    const parsed = asStringArray(data[key])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

export async function fetchTrendingCreators(
  region: string,
  options: CreatorFinderCallOptions = {},
): Promise<TrendingResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const onUpstreamCall = options.onUpstreamCall;
  const cleanRegion = region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cleanRegion)) {
    throw new CreatorFinderError('BAD_RESPONSE', 'Pick a country from the list.');
  }
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/feed/list?region=${encodeURIComponent(cleanRegion)}&count=${TRENDING_COUNT_MAX}`,
      key,
      fetchFn,
      onUpstreamCall,
    );
    return unwrapData(body);
  });
  const videos = videosFromData(data);
  const creators = dedupeCreators(videos);
  if (videos.length > 0 && creators.length === 0) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Trending videos came back without creator details, so no creator list can be shown.',
    );
  }
  return { region: cleanRegion, creators, videosSeen: videos.length };
}

function challengeIdFromData(data: Record<string, unknown>): string | null {
  const challenge = asRecord(data.challenge);
  return (
    asString(challenge?.id) ??
    asString(challenge?.challenge_id) ??
    asString(data.id) ??
    asString(data.challenge_id) ??
    asString(data.cid)
  );
}

function challengesFromData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  for (const key of ['challenges', 'hashtags', 'items', 'list']) {
    const parsed = asStringArray(data[key])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    if (parsed.length > 0) return parsed;
  }
  const single = asRecord(data.challenge);
  return single ? [single] : [];
}

function challengeIdFromSearchItem(
  item: Record<string, unknown>,
): string | null {
  return (
    asString(item.id) ??
    asString(item.challenge_id) ??
    asString(item.cid) ??
    asString(asRecord(item.challenge)?.id)
  );
}

function challengeNameFromSearchItem(
  item: Record<string, unknown>,
): string | null {
  return (
    asString(item.cha_name) ??
    asString(item.challenge_name) ??
    asString(item.name)
  );
}

/** Niche filter values, exactly as the API defines them. */
export type NichePublishTime = 0 | 1 | 7 | 30 | 90 | 180;
export type NicheSortType = 0 | 1 | 3;
export interface NicheSearchFilters {
  region?: string | undefined;
  publishTime?: NichePublishTime | undefined;
  sortType?: NicheSortType | undefined;
}

/** Raw query params for the niche route: strings, validated before use. */
export const NicheSearchFiltersQuerySchema = z.object({
  region: z.string().trim().min(1).max(10).optional(),
  publish_time: z.enum(['0', '1', '7', '30', '90', '180']).optional(),
  sort_type: z.enum(['0', '1', '3']).optional(),
});

/**
 * Niche keyword search, one merged list. Flow, in order:
 * 1. In parallel: GET /challenge/search and GET /feed/search, both
 *    with keywords and count 30. Optional filters: region is sent
 *    to feed/search and to challenge/posts (both support region);
 *    publish_time and sort_type are sent to feed/search ONLY —
 *    the hashtag endpoints have no such parameters, so Time and
 *    Sort never pretend to filter the hashtag side. When all
 *    filters are at their defaults (no region, publishTime 0,
 *    sortType 0), no filter param is sent at all and the search
 *    behaves exactly as the unfiltered one did.
 * 2. From the hashtag search, take the top 3 hashtags in
 *    API-returned order and fetch GET /challenge/posts for each.
 *    GET /challenge/info is used ONLY when a search item carries
 *    no usable id, to resolve that item's name to an id.
 * 3. Merge: video-search creators first (in video order, so a
 *    creator found both ways naturally comes first), then
 *    hashtag-only creators in hashtag order, deduped by handle.
 * A single hashtag's posts failing for a hashtag-level reason
 * (not found / bad shape / generic feed error) contributes
 * nothing; key, quota, rate-limit, HTTP, and reachability errors
 * fail the whole search loudly. No per-creator /user/info calls.
 */
export async function fetchCreatorsByKeyword(
  keyword: string,
  options: CreatorFinderCallOptions & { filters?: NicheSearchFilters } = {},
): Promise<NicheResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const onUpstreamCall = options.onUpstreamCall;
  const cleanKeyword = keyword.trim();
  if (cleanKeyword.length === 0) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Enter a niche or keyword to search.',
    );
  }
  const filters = options.filters ?? {};
  const regionParam = filters.region
    ? `&region=${encodeURIComponent(filters.region)}`
    : '';
  // Defaults send nothing: publishTime 0 = All time, sortType 0 =
  // Relevance are the API's unfiltered behaviour (and falsy), so
  // they are only sent when the user actually picked something else.
  const feedParams =
    `?keywords=${encodeURIComponent(cleanKeyword)}&count=${SEARCH_COUNT_MAX}` +
    regionParam +
    (filters.publishTime ? `&publish_time=${filters.publishTime}` : '') +
    (filters.sortType ? `&sort_type=${filters.sortType}` : '');
  const encoded = encodeURIComponent(cleanKeyword);
  const [hashtagSearchData, videoSearchData] = await Promise.all([
    callWithKeys(options.apiKeys ?? [], async (key) => {
      const body = await fetchTikwmJson(
        `/challenge/search?keywords=${encoded}&count=${SEARCH_COUNT_MAX}`,
        key,
        fetchFn,
        onUpstreamCall,
      );
      return unwrapData(body);
    }),
    callWithKeys(options.apiKeys ?? [], async (key) => {
      const body = await fetchTikwmJson(
        `/feed/search${feedParams}`,
        key,
        fetchFn,
        onUpstreamCall,
      );
      return unwrapData(body);
    }),
  ]);
  const videoVideos = videosFromData(videoSearchData);
  const videoCreators = dedupeCreators(videoVideos);

  const topHashtags = challengesFromData(hashtagSearchData).slice(
    0,
    NICHE_HASHTAG_TOP,
  );
  let hashtagVideosSeen = 0;
  const hashtagCreators: Creator[] = [];
  for (const item of topHashtags) {
    try {
      let challengeId = challengeIdFromSearchItem(item);
      if (!challengeId) {
        // Id-resolution fallback only: the search item did not
        // already carry a usable id.
        const name = challengeNameFromSearchItem(item);
        if (!name) continue;
        challengeId = await callWithKeys(options.apiKeys ?? [], async (key) => {
          const body = await fetchTikwmJson(
            `/challenge/info?challenge_name=${encodeURIComponent(name)}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          const data = unwrapData(body);
          const id = challengeIdFromData(data);
          if (!id) {
            throw new CreatorFinderError(
              'NOT_FOUND',
              `No hashtag was found for "${name}".`,
            );
          }
          return id;
        });
      }
      const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
        const body = await fetchTikwmJson(
          `/challenge/posts?challenge_id=${encodeURIComponent(challengeId)}&count=${CHALLENGE_COUNT_MAX}${regionParam}`,
          key,
          fetchFn,
          onUpstreamCall,
        );
        return unwrapData(body);
      });
      const videos = videosFromData(data);
      hashtagVideosSeen += videos.length;
      hashtagCreators.push(...dedupeCreators(videos));
    } catch (err) {
      // One hashtag failing for a hashtag-level reason contributes
      // nothing; key/quota/rate/HTTP/reachability errors fail loud.
      if (
        err instanceof CreatorFinderError &&
        (err.code === 'NOT_FOUND' ||
          err.code === 'FEED_UNAVAILABLE' ||
          err.code === 'BAD_RESPONSE')
      ) {
        continue;
      }
      throw err;
    }
  }

  const seen = new Set<string>();
  const creators: Creator[] = [];
  for (const creator of [...videoCreators, ...hashtagCreators]) {
    if (!seen.has(creator.handle)) {
      seen.add(creator.handle);
      creators.push(creator);
    }
  }
  const videosSeen = videoVideos.length + hashtagVideosSeen;
  if (videosSeen > 0 && creators.length === 0) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Search results came back without creator details, so no creator list can be shown.',
    );
  }
  return { keyword: cleanKeyword, creators, videosSeen };
}

/** People-list entries under the first non-empty of these keys. */
function peopleFromData(
  data: Record<string, unknown>,
  keys: string[],
): Record<string, unknown>[] {
  for (const key of keys) {
    const parsed = asStringArray(data[key])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    if (parsed.length > 0) return parsed;
  }
  return [];
}

/** A user-search item is either a bare user record or a wrapper
 *  around one ({user, stats}). Either way it maps through the same
 *  author mapping, so avatar variants carry over. Follower count
 *  comes from stats.followerCount (falling back to the user record)
 *  and verified from the user record — both similar-only fields. */
function creatorFromSearchItem(item: Record<string, unknown>): Creator | null {
  const user = asRecord(item.user) ?? item;
  const base = creatorFromAuthor(user, null);
  if (!base) return null;
  const stats = asRecord(item.stats);
  const followerCount =
    pickFollowerCount(stats) ?? pickFollowerCount(user);
  if (followerCount !== undefined) base.followerCount = followerCount;
  const verified = pickVerified(user);
  if (verified !== undefined) base.verified = verified;
  return base;
}

/**
 * A single source failing for a source-level reason (private,
 * not found, bad/unrecognised shape) contributes nothing; key,
 * quota, rate-limit, HTTP, and reachability errors fail the whole
 * search loudly, as they say nothing about that one source.
 */
async function skipOnSourceError<T>(
  call: () => Promise<T>,
  empty: T,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (
      err instanceof CreatorFinderError &&
      (err.code === 'NOT_FOUND' ||
        err.code === 'FEED_UNAVAILABLE' ||
        err.code === 'BAD_RESPONSE')
    ) {
      return empty;
    }
    throw err;
  }
}

/** Hashtags in first-appearance order, deduplicated case-insensitively. */
function extractHashtags(
  videos: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const video of videos) {
    for (const field of [video.title, video.content_desc]) {
      if (typeof field !== 'string') continue;
      for (const match of field.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
        const tag = match[1];
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          hashtags.push(tag);
        }
      }
    }
  }
  return hashtags;
}

/**
 * Merge source lists into one list, deduplicated by handle
 * (case-insensitive). Creators found in more sources come first;
 * within the same source count, first-appearance order wins, with
 * sources in the order they are passed in. The seed creator is
 * excluded by handle; the Creator schema carries no numeric id,
 * so handle exclusion is the available check.
 */
function mergeSimilarCreators(
  sources: ReadonlyArray<ReadonlyArray<Creator>>,
  seedHandle: string,
): Creator[] {
  const seed = seedHandle.toLowerCase();
  const byHandle = new Map<
    string,
    { creator: Creator; sourceCount: number; firstIndex: number }
  >();
  let index = 0;
  for (const source of sources) {
    const seenInSource = new Set<string>();
    for (const creator of source) {
      const key = creator.handle.toLowerCase();
      if (key === seed) {
        index += 1;
        continue;
      }
      const existing = byHandle.get(key);
      if (existing) {
        if (!seenInSource.has(key)) {
          existing.sourceCount += 1;
          seenInSource.add(key);
        }
        // Fill similar-only fields the first source did not carry
        // (e.g. a hashtag creator later seen in user search): only
        // undefined fields are filled, never overwritten.
        if (
          existing.creator.followerCount === undefined &&
          creator.followerCount !== undefined
        ) {
          existing.creator.followerCount = creator.followerCount;
        }
        if (
          existing.creator.verified === undefined &&
          creator.verified !== undefined
        ) {
          existing.creator.verified = creator.verified;
        }
      } else {
        byHandle.set(key, { creator, sourceCount: 1, firstIndex: index });
        seenInSource.add(key);
      }
      index += 1;
    }
  }
  return [...byHandle.values()]
    .sort(
      (a, b) =>
        b.sourceCount - a.sourceCount || a.firstIndex - b.firstIndex,
    )
    .map((entry) => entry.creator);
}

/**
 * Similar creators, one merged list. There is no similar/related
 * endpoint, so the flow combines every creator source the API
 * offers for a known creator:
 * 1. GET /user/info (unique_id) resolves the numeric user_id and
 *    the seed's nickname. If this fails, the whole search fails
 *    loudly — no partial-source fallback.
 * 2. In parallel: GET /user/following and GET /user/followers
 *    (user_id, count 200 each) and GET /user/search (keywords =
 *    nickname if present, else username, count 30, no filters).
 * 3. Content chain: GET /user/posts (unique_id, count 30),
 *    hashtags extracted from titles/descriptions, top 3 taken,
 *    each resolved via GET /challenge/info (name alone is not a
 *    usable id, so info is needed for every top hashtag here)
 *    and then GET /challenge/posts (count 30).
 * 4. Merge: deduped by handle, seed excluded, more sources first,
 *    then first-appearance order in the source sequence
 *    following, followers, hashtag creators (hashtag order),
 *    search matches. No source badges or sections.
 * Failure handling follows skipOnSourceError: one private /
 * not-found / bad-shape source contributes nothing, while key,
 * quota, rate-limit, HTTP, and reachability errors fail the
 * whole search. If every source is empty, the result is an empty
 * list (the page's empty message), not an error. No per-creator
 * /user/info enrichment.
 */
export async function fetchSimilarCreators(
  username: string,
  options: CreatorFinderCallOptions = {},
): Promise<SimilarResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const onUpstreamCall = options.onUpstreamCall;
  const cleanName = username.trim().replace(/^@+/, '').toLowerCase();
  if (cleanName.length === 0) {
    throw new CreatorFinderError('BAD_RESPONSE', 'Enter a TikTok username.');
  }
  const keys = options.apiKeys ?? [];
  const profile = await callWithKeys(keys, async (key) => {
    const body = await fetchTikwmJson(
      `/user/info?unique_id=${encodeURIComponent(cleanName)}`,
      key,
      fetchFn,
      onUpstreamCall,
    );
    const data = unwrapData(body);
    const user = asRecord(data.user) ?? data;
    const numericId =
      asString(user.id) ?? asString(user.user_id) ?? asString(user.uid);
    if (!numericId) {
      throw new CreatorFinderError(
        'BAD_RESPONSE',
        'That creator could be found, but no account ID came back, so similar creators cannot be listed.',
      );
    }
    return {
      numericId,
      displayName: asString(user.nickname),
      handle: asString(user.unique_id) ?? asString(user.uniqueId) ?? cleanName,
    };
  });

  const encodedId = encodeURIComponent(profile.numericId);
  const [following, followers, searchMatches] = await Promise.all([
    skipOnSourceError(
      () =>
        callWithKeys(keys, async (key) => {
          const body = await fetchTikwmJson(
            `/user/following?user_id=${encodedId}&count=${FOLLOWING_COUNT_MAX}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          const data = unwrapData(body);
          return peopleFromData(data, [
            'followings',
            'following',
            'users',
            'followers',
          ])
            .map((entry) => creatorFromFollowingEntry(entry))
            .filter((creator): creator is Creator => creator !== null);
        }),
      [] as Creator[],
    ),
    skipOnSourceError(
      () =>
        callWithKeys(keys, async (key) => {
          const body = await fetchTikwmJson(
            `/user/followers?user_id=${encodedId}&count=${FOLLOWERS_COUNT_MAX}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          const data = unwrapData(body);
          return peopleFromData(data, [
            'followers',
            'followings',
            'users',
          ])
            .map((entry) => creatorFromFollowingEntry(entry))
            .filter((creator): creator is Creator => creator !== null);
        }),
      [] as Creator[],
    ),
    skipOnSourceError(
      () =>
        callWithKeys(keys, async (key) => {
          const searchKeyword = profile.displayName ?? profile.handle;
          const body = await fetchTikwmJson(
            `/user/search?keywords=${encodeURIComponent(searchKeyword)}&count=${USER_SEARCH_COUNT_MAX}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          const data = unwrapData(body);
          return peopleFromData(data, ['user_list', 'users', 'items', 'list'])
            .map((item) => creatorFromSearchItem(item))
            .filter((creator): creator is Creator => creator !== null);
        }),
      [] as Creator[],
    ),
  ]);

  // Content chain: the seed's own posts, then creators under the
  // top hashtags from those posts. The whole chain is one source
  // for skip purposes: a private posts list contributes nothing.
  let postsVideosSeen = 0;
  let hashtagVideosSeen = 0;
  const hashtagCreators: Creator[] = [];
  const postsVideos = await skipOnSourceError(
    () =>
      callWithKeys(keys, async (key) => {
        const body = await fetchTikwmJson(
          `/user/posts?unique_id=${encodeURIComponent(cleanName)}&count=${USER_POSTS_COUNT_MAX}`,
          key,
          fetchFn,
          onUpstreamCall,
        );
        return videosFromData(unwrapData(body));
      }),
    [] as Record<string, unknown>[],
  );
  postsVideosSeen = postsVideos.length;
  for (const tag of extractHashtags(postsVideos).slice(0, SIMILAR_HASHTAG_TOP)) {
    const creatorsForTag = await skipOnSourceError(
      async () => {
        const challengeId = await callWithKeys(keys, async (key) => {
          const body = await fetchTikwmJson(
            `/challenge/info?challenge_name=${encodeURIComponent(tag)}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          const id = challengeIdFromData(unwrapData(body));
          if (!id) {
            throw new CreatorFinderError(
              'NOT_FOUND',
              `No hashtag was found for "${tag}".`,
            );
          }
          return id;
        });
        const data = await callWithKeys(keys, async (key) => {
          const body = await fetchTikwmJson(
            `/challenge/posts?challenge_id=${encodeURIComponent(challengeId)}&count=${CHALLENGE_COUNT_MAX}`,
            key,
            fetchFn,
            onUpstreamCall,
          );
          return unwrapData(body);
        });
        const videos = videosFromData(data);
        hashtagVideosSeen += videos.length;
        return dedupeCreators(videos);
      },
      [] as Creator[],
    );
    hashtagCreators.push(...creatorsForTag);
  }

  const creators = mergeSimilarCreators(
    [following, followers, hashtagCreators, searchMatches],
    profile.handle,
  );
  return {
    username: profile.handle,
    displayName: profile.displayName,
    creators,
    videosSeen: postsVideosSeen + hashtagVideosSeen,
  };
}

/**
 * Countik user-data API — server-side only, never browser-direct,
 * no key, no cookie. Discovery stays on TikWM; Countik enriches
 * user data only. Verified endpoints:
 * - GET https://countik.com/api/exist/<username> — flat fields
 *   including sec_uid. Its verified field is UNRELIABLE and is
 *   never read; the tick comes only from analyze author.verified.
 * - GET https://countik.com/api/analyze/?sec_user_id=<sec_uid>
 *   &username=<username> — author.verified (the tick source),
 *   engagement_rates, performance, hashtags, mentions.
 * Enrichment is 2 calls per creator, no cache, no Countik cap
 * (owner-confirmed cost). A per-creator failure never fails the
 * search: enrichCreators marks that creator countikUnavailable.
 * Countik responses are untrusted: every field is picked
 * defensively from known variants, and a missing field is
 * omitted, never fabricated.
 */
export const COUNTIK_BASE_URL = 'https://countik.com/api';
const COUNTIK_TIMEOUT_MS = 30_000;
/**
 * Enrichment leg timeout (spec 169): one slow `exist` / `analyze` call used to
 * hold a whole search for 30s. A leg that takes longer than this is treated
 * as unavailable for that creator instead of holding everyone up.
 */
export const COUNTIK_ENRICH_LEG_TIMEOUT_MS = 5_000;
/**
 * Enrichment budget (spec 169): one `enrichCreators` call never runs longer
 * than this overall, however many creators it was given. Creators not
 * finished inside the budget are marked countikUnavailable.
 */
export const COUNTIK_ENRICH_BUDGET_MS = 10_000;
// Same browser header the secuid Worker sends to this upstream:
// a minimal-header datacenter request is the profile most likely
// to be challenged, so this matches the Worker's proven header.
/** Browser User-Agent sent on upstream calls (server-side only). */
const COUNTIK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Server-side-only env access. Read dynamically (never a literal
 * `process.env.X` reference) so a bundler cannot inline these
 * values into any client bundle: the proxy URL and especially
 * the proxy secret must never reach the browser.
 */
function countikEnv(name: string): string | undefined {
  const proc = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  const value = proc?.env?.[name];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Upstream base URL for Countik calls. When COUNTIK_PROXY_URL is
 * set, calls go through the Cloudflare Worker proxy (which
 * changes only egress IP + headers, never the logic); otherwise
 * they go direct. This is a configuration fallback for
 * environments where the proxy is not yet provisioned — it is
 * NOT a failure fallback: a proxy failure is never retried
 * direct, so a proxy outage stays diagnosable instead of being
 * silently masked by a direct call.
 */
export function resolveCountikBaseUrl(): string {
  const proxy = countikEnv('COUNTIK_PROXY_URL');
  if (proxy) {
    // No regex strip here: Sonar flags /\/+$/ as a super-linear
    // backtracking risk (the same smell that sent PR #152 back),
    // and a loop over endsWith('/') is byte-identical on every
    // input including empty and all-slashes strings.
    let base = proxy;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return base;
  }
  return COUNTIK_BASE_URL;
}

/** Proxy secret header name, sent only when proxying. */
export const COUNTIK_PROXY_SECRET_HEADER = 'x-countik-proxy-secret';
/** Countik enrichment runs at most this many creators at once:
 * a Similar search can return hundreds of creators, and firing
 * 2 calls per creator all at once would exhaust sockets. This
 * bounds concurrency only — it caps no call count. */
const COUNTIK_ENRICH_CONCURRENCY = 20;

export type CountikFailureKind = 'network' | 'upstream' | 'shape';
export type CountikEndpoint =
  | 'exist'
  | 'analyze'
  | 'video-exist'
  | 'videoinfo'
  | 'generateHashtags';

export class CountikError extends Error {
  readonly endpoint: CountikEndpoint | undefined;
  readonly kind: CountikFailureKind;
  readonly upstreamStatus: number | undefined;
  constructor(
    message: string,
    options: {
      endpoint?: CountikEndpoint;
      kind?: CountikFailureKind;
      upstreamStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CountikError';
    this.endpoint = options.endpoint;
    this.kind = options.kind ?? 'shape';
    this.upstreamStatus = options.upstreamStatus;
  }
}

type CountikFetchFn = typeof fetch;

async function fetchCountikJson(
  path: string,
  options: {
    fetchFn: CountikFetchFn;
    method?: 'GET' | 'POST' | undefined;
    body?: unknown | undefined;
    endpoint: CountikEndpoint;
    /** Test override for the base URL; production reads env. */
    baseUrl?: string | undefined;
    /** Test override for the proxy secret; production reads env. */
    proxySecret?: string | undefined;
    /** Per-call leg timeout override; default COUNTIK_TIMEOUT_MS. */
    timeoutMs?: number | undefined;
    /** Abort the call when this fires (enrichment budget); combined with the leg timeout. */
    signal?: AbortSignal | undefined;
  },
): Promise<unknown> {
  const baseUrl = options.baseUrl ?? resolveCountikBaseUrl();
  const isProxy = baseUrl !== COUNTIK_BASE_URL;
  const proxySecret =
    options.proxySecret ?? (isProxy ? countikEnv('COUNTIK_PROXY_SECRET') : undefined);
  const url = `${baseUrl}${path}`;
  const timeoutMs = options.timeoutMs ?? COUNTIK_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
    : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await options.fetchFn(url, {
      signal,
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': COUNTIK_UA,
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(proxySecret ? { [COUNTIK_PROXY_SECRET_HEADER]: proxySecret } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw new CountikError('Details could not be loaded. Please try again.', {
      endpoint: options.endpoint,
      kind: 'network',
    });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Never pass the upstream body's wording through to the UI:
    // it can name the provider or leak internal wording, and a
    // challenge page is not a usable message at all.
    throw new CountikError('Details could not be loaded. Please try again.', {
      endpoint: options.endpoint,
      kind: 'upstream',
      upstreamStatus: res.status,
    });
  }
  return body;
}

/** First non-empty string among the record's candidate keys. */
function pickString(
  record: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

/** First usable non-negative number among candidate keys. */
function pickCountikNumber(
  record: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
    if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim())) {
      return Number(raw.trim());
    }
  }
  return undefined;
}

/**
 * String list from an array of strings or of objects carrying a
 * name-like field. A leading # (hashtags) or @ (mentions) is
 * stripped so stored tags are bare; the UI re-adds the marker.
 * Deduplicated case-insensitively, first-appearance order kept.
 */
function pickTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const raw =
      typeof item === 'string'
        ? item
        : pickString(asRecord(item), [
            'hashtag',
            'name',
            'tag',
            'title',
            'username',
            'unique_id',
            'text',
          ]);
    if (!raw) continue;
    const tag = raw.trim().replace(/^[#@]/, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** Unwrap a Countik body: {data: {...}} or the flat object itself. */
function countikData(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  return asRecord(root.data) ?? root;
}

export interface CountikCallOptions {
  fetchFn?: CountikFetchFn | undefined;
  /** Test override for the upstream base URL; production reads env. */
  baseUrl?: string | undefined;
  /** Test override for the proxy secret; production reads env. */
  proxySecret?: string | undefined;
  /** Per-leg timeout override; enrichment passes its short leg timeout. */
  timeoutMs?: number | undefined;
  /** Abort in-flight calls when this fires (enrichment budget). */
  signal?: AbortSignal | undefined;
  /** Overall budget for one enrichCreators call; default COUNTIK_ENRICH_BUDGET_MS. */
  budgetMs?: number | undefined;
}

/**
 * Enrich one creator via exist → analyze. Throws CountikError
 * when either call fails or the shape is unusable; callers that
 * enrich a list catch per creator (see enrichCreators).
 */
export async function fetchCountikEnrichment(
  handle: string,
  options: CountikCallOptions = {},
): Promise<CreatorEnrichment> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanHandle = handle.trim().replace(/^@+/, '');
  if (!cleanHandle) {
    throw new CountikError('Details unavailable for this creator.', {
      endpoint: 'exist',
      kind: 'shape',
    });
  }
  const existBody = await fetchCountikJson(
    `/exist/${encodeURIComponent(cleanHandle)}`,
    { fetchFn, endpoint: 'exist', baseUrl: options.baseUrl, proxySecret: options.proxySecret, timeoutMs: options.timeoutMs, signal: options.signal },
  );
  const exist = countikData(existBody);
  // NOTE: exist.verified is deliberately never read — it is
  // unreliable. Only analyze author.verified feeds the tick.
  const secUid = pickString(exist, ['sec_uid', 'secUid', 'sec_user_id']);
  if (!secUid) {
    throw new CountikError('Details unavailable for this creator.', {
      endpoint: 'exist',
      kind: 'shape',
    });
  }
  const analyzeBody = await fetchCountikJson(
    `/analyze/?sec_user_id=${encodeURIComponent(secUid)}&username=${encodeURIComponent(cleanHandle)}`,
    { fetchFn, endpoint: 'analyze', baseUrl: options.baseUrl, proxySecret: options.proxySecret, timeoutMs: options.timeoutMs, signal: options.signal },
  );
  const data = countikData(analyzeBody);
  if (!data) {
    throw new CountikError('Details unavailable for this creator.', {
      endpoint: 'analyze',
      kind: 'shape',
    });
  }
  const author = asRecord(data.author) ?? data;
  const rates = asRecord(data.engagement_rates) ?? asRecord(data.engagementRates);
  const performance = asRecord(data.performance);
  const enrichment: CreatorEnrichment = {
    bio: pickString(author, ['signature', 'bio', 'description']),
    hashtags: pickTagList(data.hashtags),
    mentions: pickTagList(data.mentions),
  };
  const followerCount = pickCountikNumber(author, [
    'follower_count',
    'followerCount',
    'followers',
  ]);
  if (followerCount !== undefined) {
    enrichment.followerCount = Math.trunc(followerCount);
  }
  const followingCount = pickCountikNumber(author, [
    'following_count',
    'followingCount',
    'following',
  ]);
  if (followingCount !== undefined) {
    enrichment.followingCount = Math.trunc(followingCount);
  }
  const heartsCount = pickCountikNumber(author, [
    'total_heart',
    'heart_count',
    'heartCount',
    'hearts',
  ]);
  if (heartsCount !== undefined) enrichment.heartsCount = Math.trunc(heartsCount);
  const videoCount = pickCountikNumber(author, [
    'video_count',
    'videoCount',
    'videos',
  ]);
  if (videoCount !== undefined) enrichment.videoCount = Math.trunc(videoCount);
  // The ONLY verified source: analyze author.verified, boolean only.
  if (typeof author.verified === 'boolean') {
    enrichment.verified = author.verified;
  }
  const engagementTotal = pickCountikNumber(rates, [
    'total',
    'total_rate',
    'engagement_rate',
  ]);
  if (engagementTotal !== undefined) enrichment.engagementTotal = engagementTotal;
  // Live analyze keys first: the *_rate / avg* forms are what the
  // upstream actually returns; the older variants stay as fallbacks.
  const engagementLikes = pickCountikNumber(rates, [
    'likes_rate',
    'likes',
    'like_rate',
  ]);
  if (engagementLikes !== undefined) enrichment.engagementLikes = engagementLikes;
  const engagementComments = pickCountikNumber(rates, [
    'comments_rate',
    'comments',
    'comment_rate',
  ]);
  if (engagementComments !== undefined) {
    enrichment.engagementComments = engagementComments;
  }
  const engagementShares = pickCountikNumber(rates, [
    'shares_rate',
    'shares',
    'share_rate',
  ]);
  if (engagementShares !== undefined) enrichment.engagementShares = engagementShares;
  const averageViews = pickCountikNumber(performance, [
    'avgViews',
    'average_views',
    'avg_views',
    'averageViews',
  ]);
  if (averageViews !== undefined) enrichment.averageViews = Math.trunc(averageViews);
  const averageLikes = pickCountikNumber(performance, [
    'avgLikes',
    'average_likes',
    'avg_likes',
    'averageLikes',
  ]);
  if (averageLikes !== undefined) enrichment.averageLikes = Math.trunc(averageLikes);
  const averageComments = pickCountikNumber(performance, [
    'avgComments',
    'average_comments',
    'avg_comments',
    'averageComments',
  ]);
  if (averageComments !== undefined) {
    enrichment.averageComments = Math.trunc(averageComments);
  }
  const averageShares = pickCountikNumber(performance, [
    'avgShares',
    'average_shares',
    'avg_shares',
    'averageShares',
  ]);
  if (averageShares !== undefined) enrichment.averageShares = Math.trunc(averageShares);
  return enrichment;
}

/**
 * Enrich every creator in a result list, in order — bounded (spec 169).
 * A search used to show NO cards until this resolved (wait-for-all with a
 * 30s leg timeout): one slow creator held a whole search for ~32s. Now each
 * leg times out after COUNTIK_ENRICH_LEG_TIMEOUT_MS and the whole call is
 * aborted at COUNTIK_ENRICH_BUDGET_MS, so wall time is ~budget however many
 * creators were given. Creators not finished inside the budget are marked
 * countikUnavailable, exactly like a per-creator failure — the caller shows
 * their basic card instead of waiting. Each creator's failure is isolated —
 * that creator alone is marked countikUnavailable and the rest keep their
 * enrichment. The original TikWM followerCount/verified stay on the creator,
 * so Similar fallback rendering works.
 */
export async function enrichCreators(
  creators: ReadonlyArray<Creator>,
  options: CountikCallOptions = {},
): Promise<Creator[]> {
  const results: Creator[] = new Array(creators.length);
  const budgetMs = options.budgetMs ?? COUNTIK_ENRICH_BUDGET_MS;
  const legTimeoutMs = options.timeoutMs ?? COUNTIK_ENRICH_LEG_TIMEOUT_MS;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), budgetMs);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= creators.length) return;
      const creator = creators[index] as Creator;
      if (controller.signal.aborted) {
        results[index] = { ...creator, countikUnavailable: true };
        continue;
      }
      try {
        const enrichment = await fetchCountikEnrichment(creator.handle, {
          ...options,
          timeoutMs: legTimeoutMs,
          signal: controller.signal,
        });
        results[index] = { ...creator, enrichment };
      } catch (err) {
        // Log the failure CLASS only — endpoint, kind, status.
        // Never a handle, username, or response body: this log is
        // the only way to tell a block from a timeout from a shape
        // change on the next total failure, and it must not leak
        // who was being looked up.
        if (err instanceof CountikError) {
          console.error('creator enrichment failed', {
            endpoint: err.endpoint ?? 'unknown',
            kind: err.kind,
            upstreamStatus: err.upstreamStatus ?? null,
          });
        } else {
          console.error('creator enrichment failed', {
            endpoint: 'unknown',
            kind: 'unknown',
            upstreamStatus: null,
          });
        }
        results[index] = { ...creator, countikUnavailable: true };
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(COUNTIK_ENRICH_CONCURRENCY, Math.max(1, creators.length)) },
    () => worker(),
  );
  try {
    await Promise.all(workers);
  } finally {
    clearTimeout(deadline);
  }
  return results;
}

/**
 * Countik video check — server-side only. Verified endpoints:
 * - POST https://countik.com/api/video/exist {"url": "<video url>"}
 * - GET https://countik.com/api/videoinfo/<video_id>
 * The download is videoinfo's direct download_link (a direct mp4
 * link), never a server proxy. Video checks are never saved.
 */
export const VideoCheckRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
});
export type VideoCheckRequest = z.infer<typeof VideoCheckRequestSchema>;

export const VideoInfoSchema = z.object({
  videoId: z.string().nullable(),
  coverUrl: z.string().nullable(),
  creatorHandle: z.string().nullable(),
  creatorName: z.string().nullable(),
  description: z.string().nullable(),
  /** ISO timestamp when the source gave a usable date, else null. */
  postedAt: z.string().nullable(),
  plays: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  saves: z.number().int().nonnegative().optional(),
  musicTitle: z.string().nullable(),
  musicArtist: z.string().nullable(),
  /** Direct mp4 link from videoinfo, or null when absent. */
  downloadUrl: z.string().nullable(),
});
export type VideoInfo = z.infer<typeof VideoInfoSchema>;

export const VideoCheckResponseSchema = z.object({
  url: z.string().min(1),
  video: VideoInfoSchema,
});
export type VideoCheckResponse = z.infer<typeof VideoCheckResponseSchema>;

/** Normalise a posted date: epoch seconds/millis → ISO, a
 *  parseable date string kept as-is, anything else → null. */
function pickPostedAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1e11 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? value.trim() : date.toISOString();
  }
  return null;
}

export async function checkCountikVideo(
  url: string,
  options: CountikCallOptions = {},
): Promise<VideoCheckResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanUrl = url.trim();
  if (!cleanUrl) {
    throw new CountikError('Enter a TikTok video link to check.');
  }
  const existBody = await fetchCountikJson(
    '/video/exist',
    { fetchFn, method: 'POST', body: { url: cleanUrl }, endpoint: 'video-exist', baseUrl: options.baseUrl, proxySecret: options.proxySecret },
  );
  const exist = countikData(existBody);
  const videoId = pickString(exist, ['video_id', 'videoId', 'aweme_id', 'id']);
  if (!videoId) {
    throw new CountikError(
      'That video could not be found. Try a different TikTok video link.',
    );
  }
  const infoBody = await fetchCountikJson(
    `/videoinfo/${encodeURIComponent(videoId)}`,
    { fetchFn, endpoint: 'videoinfo', baseUrl: options.baseUrl, proxySecret: options.proxySecret },
  );
  const data = countikData(infoBody);
  if (!data) {
    throw new CountikError(
      'That video could not be found. Try a different TikTok video link.',
    );
  }
  const author = asRecord(data.author) ?? asRecord(data.creator);
  const music = asRecord(data.music);
  const video: VideoInfo = {
    videoId,
    coverUrl: pickString(data, ['cover_url', 'coverUrl', 'cover']),
    creatorHandle: pickString(author, ['unique_id', 'uniqueId']),
    creatorName: pickString(author, ['nickname', 'name']),
    description: pickString(data, ['desc', 'description', 'title']),
    postedAt: pickPostedAt(data.create_time ?? data.createTime ?? data.posted_at),
    musicTitle: pickString(music, ['title', 'name']),
    musicArtist: pickString(music, ['author', 'artist']),
    downloadUrl: pickString(data, ['download_link', 'downloadUrl', 'download_url']),
  };
  const plays = pickCountikNumber(data, ['play_count', 'playCount', 'plays']);
  if (plays !== undefined) video.plays = Math.trunc(plays);
  const likes = pickCountikNumber(data, ['digg_count', 'like_count', 'likeCount', 'likes']);
  if (likes !== undefined) video.likes = Math.trunc(likes);
  const comments = pickCountikNumber(data, ['comment_count', 'commentCount', 'comments']);
  if (comments !== undefined) video.comments = Math.trunc(comments);
  const shares = pickCountikNumber(data, ['share_count', 'shareCount', 'shares']);
  if (shares !== undefined) video.shares = Math.trunc(shares);
  const saves = pickCountikNumber(data, [
    'collect_count',
    'save_count',
    'bookmark_count',
    'saves',
  ]);
  if (saves !== undefined) video.saves = Math.trunc(saves);
  return { url: cleanUrl, video };
}

/**
 * Countik hashtag generation — server-side only. Verified
 * endpoint: POST https://countik.com/api/generateHashtags
 * {"query": "<keyword>"} (POST-only; GET returns 405). The raw
 * JSON field names were not captured, so the result list is
 * extracted defensively from the common shapes (a bare array,
 * or hashtags/tags/data/result/suggestions) — never a claimed
 * field name. Generations are never saved.
 */
export const HashtagGenerateRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
});
export type HashtagGenerateRequest = z.infer<
  typeof HashtagGenerateRequestSchema
>;

export const HashtagGenerateResponseSchema = z.object({
  keyword: z.string().min(1),
  hashtags: z.array(z.string()),
});
export type HashtagGenerateResponse = z.infer<
  typeof HashtagGenerateResponseSchema
>;

export async function generateCountikHashtags(
  query: string,
  options: CountikCallOptions = {},
): Promise<HashtagGenerateResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new CountikError('Enter a keyword to generate hashtags.');
  }
  const body = await fetchCountikJson(
    '/generateHashtags',
    { fetchFn, method: 'POST', body: { query: cleanQuery }, endpoint: 'generateHashtags', baseUrl: options.baseUrl, proxySecret: options.proxySecret },
  );
  const root = asRecord(body);
  const data = countikData(body);
  const candidates: unknown[] = [
    body,
    root?.hashtags,
    root?.tags,
    data?.hashtags,
    data?.tags,
    data?.result,
    data?.suggestions,
    data,
  ];
  for (const candidate of candidates) {
    const tags = pickTagList(candidate);
    if (tags.length > 0) return { keyword: cleanQuery, hashtags: tags };
  }
  throw new CountikError(
    'No hashtags were generated for that keyword. Try a different keyword.',
  );
}

/**
 * Saved-creator database row (snake_case, as stored in
 * creator_finder_saved_creators). savedAt maps to updated_at: the
 * last time this creator was saved, which is also the "newest
 * first" ordering key for the Saved tab.
 */
export interface SavedCreatorRow {
  workspace_id: string;
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  follower_count: number | null;
  verified: boolean | null;
  /** Countik data as saved at search time; null fields = absent. */
  bio: string | null;
  countik_enriched: boolean;
  countik_follower_count: number | null;
  following_count: number | null;
  hearts_count: number | null;
  video_count: number | null;
  countik_verified: boolean | null;
  engagement_total: number | null;
  engagement_likes: number | null;
  engagement_comments: number | null;
  engagement_shares: number | null;
  average_views: number | null;
  average_likes: number | null;
  average_comments: number | null;
  average_shares: number | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  source: SavedCreatorSource;
  search_term: string;
  updated_at: string | null;
}

/** Map a database row to a SavedCreator, or null if unusable. */
export function savedCreatorFromRow(
  row: Record<string, unknown>,
): SavedCreator | null {
  const handle = asString(row.handle);
  const savedAt = asString(row.updated_at) ?? asString(row.created_at);
  const source = row.source;
  if (
    !handle ||
    !savedAt ||
    (source !== 'trending' && source !== 'niche' && source !== 'similar')
  ) {
    return null;
  }
  const searchTerm = asString(row.search_term);
  if (!searchTerm) return null;
  const creator: SavedCreator = {
    handle,
    displayName: asString(row.display_name),
    avatarUrl: asString(row.avatar_url),
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl:
      asString(row.profile_url) ?? `https://www.tiktok.com/@${handle}`,
    source,
    searchTerm,
    savedAt,
  };
  const followerCount = pickFollowerCount(row);
  if (followerCount !== undefined) creator.followerCount = followerCount;
  const verified = pickVerified(row);
  if (verified !== undefined) creator.verified = verified;
  // Countik enrichment, only when the row was saved enriched:
  // old rows (countik_enriched false/absent) keep enrichment
  // undefined, so the card renders them exactly as before —
  // stored follower/verified when present, else the no-data
  // variant. Nothing is backfilled or rewritten here.
  if (row.countik_enriched === true) {
    const enrichment: CreatorEnrichment = {
      bio: asString(row.bio),
      hashtags: pickTagList(row.hashtags),
      mentions: pickTagList(row.mentions),
    };
    const countikFollower = asNonnegativeInt(row.countik_follower_count);
    if (countikFollower !== undefined) enrichment.followerCount = countikFollower;
    const following = asNonnegativeInt(row.following_count);
    if (following !== undefined) enrichment.followingCount = following;
    const hearts = asNonnegativeInt(row.hearts_count);
    if (hearts !== undefined) enrichment.heartsCount = hearts;
    const videos = asNonnegativeInt(row.video_count);
    if (videos !== undefined) enrichment.videoCount = videos;
    if (typeof row.countik_verified === 'boolean') {
      enrichment.verified = row.countik_verified;
    }
    const rate = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
      }
      return undefined;
    };
    const engagementTotal = rate(row.engagement_total);
    if (engagementTotal !== undefined) enrichment.engagementTotal = engagementTotal;
    const engagementLikes = rate(row.engagement_likes);
    if (engagementLikes !== undefined) enrichment.engagementLikes = engagementLikes;
    const engagementComments = rate(row.engagement_comments);
    if (engagementComments !== undefined) {
      enrichment.engagementComments = engagementComments;
    }
    const engagementShares = rate(row.engagement_shares);
    if (engagementShares !== undefined) enrichment.engagementShares = engagementShares;
    const averageViews = asNonnegativeInt(row.average_views);
    if (averageViews !== undefined) enrichment.averageViews = averageViews;
    const averageLikes = asNonnegativeInt(row.average_likes);
    if (averageLikes !== undefined) enrichment.averageLikes = averageLikes;
    const averageComments = asNonnegativeInt(row.average_comments);
    if (averageComments !== undefined) enrichment.averageComments = averageComments;
    const averageShares = asNonnegativeInt(row.average_shares);
    if (averageShares !== undefined) enrichment.averageShares = averageShares;
    creator.enrichment = enrichment;
  }
  return creator;
}

/**
 * Build the database row for upserting one creator, merging with
 * an existing row so a later source that lacks follower_count or
 * verified never overwrites a value an earlier source supplied.
 * Only undefined fields are filled from the existing row; a
 * present value (including verified === false) is never replaced
 * by null. Display fields always come from the newest save.
 */
export function savedCreatorUpsertRow(
  workspaceId: string,
  userId: string,
  creator: Creator,
  source: SavedCreatorSource,
  searchTerm: string,
  existing: {
    followerCount?: number | undefined;
    verified?: boolean | undefined;
    enrichment?: CreatorEnrichment | null | undefined;
  } | null,
  savedAt: string,
): SavedCreatorRow {
  // Enrichment merge follows the existing rule: a fresh
  // enrichment replaces the stored one wholesale (never a mix
  // of two searches' numbers); a save without enrichment keeps
  // whatever was stored, so a later Countik failure never wipes
  // data saved earlier.
  const enrichment = creator.enrichment ?? existing?.enrichment ?? null;
  return {
    workspace_id: workspaceId,
    user_id: userId,
    handle: creator.handle,
    display_name: creator.displayName,
    avatar_url: creator.avatarUrl,
    profile_url: creator.profileUrl,
    follower_count: creator.followerCount ?? existing?.followerCount ?? null,
    verified: creator.verified ?? existing?.verified ?? null,
    bio: enrichment?.bio ?? null,
    countik_enriched: enrichment !== null,
    countik_follower_count: enrichment?.followerCount ?? null,
    following_count: enrichment?.followingCount ?? null,
    hearts_count: enrichment?.heartsCount ?? null,
    video_count: enrichment?.videoCount ?? null,
    countik_verified: enrichment?.verified ?? null,
    engagement_total: enrichment?.engagementTotal ?? null,
    engagement_likes: enrichment?.engagementLikes ?? null,
    engagement_comments: enrichment?.engagementComments ?? null,
    engagement_shares: enrichment?.engagementShares ?? null,
    average_views: enrichment?.averageViews ?? null,
    average_likes: enrichment?.averageLikes ?? null,
    average_comments: enrichment?.averageComments ?? null,
    average_shares: enrichment?.averageShares ?? null,
    hashtags: enrichment ? enrichment.hashtags : null,
    mentions: enrichment ? enrichment.mentions : null,
    source,
    search_term: searchTerm,
    updated_at: savedAt,
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Saved creators as CSV (RFC 4180 escaping: fields containing a
 * comma, quote, or newline are quoted, quotes doubled). Column
 * order is fixed: the original columns first, then the Countik
 * fields (bio, following/hearts/video counts, engagement rates,
 * averages, hashtags, mentions). Hashtags render as "#a #b" and
 * mentions as "@a @b" so the exported values are directly usable.
 * Old rows without enrichment export empty Countik columns.
 */
export function savedCreatorsToCsv(
  creators: ReadonlyArray<SavedCreator>,
): string {
  const header =
    'handle,display_name,avatar_url,profile_url,follower_count,verified,source,search_term,saved_at,bio,following_count,hearts_count,video_count,engagement_total,engagement_likes,engagement_comments,engagement_shares,average_views,average_likes,average_comments,average_shares,hashtags,mentions';
  const lines = creators.map((creator) => {
    const enrichment = creator.enrichment ?? null;
    return [
      creator.handle,
      creator.displayName ?? '',
      creator.avatarUrl ?? '',
      creator.profileUrl,
      creator.followerCount !== undefined
        ? String(creator.followerCount)
        : '',
      creator.verified !== undefined ? String(creator.verified) : '',
      creator.source,
      creator.searchTerm,
      creator.savedAt,
      enrichment?.bio ?? '',
      enrichment?.followingCount !== undefined
        ? String(enrichment.followingCount)
        : '',
      enrichment?.heartsCount !== undefined
        ? String(enrichment.heartsCount)
        : '',
      enrichment?.videoCount !== undefined
        ? String(enrichment.videoCount)
        : '',
      enrichment?.engagementTotal !== undefined
        ? String(enrichment.engagementTotal)
        : '',
      enrichment?.engagementLikes !== undefined
        ? String(enrichment.engagementLikes)
        : '',
      enrichment?.engagementComments !== undefined
        ? String(enrichment.engagementComments)
        : '',
      enrichment?.engagementShares !== undefined
        ? String(enrichment.engagementShares)
        : '',
      enrichment?.averageViews !== undefined
        ? String(enrichment.averageViews)
        : '',
      enrichment?.averageLikes !== undefined
        ? String(enrichment.averageLikes)
        : '',
      enrichment?.averageComments !== undefined
        ? String(enrichment.averageComments)
        : '',
      enrichment?.averageShares !== undefined
        ? String(enrichment.averageShares)
        : '',
      enrichment ? enrichment.hashtags.map((tag) => `#${tag}`).join(' ') : '',
      enrichment ? enrichment.mentions.map((tag) => `@${tag}`).join(' ') : '',
    ]
      .map(csvEscape)
      .join(',');
  });
  return [header, ...lines].join('\n') + '\n';
}

// Referenced so the permissive raw shapes stay part of the contract
// surface and are not dead code: they document the API's loose fields.
export const RawAuthorSchemaExport = RawAuthorSchema;
export const RawVideoSchemaExport = RawVideoSchema;
export const RawFollowingEntrySchemaExport = RawFollowingEntrySchema;
