import { z } from 'zod';

// ==========================================
// Publish Now (direct, multi-page publish)
// ==========================================
// This flow deliberately saves NOTHING to the database: no queue
// row, no destination import, no idempotency row, no publish log,
// no media row. The server route publishes synchronously to
// Facebook with page tokens obtained transiently (re-discovered
// from the account token at publish time) and returns per-page
// results in the same response. Because nothing is persisted, a
// results screen that is closed or refreshed loses its success
// tracking — that trade-off is accepted by the product owner and
// is NOT papered over with a hidden write here.

/** One publish target: a discovered Facebook page under an account. */
export const PublishNowTargetSchema = z.object({
  accountId: z.string().uuid(),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
});
export type PublishNowTarget = z.infer<typeof PublishNowTargetSchema>;

/**
 * Media attached to a Publish Now post. `library` media is a read
 * from the Media Library (the server re-resolves its URL from the
 * media row — the client-supplied URL is never trusted for it).
 * `temp` media is a device file uploaded to a temporary R2 prefix
 * (see the temp-media route); the server validates that its key
 * sits under the caller's own temp prefix and that its URL is the
 * R2 public URL for that key.
 */
export const PublishNowMediaSchema = z
  .object({
    source: z.enum(['library', 'temp']),
    // Validation fix (2026-10-29, bare INVALID_REQUEST): these fields
    // are .nullish(), not just .nullable() — a client may legitimately
    // omit a field it has no value for (JSON.stringify drops
    // undefined), and an absent field must be treated as null, not
    // as a validation failure. The superRefine below still enforces
    // the source-specific requirement (library needs mediaId, temp
    // needs tempKey), so nothing safety-critical is loosened.
    mediaId: z.string().uuid().nullish(),
    // Audit N7: bounded — a temp key is temp/<user>/<uuid>/<name>,
    // far under 512; the route also checks prefix + URL equality.
    tempKey: z.string().min(1).max(512).nullish(),
    url: z.string().url(),
    mediaType: z.enum(['image', 'video']),
    aspectRatio: z.string().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    name: z.string().min(1).max(255),
  })
  .superRefine((media, ctx) => {
    if (media.source === 'library' && !media.mediaId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Library media requires a media id',
        path: ['mediaId'],
      });
    }
    if (media.source === 'temp' && !media.tempKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Temporary media requires a temp key',
        path: ['tempKey'],
      });
    }
  });
export type PublishNowMedia = z.infer<typeof PublishNowMediaSchema>;

/**
 * Direct-publish request: one caption + optional media, N targets.
 * `postType` is EXPLICIT (picked in the composer, old Direct Post
 * style) — it replaces the previously derived type: the picked
 * type is the type published. `firstComment` is the old Direct
 * Post first comment: trimmed server-side, empty = absent, max
 * 8,000 (the old schedule validations' figure). It is posted per
 * page only after that page's own post succeeds, and a comment
 * failure never fails the post (see the result fields below).
 */
export const PublishNowRequestSchema = z
  .object({
    caption: z.string().max(63206),
    postType: z.enum(['text', 'image', 'video', 'reel']),
    firstComment: z.string().max(8000).optional(),
    targets: z.array(PublishNowTargetSchema).min(1).max(50),
    media: PublishNowMediaSchema.nullable(),
  })
  .superRefine((data, ctx) => {
    // Audit N7: the route never cross-checked mediaType against
    // postType — an image post carrying video media reached
    // publishPhotoWithBytes and failed with a generic media-fetch
    // error, and a text post silently dropped attached media (the
    // text branch never reads it). Reject mismatches up front
    // with 400. Missing media for non-text types is still the
    // route's 400 ("This post type needs media."), unchanged.
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
    if (
      (data.postType === 'video' || data.postType === 'reel') &&
      data.media.mediaType !== 'video'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A ${data.postType} post requires video media.`,
        path: ['media', 'mediaType'],
      });
    }
  });
export type PublishNowRequest = z.infer<typeof PublishNowRequestSchema>;

/** Step a Publish Now publish attempt reached, for failure diagnostics.
 * 'precheck' is a publish-rights fail-fast (page task / declined
 * permission), not a Facebook publish call. */
export const PublishNowStepSchema = z.enum([
  'discover',
  'feed',
  'photos',
  'videos',
  'reel-start',
  'reel-upload',
  'reel-finish',
  'media-fetch',
  'precheck',
  'publish',
]);
export type PublishNowStep = z.infer<typeof PublishNowStepSchema>;

/** One per-page publish result. No public post URL is fabricated:
 * the codebase has no post-URL builder, so success carries the
 * Facebook post id only — the UI shows "Published", not a link.
 *
 * Diagnostic fields are optional + nullable so results recorded
 * before diagnostics existed still validate. They carry only
 * Facebook's error code/subcode, the step reached, the HTTP status,
 * and Facebook's trace id — never any token, secret, or media URL. */
export const PublishNowResultSchema = z.object({
  accountId: z.string().uuid(),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  status: z.enum(['published', 'failed']),
  postId: z.string().nullable(),
  reason: z.string().nullable(),
  graphCode: z.number().int().optional().nullable(),
  graphSubcode: z.number().int().optional().nullable(),
  step: PublishNowStepSchema.optional().nullable(),
  httpStatus: z.number().int().optional().nullable(),
  fbtraceId: z.string().max(200).optional().nullable(),
  /**
   * First-comment outcome, only meaningful on a published row: a
   * failed comment never flips a published post to failed — the
   * post DID publish — so it is reported here as a warning, with
   * the reason, and is not retryable (retry never re-publishes
   * a success). Null/absent on failed rows and on published
   * rows with no first comment.
   */
  firstCommentFailed: z.boolean().optional().nullable(),
  firstCommentReason: z.string().max(500).optional().nullable(),
});
export type PublishNowResult = z.infer<typeof PublishNowResultSchema>;

export const PublishNowResponseSchema = z.object({
  results: z.array(PublishNowResultSchema),
});
export type PublishNowResponse = z.infer<typeof PublishNowResponseSchema>;

// ==========================================
// Temporary device media
// ==========================================
// A device file for Publish Now is uploaded straight to R2 under a
// per-user temp prefix. No media_items row is ever created for it,
// so it never appears in the Media Library, and the client deletes
// the object when the run ends (Done / dialogue close after the
// results screen) — kept alive through the results screen so a
// "Retry failed only" can reuse the same file.

/** MIME types accepted for temp uploads (same list as library media). */
export const PublishNowTempMimeTypes = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/** 500 MB cap, identical to the library multipart cap. */
export const PUBLISH_NOW_TEMP_MAX_FILE_SIZE_BYTES = 524288000;

export const PublishNowTempMediaRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive().max(PUBLISH_NOW_TEMP_MAX_FILE_SIZE_BYTES),
  // Browser alias: some browsers report JPEG files as image/jpg,
  // which is not in the allowlist. Normalise that one genuine alias
  // to image/jpeg before the enum check; every other type still has
  // to be in the allowlist, so this is not an open-ended accept.
  mimeType: z.preprocess(
    (value) => (value === 'image/jpg' ? 'image/jpeg' : value),
    z.enum(PublishNowTempMimeTypes)
  ),
});
export type PublishNowTempMediaRequest = z.infer<
  typeof PublishNowTempMediaRequestSchema
>;

export const PublishNowTempMediaResponseSchema = z.object({
  key: z.string().min(1),
  uploadUrl: z.string().url(),
  publicUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type PublishNowTempMediaResponse = z.infer<
  typeof PublishNowTempMediaResponseSchema
>;

export const PublishNowTempMediaDeleteRequestSchema = z.object({
  key: z.string().min(1),
});
export type PublishNowTempMediaDeleteRequest = z.infer<
  typeof PublishNowTempMediaDeleteRequestSchema
>;

export const PublishNowTempMediaDeleteResponseSchema = z.object({
  deleted: z.boolean(),
});

// ==========================================
// Human-readable validation messages
// ==========================================
// Added 2026-10-29 after a bare "INVALID_REQUEST" reached the user:
// the Publish Now routes used to return { error, details } with no
// message for schema failures, and the client then displayed the
// code itself. Every schema failure in these routes must now carry
// this message, which names the actual problem in plain user
// language. It describes only the FIRST issue (the one most likely
// to be the cause) — the full flattened details are still returned
// alongside it for debugging. Raw Zod wording is never surfaced.

const VALIDATION_FIELD_LABELS: Record<string, string> = {
  caption: 'Text',
  postType: 'Post type',
  firstComment: 'First comment',
  targets: 'Pages',
  accountId: 'A selected page',
  fbPageId: 'A selected page',
  pageName: 'A selected page',
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

export function publishNowValidationMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) {
    return 'The request could not be understood. Please check your post and try again.';
  }
  // Custom issues (e.g. the media superRefine) already carry plain
  // wording — use them as written.
  if (first.code === z.ZodIssueCode.custom) return first.message;
  const label = validationFieldLabel(first.path);
  const path = first.path.map(String);
  const last = path[path.length - 1];

  if (first.code === z.ZodIssueCode.too_big) {
    if (last === 'targets') {
      return 'You can publish to at most 50 pages at once.';
    }
    if (last === 'caption') {
      return 'Text exceeds the 63,206-character limit.';
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
      return 'Please select at least one page.';
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
export type PublishNowTempMediaDeleteResponse = z.infer<
  typeof PublishNowTempMediaDeleteResponseSchema
>;
