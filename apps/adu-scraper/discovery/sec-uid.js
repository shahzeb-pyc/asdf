/**
 * TikTok sec_uid resolver via Countik API (matches video_downloader/scraper.py).
 * Resolving sec_uid allows yt-dlp to query TikTok's mobile feed directly via `tiktokuser:{sec_uid}`,
 * bypassing desktop captcha walls and 429 rate limits.
 */

const COUNTIK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function resolveTiktokSecUid(username, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const clean = String(username || '')
    .replace(/[\u200b-\u200d\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s/g, '')
    .replace(/^@+/, '')
    .trim();

  if (!clean) {
    return null;
  }

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
