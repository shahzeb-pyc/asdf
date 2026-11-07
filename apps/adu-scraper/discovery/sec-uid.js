/**
 * TikTok sec_uid resolver: Worker-first, direct Countik fallback.
 * Resolving sec_uid allows yt-dlp to query TikTok's mobile feed directly via `tiktokuser:{sec_uid}`,
 * bypassing desktop captcha walls and 429 rate limits.
 *
 * Why Worker-first: the VPS datacenter IP is reputation-blocked by Countik (HTTP 403
 * Cloudflare challenge) and by TikTok profile pages, while Cloudflare Worker egress passes
 * Countik's challenge (proven live 2026-11-03). The Worker only changes the sec_uid SOURCE;
 * the yt-dlp path and the fail-loud contract are unchanged. If the Worker is unavailable,
 * the original direct Countik call runs exactly as before; if both fail, null is returned
 * and the caller falls back to the standard profile URL, as before.
 *
 * Countik via proxy: when COUNTIK_PROXY_URL is set (or options.countikProxyUrl is
 * passed), the direct Countik fallback goes through that rotating HTTP proxy
 * instead of direct — the VPS IP is 403-blocked by Countik, while residential
 * proxy IPs answer. The Worker fetch never uses the proxy; yt-dlp uses it
 * only for the first profile-URL attempt (see discovery/ytdlp.js), never
 * for the `tiktokuser:` attempt. A proxy
 * failure is fail-loud: null is returned and direct Countik is NOT retried.
 * This module stays dependency-free (node builtins only) so the standalone CI
 * scraper test step (which runs without npm install) keeps passing.
 */

import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

const COUNTIK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_WORKER_URL = 'https://fbuploadpro-secuid.fbuploadpro.workers.dev';

function cleanUsername(username) {
  return String(username || '')
    .replace(/[\u200b-\u200d\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s/g, '')
    .replace(/^@+/, '')
    .trim();
}

// Log-safe form (matches discovery/ytdlp.js): no newlines, escapes, or control
// characters from user input can forge a log line.
function logSafe(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
}

/**
 * Parse an HTTP proxy URL into CONNECT-tunnel parts. Only plain `http:` proxies
 * are supported (the rotating residential proxy is HTTP). Returns null for an
 * empty, unparsable, or non-http value. The returned `auth` is the decoded
 * `user:password` pair (or null); it is never logged.
 */
export function parseProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !parsed.hostname) {
    return null;
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 80,
    auth: parsed.username
      ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
      : null,
  };
}

/**
 * Minimal HTTPS-via-HTTP-proxy agent (node:https Agent API, no dependencies).
 * createConnection opens a CONNECT tunnel to the proxy, then TLS-upgrades the
 * tunnel socket. Only used for the Countik fallback fetch; the Worker fetch
 * and yt-dlp never see this agent. No per-IP/session state is kept, so a
 * rotating proxy (a different egress IP per call) is safe.
 */
export class ProxyHttpsAgent extends HttpsAgent {
  constructor(proxy, timeoutMs) {
    super();
    this.proxy = proxy;
    this.timeoutMs = timeoutMs || 5000;
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = Number(options.port) || 443;
    const servername = options.servername || targetHost;
    let finished = false;
    const done = (err, socket) => {
      if (finished) {
        return;
      }
      finished = true;
      callback(err, socket);
    };

    const headers = { Host: `${targetHost}:${targetPort}` };
    if (this.proxy.auth) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(this.proxy.auth, 'utf8').toString('base64')}`;
    }

    const connectReq = httpRequest({
      host: this.proxy.host,
      port: this.proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
    });
    connectReq.setTimeout(this.timeoutMs, () => {
      connectReq.destroy(new Error('proxy CONNECT timeout'));
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`proxy CONNECT failed with status ${res.statusCode}`));
        return;
      }
      const tlsSocket = tlsConnect({ socket, servername });
      tlsSocket.once('secureConnect', () => done(null, tlsSocket));
      tlsSocket.once('error', done);
    });
    connectReq.on('error', done);
    connectReq.end();
  }
}

/**
 * GET a JSON document over HTTPS through the proxy. Returns
 * `{ ok: true, data }` on a 2xx JSON response, otherwise
 * `{ ok: false, reason }` where reason is a short failure class that never
 * contains the proxy value (e.g. `proxy CONNECT failed with status 407`,
 * `timeout`, `http_429`, `invalid_json`, `network_error`).
 */
export async function fetchJsonViaProxy(url, proxy, { headers, timeoutMs }) {
  return new Promise((resolve) => {
    let req;
    try {
      req = httpsRequest(
        url,
        {
          method: 'GET',
          headers,
          agent: new ProxyHttpsAgent(proxy, timeoutMs),
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              resolve({ ok: false, reason: `http_${status}` });
              return;
            }
            try {
              resolve({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
            } catch {
              resolve({ ok: false, reason: 'invalid_json' });
            }
          });
        },
      );
    } catch {
      resolve({ ok: false, reason: 'network_error' });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('proxy CONNECT')) {
        resolve({ ok: false, reason: message });
      } else if (/timeout|abort/i.test(message)) {
        resolve({ ok: false, reason: 'timeout' });
      } else {
        resolve({ ok: false, reason: 'network_error' });
      }
    });
    req.end();
  });
}

async function fetchJsonWithTimeout(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    try {
      return await res.json();
    } catch {
      return null;
    }
  } catch {
    // Timeout or network error — caller falls through to the next source.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Worker returns { sec_uid }; Countik returns { status: 'success', sec_uid }.
// Anything else (error shape, missing/empty sec_uid) is not a resolution.
function extractSecUid(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  if (typeof data.sec_uid === 'string' && data.sec_uid.trim()) {
    if (data.status !== undefined && data.status !== 'success') {
      return null;
    }
    return data.sec_uid.trim();
  }
  return null;
}

export async function resolveTiktokSecUid(username, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const clean = cleanUsername(username);

  if (!clean) {
    return null;
  }

  // 1. Worker first (egress passes Countik's challenge; VPS direct fetch does not).
  // NOTE: the Worker URL is read from process.env at call time (not via config.js)
  // on purpose: this module must stay dependency-free so the standalone CI scraper
  // test step (which runs without npm install) keeps passing. Importing config.js
  // would pull in dotenv and break that step. The proxy URL below is read the
  // same way, for the same reason.
  // Strip trailing slashes with plain string ops (no regex): identical to
  // the old `.replace(/\/+$/, '')` but without super-linear backtracking.
  let workerBase = options.workerUrl || options.workerBaseUrl || process.env.SECUID_WORKER_URL || DEFAULT_WORKER_URL;
  while (workerBase.endsWith('/')) {
    workerBase = workerBase.slice(0, -1);
  }
  if (workerBase) {
    const data = await fetchJsonWithTimeout(`${workerBase}/?username=${encodeURIComponent(clean)}`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
      },
      timeoutMs,
    });
    const fromWorker = extractSecUid(data);
    if (fromWorker) {
      return fromWorker;
    }
    const viaProxy = String(options.countikProxyUrl || process.env.COUNTIK_PROXY_URL || '').trim();
    console.log(`ℹ️ sec_uid Worker unavailable for @${logSafe(clean)}; falling back to Countik${viaProxy ? ' via proxy' : ' direct'}.`);
  }

  // 2. Countik fallback — through the rotating proxy when configured, direct
  // otherwise. The VPS datacenter IP is 403-blocked by Countik, so the direct
  // path is dead from the VPS; the proxy's residential IPs answer instead.
  const url = `https://countik.com/api/exist/${encodeURIComponent(clean)}`;
  const countikHeaders = {
    'User-Agent': options.userAgent || COUNTIK_UA,
    'Accept': 'application/json, text/plain, */*',
  };
  const proxyRaw = options.countikProxyUrl || process.env.COUNTIK_PROXY_URL || '';
  if (String(proxyRaw).trim()) {
    const proxy = parseProxyUrl(proxyRaw);
    if (!proxy) {
      // Fail loud: a configured-but-unusable proxy must not silently degrade
      // to the direct fetch (which is 403-blocked from the VPS anyway).
      console.error(`❌ COUNTIK_PROXY_URL is set but not a valid http proxy URL for @${logSafe(clean)}; not retrying direct Countik.`);
      return null;
    }
    const result = await fetchJsonViaProxy(url, proxy, { headers: countikHeaders, timeoutMs });
    if (result.ok && result.data?.status === 'success' && result.data?.sec_uid) {
      return String(result.data.sec_uid).trim();
    }
    console.log(`ℹ️ Countik via proxy failed for @${logSafe(clean)} (${result.reason}); not retrying direct.`);
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      headers: countikHeaders,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (data?.status === 'success' && data?.sec_uid) {
      return String(data.sec_uid).trim();
    }
  } catch (err) {
    // Timeout or network error — return null to trigger standard URL fallback
  }

  return null;
}
