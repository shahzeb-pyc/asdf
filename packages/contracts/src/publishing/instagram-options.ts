import { z } from 'zod';

// ==========================================
// Instagram platform options + field validation (spec 124)
// ==========================================
//
// The validated shape of `queue_items.platform_options` for Instagram
// posts, plus the caption/media field rules the Instagram-Login API
// enforces. Spec 128's Instagram composer renders its fields from this
// schema; the worker's Instagram publisher re-validates with it before
// creating any container.
//
// Route (D2, DECIDED): Instagram-Login ONLY. The schemas and limits here
// describe that route (`graph.instagram.com`); the Facebook-Login route
// is out of scope in any form.
//
// Deliberately ABSENT (spec 124 Out of scope, v1): location tags, user
// tags beyond the caption mention limits, product tags, and alt text.
// The schema is `.strict()`, so any of those keys is a validation
// failure, never a silently-ignored extra.

/**
 * OAuth scopes requested by the Instagram-Login connect flow. The
 * manage-comments permission is in the requested set because the first
 * comment is a separate post-publish call that needs it (spec 124 §2).
 */
export const INSTAGRAM_OAUTH_SCOPES: readonly string[] = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
];

/**
 * Scopes for the Instagram API with Unified Login connect flow (single
 * source of truth — the callback probe, the settings copy and the tests
 * must all import this list, never a second copy). The configuration
 * owns the permission set at dialog time (no `scope` parameter is sent);
 * these four are the hard-required set: a proven decline of any one of
 * them rejects the connect with nothing saved. Insights is a read
 * permission here, not an Insights product surface. No messages, ads,
 * or events permissions are requested.
 */
export const INSTAGRAM_UNIFIED_OAUTH_SCOPES: readonly string[] = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
];

/** Facebook Login for Business dialog host for Unified Login connects. */
export const INSTAGRAM_UNIFIED_DIALOG_URL =
  'https://www.facebook.com/dialog/oauth';

/** Graph host for Unified Login (BISU) token calls and publishing. */
export const INSTAGRAM_UNIFIED_GRAPH_BASE_URL =
  'https://graph.facebook.com/v26.0';

// --- Caption limits (enforced by Meta at container creation) ---

/** Captions are capped at 2,200 characters. */
export const INSTAGRAM_MAX_CAPTION_CHARACTERS = 2200;

/** At most 30 hashtags per caption. */
export const INSTAGRAM_MAX_HASHTAGS = 30;

/** At most 20 @-mentions per caption. */
export const INSTAGRAM_MAX_MENTIONS = 20;

// --- Media limits ---

/** Single photos: JPEG only, at most 8 MB. */
export const INSTAGRAM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Photo aspect ratio must sit between 4:5 (0.8) and 1.91:1. */
export const INSTAGRAM_IMAGE_MIN_ASPECT_RATIO = 4 / 5;
export const INSTAGRAM_IMAGE_MAX_ASPECT_RATIO = 1.91;

/** Every Instagram video is a Reel: 3 seconds to 15 minutes. */
export const INSTAGRAM_VIDEO_MIN_DURATION_SECONDS = 3;
export const INSTAGRAM_VIDEO_MAX_DURATION_SECONDS = 15 * 60;

/** Reels are at most 1920 px wide, 23–60 fps. */
export const INSTAGRAM_VIDEO_MAX_WIDTH_PX = 1920;
export const INSTAGRAM_VIDEO_MIN_FPS = 23;
export const INSTAGRAM_VIDEO_MAX_FPS = 60;

// --- Carousel limits ---

export const INSTAGRAM_CAROUSEL_MIN_ITEMS = 2;
export const INSTAGRAM_CAROUSEL_MAX_ITEMS = 10;

// --- Collaborators ---

/** At most 3 collaborator usernames per post. */
export const INSTAGRAM_MAX_COLLABORATORS = 3;

/** Instagram usernames: letters, digits, periods, underscores; 1–30 chars. */
const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

// ==========================================
// Caption helpers
// ==========================================

/** Counts `#hashtag` occurrences in a caption. */
export function countInstagramHashtags(caption: string): number {
  return caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

/** Counts `@mention` occurrences in a caption. */
export function countInstagramMentions(caption: string): number {
  return caption.match(/@[\p{L}\p{N}._]+/gu)?.length ?? 0;
}

/**
 * Validates an Instagram caption against the character, hashtag, and
 * mention caps. Returns a plain-language error message, or null when
 * the caption is publishable.
 */
export function validateInstagramCaption(caption: string): string | null {
  if (caption.length > INSTAGRAM_MAX_CAPTION_CHARACTERS) {
    return `Instagram captions can be at most ${INSTAGRAM_MAX_CAPTION_CHARACTERS} characters. Shorten the caption and try again.`;
  }
  if (countInstagramHashtags(caption) > INSTAGRAM_MAX_HASHTAGS) {
    return `Instagram allows at most ${INSTAGRAM_MAX_HASHTAGS} hashtags in a caption. Remove a few and try again.`;
  }
  if (countInstagramMentions(caption) > INSTAGRAM_MAX_MENTIONS) {
    return `Instagram allows at most ${INSTAGRAM_MAX_MENTIONS} mentions in a caption. Remove a few and try again.`;
  }
  return null;
}

// ==========================================
// Media descriptors (carousel items + media facts the composer knows)
// ==========================================

export const InstagramCarouselItemSchema = z
  .object({
    mediaUrl: z.string().url(),
    mediaType: z.enum(['image', 'video']),
  })
  .strict();
export type InstagramCarouselItem = z.infer<typeof InstagramCarouselItemSchema>;

/**
 * Optional media facts a composer may supply so validation can enforce
 * the platform's size/format rules before claim. Every field is
 * optional: when a fact is unknown the schema cannot check it, and the
 * platform's own rejection remains the backstop.
 */
export const InstagramMediaFactsSchema = z
  .object({
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    widthPx: z.number().int().positive().optional(),
    heightPx: z.number().int().positive().optional(),
    durationSeconds: z.number().nonnegative().optional(),
    fps: z.number().positive().optional(),
  })
  .strict();
export type InstagramMediaFacts = z.infer<typeof InstagramMediaFactsSchema>;

/**
 * Validates the media facts of a single photo against the JPEG, size,
 * and aspect-ratio rules. Returns a plain-language error, or null.
 */
export function validateInstagramImageFacts(
  facts: InstagramMediaFacts
): string | null {
  if (facts.mimeType !== undefined && facts.mimeType !== 'image/jpeg') {
    return 'Instagram photos must be JPEG files. Choose a JPEG photo and try again.';
  }
  if (
    facts.sizeBytes !== undefined &&
    facts.sizeBytes > INSTAGRAM_IMAGE_MAX_BYTES
  ) {
    return 'Instagram photos can be at most 8 MB. Choose a smaller photo and try again.';
  }
  if (facts.widthPx !== undefined && facts.heightPx !== undefined) {
    const ratio = facts.widthPx / facts.heightPx;
    if (
      ratio < INSTAGRAM_IMAGE_MIN_ASPECT_RATIO ||
      ratio > INSTAGRAM_IMAGE_MAX_ASPECT_RATIO
    ) {
      return 'Instagram photos must be between 4:5 and 1.91:1 in shape. Crop the photo and try again.';
    }
  }
  return null;
}

/** Validates the media facts of a Reel/video. Returns an error or null. */
export function validateInstagramVideoFacts(
  facts: InstagramMediaFacts
): string | null {
  if (
    facts.durationSeconds !== undefined &&
    (facts.durationSeconds < INSTAGRAM_VIDEO_MIN_DURATION_SECONDS ||
      facts.durationSeconds > INSTAGRAM_VIDEO_MAX_DURATION_SECONDS)
  ) {
    return 'Instagram videos must be between 3 seconds and 15 minutes long. Choose a different video and try again.';
  }
  if (facts.widthPx !== undefined && facts.widthPx > INSTAGRAM_VIDEO_MAX_WIDTH_PX) {
    return 'Instagram videos can be at most 1920 pixels wide. Choose a smaller video and try again.';
  }
  if (
    facts.fps !== undefined &&
    (facts.fps < INSTAGRAM_VIDEO_MIN_FPS || facts.fps > INSTAGRAM_VIDEO_MAX_FPS)
  ) {
    return 'Instagram videos must be between 23 and 60 frames per second. Choose a different video and try again.';
  }
  return null;
}

// ==========================================
// platform_options schema
// ==========================================

export const InstagramTrialParamsSchema = z
  .object({
    /** Trial Reels are shown to non-followers first. */
    graduationStrategy: z
      .enum(['SS_PERFORMANCE', 'SS_PERFORMANCE_WITH_MANUAL_REVIEW', 'MANUAL'])
      .optional(),
  })
  .strict();
export type InstagramTrialParams = z.infer<typeof InstagramTrialParamsSchema>;

export const InstagramPlatformOptionsSchema = z
  .object({
    /** Collaborator usernames invited to co-author the post (at most 3). */
    collaborators: z
      .array(z.string().regex(INSTAGRAM_USERNAME_PATTERN))
      .max(INSTAGRAM_MAX_COLLABORATORS)
      .optional(),
    /** Reels only: also place the Reel in the profile feed. */
    shareToFeed: z.boolean().optional(),
    /** Reels only: cover image URL for the Reel. */
    coverUrl: z.string().url().optional(),
    /** Reels only: trial-Reel parameters, where the API supports them. */
    trialParams: InstagramTrialParamsSchema.optional(),
    /** Carousel items (2–10) for carousel posts; mirrors the item rows. */
    carouselItems: z
      .array(InstagramCarouselItemSchema)
      .min(INSTAGRAM_CAROUSEL_MIN_ITEMS)
      .max(INSTAGRAM_CAROUSEL_MAX_ITEMS)
      .optional(),
  })
  .strict();
export type InstagramPlatformOptions = z.infer<
  typeof InstagramPlatformOptionsSchema
>;

/** Parses raw `platform_options` jsonb into validated Instagram options. */
export function parseInstagramPlatformOptions(
  raw: Record<string, unknown> | null | undefined
): InstagramPlatformOptions {
  return InstagramPlatformOptionsSchema.parse(raw ?? {});
}
