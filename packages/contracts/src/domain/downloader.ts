import { z } from 'zod';
import { MediaItemResponseSchema } from './media.js';

export const MAX_MEDIA_DOWNLOAD_BYTES = 524_288_000; // 500 MB

export const DownloaderSourcePlatformValues = [
  'tiktok',
  'facebook',
  'instagram',
  'x',
  'youtube',
  'google_drive',
  'dropbox',
  'direct',
  'web',
] as const;

export const DownloaderSourcePlatformSchema = z.enum(DownloaderSourcePlatformValues);

export type DownloaderSourcePlatform = z.infer<typeof DownloaderSourcePlatformSchema>;

const DIRECT_MEDIA_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function detectSourcePlatform(rawUrl: string): DownloaderSourcePlatform {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_e) {
    return 'web';
  }

  const host = parsed.hostname.toLowerCase();

  if (matchesDomain(host, 'tiktok.com') || matchesDomain(host, 'tiktokv.com')) {
    return 'tiktok';
  }
  if (
    matchesDomain(host, 'facebook.com') ||
    matchesDomain(host, 'fb.watch') ||
    matchesDomain(host, 'fb.com') ||
    matchesDomain(host, 'fbcdn.net')
  ) {
    return 'facebook';
  }
  if (
    matchesDomain(host, 'instagram.com') ||
    matchesDomain(host, 'instagr.am') ||
    matchesDomain(host, 'cdninstagram.com')
  ) {
    return 'instagram';
  }
  if (
    matchesDomain(host, 'x.com') ||
    matchesDomain(host, 'twitter.com') ||
    matchesDomain(host, 't.co') ||
    matchesDomain(host, 'fxtwitter.com') ||
    matchesDomain(host, 'vxtwitter.com') ||
    matchesDomain(host, 'twimg.com')
  ) {
    return 'x';
  }
  if (matchesDomain(host, 'youtube.com') || matchesDomain(host, 'youtu.be')) {
    return 'youtube';
  }
  if (
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    matchesDomain(host, 'googleusercontent.com') ||
    host === 'drive.usercontent.google.com'
  ) {
    return 'google_drive';
  }
  if (matchesDomain(host, 'dropbox.com') || matchesDomain(host, 'dropboxusercontent.com')) {
    return 'dropbox';
  }

  const pathname = parsed.pathname.toLowerCase();
  const lastDot = pathname.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = pathname.slice(lastDot);
    if (DIRECT_MEDIA_EXTENSIONS.has(ext)) {
      return 'direct';
    }
  }

  return 'web';
}

export function normalizeCloudDriveUrl(url: URL): string {
  const host = url.hostname.toLowerCase();

  if (host === 'drive.google.com') {
    const fileMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
    if (fileMatch?.[1]) {
      return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
    }
    const queryId = url.searchParams.get('id');
    if (url.pathname === '/open' && queryId) {
      return `https://drive.google.com/uc?export=download&id=${queryId}`;
    }
  }

  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    const cloned = new URL(url.toString());
    cloned.searchParams.set('dl', '1');
    return cloned.toString();
  }

  return url.toString();
}

export function resolveGoogleDriveDirectUrl(rawUrl: string, htmlContent?: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    let fileId: string | null = null;
    const fileMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(parsed.pathname);
    if (fileMatch?.[1]) {
      fileId = fileMatch[1];
    } else {
      fileId = parsed.searchParams.get('id');
    }
    if (!fileId) return null;

    let confirmToken = 't';
    if (htmlContent) {
      const confirmMatch = /confirm=([0-9a-zA-Z_-]+)/.exec(htmlContent);
      if (confirmMatch?.[1]) {
        confirmToken = confirmMatch[1];
      }
    }
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirmToken}`;
  } catch {
    return null;
  }
}

export interface RemoteMediaCandidate {
  streamUrl: string;
  thumbnailUrl?: string | null | undefined;
  caption?: string | null | undefined;
  fileName?: string | null | undefined;
  mediaTypeHint?: 'video' | 'image' | undefined;
  durationSeconds?: number | null | undefined;
  aspectRatio?: string | null | undefined;
}

export interface ParsedHtmlMedia {
  candidates: RemoteMediaCandidate[];
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim();
}

function isAttributeNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 58 ||
    code === 45
  );
}

function readAttrNameBeforeEquals(text: string, eqIdx: number): string {
  let pos = eqIdx - 1;
  while (pos >= 0 && text.codePointAt(pos) === 32) {
    pos -= 1;
  }
  const nameEnd = pos + 1;
  while (pos >= 0 && isAttributeNameChar(text.codePointAt(pos) ?? 0)) {
    pos -= 1;
  }
  return text.slice(pos + 1, nameEnd).toLowerCase();
}

function readQuotedAttrValueAfterEquals(
  text: string,
  eqIdx: number
): { value: string; nextIndex: number } | null {
  let pos = eqIdx + 1;
  while (pos < text.length && text.codePointAt(pos) === 32) {
    pos += 1;
  }
  const quoteChar = text[pos];
  if (quoteChar !== '"' && quoteChar !== "'") {
    return null;
  }
  const closeIdx = text.indexOf(quoteChar, pos + 1);
  if (closeIdx === -1) {
    return null;
  }
  return {
    value: text.slice(pos + 1, closeIdx),
    nextIndex: closeIdx + 1,
  };
}

function parseMetaTagAttributes(tag: string): Record<string, string> {
  const normalized = tag.replaceAll(/\s+/g, ' ');
  const attrs: Record<string, string> = {};
  let searchFrom = 0;

  while (searchFrom < normalized.length) {
    const eqIdx = normalized.indexOf('=', searchFrom);
    if (eqIdx === -1) {
      break;
    }
    const attrName = readAttrNameBeforeEquals(normalized, eqIdx);
    const quoted = readQuotedAttrValueAfterEquals(normalized, eqIdx);
    if (!quoted) {
      searchFrom = eqIdx + 1;
      continue;
    }
    if (attrName) {
      attrs[attrName] = quoted.value;
    }
    searchFrom = quoted.nextIndex;
  }

  return attrs;
}

function extractMetaValues(html: string, keys: string[]): string[] {
  const results: string[] = [];
  const metaTagRegex = /<meta\b[^>]*>/gi;
  const keySet = new Set(keys.map((k) => k.toLowerCase()));

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = metaTagRegex.exec(html)) !== null) {
    const attrs = parseMetaTagAttributes(tagMatch[0]);
    const prop = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').toLowerCase();
    const content = attrs.content ? decodeHtmlEntities(attrs.content) : '';
    if (prop && content && keySet.has(prop)) {
      results.push(content);
    }
  }

  return results;
}

function resolveRelativeUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const val of values) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val;
    }
  }
  return null;
}

interface HtmlMediaAccumulator {
  videoUrls: string[];
  imageUrls: string[];
  thumbnailUrls: string[];
  captions: string[];
}

function appendResolvedUrl(target: string[], rawUrl: string | null, baseUrl: string): void {
  if (!rawUrl) {
    return;
  }
  const resolved = resolveRelativeUrl(rawUrl, baseUrl);
  if (resolved) {
    target.push(resolved);
  }
}

function extractJsonLdCaption(record: Record<string, unknown>, captions: string[]): void {
  const rawText = firstNonEmptyString(record.description, record.name, record.headline);
  if (rawText) {
    captions.push(decodeHtmlEntities(rawText));
  }
}

function extractJsonLdThumbnails(
  record: Record<string, unknown>,
  baseUrl: string,
  thumbnails: string[]
): void {
  if (typeof record.thumbnailUrl === 'string') {
    appendResolvedUrl(thumbnails, record.thumbnailUrl, baseUrl);
    return;
  }
  if (Array.isArray(record.thumbnailUrl)) {
    for (const item of record.thumbnailUrl) {
      if (typeof item === 'string') {
        appendResolvedUrl(thumbnails, item, baseUrl);
      }
    }
  }
}

function extractJsonLdMediaStream(
  record: Record<string, unknown>,
  baseUrl: string,
  acc: HtmlMediaAccumulator
): void {
  const typeVal = typeof record['@type'] === 'string' ? record['@type'].toLowerCase() : '';
  const streamCandidate = firstNonEmptyString(record.contentUrl, record.url);
  if (typeVal.includes('video')) {
    appendResolvedUrl(acc.videoUrls, streamCandidate, baseUrl);
  } else if (typeVal.includes('image')) {
    appendResolvedUrl(acc.imageUrls, streamCandidate, baseUrl);
  }
}

const JSON_LD_NESTED_KEYS = [
  '@graph',
  'video',
  'image',
  'hasPart',
  'sharedContent',
  'associatedMedia',
] as const;

function parseJsonLdNodes(node: unknown, baseUrl: string, acc: HtmlMediaAccumulator): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      parseJsonLdNodes(item, baseUrl, acc);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  extractJsonLdCaption(record, acc.captions);
  extractJsonLdThumbnails(record, baseUrl, acc.thumbnailUrls);
  extractJsonLdMediaStream(record, baseUrl, acc);

  for (const nestedKey of JSON_LD_NESTED_KEYS) {
    if (record[nestedKey]) {
      parseJsonLdNodes(record[nestedKey], baseUrl, acc);
    }
  }
}

function extractJsonLdBlocksFromHtml(
  html: string,
  baseUrl: string,
  acc: HtmlMediaAccumulator
): void {
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = jsonLdRegex.exec(html)) !== null) {
    const rawJson = scriptMatch[1]?.trim();
    if (!rawJson) {
      continue;
    }
    try {
      const parsedJson: unknown = JSON.parse(rawJson);
      parseJsonLdNodes(parsedJson, baseUrl, acc);
    } catch {
      // Ignore malformed JSON-LD script blocks
    }
  }
}

function extractHtmlVideoTags(html: string, baseUrl: string, videoUrls: string[]): void {
  const videoSrcRegex = /<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let videoMatch: RegExpExecArray | null;
  while ((videoMatch = videoSrcRegex.exec(html)) !== null) {
    const src = videoMatch[1];
    if (src) {
      appendResolvedUrl(videoUrls, decodeHtmlEntities(src), baseUrl);
    }
  }
}

function deduplicateUrlsByHttpsKey(urls: string[]): string[] {
  const unique: string[] = [];
  const seenKeys = new Set<string>();
  for (const rawUrl of urls) {
    const canonicalKey = rawUrl.replace(/^http:\/\//i, 'https://');
    if (!seenKeys.has(canonicalKey)) {
      seenKeys.add(canonicalKey);
      unique.push(rawUrl);
    }
  }
  return unique;
}

function extractTitleTagFallback(html: string): string | null {
  const titleMatch = /<title\b[^>]*>([^<]+)<\/title>/i.exec(html);
  if (!titleMatch?.[1]) {
    return null;
  }
  const cleanedTitle = decodeHtmlEntities(titleMatch[1]);
  return cleanedTitle.length > 0 ? cleanedTitle : null;
}

export function parseHtmlMediaCandidates(html: string, baseUrl: string): ParsedHtmlMedia {
  const acc: HtmlMediaAccumulator = {
    videoUrls: [],
    imageUrls: [],
    thumbnailUrls: [],
    captions: [],
  };

  const metaDescriptions = extractMetaValues(html, [
    'og:description',
    'twitter:description',
    'description',
  ]);
  const metaTitles = extractMetaValues(html, ['og:title', 'twitter:title']);
  acc.captions.push(...metaDescriptions, ...metaTitles);

  const ogVideos = extractMetaValues(html, [
    'og:video:secure_url',
    'og:video:url',
    'og:video',
    'twitter:player:stream',
  ]);
  for (const v of ogVideos) {
    appendResolvedUrl(acc.videoUrls, v, baseUrl);
  }

  const ogImages = extractMetaValues(html, [
    'og:image:secure_url',
    'og:image:url',
    'og:image',
    'twitter:image',
    'twitter:image:src',
  ]);
  for (const img of ogImages) {
    appendResolvedUrl(acc.imageUrls, img, baseUrl);
  }

  extractJsonLdBlocksFromHtml(html, baseUrl, acc);
  extractHtmlVideoTags(html, baseUrl, acc.videoUrls);

  if (acc.captions.length === 0) {
    const fallbackTitle = extractTitleTagFallback(html);
    if (fallbackTitle) {
      acc.captions.push(fallbackTitle);
    }
  }

  const primaryCaption = acc.captions.find((c) => c.trim().length > 0)?.trim() ?? null;
  const uniqueVideos = deduplicateUrlsByHttpsKey(acc.videoUrls);
  const uniqueImages = deduplicateUrlsByHttpsKey(acc.imageUrls);

  if (uniqueVideos.length > 0) {
    const defaultThumb = acc.thumbnailUrls[0] ?? uniqueImages[0] ?? null;
    return {
      candidates: uniqueVideos.map((streamUrl, idx) => ({
        streamUrl,
        thumbnailUrl: acc.thumbnailUrls[idx] ?? defaultThumb,
        caption: primaryCaption,
        mediaTypeHint: 'video',
      })),
    };
  }

  if (uniqueImages.length > 0) {
    return {
      candidates: uniqueImages.map((streamUrl) => ({
        streamUrl,
        thumbnailUrl: null,
        caption: primaryCaption,
        mediaTypeHint: 'image',
      })),
    };
  }

  return { candidates: [] };
}

function classifyMediaTypeHint(rawType: unknown): 'video' | 'image' | undefined {
  if (typeof rawType !== 'string') {
    return undefined;
  }
  const lower = rawType.toLowerCase();
  if (lower === 'photo' || lower === 'image') {
    return 'image';
  }
  if (lower === 'video' || lower === 'gif') {
    return 'video';
  }
  return undefined;
}

function parsePickerArrayItem(
  rawItem: unknown,
  topThumb: string | null,
  topCaption: string | null
): RemoteMediaCandidate | null {
  if (!rawItem || typeof rawItem !== 'object') {
    return null;
  }
  const item = rawItem as Record<string, unknown>;
  const streamUrl = firstNonEmptyString(item.url, item.streamUrl);
  if (!streamUrl) {
    return null;
  }

  return {
    streamUrl,
    thumbnailUrl: firstNonEmptyString(item.thumb, item.thumbnailUrl, item.thumbnail) ?? topThumb,
    caption: firstNonEmptyString(item.caption, item.title) ?? topCaption,
    fileName: firstNonEmptyString(item.filename),
    mediaTypeHint: classifyMediaTypeHint(item.type),
  };
}

function extractTweetMediaList(mediaObj: Record<string, unknown> | null): unknown[] {
  if (!mediaObj) {
    return [];
  }
  if (Array.isArray(mediaObj.all)) {
    return mediaObj.all as unknown[];
  }
  const videos = Array.isArray(mediaObj.videos) ? (mediaObj.videos as unknown[]) : [];
  const photos = Array.isArray(mediaObj.photos) ? (mediaObj.photos as unknown[]) : [];
  return [...videos, ...photos];
}

function parseTweetCandidatesFromObject(
  tweet: Record<string, unknown>,
  topCaption: string | null
): RemoteMediaCandidate[] {
  const tweetText = firstNonEmptyString(tweet.text) ?? topCaption;
  const mediaObj =
    tweet.media && typeof tweet.media === 'object'
      ? (tweet.media as Record<string, unknown>)
      : null;
  const mediaList = extractTweetMediaList(mediaObj);

  const tweetCandidates: RemoteMediaCandidate[] = [];
  for (const entry of mediaList) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const m = entry as Record<string, unknown>;
    const streamUrl = firstNonEmptyString(m.url);
    if (!streamUrl) {
      continue;
    }
    const hint = classifyMediaTypeHint(m.type) ?? 'video';
    tweetCandidates.push({
      streamUrl,
      thumbnailUrl: firstNonEmptyString(m.thumbnail_url),
      caption: tweetText,
      mediaTypeHint: hint,
      durationSeconds: typeof m.duration === 'number' ? m.duration : null,
    });
  }
  return tweetCandidates;
}

export function parseJsonPayloadCandidates(payload: unknown): RemoteMediaCandidate[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const data = payload as Record<string, unknown>;
  const topCaption = firstNonEmptyString(data.caption, data.title, data.description);
  const topThumb = firstNonEmptyString(data.thumbnail, data.thumbnailUrl, data.thumb);

  let arrayField: unknown[] | null = null;
  if (Array.isArray(data.picker)) {
    arrayField = data.picker;
  } else if (Array.isArray(data.items)) {
    arrayField = data.items;
  }

  if (arrayField && arrayField.length > 0) {
    const candidates = arrayField
      .map((rawItem) => parsePickerArrayItem(rawItem, topThumb, topCaption))
      .filter((item): item is RemoteMediaCandidate => item !== null);
    if (candidates.length > 0) {
      return candidates;
    }
  }

  if (data.tweet && typeof data.tweet === 'object') {
    const tweetCandidates = parseTweetCandidatesFromObject(
      data.tweet as Record<string, unknown>,
      topCaption
    );
    if (tweetCandidates.length > 0) {
      return tweetCandidates;
    }
  }

  const singleUrl = firstNonEmptyString(data.url, data.streamUrl);
  if (singleUrl) {
    return [
      {
        streamUrl: singleUrl,
        thumbnailUrl: topThumb,
        caption: topCaption,
        fileName: firstNonEmptyString(data.filename),
        durationSeconds: typeof data.duration === 'number' ? data.duration : null,
        aspectRatio: firstNonEmptyString(data.aspectRatio),
      },
    ];
  }

  return [];
}

function isDocumentationOrBenchmarkIpv4(a: number, b: number, c: number): boolean {
  if (a === 192 && b === 0) {
    return c === 0 || c === 2;
  }
  if (a === 198) {
    return b === 18 || b === 19 || (b === 51 && c === 100);
  }
  return a === 203 && b === 0 && c === 113;
}

function isPrivateOrReservedIpv4(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return true;
  }
  if (a === 100) {
    return b >= 64 && b <= 127;
  }
  if (a === 169) {
    return b === 254;
  }
  if (a === 172) {
    return b >= 16 && b <= 31;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return isDocumentationOrBenchmarkIpv4(a, b, c);
}

function isUnsafeIpv6(rawIpv6: string): boolean {
  const normalized = rawIpv6.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '0:0:0:0:0:0:0:0'
  ) {
    return true;
  }

  // Unique local (fc00::/7 -> fc.. or fd..)
  if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) {
    return true;
  }

  // Link-local (fe80::/10 -> fe8., fe9., fea., feb.)
  if (/^fe[89ab][0-9a-f]?:/.test(normalized)) {
    return true;
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) {
    return true;
  }

  // IPv4-mapped or IPv4-compatible IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const v4MappedPrefix = '::ffff:';
  if (normalized.startsWith(v4MappedPrefix)) {
    const tail = normalized.slice(v4MappedPrefix.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) {
      const parts = tail.split('.').map((part) => Number.parseInt(part, 10));
      if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return true;
      }
      return isPrivateOrReservedIpv4(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
    }

    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const high = Number.parseInt(hexParts[0]!, 16);
      const low = Number.parseInt(hexParts[1]!, 16);
      if (Number.isNaN(high) || Number.isNaN(low)) {
        return true;
      }
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return isPrivateOrReservedIpv4(a, b, c, d);
    }
    return true;
  }

  return false;
}

export interface SafeUrlValidationResult {
  valid: boolean;
  url?: URL;
  reason?: string;
}

function stripTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 46) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isLocalHostname(rawHost: string): boolean {
  return (
    rawHost === 'localhost' ||
    rawHost.endsWith('.localhost') ||
    rawHost.endsWith('.local') ||
    rawHost.endsWith('.internal')
  );
}

function validateIpv4Host(rawHost: string): string | null {
  const octets = rawHost.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return 'Invalid IPv4 address in link.';
  }
  if (isPrivateOrReservedIpv4(octets[0]!, octets[1]!, octets[2]!, octets[3]!)) {
    return 'Private and loopback network addresses are not allowed.';
  }
  return null;
}

function validateParsedHostSafety(rawHost: string): string | null {
  if (!rawHost || isLocalHostname(rawHost)) {
    return rawHost
      ? 'Local and internal network addresses are not allowed.'
      : 'Please enter a valid link with a public domain.';
  }

  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    const ipv6Inner = rawHost.slice(1, -1);
    return isUnsafeIpv6(ipv6Inner)
      ? 'Private and loopback network addresses are not allowed.'
      : null;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rawHost)) {
    return validateIpv4Host(rawHost);
  }

  if (!rawHost.includes('.')) {
    return 'Please enter a valid link with a public domain.';
  }

  return null;
}

export function validateSafeRemoteUrl(rawUrl: string): SafeUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) {
    return {
      valid: false,
      reason: 'Please enter a valid link starting with http:// or https://.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      reason: 'Please enter a valid link starting with http:// or https://.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: 'Only http:// and https:// links are supported.',
    };
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      valid: false,
      reason: 'Links containing embedded credentials are not allowed.',
    };
  }

  const rawHost = stripTrailingDots(parsed.hostname.toLowerCase());
  const hostError = validateParsedHostSafety(rawHost);
  if (hostError) {
    return {
      valid: false,
      reason: hostError,
    };
  }

  return { valid: true, url: parsed };
}

export interface BatchUrlDeduplicationResult {
  urls: string[];
  duplicateCount: number;
  invalidUrls: string[];
  invalidLines: string[];
}

export function deduplicateBatchUrls(rawInput: string): BatchUrlDeduplicationResult {
  const lines = rawInput.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const seen = new Set<string>();
  const urls: string[] = [];
  const invalidUrls: string[] = [];
  let duplicateCount = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const validation = validateSafeRemoteUrl(trimmed);
    if (!validation.valid || !validation.url) {
      invalidUrls.push(trimmed);
      continue;
    }

    const normalized = validation.url.toString();
    if (seen.has(normalized)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(normalized);
    urls.push(normalized);
  }

  return {
    urls,
    duplicateCount,
    invalidUrls,
    invalidLines: invalidUrls,
  };
}

export const DownloaderIngestRequestSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, 'Please enter a valid link starting with http:// or https://.')
    .max(2048, 'Link must be 2048 characters or fewer.'),
  folderId: z.string().uuid().nullable().optional(),
});

export type DownloaderIngestRequest = z.infer<typeof DownloaderIngestRequestSchema>;

export const DownloaderIngestResponseSchema = z.object({
  sourceUrl: z.string().url(),
  platform: DownloaderSourcePlatformSchema,
  items: z.array(MediaItemResponseSchema).min(1),
});

export type DownloaderIngestResponse = z.infer<typeof DownloaderIngestResponseSchema>;

// Persistent download-job contracts live in ./download-jobs.js (spec 149).
// This file keeps only the resolve/ingest engine contracts; the job shapes
// moved there so there is exactly one jobs model.

