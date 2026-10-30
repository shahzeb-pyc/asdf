import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { YTDLP_CONFIG } from '../config.js';
import { buildTiktokProfileUrl, supportsYtdlpDiscovery } from './profile-urls.js';
import { buildTiktokYtdlpArgs } from './ytdlp-args.js';
import { resolveTiktokSecUid } from './sec-uid.js';
import { extractIdsFromYtdlpJson } from './extract-ids.js';

const execFileAsync = promisify(execFile);

const EXEC_OPTS_BASE = {
  maxBuffer: 50 * 1024 * 1024,
};

function getCandidateBinaries() {
  const bins = [];
  if (YTDLP_CONFIG.BIN) bins.push(YTDLP_CONFIG.BIN);
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
    timeout: YTDLP_CONFIG.TIMEOUT_MS,
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
 * Discover TikTok video IDs via yt-dlp matching video_downloader/scraper.py pattern:
 * 1. Resolves sec_uid via Countik API.
 * 2. Targets `tiktokuser:{sec_uid}` first (queries mobile feed directly, bypassing captcha).
 * 3. Falls back to `https://www.tiktok.com/@{username}` if sec_uid unavailable or empty.
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
  // The discovery itself keeps using cleanUser/secUid unchanged.
  const logSafe = (value) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128);
  const logUser = logSafe(cleanUser);

  if (!cleanUser) {
    return { ok: false, reason: 'invalid_source_username' };
  }

  const profileUrl = buildTiktokProfileUrl(cleanUser);
  const targetUrls = [];

  // Try sec_uid resolution first (matches video_downloader/scraper.py)
  console.log(`🔍 Resolving TikTok sec_uid for @${logUser}...`);
  const secUid = await resolveTiktokSecUid(cleanUser);
  if (secUid) {
    console.log(`✅ Resolved sec_uid for @${logUser}: ${logSafe(secUid)}`);
    targetUrls.push(`tiktokuser:${secUid}`);
  } else {
    console.log(`ℹ️ No sec_uid resolved for @${logUser}; using standard profile URL.`);
  }

  if (profileUrl && !targetUrls.includes(profileUrl)) {
    targetUrls.push(profileUrl);
  }

  let lastDetail = 'unknown_error';

  for (const targetUrl of targetUrls) {
    const args = buildTiktokYtdlpArgs(targetUrl, maxCount);
    console.log(`📡 TikTok yt-dlp discovery: ${targetUrl}`);

    let stdout;
    try {
      stdout = await runYtDlp(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = err.stderr?.toString?.() || '';
      lastDetail = stderr.trim().slice(-500) || message;
      console.warn(`⚠️ TikTok yt-dlp target ${targetUrl} failed: ${lastDetail}`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch (parseErr) {
      const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.warn(`⚠️ TikTok yt-dlp returned invalid JSON for ${targetUrl}: ${message}`);
      lastDetail = 'unparseable_json';
      continue;
    }

    const ids = extractIdsFromYtdlpJson(payload, 'tiktok', maxCount);
    if (ids.length > 0) {
      console.log(`✅ TikTok yt-dlp discovered ${ids.length} ID(s) for @${logUser} via ${targetUrl}`);
      return { ok: true, ids };
    }

    console.warn(`⚠️ TikTok yt-dlp returned zero valid IDs for ${targetUrl}; trying next target...`);
    lastDetail = 'empty_result';
  }

  console.warn(`⚠️ All TikTok discovery targets failed for @${logUser} (${lastDetail})`);
  return { ok: false, reason: lastDetail };
}
