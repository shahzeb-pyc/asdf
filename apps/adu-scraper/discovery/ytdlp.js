import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildTiktokProfileUrl, supportsYtdlpDiscovery } from './profile-urls.js';
import { buildTiktokYtdlpArgs } from './ytdlp-args.js';
import { extractIdsFromYtdlpJson } from './extract-ids.js';

const execFileAsync = promisify(execFile);

const EXEC_OPTS_BASE = {
  maxBuffer: 50 * 1024 * 1024,
};

// Proxy values that can appear in yt-dlp argv and therefore in execFile's
// err.message (`Command failed: <binary> <full argv>`). The profile attempt
// passes COUNTIK_PROXY_URL explicitly; buildTiktokYtdlpArgs also falls back
// to DATACENTER_PROXY/PROXY_URL/HTTP_PROXY/HTTPS_PROXY when set.
// When a child exits non-zero with EMPTY stderr — or is timeout-killed —
// the stderr tail is empty, so the err.message fallback would otherwise
// carry the proxy credential verbatim into the log (and, via the returned
// reason, into index.js processJob's log too). Strip every known proxy
// value from any failure detail before it is logged or returned.
function collectProxyValues(argOptions) {
  const values = [];
  const candidates = [
    argOptions?.proxy,
    process.env.COUNTIK_PROXY_URL,
    process.env.DATACENTER_PROXY,
    process.env.PROXY_URL,
    process.env.HTTP_PROXY,
    process.env.HTTPS_PROXY,
  ];
  for (const value of candidates) {
    const trimmed = String(value ?? '').trim();
    if (trimmed && !values.includes(trimmed)) values.push(trimmed);
  }
  return values;
}

function redactProxyValues(text, argOptions) {
  let out = String(text ?? '');
  for (const value of collectProxyValues(argOptions)) {
    out = out.split(value).join('[proxy]');
  }
  return out;
}

// TikTok discovery is yt-dlp ONLY (owner order 2026-11-08): the plain
// profile-URL attempt, retried up to MAX_PROFILE_ATTEMPTS times per claim
// with RETRY_DELAY_MS between attempts. Each attempt draws a different
// rotating proxy exit IP — the exit-IP lottery is what decides success,
// and a single attempt wastes a claim on one blocked IP. Countik is gone
// from discovery (dead from every egress): no sec_uid resolution, no
// secuid Worker call, no direct Countik fallback.
const MAX_PROFILE_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// yt-dlp binary/timeout are read from env at call time (not via config.js)
// on purpose: this module must stay dependency-free (node builtins only) so
// the standalone CI scraper test step (which runs without npm install) can
// import it — config.js pulls in dotenv. index.js loads config.js (and the
// .env file) at startup, so production behaviour is unchanged.
function getYtdlpBin() {
  return process.env.YTDLP_BIN || 'yt-dlp';
}

function getYtdlpTimeoutMs() {
  const parsed = Number(process.env.YTDLP_TIMEOUT_MS ?? 600_000);
  if (!Number.isFinite(parsed)) {
    return 600_000;
  }
  return Math.min(600_000, Math.max(10_000, parsed));
}

function getCandidateBinaries() {
  const bins = [];
  if (getYtdlpBin()) bins.push(getYtdlpBin());
  bins.push('yt-dlp');
  bins.push('yt-dlp.exe');
  if (process.env.LOCALAPPDATA) {
    bins.push(`${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\yt-dlp.exe`);
  }
  return [...new Set(bins)];
}

async function runYtDlp(args) {
  const execOpts = {
    ...EXEC_OPTS_BASE,
    timeout: getYtdlpTimeoutMs(),
  };

  const candidates = getCandidateBinaries();
  let lastError = null;

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, args, execOpts);
      return stdout;
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastError = err;
        continue;
      }

      // Check if impersonation error occurred (e.g. curl-cffi missing)
      const stderr = err.stderr?.toString() || '';
      const errMessage = err.message || '';
      const isImpersonateError =
        stderr.includes('Impersonate target') || errMessage.includes('Impersonate target');

      if (isImpersonateError) {
        console.warn('⚠️ Impersonation not available. Retrying without --impersonate...');
        const fallbackArgs = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--impersonate') {
            i++; // skip next arg
            continue;
          }
          fallbackArgs.push(args[i]);
        }
        const { stdout } = await execFileAsync(bin, fallbackArgs, execOpts);
        return stdout;
      }

      throw err;
    }
  }

  // Fallback to python module if standalone binary wasn't found
  const pythonCmds = ['python3', 'python'];
  for (const py of pythonCmds) {
    try {
      const { stdout } = await execFileAsync(py, ['-m', 'yt_dlp', ...args], execOpts);
      return stdout;
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('yt-dlp binary not found');
}

/**
 * Run yt-dlp once for a single discovery target and parse its JSON output.
 * Returns { ok: true, ids } when at least one ID is extracted, otherwise
 * { ok: false, reason } with the failure detail (stderr tail,
 * 'unparseable_json', or 'empty_result'). Never throws.
 */
async function runDiscoveryTarget(targetUrl, maxCount, argOptions, logUser) {
  const args = buildTiktokYtdlpArgs(targetUrl, maxCount, argOptions);
  console.log(`📡 TikTok yt-dlp discovery: ${targetUrl}`);

  let stdout;
  try {
    stdout = await runYtDlp(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err.stderr?.toString?.() || '';
    // Never fall back to err.message verbatim: with empty stderr it is
    // `Command failed: <binary> <full argv>` and would leak --proxy.
    // Redact first so the logged line AND the returned reason (which
    // index.js processJob also logs) can never contain the proxy value.
    const detail = redactProxyValues(stderr.trim().slice(-500) || message, argOptions);
    console.warn(`⚠️ TikTok yt-dlp target ${targetUrl} failed: ${detail}`);
    return { ok: false, reason: detail };
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.warn(`⚠️ TikTok yt-dlp returned invalid JSON for ${targetUrl}: ${message}`);
    return { ok: false, reason: 'unparseable_json' };
  }

  const ids = extractIdsFromYtdlpJson(payload, 'tiktok', maxCount);
  if (ids.length > 0) {
    console.log(`✅ TikTok yt-dlp discovered ${ids.length} ID(s) for @${logUser} via ${targetUrl}`);
    return { ok: true, ids };
  }

  console.warn(`⚠️ TikTok yt-dlp returned zero valid IDs for ${targetUrl}; trying next target...`);
  return { ok: false, reason: 'empty_result' };
}

/**
 * Discover TikTok video IDs via yt-dlp ONLY (owner order 2026-11-08:
 * Countik removed, 5 retries):
 * - yt-dlp, plain profile URL through the rotating proxy
 *   (COUNTIK_PROXY_URL from env — the name is historical, the value is
 *   the DataImpulse proxy). yt-dlp resolves the sec_uid itself from the
 *   profile page. Listing only (--flat-playlist -J); it never downloads
 *   video bytes. If it yields reel IDs, discovery is done.
 * - The profile attempt is retried up to 5 times total per claim, 2s
 *   between attempts — each attempt draws a different rotating proxy
 *   exit IP. Success on any attempt returns the IDs.
 * - All 5 fail -> { ok: false, reason } with the last failure detail
 *   (redacted — never the proxy value); the caller marks the config
 *   error, as before.
 *
 * The proxy value is read from env and is never logged.
 *
 * @param {string} platform
 * @param {string} sourceUsername
 * @param {number} maxCount
 * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, reason: string }>}
 */
export async function discoverReelIdsWithYtdlp(platform, sourceUsername, maxCount) {
  const p = (platform || '').toLowerCase();

  if (!supportsYtdlpDiscovery(p)) {
    return { ok: false, reason: 'platform_not_supported' };
  }

  const cleanUser = String(sourceUsername || '')
    .replace(/[\u200b-\u200d\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s/g, '')
    .replace(/^@+/, '')
    .trim();
  // Log-safe forms (Sonar S5145 log injection, S6324 control chars):
  // anything interpolated into a log line is reduced to an allowlist
  // first, so no newline, carriage return, or escape sequence from
  // user input or an external API response can forge a log line.
  // The discovery itself keeps using cleanUser unchanged.
  const logSafe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
  const logUser = logSafe(cleanUser);

  if (!cleanUser) {
    return { ok: false, reason: 'invalid_source_username' };
  }

  const profileUrl = buildTiktokProfileUrl(cleanUser);
  if (!profileUrl) {
    return { ok: false, reason: 'invalid_source_username' };
  }

  // Rotating proxy for the profile-URL attempts (discovery metadata).
  // Never logged.
  const resolveProxy = String(process.env.COUNTIK_PROXY_URL || '').trim();

  console.log(
    `🔍 TikTok yt-dlp: profile URL for @${logUser}${resolveProxy ? ' via proxy' : ' (no proxy configured)'} — up to ${MAX_PROFILE_ATTEMPTS} attempts.`,
  );
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= MAX_PROFILE_ATTEMPTS; attempt += 1) {
    const result = await runDiscoveryTarget(profileUrl, maxCount, { proxy: resolveProxy }, logUser);
    if (result.ok) {
      return result;
    }
    lastReason = result.reason;
    if (attempt < MAX_PROFILE_ATTEMPTS) {
      console.log(
        `🔁 TikTok yt-dlp attempt ${attempt} of ${MAX_PROFILE_ATTEMPTS} failed for @${logUser}; retrying in ${RETRY_DELAY_MS / 1000}s...`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.warn(`⚠️ All TikTok yt-dlp profile attempts failed for @${logUser} (${lastReason})`);
  return { ok: false, reason: lastReason };
}
