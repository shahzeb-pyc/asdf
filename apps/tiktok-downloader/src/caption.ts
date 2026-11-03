/**
 * Port of `apps/adu-downloader/caption_utils.py::normalize_reel_caption`
 * (itself identical to the old service's version). Empty, placeholder,
 * generic, and ID-like captions become the default reel caption.
 * Behaviour is pinned by caption.test.ts; do not "improve" it here.
 */

export const DEFAULT_REEL_CAPTION = '❤️';

const PLACEHOLDER_CAPTIONS = new Set(['...', '…', '.', '-', 'n/a', 'na', 'none', '']);

const GENERIC_TITLE_PATTERNS = [
  /^instagram\s*reel\s*#?\d*$/i,
  /^tiktok\s*#?\d*$/i,
  /^youtube\s*shorts?$/i,
  /^reel\s*#?\d*$/i,
  /^video\s*#?\d*$/i,
];

const PLATFORM_PREFIXES = '(?:video|tiktok|facebook|instagram|youtube|reel|post|id|photo|audio|shorts|clip)';

function stripChars(text: string, chars: string): string {
  const escaped = chars.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return text.replace(new RegExp(`^[${escaped}]+|[${escaped}]+$`, 'g'), '');
}

function looksLikePlatformId(text: string, reelExternalId: string | null): boolean {
  const candidate = text.trim();
  if (!candidate) {
    return true;
  }

  // 1. Matches or contains the reel id plus only generic words.
  if (reelExternalId) {
    const reelId = reelExternalId.trim();
    if (candidate.toLowerCase().includes(reelId.toLowerCase())) {
      const rem = stripChars(
        candidate.toLowerCase().split(reelId.toLowerCase()).join(''),
        ' _-#',
      );
      if (
        !rem ||
        ['video', 'reel', 'tiktok', 'facebook', 'instagram', 'youtube', 'shorts', 'id', 'post', 'photo', 'audio'].includes(rem)
      ) {
        return true;
      }
    }
  }

  // 2. A pure numeric ID (length >= 5).
  if (/^\d{5,}$/.test(candidate)) {
    return true;
  }

  // 3. Typical platform video/post ID formats.
  if (new RegExp(`^${PLATFORM_PREFIXES}[_\\s-]+\\d+$`, 'i').test(candidate)) {
    return true;
  }
  if (new RegExp(`^${PLATFORM_PREFIXES}[_\\s-]*id[_\\s-]+\\d+$`, 'i').test(candidate)) {
    return true;
  }

  // 4. A single alphanumeric token of length 11-32 that is heavily
  // numeric/ID-like.
  if (!candidate.includes(' ') && /^[A-Za-z0-9_-]+$/.test(candidate)) {
    if (
      [32, 40, 64].includes(candidate.length) &&
      /^[a-fA-F0-9]+$/.test(candidate)
    ) {
      return true;
    }
    if (candidate.length >= 11 && candidate.length <= 32) {
      const numDigits = [...candidate].filter((c) => c >= '0' && c <= '9').length;
      const numLetters = [...candidate].filter(
        (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'),
      ).length;
      if (numLetters === 0) {
        return true;
      }
      const letterRuns = candidate.match(/[a-zA-Z]{4,}/g);
      if (!letterRuns) {
        return true;
      }
      if (candidate.length >= 15 && numDigits >= 2) {
        return true;
      }
    }
  }

  return false;
}

export function normalizeReelCaption(
  raw: string | null | undefined,
  reelExternalId: string | null = null,
): string {
  const text = (raw ?? '').trim();
  if (!text || PLACEHOLDER_CAPTIONS.has(text.toLowerCase())) {
    return DEFAULT_REEL_CAPTION;
  }

  if (looksLikePlatformId(text, reelExternalId)) {
    return DEFAULT_REEL_CAPTION;
  }

  const lowered = stripChars(text.toLowerCase(), '# ');
  if (
    ['video', 'reel', 'untitled', 'tiktok', 'instagram reel', 'youtube shorts', 'shorts'].includes(lowered)
  ) {
    return DEFAULT_REEL_CAPTION;
  }

  for (const pattern of GENERIC_TITLE_PATTERNS) {
    if (pattern.test(lowered)) {
      return DEFAULT_REEL_CAPTION;
    }
  }

  return text;
}
