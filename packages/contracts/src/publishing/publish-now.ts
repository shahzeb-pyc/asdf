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
    mediaId: z.string().uuid().nullable(),
    tempKey: z.string().min(1).nullable(),
    url: z.string().url(),
    mediaType: z.enum(['image', 'video']),
    aspectRatio: z.string().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
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

/** Direct-publish request: one caption + optional media, N targets. */
export const PublishNowRequestSchema = z.object({
  caption: z.string().max(63206),
  targets: z.array(PublishNowTargetSchema).min(1).max(50),
  media: PublishNowMediaSchema.nullable(),
});
export type PublishNowRequest = z.infer<typeof PublishNowRequestSchema>;

/** One per-page publish result. No public post URL is fabricated:
 * the codebase has no post-URL builder, so success carries the
 * Facebook post id only — the UI shows "Published", not a link. */
export const PublishNowResultSchema = z.object({
  accountId: z.string().uuid(),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  status: z.enum(['published', 'failed']),
  postId: z.string().nullable(),
  reason: z.string().nullable(),
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
  mimeType: z.enum(PublishNowTempMimeTypes),
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
export type PublishNowTempMediaDeleteResponse = z.infer<
  typeof PublishNowTempMediaDeleteResponseSchema
>;
