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
 */

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
  // would pull in dotenv and break that step.
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
    console.log(`ℹ️ sec_uid Worker unavailable for @${logSafe(clean)}; falling back to direct Countik.`);
  }

  // 2. Direct Countik, exactly as before.
  const url = `https://countik.com/api/exist/${encodeURIComponent(clean)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      headers: {
        'User-Agent': options.userAgent || COUNTIK_UA,
        'Accept': 'application/json, text/plain, */*',
      },
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
