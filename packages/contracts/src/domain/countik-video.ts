/**
 * Countik video resolve — mirror-side helper (server/worker only).
 *
 * Why this file exists instead of importing checkCountikVideo from
 * creator-finder.ts: creator-finder.ts imports TIKWMAPI_BASE_URL
 * from tikwmapi.ts, so tikwmapi.ts importing checkCountikVideo
 * would create a creator-finder <-> tikwmapi import cycle. This
 * module is self-contained (no imports from any other domain
 * module) and implements the same two verified Countik endpoints
 * Creator Finder uses, with the same field names:
 * - POST https://countik.com/api/video/exist {"url": "<video url>"}
 *   -> video id (video_id | videoId | aweme_id | id)
 * - GET https://countik.com/api/videoinfo/<video_id>
 *   -> download_link (download_link | downloadUrl | download_url)
 *   plus desc | description | title for the caption.
 *
 * Watermark status (verified live 2026-11-03, before this helper
 * shipped in a mirror path): for a real public reel
 * (@420doggface208/video/6876424179084709126), videoinfo
 * returned download_link
 * https://v16.tokcdn.com/.../6876424179084709126_original.mp4 —
 * a playable 576x1024 h264 mp4 — and frames sampled at 2s, 8s,
 * 14s and 20s of the 22.9s clip showed no TikTok logo or username
 * overlay. The link is the original file, not a watermarked
 * download. That is one-video evidence, not a guarantee for every
 * video: if Countik ever returns a visibly watermarked file for
 * a mirror, that is a new provider behaviour to investigate, not
 * something this helper can detect from the response shape (the
 * response carries no watermark field).
 *
 * No key, no cookie. Provider reasons are never passed through:
 * a Countik failure throws CountikVideoError with a generic
 * message, so no provider wording can leak into a user-facing
 * error via this helper.
 */

export const COUNTIK_VIDEO_BASE_URL = 'https://countik.com/api';
const COUNTIK_VIDEO_TIMEOUT_MS = 30_000;

export class CountikVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountikVideoError';
  }
}

type CountikVideoFetchFn = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

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

/** Unwrap a Countik body: {data: {...}} or the flat object itself. */
function countikData(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  return asRecord(root.data) ?? root;
}

async function fetchCountikVideoJson(
  url: string,
  options: {
    fetchFn: CountikVideoFetchFn;
    method?: 'GET' | 'POST';
    body?: unknown;
  },
): Promise<unknown> {
  let res: Response;
  try {
    res = await options.fetchFn(url, {
      signal: AbortSignal.timeout(COUNTIK_VIDEO_TIMEOUT_MS),
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
  } catch {
    throw new CountikVideoError('Countik could not be reached.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new CountikVideoError('Countik could not complete this request.');
  }
  return body;
}

/**
 * Resolve one known TikTok video via Countik to its direct mp4
 * link + description. A result with no download_link is a
 * failure (CountikVideoError), never a postable result. An empty
 * description is acceptable — mirror callers fall back to the
 * feed title when the resolved title is empty.
 */
export async function resolveCountikVideo(
  videoUrl: string,
  options: { fetchFn?: CountikVideoFetchFn } = {},
): Promise<{ playUrl: string; title: string }> {
  const fetchFn = options.fetchFn ?? fetch;
  const cleanUrl = videoUrl.trim();
  if (!cleanUrl) {
    throw new CountikVideoError('No video link was given.');
  }
  const existBody = await fetchCountikVideoJson(
    `${COUNTIK_VIDEO_BASE_URL}/video/exist`,
    { fetchFn, method: 'POST', body: { url: cleanUrl } },
  );
  const videoId = pickString(countikData(existBody), [
    'video_id',
    'videoId',
    'aweme_id',
    'id',
  ]);
  if (!videoId) {
    throw new CountikVideoError('Countik could not find that video.');
  }
  const infoBody = await fetchCountikVideoJson(
    `${COUNTIK_VIDEO_BASE_URL}/videoinfo/${encodeURIComponent(videoId)}`,
    { fetchFn },
  );
  const data = countikData(infoBody);
  const playUrl = pickString(data, [
    'download_link',
    'downloadUrl',
    'download_url',
  ]);
  if (!playUrl) {
    throw new CountikVideoError('Countik returned no playable link.');
  }
  return {
    playUrl,
    title: pickString(data, ['desc', 'description', 'title']) ?? '',
  };
}
