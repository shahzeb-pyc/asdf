/**
 * TikTok yt-dlp arguments matching video_downloader/scraper.py.
 * Uses mobile iPhone UA and mobile browser headers to bypass 429 rate limits
 * and bot detection without requiring curl-cffi impersonation.
 */
export const DEFAULT_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** Backward-compatibility alias */
export const TIKTOK_YTDLP_USER_AGENT = DEFAULT_MOBILE_UA;

/**
 * Build argv for TikTok profile/user discovery via yt-dlp flat extract.
 * @param {string} targetUrl - Profile URL or `tiktokuser:{sec_uid}`
 * @param {number} maxItems
 * @param {string|object} [optsOrUa] - Options object or userAgent string
 */
export function buildTiktokYtdlpArgs(targetUrl, maxItems, optsOrUa = {}) {
  const limit = Math.max(1, maxItems || 1000);
  const options = typeof optsOrUa === 'string' ? { userAgent: optsOrUa } : (optsOrUa || {});
  const userAgent = options.userAgent || DEFAULT_MOBILE_UA;
  const proxy =
    options.proxy ||
    process.env.DATACENTER_PROXY ||
    process.env.PROXY_URL ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY;

  const args = [
    '--flat-playlist',
    '-J',
    '--no-warnings',
    '--quiet',
    '--playlist-items',
    `1:${limit}`,
    '--user-agent',
    userAgent,
    '--add-header',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    '--add-header',
    'Accept-Language: en-US,en;q=0.9',
    '--add-header',
    'Sec-Fetch-Dest: document',
    '--add-header',
    'Sec-Fetch-Mode: navigate',
    '--add-header',
    'Sec-Fetch-Site: none',
    '--add-header',
    'Sec-Fetch-User: ?1',
    '--add-header',
    'Upgrade-Insecure-Requests: 1',
    '--retries',
    '5',
    '--extractor-retries',
    '10',
    '--socket-timeout',
    '30',
    '--no-check-certificates',
  ];

  if (proxy && String(proxy).trim()) {
    args.push('--proxy', String(proxy).trim());
  }

  args.push(targetUrl);
  return args;
}
