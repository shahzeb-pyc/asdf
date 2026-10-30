import { z } from 'zod';

/**
 * Creator Finder — TikTok creator discovery via the paid tikwmapi
 * service (https://api.tikwmapi.com), server-side only.
 *
 * Verified endpoints (docs, Trending API group + user/challenge):
 * - GET /region — no params, 242 region codes to names.
 * - GET /feed/list — region required, count optional, max 20.
 * - GET /user/info — unique_id or user_id.
 * - GET /user/following — user_id required, count optional, max 200.
 * - GET /challenge/info — challenge_id or challenge_name.
 * - GET /challenge/posts — challenge_id required, count optional, max 30.
 * Every call sends `x-tikwmapi-key` and returns {code, msg, data}.
 * Codes: 0 success, 10401 invalid/missing key, 10429 rate limit,
 * 10430 quota exhausted. There is no fallback to the free tikwm
 * service or any other source: a failed call fails loud.
 *
 * Creator fields are only what the API returns. Follower counts,
 * bios, and other fields are deliberately not in the schema: a
 * field that is not returned is omitted, never fabricated.
 */

export const TIKWMAPI_BASE_URL = 'https://api.tikwmapi.com';
export const TRENDING_COUNT_MAX = 20;
export const CHALLENGE_COUNT_MAX = 30;
export const FOLLOWING_COUNT_MAX = 200;
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

export const CreatorSchema = z.object({
  handle: z.string().min(1),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  latestVideoTitle: z.string().nullable(),
  latestVideoCover: z.string().nullable(),
  profileUrl: z.string().url(),
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

export const CreatorListResponseSchema = z.object({
  creators: z.array(CreatorSchema),
  videosSeen: z.number().int().nonnegative(),
});
export type CreatorListResponse = z.infer<typeof CreatorListResponseSchema>;

export const TrendingResponseSchema = CreatorListResponseSchema.extend({
  region: z.string().min(1),
});
export type TrendingResponse = z.infer<typeof TrendingResponseSchema>;

export const NicheResponseSchema = CreatorListResponseSchema.extend({
  hashtag: z.string().min(1),
  word: z.string().nullable(),
});
export type NicheResponse = z.infer<typeof NicheResponseSchema>;

export const SimilarResponseSchema = CreatorListResponseSchema.extend({
  username: z.string().min(1),
  displayName: z.string().nullable(),
});
export type SimilarResponse = z.infer<typeof SimilarResponseSchema>;

const NullableString = z.string().nullable().optional();

const RawAuthorSchema = z
  .object({
    unique_id: NullableString,
    nickname: NullableString,
    avatar: NullableString,
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

function creatorFromAuthor(
  author: Record<string, unknown> | null,
  video: Record<string, unknown> | null,
): Creator | null {
  const handle =
    asString(author?.unique_id) ??
    asString(video?.author_unique_id) ??
    asString(video?.unique_id);
  if (!handle) return null;
  const displayName = asString(author?.nickname) ?? asString(video?.nickname);
  const avatarUrl = asString(author?.avatar) ?? asString(video?.avatar);
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
  return {
    handle,
    displayName: asString(entry.nickname),
    avatarUrl: asString(entry.avatar),
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: `https://www.tiktok.com/@${handle}`,
  };
}

type FetchFn = typeof fetch;

async function fetchTikwmJson(
  path: string,
  key: string,
  fetchFn: FetchFn,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${TIKWMAPI_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'x-tikwmapi-key': key },
    });
  } catch {
    throw new CreatorFinderError(
      'UNREACHABLE',
      'Could not reach the TikTok creator service. Please try again.',
    );
  }
  if (!res.ok) {
    throw new CreatorFinderError(
      'HTTP_ERROR',
      `TikTok creator service returned HTTP ${res.status}. Please try again.`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'TikTok creator service returned an unreadable response.',
    );
  }
}

function codeToError(code: number, msg: string | undefined): CreatorFinderError {
  if (code === 10401) {
    return new CreatorFinderError(
      'KEY_INVALID',
      'The TikTok creator API key is invalid. Check the configured key and try again.',
    );
  }
  if (code === 10429) {
    return new CreatorFinderError(
      'RATE_LIMITED',
      'TikTok creator service is rate-limited right now. Please try again shortly.',
    );
  }
  if (code === 10430) {
    return new CreatorFinderError(
      'QUOTA_EXHAUSTED',
      'The TikTok creator quota for this period is exhausted.',
    );
  }
  const detail = msg?.trim();
  return new CreatorFinderError(
    'FEED_UNAVAILABLE',
    detail
      ? `TikTok creator service could not complete this search: ${detail}`
      : 'TikTok creator service could not complete this search.',
  );
}

function unwrapData(body: unknown): Record<string, unknown> {
  const root = asRecord(body);
  if (!root) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'TikTok creator service returned an unexpected response.',
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
      'TikTok creator service returned an unexpected response.',
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
      'No TikTok creator API key is configured. Set TIKWMAPI_KEYS (or TIKWMAPI_KEY) in the environment.',
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
    'TikTok creator service could not complete this search.',
  );
}

export interface CreatorFinderCallOptions {
  fetchFn?: FetchFn | undefined;
  apiKeys?: string[] | undefined;
}

export async function fetchRegionList(
  options: CreatorFinderCallOptions = {},
): Promise<RegionListResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson('/region', key, fetchFn);
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
      'TikTok creator service returned an empty region list.',
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
  const cleanRegion = region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cleanRegion)) {
    throw new CreatorFinderError('BAD_RESPONSE', 'Pick a country from the list.');
  }
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/feed/list?region=${encodeURIComponent(cleanRegion)}&count=${TRENDING_COUNT_MAX}`,
      key,
      fetchFn,
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

export async function fetchCreatorsByHashtag(
  hashtag: string,
  word: string | null,
  options: CreatorFinderCallOptions = {},
): Promise<NicheResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanTag = hashtag.trim().replace(/^#+/, '').toLowerCase();
  if (cleanTag.length === 0) {
    throw new CreatorFinderError('BAD_RESPONSE', 'Enter a hashtag or word to search.');
  }
  const cleanWord = word?.trim().toLowerCase() || null;
  const challengeId = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/challenge/info?challenge_name=${encodeURIComponent(cleanTag)}`,
      key,
      fetchFn,
    );
    const data = unwrapData(body);
    const id = challengeIdFromData(data);
    if (!id) {
      throw new CreatorFinderError(
        'NOT_FOUND',
        `No hashtag was found for "${cleanTag}". Check the spelling and try again.`,
      );
    }
    return id;
  });
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/challenge/posts?challenge_id=${encodeURIComponent(challengeId)}&count=${CHALLENGE_COUNT_MAX}`,
      key,
      fetchFn,
    );
    return unwrapData(body);
  });
  let videos = videosFromData(data);
  if (cleanWord) {
    videos = videos.filter((video) => {
      const text = `${asString(video.title) ?? ''} ${asString(video.content_desc) ?? ''}`.toLowerCase();
      return text.includes(cleanWord);
    });
  }
  const creators = dedupeCreators(videos);
  if (videos.length > 0 && creators.length === 0) {
    throw new CreatorFinderError(
      'BAD_RESPONSE',
      'Hashtag videos came back without creator details, so no creator list can be shown.',
    );
  }
  return { hashtag: cleanTag, word: cleanWord, creators, videosSeen: videos.length };
}

export async function fetchSimilarCreators(
  username: string,
  options: CreatorFinderCallOptions = {},
): Promise<SimilarResponse> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanName = username.trim().replace(/^@+/, '').toLowerCase();
  if (cleanName.length === 0) {
    throw new CreatorFinderError('BAD_RESPONSE', 'Enter a TikTok username.');
  }
  const profile = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/user/info?unique_id=${encodeURIComponent(cleanName)}`,
      key,
      fetchFn,
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
      handle: asString(user.unique_id) ?? cleanName,
    };
  });
  const data = await callWithKeys(options.apiKeys ?? [], async (key) => {
    const body = await fetchTikwmJson(
      `/user/following?user_id=${encodeURIComponent(profile.numericId)}&count=${FOLLOWING_COUNT_MAX}`,
      key,
      fetchFn,
    );
    return unwrapData(body);
  });
  const entries: Record<string, unknown>[] = [];
  for (const key of ['followings', 'following', 'users', 'followers']) {
    const parsed = asStringArray(data[key])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    if (parsed.length > 0) {
      entries.push(...parsed);
      break;
    }
  }
  const creators = entries
    .map((entry) => creatorFromFollowingEntry(entry))
    .filter((creator): creator is Creator => creator !== null);
  return {
    username: profile.handle,
    displayName: profile.displayName,
    creators,
    videosSeen: 0,
  };
}

// Referenced so the permissive raw shapes stay part of the contract
// surface and are not dead code: they document the API's loose fields.
export const RawAuthorSchemaExport = RawAuthorSchema;
export const RawVideoSchemaExport = RawVideoSchema;
export const RawFollowingEntrySchemaExport = RawFollowingEntrySchema;
