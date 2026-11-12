import dotenv from 'dotenv';
dotenv.config();

const toBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());

const boundedInt = (value, fallback, { min = 0, max = null } = {}) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (max !== null && parsed > max) {
    return max;
  }
  return parsed;
};

export const INSTAGRAM_CONFIG = {
  USERNAME: process.env.INSTAGRAM_USERNAME,
  PASSWORD: process.env.INSTAGRAM_PASSWORD,
};

export const SUPABASE_CONFIG = {
  URL: process.env.SUPABASE_URL,
  SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

export const FACEBOOK_CONFIG = {
    // Stall limit from the no-login spike (spec 158): stop scrolling
    // after this many consecutive scrolls with no new reels.
    STALL_LIMIT: 5,
    // Optional override for the headless-shell executable (spec 158).
    // Unset = Patchright's bundled chrome-headless-shell.
    EXECUTABLE_PATH: process.env.FACEBOOK_HEADLESS_SHELL_PATH || null,
};

export const SCRAPER_CONFIG = {
  SCROLL_PAUSE: 2000,
  MAX_SAME_HEIGHT: 44,
  MAX_REELS_PER_PLATFORM: boundedInt(process.env.MAX_REELS_PER_PLATFORM, 1000, { min: 1, max: 10000 }),
  // TikTok worker pool size (spec scraper-tikwm-first-concurrency §3):
  // measured N = 2 on the old VPS (nproc 2, 1034 MB free 2026-11-12 —
  // the N = 3 rule needs nproc >= 4 AND >= 2 GB free). Clamped 1–4;
  // a non-numeric value logs a loud warning and falls back to 2.
  TIKTOK_CONCURRENCY: tikTokConcurrency(),
};

function tikTokConcurrency() {
  const raw = process.env.TIKTOK_CONCURRENCY;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      console.warn(
        `⚠️ TIKTOK_CONCURRENCY=${JSON.stringify(String(raw).slice(0, 32))} is not a number — defaulting to 2 TikTok pool workers.`,
      );
      return 2;
    }
  }
  return Math.floor(boundedInt(raw, 2, { min: 1, max: 4 }));
}

let userDataDir = process.env.BROWSER_USER_DATA_DIR || '.browser-profile';
let profileDirectory = process.env.BROWSER_PROFILE_DIRECTORY || null;

// Normalize if user points directly to "User Data\Default" subfolder
if (userDataDir.match(/[/\\]Default$/i)) {
  userDataDir = userDataDir.replace(/[/\\]Default$/i, '');
  if (!profileDirectory) {
    profileDirectory = 'Default';
  }
}

export const BROWSER_CONFIG = {
  EXECUTABLE_PATH: process.env.BROWSER_EXECUTABLE_PATH || null,
  USER_DATA_DIR: userDataDir,
  PROFILE_DIRECTORY: profileDirectory,
  USER_AGENT: process.env.BROWSER_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

export const LOGIN_CONFIG = {
  SKIP_STARTUP_LOGINS: toBoolean(process.env.SKIP_STARTUP_LOGINS),
};
