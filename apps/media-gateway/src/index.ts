/**
 * fbuploadpro-media-gateway (spec 259): dual-read gateway in front of
 * `media.vinsmokemedia.online` and `adu.vinsmokemedia.online`.
 *
 * The locked cutover flips new uploads to Backblaze B2 first while old
 * files are still only on Cloudflare R2, and the public domain can only
 * point at one backend at a time. This Worker is what makes that safe:
 * every read tries B2 first and falls back to R2 on 404, so both old
 * and new files resolve through the same domain with zero downtime
 * while the backfill runs in the background.
 *
 * Request flow:
 * - `GET <host>/<key>` → B2 origin
 *   `https://<B2_FRIENDLY_HOST>/file/<bucket>/<key>` (bucket chosen by
 *   hostname: media → media bucket, adu → ADU buffer bucket).
 * - B2 2xx → streamed through, origin headers passed through.
 * - B2 404/410 → R2 fallback origin (`<R2_*_DEV_URL>/<key>`).
 * - Any other B2 failure (5xx, timeout) → 502, NEVER the fallback: a
 *   5xx might mean the object exists but B2 is down, and falling back
 *   could serve a stale R2 copy after a newer B2 write.
 * - The R2 fallback var is a deploy-time var (passed via
 *   `wrangler deploy --var` by the deploy workflow). A request that
 *   needs the fallback when the var is missing fails loud with a 500
 *   — never silently served.
 *
 * Streaming, not buffering: origin bodies stream straight through (no
 * `arrayBuffer()` on video bodies). The client's Range header is
 * forwarded and the origin's status + headers (Content-Type,
 * Content-Length, Content-Range, Accept-Ranges, ETag, Cache-Control)
 * pass through, so video streaming and the publishing worker's fetch
 * both work unchanged. Reads are edge-cached (`cacheEverything`, TTL
 * below); B2 responses carry their own cache headers and the gateway
 * never invents cache policy on the response itself.
 *
 * Observability: every response carries `x-fbup-origin: b2 | r2`
 * (which origin served it). No request logging, no PII — error logs
 * name only the bucket and the status, never the key.
 *
 * Retirement: after the backfill verifies and the domains switch to
 * native CNAME + Transform Rule serving, this Worker, its routes and
 * its deploy workflow are deleted.
 */

export interface Env {
  B2_FRIENDLY_HOST: string;
  B2_MEDIA_BUCKET: string;
  B2_BUFFER_BUCKET: string;
  /** Deploy-time var (wrangler --var); absent until phase 2b sets it. */
  R2_MEDIA_DEV_URL?: string | undefined;
  /** Deploy-time var (wrangler --var); absent until phase 2b sets it. */
  R2_BUFFER_DEV_URL?: string | undefined;
}

const MEDIA_HOST = 'media.vinsmokemedia.online';
const BUFFER_HOST = 'adu.vinsmokemedia.online';

/** Edge-cache TTL for origin reads (seconds). Matches B2's default
 * public-file max-age; it governs edge caching only, never the
 * Cache-Control header passed through to the client. */
const ORIGIN_CACHE_TTL_SECONDS = 3600;

/** Origin response headers passed through to the client, verbatim. */
const PASSTHROUGH_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'cache-control',
] as const;

/** B2 statuses that mean "not on B2" and may fall back to R2. */
const FALLBACK_STATUSES = [404, 410];

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

function textResponse(body: string, status: number, origin?: 'b2' | 'r2'): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
  if (origin) {
    headers.set('x-fbup-origin', origin);
  }
  return new Response(body, { status, headers });
}

/** Stream an origin response through with its status + headers. */
function passthroughResponse(originResponse: Response, origin: 'b2' | 'r2'): Response {
  const headers = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = originResponse.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set('x-fbup-origin', origin);
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

interface OriginRoute {
  bucket: string;
  fallbackBase: string | undefined;
}

function resolveRoute(url: URL, env: Env): OriginRoute | null {
  if (url.hostname === MEDIA_HOST) {
    return { bucket: env.B2_MEDIA_BUCKET, fallbackBase: env.R2_MEDIA_DEV_URL };
  }
  if (url.hostname === BUFFER_HOST) {
    return { bucket: env.B2_BUFFER_BUCKET, fallbackBase: env.R2_BUFFER_DEV_URL };
  }
  return null;
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse('Method not allowed', 405);
  }

  const url = new URL(request.url);
  const route = resolveRoute(url, env);
  if (!route) {
    return textResponse('Unknown host', 404);
  }
  // A bare domain request has no key to serve.
  if (url.pathname === '/') {
    return textResponse('Not found', 404);
  }
  // The pathname stays percent-encoded: it is the storage key as-is.
  const keyPath = url.pathname;

  const range = request.headers.get('range');
  const originInit: RequestInit = {
    method: request.method,
    cf: { cacheTtl: ORIGIN_CACHE_TTL_SECONDS, cacheEverything: true },
  };
  if (range) {
    originInit.headers = { range };
  }

  const b2Url = `https://${env.B2_FRIENDLY_HOST}/file/${route.bucket}${keyPath}`;
  let b2Response: Response;
  try {
    b2Response = await fetch(b2Url, originInit);
  } catch (err) {
    console.error(`[media-gateway] B2 origin fetch failed for bucket ${route.bucket}`, err);
    return textResponse('Bad gateway', 502);
  }

  if (b2Response.ok) {
    return passthroughResponse(b2Response, 'b2');
  }
  if (!FALLBACK_STATUSES.includes(b2Response.status)) {
    // Any other B2 failure: fail loud, never fall back. A 5xx might
    // mean the object exists but B2 is down; serving the R2 copy
    // would mask that and could serve stale bytes after a newer B2 write.
    console.error(
      `[media-gateway] B2 origin returned ${b2Response.status} for bucket ${route.bucket}`
    );
    return textResponse('Bad gateway', 502);
  }

  // B2 404/410: the object is not on B2 (yet) — try R2.
  const fallbackBase = route.fallbackBase;
  if (!fallbackBase) {
    console.error(
      `[media-gateway] B2 miss for bucket ${route.bucket} but no R2 fallback URL is configured`
    );
    return textResponse('Media gateway is not configured for fallback reads', 500);
  }
  const fallbackUrl = `${trimTrailingSlashes(fallbackBase)}${keyPath}`;
  let fallbackResponse: Response;
  try {
    fallbackResponse = await fetch(fallbackUrl, originInit);
  } catch (err) {
    console.error(`[media-gateway] R2 fallback fetch failed for bucket ${route.bucket}`, err);
    return textResponse('Bad gateway', 502);
  }

  if (fallbackResponse.ok) {
    return passthroughResponse(fallbackResponse, 'r2');
  }
  if (FALLBACK_STATUSES.includes(fallbackResponse.status)) {
    return textResponse('Not found', 404);
  }
  console.error(
    `[media-gateway] R2 fallback returned ${fallbackResponse.status} for bucket ${route.bucket}`
  );
  return textResponse('Bad gateway', 502);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },
};
