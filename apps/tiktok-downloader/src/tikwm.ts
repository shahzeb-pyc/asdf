/**
 * TikWM HD stream resolution, ported from the old downloader's
 * `download_tiktok_hd_stream` — minus the yt-dlp fallback, which cannot
 * exist in a Worker. Every failure returns null and the caller follows
 * the existing failed path; nothing here ever falls back silently.
 */

export const TIKWM_API_URL = 'https://www.tikwm.com/api/';
export const TIKWM_ORIGIN = 'https://www.tikwm.com/';
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** Old code: httpx client timeout 25 s, applied to the API call. */
export const TIKWM_API_TIMEOUT_MS = 25_000;
/** Per-chunk inactivity budget for the video stream (codebase socket-timeout idiom). */
export const STREAM_CHUNK_TIMEOUT_MS = 30_000;
/** Old code: a downloaded file must be larger than 10,000 bytes. */
export const MIN_FILE_BYTES = 10_000;
/** VPS downloader default DOWNLOAD_MAX_BYTES: 1 GiB cap. */
export const MAX_FILE_BYTES = 1_073_741_824;
/** Probe window: the old binary fallback read the first 4 MB. */
export const PROBE_WINDOW_BYTES = 4 * 1024 * 1024;

export interface TikwmStream {
  streamUrl: string;
  /** Raw title from the API, or null when absent. */
  rawTitle: string | null;
}

export type FetchImpl = typeof fetch;

/**
 * Resolve a TikTok video URL to its HD stream URL via the tikwm API.
 * Returns null on ANY failure: non-200, unparsable body, code != 0,
 * missing data, or no stream URL — exactly like the old code's None.
 */
export async function resolveTikwmStream(
  videoUrl: string,
  // Workerd brand-check: arrow wrapper, never bare `fetch` (see supabase.ts).
  fetchImpl: FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
): Promise<TikwmStream | null> {
  let res: Response;
  try {
    res = await fetchImpl(TIKWM_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // httpx `data={...}` sends form-encoded fields; hd=1 requests HD.
      body: new URLSearchParams({ url: videoUrl, hd: '1' }),
      signal: AbortSignal.timeout(TIKWM_API_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  // The old code required status_code == 200 exactly.
  if (res.status !== 200) {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { code, data } = body as { code?: unknown; data?: unknown };
  if (code !== 0 || typeof data !== 'object' || data === null) {
    return null;
  }
  const { hdplay, play, title } = data as {
    hdplay?: unknown;
    play?: unknown;
    title?: unknown;
  };
  // Prefer uncompressed 1080p hdplay, then play.
  const streamUrl = typeof hdplay === 'string' && hdplay
    ? hdplay
    : typeof play === 'string' && play
      ? play
      : null;
  if (!streamUrl) {
    return null;
  }
  return {
    streamUrl: streamUrl.startsWith('/') ? `${TIKWM_ORIGIN}${streamUrl.slice(1)}` : streamUrl,
    rawTitle: typeof title === 'string' ? title : null,
  };
}

/**
 * Open the video stream GET with the old code's headers. Returns null
 * unless the response is HTTP 200 (the old code's raise_for_status).
 */
export async function openVideoStream(
  streamUrl: string,
  // Workerd brand-check: arrow wrapper, never bare `fetch` (see supabase.ts).
  fetchImpl: FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
): Promise<ReadableStream<Uint8Array> | null> {
  let res: Response;
  try {
    res = await fetchImpl(streamUrl, {
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        Referer: TIKWM_ORIGIN,
      },
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  if (res.status !== 200 || !res.body) {
    return null;
  }
  return res.body;
}
