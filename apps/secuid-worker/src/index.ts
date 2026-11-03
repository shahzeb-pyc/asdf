/**
 * TikTok sec_uid lookup Worker (fbuploadpro-secuid).
 *
 * The VPS ADU scraper's datacenter IP is blocked by Countik (HTTP 403
 * Cloudflare challenge) and by TikTok profile pages, but yt-dlp on the VPS
 * via `tiktokuser:{sec_uid}` still works — so only the sec_uid source needs
 * replacing. This Worker runs on Cloudflare egress (not the VPS IP) and
 * answers one question: given a TikTok username, what is its sec_uid?
 *
 * One job only: username in, sec_uid out. No secrets (Countik needs no
 * key), no proxy, no tikwm, no other third-party service. Fail loud:
 * a blocked/unreachable/malformed upstream answer is a 502 with a reason
 * class — never the raw challenge page, never a fabricated sec_uid.
 * Usernames are never logged.
 */

const COUNTIK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COUNTIK_TIMEOUT_MS = 5000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(`https://countik.com/api/exist/${encodeURIComponent(username)}`, {
      headers: {
        'User-Agent': COUNTIK_UA,
        Accept: 'application/json, text/plain, */*',
      },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    // The timer is the only abort source for this signal, so an aborted
    // signal here means the upstream hung past the timeout.
    if (controller.signal.aborted) {
      console.error('secuid lookup timed out');
      return json({ error: 'UPSTREAM_TIMEOUT' }, 502);
    }
    console.error('secuid lookup upstream fetch failed');
    return json({ error: 'UPSTREAM_ERROR' }, 502);
  }
  clearTimeout(timer);

  if (!res.ok) {
    console.error('secuid lookup upstream non-200', res.status);
    return json({ error: 'UPSTREAM_ERROR', upstreamStatus: res.status }, 502);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.error('secuid lookup upstream returned unparseable body');
    return json({ error: 'UPSTREAM_ERROR' }, 502);
  }

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

export default {
  async fetch(request: Request): Promise<Response> {
    return handleSecUidRequest(request);
  },
};
