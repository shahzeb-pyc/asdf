// YouTube Data API v3 discovery for ADU (spec 154).
//
// Replaces the logged-in Puppeteer browser for YouTube only: the API
// lists a channel's uploads, a duration check keeps Shorts only, and
// the IDs flow into adu_reels exactly like browser discovery did.
// No browser, no login, no search.list (its 100-call/day bucket is
// wasteful; handles resolve through channels.list for 1 unit).
//
// This module is dependency-free (node builtins + global fetch only)
// so the standalone CI scraper test step can import it without npm
// install. It never touches the database directly: the caller owns the
// channel-ID cache write through onChannelResolved and the adu_reels
// upsert, and the quota-park requeue takes the caller-supplied client
// so it stays testable with a stub. The API key value is never logged.

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_API_TIMEOUT_MS = 30_000;
export const YOUTUBE_API_PAGE_SIZE = 50;

// YouTube's Shorts rule (YouTube Help, verified 2026-11-09): a Short is
// a square or vertical video of at most 3 minutes, uploaded on or after
// 15 October 2024. Before that date the cap was 60 seconds. The Data
// API cannot see aspect ratio, so the rule below enforces duration and
// date only; a short horizontal clip can slip through. Recall wins over
// precision: a missed real Short never publishes, while a slipped-in
// clip still downloads and publishes.
export const YOUTUBE_SHORTS_CUTOFF_DATE = '2024-10-15T00:00:00Z';
export const YOUTUBE_SHORTS_MAX_SECONDS = 180;
export const YOUTUBE_SHORTS_LEGACY_MAX_SECONDS = 60;

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

const ZERO_WIDTH = /[\u200b-\u200d\u200e\u200f\u202a-\u202e\ufeff]/g;

export function cleanYoutubeHandle(value) {
  return String(value || '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s/g, '')
    .replace(/^@+/, '')
    .trim();
}

/** Parse an ISO 8601 duration (PT1M30S, P1DT2H) to whole seconds, or null. */
export function parseIso8601DurationToSeconds(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    String(value || '').trim(),
  );
  if (!match) {
    return null;
  }
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) {
    return null;
  }
  return Math.floor(days * 86400 + hours * 3600 + minutes * 60 + seconds);
}

/**
 * Whether a video counts as a Short for ADU: at most 60 seconds at any
 * date, or at most 180 seconds when published on or after 15 Oct 2024.
 */
export function isYoutubeShort(durationIso, publishedAt) {
  const seconds = parseIso8601DurationToSeconds(durationIso);
  if (seconds === null || seconds <= 0) {
    return false;
  }
  if (seconds <= YOUTUBE_SHORTS_LEGACY_MAX_SECONDS) {
    return true;
  }
  if (seconds > YOUTUBE_SHORTS_MAX_SECONDS) {
    return false;
  }
  const publishedMs = Date.parse(String(publishedAt || ''));
  if (!Number.isFinite(publishedMs)) {
    return false;
  }
  return publishedMs >= Date.parse(YOUTUBE_SHORTS_CUTOFF_DATE);
}

/** The uploads playlist ID for a channel ID (UU + channel ID without UC). */
export function uploadsPlaylistIdForChannel(channelId) {
  const id = String(channelId || '').trim();
  if (!id.startsWith('UC') || id.length < 3) {
    return null;
  }
  return `UU${id.slice(2)}`;
}

// --- YouTube quota auto-retry (spec 156) ---
//
// The Data API quota resets at midnight Pacific Time. A quota error
// parks the source until that reset instead of leaving it in 'error'
// forever; the daemon re-queues parked rows whose retry time passed.
// Pacific observes daylight saving, so the reset is computed with a
// real timezone conversion, never a fixed UTC offset.

export const YOUTUBE_QUOTA_RESET_TIME_ZONE = 'America/Los_Angeles';

/** Offset of a timezone ahead of UTC, in ms, at one instant. */
function timeZoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  );
  return asUtc - date.getTime();
}

/**
 * The UTC instant of a wall-clock midnight in Pacific. Midnight never
 * falls inside a DST transition (they happen at 02:00 local), so two
 * offset corrections converge exactly.
 */
function pacificMidnightUtc(year, month, day) {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    guess =
      Date.UTC(year, month - 1, day, 0, 0, 0) -
      timeZoneOffsetMs(YOUTUBE_QUOTA_RESET_TIME_ZONE, new Date(guess));
  }
  return new Date(guess);
}

/**
 * The next YouTube quota reset after `from`: the next midnight Pacific
 * Time. At midnight exactly the next reset is 24h later, never "now".
 */
export function nextYoutubeQuotaResetAt(from = new Date()) {
  const fromDate = from instanceof Date ? from : new Date(from);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: YOUTUBE_QUOTA_RESET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(fromDate);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // Date.UTC rolls day/month/year over, so day + 1 is the next
  // calendar day in Pacific even across month and year ends.
  const nextDay = new Date(
    Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day) + 1, 0, 0, 0),
  );
  return pacificMidnightUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
  );
}

/**
 * The retry instant for a discovery failure: the next midnight Pacific
 * when the failure is a quota error, null otherwise (non-quota errors
 * stay a plain 'error' and are never parked).
 */
export function quotaParkRetryAt(isQuotaError, now = new Date()) {
  if (!isQuotaError) {
    return null;
  }
  return nextYoutubeQuotaResetAt(now).toISOString();
}

/**
 * Re-queue quota-parked YouTube sources whose retry time has passed:
 * one conditional update, back to 'pending' with the retry time
 * cleared (it is meaningful only while parked). Returns how many rows
 * were re-queued. Throws on a database error — the caller logs it
 * loudly and retries next iteration; it never silently skips.
 */
export async function requeueDueQuotaParkedConfigs(client, now = new Date()) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const { data, error } = await client
    .from('adu_configs')
    .update({ sync_status: 'pending', quota_retry_at: null })
    .eq('sync_status', 'quota_parked')
    .lte('quota_retry_at', nowIso)
    .select('id');
  if (error) {
    throw error;
  }
  return data?.length ?? 0;
}

function getYoutubeApiKey(options) {
  const key = String(options?.apiKey ?? process.env.YOUTUBE_DATA_API_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'YOUTUBE_DATA_API_KEY is not set. Add the YouTube Data API v3 key to the scraper environment (Doppler prd) — discovery cannot run without it.',
    );
  }
  return key;
}

function redactApiKey(text, apiKey) {
  const out = String(text ?? '');
  if (!apiKey) {
    return out;
  }
  return out.split(apiKey).join('[key]');
}

export class YoutubeApiError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'YoutubeApiError';
    this.status = status;
    this.reason = reason;
    this.quotaExceeded = status === 403 && QUOTA_REASONS.has(reason);
  }
}

async function youtubeApiGet(path, searchParams, { apiKey, fetchFn }) {
  const url = new URL(`${YOUTUBE_API_BASE}${path}`);
  for (const [name, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, value);
    }
  }
  url.searchParams.set('key', apiKey);
  const fetchImpl = fetchFn ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new YoutubeApiError(0, 'network_error', `YouTube Data API ${path} failed: ${redactApiKey(message, apiKey)}`);
  }
  if (!response.ok) {
    let reason = `http_${response.status}`;
    try {
      const bodyText = await response.text();
      const body = JSON.parse(bodyText.slice(0, 2000));
      const firstError = body?.error?.errors?.[0];
      if (firstError?.reason) {
        reason = firstError.reason;
      }
    } catch (_) {
      // Unparseable error body: keep the HTTP status as the reason.
    }
    throw new YoutubeApiError(
      response.status,
      reason,
      `YouTube Data API ${path} failed with HTTP ${response.status} (${reason})`,
    );
  }
  return response.json();
}

/**
 * Resolve a handle to its channel ID and uploads playlist ID (1 unit).
 * Never throws for API failures; returns { ok: false, reason } instead.
 */
export async function resolveYoutubeChannel(handle, deps = {}) {
  const cleanHandle = cleanYoutubeHandle(handle);
  if (!cleanHandle) {
    return { ok: false, reason: 'invalid_source_username' };
  }
  const apiKey = getYoutubeApiKey(deps);
  let data;
  try {
    data = await youtubeApiGet(
      '/channels',
      { part: 'snippet,contentDetails', forHandle: cleanHandle },
      { apiKey, fetchFn: deps.fetchFn },
    );
  } catch (err) {
    if (err instanceof YoutubeApiError) {
      return { ok: false, reason: err.reason, quotaExceeded: err.quotaExceeded };
    }
    throw err;
  }
  const item = data?.items?.[0];
  if (!item?.id) {
    return { ok: false, reason: 'channel_not_found' };
  }
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    return { ok: false, reason: 'no_uploads_playlist' };
  }
  return { ok: true, channelId: item.id, uploadsPlaylistId };
}

async function listPlaylistPage(uploadsPlaylistId, pageToken, { apiKey, fetchFn }) {
  const data = await youtubeApiGet(
    '/playlistItems',
    {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: String(YOUTUBE_API_PAGE_SIZE),
      pageToken: pageToken || undefined,
    },
    { apiKey, fetchFn },
  );
  const items = (data?.items || []).map((entry) => ({
    videoId: entry?.snippet?.resourceId?.videoId,
    publishedAt: entry?.snippet?.publishedAt,
  })).filter((entry) => entry.videoId);
  return { items, nextPageToken: data?.nextPageToken || null };
}

async function fetchVideoDurations(videoIds, { apiKey, fetchFn }) {
  const data = await youtubeApiGet(
    '/videos',
    { part: 'contentDetails', id: videoIds.join(','), maxResults: String(YOUTUBE_API_PAGE_SIZE) },
    { apiKey, fetchFn },
  );
  const durations = new Map();
  for (const item of data?.items || []) {
    if (item?.id) {
      durations.set(item.id, item?.contentDetails?.duration || null);
    }
  }
  return durations;
}

/**
 * Discover Shorts for one YouTube source, newest first.
 *
 * @param {object} args
 * @param {string} args.sourceUsername - handle, with or without @.
 * @param {string|null} [args.cachedChannelId] - channel ID from a
 *   previous discovery; when set, no channels.list resolve is made.
 * @param {number} [args.maxCount=1000] - cap on Shorts collected.
 * @param {string} [args.apiKey] - overrides YOUTUBE_DATA_API_KEY.
 * @param {Function} [args.fetchFn] - injected fetch, for tests.
 * @param {Function} [args.onChannelResolved] - called with the channel
 *   ID after a fresh resolve so the caller can persist the cache. A
 *   throw here aborts discovery (the cache write must not fail
 *   silently).
 * @returns {Promise<{ ok: true, ids: string[], channelId: string,
 *   resolvedFromCache: boolean, quotaUnits: number } |
 *   { ok: false, reason: string, quotaExceeded?: boolean }>}
 *   Never throws for API failures; throws only when the key is missing
 *   or the cache callback throws.
 */
export async function discoverYoutubeShorts({
  sourceUsername,
  cachedChannelId = null,
  maxCount = 1000,
  apiKey: apiKeyOverride,
  fetchFn,
  onChannelResolved,
} = {}) {
  const apiKey = getYoutubeApiKey({ apiKey: apiKeyOverride });
  const cleanHandle = cleanYoutubeHandle(sourceUsername);
  if (!cleanHandle) {
    return { ok: false, reason: 'invalid_source_username' };
  }
  const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : 1000;
  const deps = { apiKey, fetchFn };
  let quotaUnits = 0;
  let channelId = null;
  let uploadsPlaylistId = null;
  let resolvedFromCache = false;

  if (cachedChannelId) {
    uploadsPlaylistId = uploadsPlaylistIdForChannel(cachedChannelId);
    if (uploadsPlaylistId) {
      channelId = String(cachedChannelId).trim();
      resolvedFromCache = true;
    }
    // A malformed cached ID falls through to a fresh resolve, which
    // re-caches the real channel ID through onChannelResolved.
  }

  if (!channelId) {
    let resolved;
    try {
      resolved = await resolveYoutubeChannel(cleanHandle, deps);
    } catch (err) {
      if (err instanceof YoutubeApiError) {
        return { ok: false, reason: err.reason, quotaExceeded: err.quotaExceeded };
      }
      throw err;
    }
    quotaUnits += 1;
    if (!resolved.ok) {
      return resolved;
    }
    channelId = resolved.channelId;
    uploadsPlaylistId = resolved.uploadsPlaylistId;
    if (onChannelResolved) {
      await onChannelResolved(channelId);
    }
  }

  const ids = [];
  const seen = new Set();
  let pageToken = null;
  try {
    for (;;) {
      const page = await listPlaylistPage(uploadsPlaylistId, pageToken, deps);
      quotaUnits += 1;
      if (page.items.length > 0) {
        const durations = await fetchVideoDurations(
          page.items.map((entry) => entry.videoId),
          deps,
        );
        quotaUnits += 1;
        for (const entry of page.items) {
          if (ids.length >= cap) {
            break;
          }
          if (!seen.has(entry.videoId) && isYoutubeShort(durations.get(entry.videoId), entry.publishedAt)) {
            seen.add(entry.videoId);
            ids.push(entry.videoId);
          }
        }
      }
      if (ids.length >= cap || !page.nextPageToken) {
        break;
      }
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    if (err instanceof YoutubeApiError) {
      return { ok: false, reason: err.reason, quotaExceeded: err.quotaExceeded };
    }
    throw err;
  }
  return { ok: true, ids, channelId, resolvedFromCache, quotaUnits };
}
