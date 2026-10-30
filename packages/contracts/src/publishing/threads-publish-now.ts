import { z } from 'zod';

import {
  PublishNowMediaSchema,
  type PublishNowMedia,
} from './publish-now.js';
import {
  THREADS_MAX_TEXT_WEIGHTED_CHARACTERS,
  validateThreadsText,
} from './threads-options.js';

// ==========================================
// Threads Publish Now (direct, multi-account publish)
// ==========================================
//
// Facebook Publish Now's shape, for Threads. One single post,
// published directly to every selected connected Threads account
// in one run. Threads accounts ARE the destinations — there is
// no pages step, because Threads has no pages.
//
// Post types are Threads-only: text, image, video. Facebook's
// reel type does not exist on Threads (a Threads video post is
// the video type), and carousel is out of scope for this
// single-media composer (it stays available via scheduling).
//
// Like Facebook Publish Now, this flow deliberately saves
// NOTHING to the database for the publish itself: no queue
// row, no destination import, no publish log, no media row,
// no history row. The only rows it writes are the idempotency
// record (action `threads-publish-now`, same pattern as
// Facebook Publish Now) and the subscription-usage registry.
// A results screen that is closed or refreshed loses its
// success tracking — that trade-off is accepted by the product
// owner and is NOT papered over with a hidden write here.
//
// Media: Threads has no upload endpoint — Meta fetches the
// public `image_url` / `video_url` itself (see threads-options
// and the worker's Threads publisher). Library media is
// re-resolved server-side from its row; device media is a
// temporary R2 object (the existing Publish Now temp-media
// upload), deleted when the run ends and never saved to the
// Media Library.

export const THREADS_PUBLISH_NOW_POST_TYPES = [
  'text',
  'image',
  'video',
] as const;
export type ThreadsPublishNowPostType =
  (typeof THREADS_PUBLISH_NOW_POST_TYPES)[number];

/** One publish target: a connected Threads account. */
export const ThreadsPublishNowTargetSchema = z.object({
  accountId: z.string().uuid(),
  threadsUserId: z.string().min(1).max(100),
  accountName: z.string().min(1).max(255),
  handle: z.string().nullable().optional(),
});
export type ThreadsPublishNowTarget = z.infer<
  typeof ThreadsPublishNowTargetSchema
>;

export type ThreadsPublishNowMedia = PublishNowMedia;

/**
 * Direct-publish request: one caption + optional media, N
 * targets. `reply` is Facebook Publish Now's first comment,
 * implemented on Threads as a reply post (`reply_to_id`): it is
 * posted per account only after that account's own post
 * succeeds, and a reply failure never fails the post.
 */
export const ThreadsPublishNowRequestSchema = z
  .object({
    caption: z.string().max(10000),
    postType: z.enum(THREADS_PUBLISH_NOW_POST_TYPES),
    reply: z.string().max(8000).optional(),
    targets: z.array(ThreadsPublishNowTargetSchema).min(1).max(50),
    media: PublishNowMediaSchema.nullable(),
  })
  .superRefine((data, ctx) => {
    const textError = validateThreadsText(data.caption);
    if (textError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: textError, path: ['caption'] });
    }
    if (data.postType === 'text' && data.media) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A text post cannot carry media.',
        path: ['media'],
      });
      return;
    }
    if (!data.media) return;
    if (data.postType === 'image' && data.media.mediaType !== 'image') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An image post requires image media.',
        path: ['media', 'mediaType'],
      });
    }
    if (data.postType === 'video' && data.media.mediaType !== 'video') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A video post requires video media.',
        path: ['media', 'mediaType'],
      });
    }
  });
export type ThreadsPublishNowRequest = z.infer<
  typeof ThreadsPublishNowRequestSchema
>;

/** Step a Threads Publish Now attempt reached, for diagnostics. */
export const ThreadsPublishNowStepSchema = z.enum([
  'container-create',
  'container-status',
  'container-publish',
  'media-fetch',
  'reply',
  'publish',
]);
export type ThreadsPublishNowStep = z.infer<typeof ThreadsPublishNowStepSchema>;

/** One per-account publish result. No post URL is fabricated:
 * success carries the Threads media id only — the UI shows
 * "Published", not a link. Diagnostic fields carry only
 * Threads' error code/subcode, the step reached, the HTTP
 * status, and Threads' trace id — never any token, secret,
 * or media URL. */
export const ThreadsPublishNowResultSchema = z.object({
  accountId: z.string().uuid(),
  threadsUserId: z.string().min(1).max(100),
  accountName: z.string().min(1).max(255),
  handle: z.string().nullable().optional(),
  status: z.enum(['published', 'failed']),
  postId: z.string().nullable(),
  reason: z.string().nullable(),
  graphCode: z.number().int().optional().nullable(),
  graphSubcode: z.number().int().optional().nullable(),
  step: ThreadsPublishNowStepSchema.optional().nullable(),
  httpStatus: z.number().int().optional().nullable(),
  fbtraceId: z.string().max(200).optional().nullable(),
  /**
   * Reply outcome, only meaningful on a published row: a
   * failed reply never flips a published post to failed — the
   * post DID publish — so it is reported here as a warning,
   * with the reason, and is not retryable as a post (retry
   * never re-publishes a success). Null/absent on failed rows
   * and on published rows with no reply.
   */
  replyFailed: z.boolean().optional().nullable(),
  replyReason: z.string().max(500).optional().nullable(),
});
export type ThreadsPublishNowResult = z.infer<
  typeof ThreadsPublishNowResultSchema
>;

export const ThreadsPublishNowResponseSchema = z.object({
  results: z.array(ThreadsPublishNowResultSchema),
});
export type ThreadsPublishNowResponse = z.infer<
  typeof ThreadsPublishNowResponseSchema
>;

// ==========================================
// Human-readable validation messages
// ==========================================
// Mirrors publishNowValidationMessage: the first issue is the
// display text, in plain user language. A bare code is never
// shown. Custom issues (weighted-text cap, media/type
// mismatches) already carry plain wording — use them as written.

const VALIDATION_FIELD_LABELS: Record<string, string> = {
  caption: 'Text',
  postType: 'Post type',
  reply: 'Reply',
  targets: 'Accounts',
  accountId: 'A selected account',
  threadsUserId: 'A selected account',
  accountName: 'A selected account',
  handle: 'A selected account',
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
};

function validationFieldLabel(path: (string | number)[]): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const label = VALIDATION_FIELD_LABELS[String(path[i])];
    if (label) return label;
  }
  return 'This request';
}

export function threadsPublishNowValidationMessage(error: z.ZodError): string {
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
      return `Text exceeds the ${THREADS_MAX_TEXT_WEIGHTED_CHARACTERS}-character limit.`;
    }
    if (last === 'reply') {
      return 'Reply exceeds the 8,000-character limit.';
    }
    return `${label} is too long.`;
  }
  if (first.code === z.ZodIssueCode.too_small) {
    if (last === 'targets') {
      return 'Please select at least one account.';
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
    if (last === 'mimeType' || last === 'mediaType' || last === 'postType') {
      return `${label} is not valid.`;
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
