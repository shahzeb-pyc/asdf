import { z } from 'zod';

import { validateInstagramCaption } from './instagram-options.js';
import { PublishNowMediaSchema } from './publish-now.js';

// ==========================================
// Instagram Publish Now (direct, multi-account publish)
// ==========================================
// The Instagram equivalent of Facebook Publish Now, with the same
// deliberately-nothing-saved rule: no queue row, no destination
// import, no publish log, no media row for device media. The server
// route publishes synchronously to Instagram with account tokens
// decrypted transiently and returns per-account results in the same
// response. Because nothing is persisted, a results screen that is
// closed or refreshed loses its success tracking — that trade-off
// is accepted by the product owner (as for Facebook Publish Now)
// and is NOT papered over with a hidden write here.
//
// Instagram differences from Facebook Publish Now, all deliberate:
// - The target IS the connected Instagram account. There is no
//   discovered-pages step: `accountId` is the unified
//   `social_accounts` row, and the Instagram user id is re-read
//   from that row server-side, never trusted from the client.
// - Post types are Photo and Reel only. Instagram has no text-only
//   feed post (so there is no Text type), every Instagram video is
//   a Reel (so Facebook's separate Video and Reel collapse into
//   Reel), Stories require a Business account while the target is
//   Creator accounts (so no Story type), and Carousel needs a
//   multi-media composer that Facebook Publish Now does not have
//   (so no Carousel type in v1 — an additive follow-up, not a
//   silent stub).
// - Caption cap is Instagram's 2,200 characters, with its hashtag
//   (30) and mention (20) caps, enforced by validateInstagramCaption.
// - The publish steps are the Instagram container flow (create →
//   poll → media_publish), not Facebook's feed/photos/videos/reels.

/** One publish target: a connected Instagram account. */
export const InstagramPublishNowTargetSchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string().min(1).max(255),
});
export type InstagramPublishNowTarget = z.infer<
  typeof InstagramPublishNowTargetSchema
>;

/** Instagram Publish Now post types (see the header note). */
export const InstagramPublishNowPostTypeSchema = z.enum(['photo', 'reel']);
export type InstagramPublishNowPostType = z.infer<
  typeof InstagramPublishNowPostTypeSchema
>;

/**
 * Direct-publish request: one caption + media, N accounts.
 * `postType` is EXPLICIT (picked in the composer) — the picked type
 * is the type published. `firstComment` is the Facebook Publish Now
 * first comment: trimmed server-side, empty = absent, max 8,000.
 * It is posted per account only after that account's own post
 * succeeds, and a comment failure never fails the post.
 */
export const InstagramPublishNowRequestSchema = z
  .object({
    caption: z.string().max(2200),
    postType: InstagramPublishNowPostTypeSchema,
    firstComment: z.string().max(8000).optional(),
    targets: z.array(InstagramPublishNowTargetSchema).min(1).max(50),
    media: PublishNowMediaSchema.nullable(),
  })
  .superRefine((data, ctx) => {
    const captionError = validateInstagramCaption(data.caption);
    if (captionError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: captionError,
        path: ['caption'],
      });
    }
    if (!data.media) return;
    if (data.postType === 'photo' && data.media.mediaType !== 'image') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A photo post requires image media.',
        path: ['media', 'mediaType'],
      });
    }
    if (data.postType === 'reel' && data.media.mediaType !== 'video') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A reel post requires video media.',
        path: ['media', 'mediaType'],
      });
    }
  });
export type InstagramPublishNowRequest = z.infer<
  typeof InstagramPublishNowRequestSchema
>;

/** Step an Instagram Publish Now attempt reached, for diagnostics. */
export const InstagramPublishNowStepSchema = z.enum([
  'account',
  'container-create',
  'container-poll',
  'media-publish',
  'comment',
  'media-fetch',
  'precheck',
]);
export type InstagramPublishNowStep = z.infer<
  typeof InstagramPublishNowStepSchema
>;

/** One per-account publish result. No post URL is fabricated: the
 * codebase has no post-URL builder, so success carries the
 * Instagram media id only — the UI shows "Published", not a link.
 * Diagnostic fields carry only Meta's error code/subcode, the step
 * reached, the HTTP status, and Meta's trace id — never a token. */
export const InstagramPublishNowResultSchema = z.object({
  accountId: z.string().uuid(),
  accountName: z.string().min(1).max(255),
  status: z.enum(['published', 'failed']),
  postId: z.string().nullable(),
  reason: z.string().nullable(),
  graphCode: z.number().int().optional().nullable(),
  graphSubcode: z.number().int().optional().nullable(),
  step: InstagramPublishNowStepSchema.optional().nullable(),
  httpStatus: z.number().int().optional().nullable(),
  fbtraceId: z.string().max(200).optional().nullable(),
  firstCommentFailed: z.boolean().optional().nullable(),
  firstCommentReason: z.string().max(500).optional().nullable(),
});
export type InstagramPublishNowResult = z.infer<
  typeof InstagramPublishNowResultSchema
>;

export const InstagramPublishNowResponseSchema = z.object({
  results: z.array(InstagramPublishNowResultSchema),
});
export type InstagramPublishNowResponse = z.infer<
  typeof InstagramPublishNowResponseSchema
>;

// ==========================================
// Human-readable validation messages
// ==========================================
// Mirrors publishNowValidationMessage's rule: every schema failure
// must carry a plain message naming the actual problem. A bare
// code ("INVALID_REQUEST") is never the display text.

const VALIDATION_FIELD_LABELS: Record<string, string> = {
  caption: 'Caption',
  postType: 'Post type',
  firstComment: 'First comment',
  targets: 'Accounts',
  accountId: 'A selected account',
  accountName: 'A selected account',
  media: 'Media',
  mediaId: 'Media',
  tempKey: 'Media',
  url: 'Media',
  mediaType: 'Media',
  aspectRatio: 'Media',
  width: 'Media',
  height: 'Media',
  name: 'File name',
  source: 'Media',
  fileName: 'File name',
  fileSize: 'File size',
  mimeType: 'File type',
  key: 'File',
};

function validationFieldLabel(path: (string | number)[]): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const label = VALIDATION_FIELD_LABELS[String(path[i])];
    if (label) return label;
  }
  return 'This request';
}

export function instagramPublishNowValidationMessage(
  error: z.ZodError
): string {
  const first = error.issues[0];
  if (!first) {
    return 'The request could not be understood. Please check your post and try again.';
  }
  if (first.code === z.ZodIssueCode.custom) return first.message;
  const label = validationFieldLabel(first.path);
  const path = first.path.map(String);
  const last = path[path.length - 1];

  if (first.code === z.ZodIssueCode.too_big) {
    if (last === 'targets') {
      return 'You can publish to at most 50 accounts at once.';
    }
    if (last === 'caption') {
      return 'Caption exceeds the 2,200-character limit.';
    }
    if (last === 'firstComment') {
      return 'First comment exceeds the 8,000-character limit.';
    }
    if (last === 'fileSize') {
      return 'This file is over the 500 MB limit.';
    }
    return `${label} is too long.`;
  }
  if (first.code === z.ZodIssueCode.too_small) {
    if (last === 'targets') {
      return 'Please select at least one account.';
    }
    if (last === 'fileSize') {
      return 'The file appears to be empty. Please choose a different file.';
    }
    if (first.type === 'array' || first.type === 'string') {
      return `${label} is missing.`;
    }
    return `${label} is not valid.`;
  }
  if (first.code === z.ZodIssueCode.invalid_type) {
    return first.received === 'undefined'
      ? `${label} is missing.`
      : `${label} is not valid.`;
  }
  if (first.code === z.ZodIssueCode.invalid_enum_value) {
    if (last === 'mimeType' || last === 'mediaType') {
      return 'This file type is not supported. Choose an image or video.';
    }
    return `${label} is not valid.`;
  }
  if (first.code === z.ZodIssueCode.invalid_string) {
    if (first.validation === 'url') {
      return `${label} link is not valid.`;
    }
    return `${label} is not valid.`;
  }
  return 'The request could not be understood. Please check your post and try again.';
}
