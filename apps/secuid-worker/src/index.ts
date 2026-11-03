/**
 * TikTok sec_uid lookup + Creator Finder proxy Worker (fbuploadpro-secuid).
 *
 * Two jobs, one egress:
 * 1. Legacy sec_uid lookup (unchanged): the VPS ADU scraper's
 *    datacenter IP is blocked by Countik (HTTP 403 Cloudflare
 *    challenge), but yt-dlp on the VPS via `tiktokuser:{sec_uid}`
 *    still works — so only the sec_uid source needs replacing.
 *    Username in, sec_uid out. No secrets (Countik needs no key).
 * 2. Creator Finder proxy (`/proxy/*`): the app backend's
 *    datacenter egress is suspected of the same block, so the
 *    backend calls this Worker instead of Countik directly. The
 *    Worker changes only egress IP + headers, never the logic:
 *    it forwards to Countik and returns its JSON unchanged on
 *    success, or a fixed 502 error class on any failure.
 *
 * Fail loud everywhere: a blocked/unreachable/malformed upstream
 * answer is a 502 with a reason class — never the raw challenge
 * page, never a fabricated value. Usernames are never logged.
 *
 * Auth: the legacy sec_uid route stays as it was (the VPS scraper
 * calls it without a secret). The /proxy/* routes are different:
 * without auth they would be a free public mirror of the
 * upstream, so they require a shared secret (PROXY_SECRET, set
 * via wrangler secret — never in code) sent as the
 * x-countik-proxy-secret header. When no secret is configured,
 * proxy routes fail closed with 503 instead of serving open.
 */

const COUNTIK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COUNTIK_TIMEOUT_MS = 5000;
// Proxy upstream calls get a longer budget than the sec_uid
// lookup: analyze can be slower, and the backend's own per-call
// timeout is 30s, so 15s here still leaves margin.
const PROXY_TIMEOUT_MS = 15000;

export const PROXY_SECRET_HEADER = 'x-countik-proxy-secret';

// TikTok usernames: letters, digits, underscore, period, 1–24 chars.
// Mirrors the scraper's cleaning (strip zero-width chars, whitespace,
// leading @) and then enforces the charset, so malformed input is a 400
// instead of a pointless upstream fetch.
const USERNAME_PATTERN = /^[A-Za-z0-9._]{1,24}$/;

export function cleanUsername(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const clean = raw
    .replace(/[\u200b-\u200d\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s/g, '')
    .replace(/^@+/, '')
    .trim();
  if (!clean || !USERNAME_PATTERN.test(clean)) {
    return null;
  }
  return clean;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type UpstreamFetchResult =
  | { data: unknown }
  | { error: 'UPSTREAM_TIMEOUT' | 'UPSTREAM_ERROR'; upstreamStatus?: number };

/**
 * One upstream fetch with timeout, shared by the sec_uid lookup
 * and the proxy routes (they previously duplicated this block
 * almost verbatim, which tripped Sonar's duplication gate).
 * Returns the parsed JSON on success, or a fixed error class —
 * never the upstream body, which may be a challenge page.
 */
async function fetchUpstreamJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  logPrefix: string,
): Promise<UpstreamFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    // The timer is the only abort source for this signal, so an
    // aborted signal here means the upstream hung past the timeout.
    if (controller.signal.aborted) {
      console.error(`${logPrefix} timed out`);
      return { error: 'UPSTREAM_TIMEOUT' };
    }
    console.error(`${logPrefix} upstream fetch failed`);
    return { error: 'UPSTREAM_ERROR' };
  }
  clearTimeout(timer);
  if (!res.ok) {
    console.error(`${logPrefix} upstream non-200`, res.status);
    return { error: 'UPSTREAM_ERROR', upstreamStatus: res.status };
  }
  try {
    return { data: await res.json() };
  } catch {
    console.error(`${logPrefix} upstream returned unparseable body`);
    return { error: 'UPSTREAM_ERROR' };
  }
}

/** Read a JSON request body, or null when it is absent/unparseable. */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export interface SecUidHandlerOptions {
  timeoutMs?: number;
}

export async function handleSecUidRequest(
  request: Request,
  options: SecUidHandlerOptions = {},
): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get('username') ?? url.pathname.replace(/^\//, '');
  const username = cleanUsername(raw || null);
  if (!username) {
    return json({ error: 'INVALID_USERNAME' }, 400);
  }

  const timeoutMs = options.timeoutMs ?? COUNTIK_TIMEOUT_MS;
  const result = await fetchUpstreamJson(
    `https://countik.com/api/exist/${encodeURIComponent(username)}`,
    {
      headers: {
        'User-Agent': COUNTIK_UA,
        Accept: 'application/json, text/plain, */*',
      },
    },
    timeoutMs,
    'secuid lookup',
  );
  if ('error' in result) {
    return json(
      result.upstreamStatus !== undefined
        ? { error: result.error, upstreamStatus: result.upstreamStatus }
        : { error: result.error },
      502,
    );
  }
  const data = result.data;

  const record = data as { status?: unknown; sec_uid?: unknown } | null;
  const secUid =
    record?.status === 'success' && typeof record.sec_uid === 'string'
      ? record.sec_uid.trim()
      : '';
  if (!secUid) {
    console.error('secuid lookup upstream answer had no sec_uid');
    return json({ error: 'UPSTREAM_ERROR' }, 502);
  }

  return json({ sec_uid: secUid }, 200);
}

const SEC_UID_PATTERN = /^[A-Za-z0-9_\-.:]{1,200}$/;
const VIDEO_ID_PATTERN = /^\d{1,30}$/;

function secretsEqual(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface ProxyHandlerOptions {
  timeoutMs?: number;
  /** Shared secret; when undefined, proxy routes fail closed. */
  proxySecret?: string | undefined;
}

/**
 * Forward one Countik call through Cloudflare egress. Returns the
 * upstream JSON unchanged on success; on any failure returns a
 * fixed 502 error class — never the upstream body, which may be
 * a challenge page. Only the five validated routes below are
 * forwarded, so this cannot be used as an open proxy.
 */
export async function handleProxyRequest(
  request: Request,
  options: ProxyHandlerOptions = {},
): Promise<Response> {
  if (options.proxySecret === undefined) {
    return json({ error: 'PROXY_NOT_CONFIGURED' }, 503);
  }
  if (!secretsEqual(request.headers.get(PROXY_SECRET_HEADER), options.proxySecret)) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/proxy\//, '');
  let upstreamUrl: string | null = null;
  let method: 'GET' | 'POST' = 'GET';
  let body: unknown = undefined;

  if (request.method === 'GET' && path.startsWith('exist/')) {
    const username = cleanUsername(path.slice('exist/'.length) || null);
    if (!username) return json({ error: 'INVALID_USERNAME' }, 400);
    upstreamUrl = `https://countik.com/api/exist/${encodeURIComponent(username)}`;
  } else if (request.method === 'GET' && path === 'analyze') {
    const secUid = url.searchParams.get('sec_user_id');
    const username = cleanUsername(url.searchParams.get('username'));
    if (!secUid || !SEC_UID_PATTERN.test(secUid) || !username) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    upstreamUrl = `https://countik.com/api/analyze/?sec_user_id=${encodeURIComponent(secUid)}&username=${encodeURIComponent(username)}`;
  } else if (request.method === 'POST' && path === 'video/exist') {
    const parsed = await readJsonBody(request);
    const videoUrl = (parsed as { url?: unknown } | null)?.url;
    if (typeof videoUrl !== 'string') return json({ error: 'INVALID_REQUEST' }, 400);
    let host = '';
    try {
      host = new URL(videoUrl).hostname;
    } catch {
      host = '';
    }
    if (!host.endsWith('tiktok.com')) return json({ error: 'INVALID_REQUEST' }, 400);
    method = 'POST';
    body = { url: videoUrl };
    upstreamUrl = 'https://countik.com/api/video/exist';
  } else if (request.method === 'GET' && path.startsWith('videoinfo/')) {
    const videoId = path.slice('videoinfo/'.length);
    if (!VIDEO_ID_PATTERN.test(videoId)) return json({ error: 'INVALID_REQUEST' }, 400);
    upstreamUrl = `https://countik.com/api/videoinfo/${encodeURIComponent(videoId)}`;
  } else if (request.method === 'POST' && path === 'generateHashtags') {
    const parsed = await readJsonBody(request);
    const query = (parsed as { query?: unknown } | null)?.query;
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    method = 'POST';
    body = { query: query.trim() };
    upstreamUrl = 'https://countik.com/api/generateHashtags';
  } else {
    return json({ error: 'NOT_FOUND' }, 404);
  }

  const timeoutMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
  const result = await fetchUpstreamJson(
    upstreamUrl,
    {
      method,
      headers: {
        'User-Agent': COUNTIK_UA,
        Accept: 'application/json, text/plain, */*',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    timeoutMs,
    'countik proxy',
  );
  if ('error' in result) {
    return json(
      result.upstreamStatus !== undefined
        ? { error: result.error, upstreamStatus: result.upstreamStatus }
        : { error: result.error },
      502,
    );
  }
  return json(result.data, 200);
}

export interface SecUidWorkerEnv {
  PROXY_SECRET?: string | undefined;
}

export default {
  async fetch(request: Request, env: SecUidWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/proxy' || url.pathname.startsWith('/proxy/')) {
      return handleProxyRequest(request, { proxySecret: env?.PROXY_SECRET });
    }
    return handleSecUidRequest(request);
  },
};
