/**
 * Countik video resolution, ported from the repo-proven helper in
 * `packages/contracts/src/domain/countik-video.ts` (the mirror path's
 * Countik fallback, PR #150) — adapted to this Worker's conventions
 * (discriminated failures, arrow-wrapper fetch, tikwm's timeout).
 *
 * Two calls, exactly as the helper does them:
 * - POST https://countik.com/api/video/exist {"url": "<video url>"}
 *   -> video id (video_id | videoId | aweme_id | id)
 * - GET https://countik.com/api/videoinfo/<video_id>
 *   -> download_link (download_link | downloadUrl | download_url)
 *   plus desc | description | title for the caption.
 *
 * No key, no cookie, no secret: Countik needs none, and this Worker
 * calls it DIRECTLY. Do NOT route through the secuid Worker's /proxy:
 * that route exists for the app backend's datacenter egress (suspected
 * Countik block), is gated by a shared secret another chat owns, and
 * would couple this Worker to another Worker's deployment. Direct
 * Countik from Cloudflare egress is already proven by the secuid
 * Worker's own exist lookups, which run direct from the same egress.
 *
 * Watermark status (repo evidence, one-video check 2026-11-03): the
 * link is the original upload file, not a watermarked download.
 * The response carries no watermark field, so nothing here can (or
 * tries to) detect one.
 */

import { DESKTOP_CHROME_UA, type FetchImpl } from './tikwm.js';

export const COUNTIK_VIDEO_BASE_URL = 'https://countik.com/api';
export const COUNTIK_ORIGIN = 'https://countik.com/';
/** Per-call budget, matching this Worker's tikwm timeout. */
export const COUNTIK_API_TIMEOUT_MS = 25_000;

export type CountikResolveFailure =
  | { reason: 'countik_api_timeout'; step: 'exist' | 'info' }
  | { reason: 'countik_api_fetch_error'; step: 'exist' | 'info'; detail: string }
  | { reason: 'countik_api_http_status'; step: 'exist' | 'info'; status: number }
  | { reason: 'countik_api_body_unparsable'; step: 'exist' | 'info' }
  | { reason: 'countik_api_bad_body'; step: 'exist' | 'info' }
  | { reason: 'countik_no_video_id' }
  | { reason: 'countik_no_download_link' };

export type CountikResolveResult =
  | { ok: true; streamUrl: string; rawTitle: string | null }
  | { ok: false; failure: CountikResolveFailure };

function isTimeout(err: unknown): boolean {
  // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
  return err instanceof Error && err.name === 'TimeoutError';
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
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

type CountikStep = 'exist' | 'info';

async function fetchCountikJson(
  url: string,
  init: RequestInit,
  step: CountikStep,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; data: Record<string, unknown> | null } | { ok: false; failure: CountikResolveFailure }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(COUNTIK_API_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, failure: { reason: 'countik_api_timeout', step } };
    }
    return { ok: false, failure: { reason: 'countik_api_fetch_error', step, detail: errorDetail(err) } };
  }
  // Non-200 fails before any body parse, exactly like the tikwm path.
  if (res.status !== 200) {
    return { ok: false, failure: { reason: 'countik_api_http_status', step, status: res.status } };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, failure: { reason: 'countik_api_body_unparsable', step } };
  }
  const data = countikData(body);
  if (!data) {
    return { ok: false, failure: { reason: 'countik_api_bad_body', step } };
  }
  return { ok: true, data };
}

/**
 * Resolve a TikTok video URL to its direct mp4 link via Countik.
 * Returns a discriminated result: every failure carries its exact
 * reason and the step (exist/info) it failed on, so the caller can
 * persist both attempts when tikwm already failed. The caption text
 * (desc/description/title) maps to rawTitle, so a Countik download
 * gets its real caption through the same normalization as tikwm —
 * missing/generic text falls back to the default caption downstream.
 */
export async function resolveCountikStream(
  videoUrl: string,
  // Workerd brand-check: arrow wrapper, never bare `fetch` (see supabase.ts).
  fetchImpl: FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
): Promise<CountikResolveResult> {
  const exist = await fetchCountikJson(
    `${COUNTIK_VIDEO_BASE_URL}/video/exist`,
    {
      method: 'POST',
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: videoUrl }),
    },
    'exist',
    fetchImpl,
  );
  if (!exist.ok) {
    return { ok: false, failure: exist.failure };
  }
  const videoId = pickString(exist.data, ['video_id', 'videoId', 'aweme_id', 'id']);
  if (!videoId) {
    return { ok: false, failure: { reason: 'countik_no_video_id' } };
  }
  const info = await fetchCountikJson(
    `${COUNTIK_VIDEO_BASE_URL}/videoinfo/${encodeURIComponent(videoId)}`,
    {
      headers: {
        'User-Agent': DESKTOP_CHROME_UA,
        Accept: 'application/json',
      },
    },
    'info',
    fetchImpl,
  );
  if (!info.ok) {
    return { ok: false, failure: info.failure };
  }
  const streamUrl = pickString(info.data, ['download_link', 'downloadUrl', 'download_url']);
  if (!streamUrl) {
    return { ok: false, failure: { reason: 'countik_no_download_link' } };
  }
  return {
    ok: true,
    streamUrl: streamUrl.startsWith('/') ? `${COUNTIK_ORIGIN}${streamUrl.slice(1)}` : streamUrl,
    rawTitle: pickString(info.data, ['desc', 'description', 'title']),
  };
}
