/**
 * Parse yt-dlp --flat-playlist -J output into platform-native reel/video/short IDs.
 */

function normalizeEntries(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  if (Array.isArray(payload.entries)) {
    return payload.entries.filter(Boolean);
  }

  if (payload.id || payload.url || payload.webpage_url) {
    return [payload];
  }

  return [];
}

function idFromUrl(url, platform) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const withoutQuery = url.split('?')[0];

  if (platform === 'tiktok') {
    const match = withoutQuery.match(/\/video\/([^/?#]+)/);
    return match?.[1] || null;
  }

  if (platform === 'youtube') {
    const match = withoutQuery.match(/\/shorts\/([^/?#]+)/);
    return match?.[1] || null;
  }

  return null;
}

/**
 * Checks if string is an internal ByteDance video asset ID (matches video_downloader/scraper.py).
 * E.g. vid:v12044... or v[0-9a-zA-Z]{15,}
 */
export function isInternalVidId(text) {
  if (!text || typeof text !== 'string') {
    return true;
  }
  const clean = text.trim();
  return clean.startsWith('vid:') || /^v[0-9a-zA-Z]{15,}$/.test(clean);
}

function extractEntryId(entry, platform) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const rawId = entry.id;
  if (typeof rawId === 'string' && rawId.trim()) {
    const cleanId = rawId.trim();
    if (platform === 'tiktok' && isInternalVidId(cleanId)) {
      // Ignore internal asset ID and check url instead
    } else {
      return cleanId;
    }
  }

  const url = entry.url || entry.webpage_url || entry.original_url;
  const id = idFromUrl(url, platform);
  if (platform === 'tiktok' && isInternalVidId(id)) {
    return null;
  }
  return id;
}

export function extractIdsFromYtdlpJson(payload, platform, maxCount) {
  const p = (platform || '').toLowerCase();
  const limit = Math.max(1, maxCount || 1000);
  const entries = normalizeEntries(payload);
  const ids = [];
  const seen = new Set();

  for (const entry of entries) {
    const id = extractEntryId(entry, p);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) {
      break;
    }
  }

  return ids;
}
