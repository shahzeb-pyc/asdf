/**
 * Mime + filename logic — the canonical location, imported by the web
 * orchestrator and the Cloudflare download consumer alike. Pure
 * string/regex logic; no DOM, no filesystem, no Node APIs, so it
 * bundles in a Worker without nodejs_compat.
 */
import {
  AllowedMediaMimeTypes,
} from '@fbuploadpro/contracts';

export type AllowedMediaMime = (typeof AllowedMediaMimeTypes)[number];

const EXTENSION_TO_MIME: Record<string, AllowedMediaMime> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const MIME_TO_EXTENSION: Record<AllowedMediaMime, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const ALLOWED_MIME_SET = new Set<string>(AllowedMediaMimeTypes);

function inferMimeFromPathOrName(pathOrName: string): AllowedMediaMime | null {
  const lower = pathOrName.toLowerCase().split('?')[0]?.split('#')[0] ?? '';
  const dotIndex = lower.lastIndexOf('.');
  if (dotIndex === -1) {
    return null;
  }
  const ext = lower.slice(dotIndex);
  return EXTENSION_TO_MIME[ext] ?? null;
}

export function resolveAllowedMimeType(
  contentTypeHeader: string | null,
  targetUrl: string,
  fileNameHint?: string | null,
  mediaTypeHint?: 'video' | 'image'
): AllowedMediaMime | null {
  const rawMime = (contentTypeHeader ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (rawMime === 'image/jpg') {
    return 'image/jpeg';
  }
  if (rawMime === 'video/x-m4v') {
    return 'video/mp4';
  }
  if (ALLOWED_MIME_SET.has(rawMime)) {
    return rawMime as AllowedMediaMime;
  }

  if (
    rawMime.startsWith('text/html') ||
    rawMime.startsWith('application/xhtml+xml') ||
    rawMime.startsWith('application/json') ||
    rawMime.startsWith('text/plain')
  ) {
    return null;
  }

  if (fileNameHint) {
    const fromHint = inferMimeFromPathOrName(fileNameHint);
    if (fromHint) {
      return fromHint;
    }
  }

  try {
    const parsed = new URL(targetUrl);
    const fromUrl = inferMimeFromPathOrName(parsed.pathname);
    if (fromUrl) {
      return fromUrl;
    }
  } catch (_e) {
    // Ignore URL parse error and fall through to mediaTypeHint
  }

  if (
    (rawMime === '' ||
      rawMime === 'application/octet-stream' ||
      rawMime === 'binary/octet-stream') &&
    mediaTypeHint
  ) {
    return mediaTypeHint === 'video' ? 'video/mp4' : 'image/jpeg';
  }

  return null;
}

export function extractFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const utf8Match = /filename\*=UTF-8''([^;\r\n]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch (_e) {
      return utf8Match[1].trim();
    }
  }
  const quotedMatch = /filename="([^"\r\n]+)"/i.exec(header);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const plainMatch = /filename=([^;\r\n]+)/i.exec(header);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim();
  }
  return null;
}

export function sanitizeFileNameWithExtension(
  rawName: string | null | undefined,
  mimeType: AllowedMediaMime,
  fallbackBaseName: string
): string {
  const defaultExt = MIME_TO_EXTENSION[mimeType];
  const baseCandidate = (rawName ?? '').trim();

  let cleaned = baseCandidate
    .replaceAll(/[/\\?%*:|"<>]/g, '_')
    .replaceAll(/\s+/g, '_')
    .replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    .replaceAll(/_+/g, '_')
    .replace(/^[_.-]+/, '');

  if (!cleaned) {
    cleaned = fallbackBaseName;
  }

  const lower = cleaned.toLowerCase();
  const hasValidExt = Object.keys(EXTENSION_TO_MIME).some((ext) => lower.endsWith(ext));
  if (!hasValidExt) {
    cleaned = `${cleaned.slice(0, 200)}${defaultExt}`;
  } else if (cleaned.length > 240) {
    const dotIdx = cleaned.lastIndexOf('.');
    const ext = cleaned.slice(dotIdx);
    cleaned = `${cleaned.slice(0, 200)}${ext}`;
  } else {
    // Valid extension and within length: the name is already safe.
  }

  return cleaned;
}

export function deriveFileNameFromUrl(urlStr: string, index: number): string {
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
    const lastSegment = segments.at(-1);
    if (lastSegment) {
      const decoded = decodeURIComponent(lastSegment);
      if (decoded.length > 1 && decoded.length <= 180) {
        return decoded;
      }
    }
  } catch (_e) {
    // Use fallback name below
  }
  return index === 0 ? 'cloud_media' : `cloud_media_${index + 1}`;
}
