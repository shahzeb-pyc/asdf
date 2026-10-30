/**
 * Shared timeout helper for server-side external fetches (spec 139, A4).
 *
 * Every bare external `fetch` in `apps/web/src` must go through this module
 * so a hung upstream can never hang a route indefinitely. Callers keep
 * their existing behaviour otherwise: non-2xx responses are returned (not
 * thrown), exactly as with plain `fetch`, and a caller-supplied
 * `init.signal` is composed with the timeout — aborting the caller's
 * signal still aborts the request.
 *
 * The fetch helpers themselves live in @fbuploadpro/downloader-engine
 * (the canonical location, shared with the Cloudflare download
 * consumer); this module re-exports them and keeps only the web-side
 * Graph API budgets, so existing import sites are unchanged.
 */
export {
  MEDIA_FETCH_TIMEOUT_MS,
  composeTimeoutSignal,
  fetchWithTimeout,
  fetchWithTimeoutToHeaders,
  readBoundedJson,
  readBoundedText,
} from '@fbuploadpro/downloader-engine';

/** Budget for Facebook Graph API calls, including OAuth token exchanges. */
export const GRAPH_API_TIMEOUT_MS = 30_000;

/** Default budget when a call site does not pass an explicit timeout. */
export const DEFAULT_FETCH_TIMEOUT_MS = GRAPH_API_TIMEOUT_MS;
