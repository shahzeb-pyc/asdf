import { z } from 'zod';

export const PostFormatValues = ['text', 'image', 'reel', 'video', 'story'] as const;
export const PostFormatSchema = z.enum(PostFormatValues);
export type PostFormat = z.infer<typeof PostFormatSchema>;

/**
 * Facebook Reels cap: a reel's video may not exceed 90 seconds.
 * Overlong vertical videos are not reels at all — they queue as feed
 * videos instead (see coerceOverlongReelFormat), never blocked.
 */
export const FACEBOOK_REEL_MAX_DURATION_SECONDS = 90;

/**
 * Converts an overlong reel request into a feed video, before any
 * format validation runs. A reel whose video duration is known and
 * exceeds the Reels cap becomes a plain video post (platformFormat
 * null); anything else passes through unchanged. Unknown duration
 * never converts — the validator's own fail-open semantics for
 * missing media facts are preserved here.
 */
export function coerceOverlongReelFormat(
  platformFormat: string | null | undefined,
  durationSeconds: number | null | undefined
): string | null {
  if (
    platformFormat === 'reel' &&
    typeof durationSeconds === 'number' &&
    durationSeconds > FACEBOOK_REEL_MAX_DURATION_SECONDS
  ) {
    return null;
  }
  return platformFormat ?? null;
}

export interface GraphRateLimitTelemetry {
  appUsageMaxPct?: number | undefined;
  bucUsageMaxPct?: number | undefined;
  estimatedTimeToRegainAccessMinutes?: number | undefined;
}

export interface PublishResult {
  postId: string;
  telemetry?: GraphRateLimitTelemetry | undefined;
}

export interface MediaEligibilityInput {
  mediaType: 'video' | 'image';
  fileSize?: number | null | undefined;
  durationSeconds?: number | null | undefined;
  aspectRatio?: string | null | undefined;
}

export interface ValidatePostFormatInput {
  postFormat: PostFormat;
  caption?: string | null | undefined;
  firstComment?: string | null | undefined;
  linkUrl?: string | null | undefined;
  media?: MediaEligibilityInput | null | undefined;
}

export interface FormatValidationResult {
  valid: boolean;
  error?: string | undefined;
  warnings?: string[] | undefined;
}

function validateTextPost(caption?: string | null, linkUrl?: string | null, media?: MediaEligibilityInput | null): FormatValidationResult {
  if (media) {
    return { valid: false, error: 'Text posts cannot have attached media files.' };
  }
  const hasCaption = Boolean(caption && caption.trim().length > 0);
  const hasLinkUrl = Boolean(linkUrl && linkUrl.trim().length > 0);
  if (!hasCaption && !hasLinkUrl) {
    return { valid: false, error: 'Text posts require a non-empty caption or link URL.' };
  }
  return { valid: true };
}

function validateImagePost(media?: MediaEligibilityInput | null): FormatValidationResult {
  if (!media) {
    return { valid: false, error: 'Image posts require an attached image file.' };
  }
  if (media.mediaType !== 'image') {
    return { valid: false, error: 'Image posts require an image media asset, not a video.' };
  }
  return { valid: true };
}

function validateReelPost(media?: MediaEligibilityInput | null): FormatValidationResult {
  if (!media) {
    return { valid: false, error: 'Reels require an attached video file.' };
  }
  if (media.mediaType !== 'video') {
    return { valid: false, error: 'Reels require a video asset, not an image.' };
  }
  if (media.durationSeconds !== null && media.durationSeconds !== undefined && media.durationSeconds > FACEBOOK_REEL_MAX_DURATION_SECONDS) {
    return { valid: false, error: 'Reels cannot exceed 90 seconds. Choose Feed Video instead.' };
  }
  const warnings: string[] = [];
  if (media.aspectRatio && media.aspectRatio !== '9:16') {
    warnings.push('Reels perform best in 9:16 vertical aspect ratio.');
  }
  return { valid: true, ...(warnings.length > 0 ? { warnings } : {}) };
}

function validateVideoPost(media?: MediaEligibilityInput | null): FormatValidationResult {
  if (!media) {
    return { valid: false, error: 'Video posts require an attached video file.' };
  }
  if (media.mediaType !== 'video') {
    return { valid: false, error: 'Video posts require a video media asset, not an image.' };
  }
  return { valid: true };
}

function validateStoryPost(
  media?: MediaEligibilityInput | null,
  firstComment?: string | null
): FormatValidationResult {
  if (!media) {
    return { valid: false, error: 'Facebook Stories require an attached media file.' };
  }
  if (firstComment && firstComment.trim().length > 0) {
    return { valid: false, error: 'Facebook Stories do not support comments.' };
  }
  if (media.mediaType === 'image') {
    const isOver10Mb = media.fileSize !== null && media.fileSize !== undefined && media.fileSize > 10 * 1024 * 1024;
    if (isOver10Mb) {
      return { valid: false, error: 'Photo Stories cannot exceed 10 MB.' };
    }
  } else if (media.mediaType === 'video') {
    const isOver60s = media.durationSeconds !== null && media.durationSeconds !== undefined && media.durationSeconds > 60;
    if (isOver60s) {
      return { valid: false, error: 'Video Stories cannot exceed 60 seconds.' };
    }
  }
  return { valid: true };
}

/**
 * Validates whether the supplied post parameters and media attributes satisfy the constraints
 * of the chosen Facebook publishing format ('text', 'image', 'reel', 'video', 'story').
 */
export function validatePostFormatEligibility(input: ValidatePostFormatInput): FormatValidationResult {
  const { postFormat, caption, firstComment, linkUrl, media } = input;

  switch (postFormat) {
    case 'text':
      return validateTextPost(caption, linkUrl, media);
    case 'image':
      return validateImagePost(media);
    case 'reel':
      return validateReelPost(media);
    case 'video':
      return validateVideoPost(media);
    case 'story':
      return validateStoryPost(media, firstComment);
    default:
      return { valid: false, error: `Unsupported post format: ${String(postFormat)}` };
  }
}

/**
 * Returns all post formats compatible with a given media asset.
 */
export function getEligiblePostFormatsForMedia(media: MediaEligibilityInput): PostFormat[] {
  if (media.mediaType === 'image') {
    if (media.fileSize !== null && media.fileSize !== undefined && media.fileSize > 10 * 1024 * 1024) {
      return ['image'];
    }
    return ['image', 'story'];
  }

  const formats: PostFormat[] = [];
  const duration = media.durationSeconds;

  // Video: all durations supported
  formats.push('video');

  // Reels: 3-90 seconds (or unspecified duration)
  if (duration === null || duration === undefined || (duration >= 3 && duration <= FACEBOOK_REEL_MAX_DURATION_SECONDS)) {
    formats.push('reel');
  }

  // Story: <= 60 seconds (or unspecified duration)
  if (duration === null || duration === undefined || duration <= 60) {
    formats.push('story');
  }

  return formats;
}
