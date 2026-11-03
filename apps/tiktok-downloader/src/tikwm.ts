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

export type TikwmResolveFailure =
  | { reason: 'tikwm_api_timeout' }
  | { reason: 'tikwm_api_fetch_error'; detail: string }
  | { reason: 'tikwm_api_http_status'; status: number }
  | { reason: 'tikwm_api_body_unparsable' }
  | { reason: 'tikwm_api_bad_body' }
  | { reason: 'tikwm_api_body_code'; code: string }
  | { reason: 'tikwm_api_no_data' }
  | { reason: 'tikwm_no_stream_url' };

export type TikwmResolveResult =
  | { ok: true; streamUrl: string; rawTitle: string | null }
  | { ok: false; failure: TikwmResolveFailure };

export type StreamOpenFailure =
  | { reason: 'stream_fetch_error'; detail: string }
  | { reason: 'stream_http_status'; status: number }
  | { reason: 'stream_no_body' };

export type StreamOpenResult =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; failure: StreamOpenFailure };

function isTimeout(err: unknown): boolean {
  // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
  return err instanceof Error && err.name === 'TimeoutError';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a TikTok video URL to its HD stream URL via the tikwm API.
 * Returns a discriminated result instead of null: every failure carries
 * its exact reason, so the caller can persist it. Success semantics are
 * unchanged (non-200, unparsable body, code != 0, missing data, or no
 * stream URL all fail — exactly like the old code's None).
 */
export async function resolveTikwmStream(
  videoUrl: string,
  // Workerd brand-check: arrow wrapper, never bare `fetch` (see supabase.ts).
  fetchImpl: FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
): Promise<TikwmResolveResult> {
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
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, failure: { reason: 'tikwm_api_timeout' } };
    }
    return { ok: false, failure: { reason: 'tikwm_api_fetch_error', detail: errorDetail(err) } };
  }
  // The old code required status_code == 200 exactly.
  if (res.status !== 200) {
    return { ok: false, failure: { reason: 'tikwm_api_http_status', status: res.status } };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, failure: { reason: 'tikwm_api_body_unparsable' } };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, failure: { reason: 'tikwm_api_bad_body' } };
  }
  const { code, data } = body as { code?: unknown; data?: unknown };
  if (code !== 0) {
    return {
      ok: false,
      failure: {
        reason: 'tikwm_api_body_code',
        code: typeof code === 'number' || typeof code === 'string' ? String(code) : 'missing',
      },
    };
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, failure: { reason: 'tikwm_api_no_data' } };
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
    return { ok: false, failure: { reason: 'tikwm_no_stream_url' } };
  }
  return {
    ok: true,
    streamUrl: streamUrl.startsWith('/') ? `${TIKWM_ORIGIN}${streamUrl.slice(1)}` : streamUrl,
    rawTitle: typeof title === 'string' ? title : null,
  };
}

/**
 * Open the video stream GET with the old code's headers. Returns a
 * discriminated result: null body or non-200 fails, as before (the old
 * code's raise_for_status), but now with the exact reason attached.
 * The Referer is tikwm's origin for tikwm-resolved streams; a
 * Countik-resolved stream (a direct CDN link) sends no Referer —
 * passing null omits the header instead of misattributing the fetch.
 */
export async function openVideoStream(
  streamUrl: string,
  // Workerd brand-check: arrow wrapper, never bare `fetch` (see supabase.ts).
  fetchImpl: FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  referer: string | null = TIKWM_ORIGIN,
): Promise<StreamOpenResult> {
  let res: Response;
  try {
    res = await fetchImpl(streamUrl, {
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, failure: { reason: 'stream_fetch_error', detail: errorDetail(err) } };
  }
  if (res.status !== 200) {
    return { ok: false, failure: { reason: 'stream_http_status', status: res.status } };
  }
  if (!res.body) {
    return { ok: false, failure: { reason: 'stream_no_body' } };
  }
  return { ok: true, body: res.body };
}
