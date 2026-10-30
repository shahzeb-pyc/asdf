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

export const SCRAPER_CONFIG = {
  SCROLL_PAUSE: 2000,
  MAX_SAME_HEIGHT: 44,
  MAX_REELS_PER_PLATFORM: boundedInt(process.env.MAX_REELS_PER_PLATFORM, 1000, { min: 1, max: 10000 }),
};

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

/** TikTok-only yt-dlp discovery (see main-scraper/scrapers/tiktok-ytdlp.js). */
export const YTDLP_CONFIG = {
  BIN: process.env.YTDLP_BIN || 'yt-dlp',
  TIMEOUT_MS: boundedInt(process.env.YTDLP_TIMEOUT_MS, 600_000, { min: 10_000, max: 600_000 }),
};
