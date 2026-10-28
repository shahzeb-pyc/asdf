import { z } from 'zod';
import { PostFormatSchema } from './publishing.js';

export {
  validatePostFormatEligibility,
  getEligiblePostFormatsForMedia,
} from './publishing.js';

export const AllowedMediaMimeTypes = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const AllowedThumbnailMimeTypes = ['image/webp', 'image/jpeg'] as const;

/**
 * Strips the trailing file extension from a filename to produce the default media caption.
 * Example: "My Viral Reel.mp4" -> "My Viral Reel"
 */
export function deriveDefaultCaptionFromFilename(fileName: string): string {
  const trimmed = fileName.trim();
  const lastDotIndex = trimmed.lastIndexOf('.');
  if (lastDotIndex > 0) {
    return trimmed.slice(0, lastDotIndex).trim();
  }
  return trimmed;
}

export const UploadUrlRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive().max(524288000), // Max 500 MB
  mimeType: z.enum(AllowedMediaMimeTypes),
  thumbnailMimeType: z.enum(AllowedThumbnailMimeTypes).default('image/webp'),
});

export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

export const UploadUrlResponseSchema = z.object({
  mediaId: z.string().uuid(),
  mediaKey: z.string().min(1),
  mediaUploadUrl: z.string().url(),
  thumbnailKey: z.string().min(1),
  thumbnailUploadUrl: z.string().url(),
  publicMediaUrl: z.string().url(),
  publicThumbnailUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});

export type UploadUrlResponse = z.infer<typeof UploadUrlResponseSchema>;

export const ConfirmUploadRequestSchema = z.object({
  mediaId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive(),
  mimeType: z.enum(AllowedMediaMimeTypes),
  mediaType: z.enum(['video', 'image']),
  storageKey: z.string().min(1).max(500),
  url: z.string().url(),
  thumbnailKey: z.string().min(1).max(500).nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  durationSeconds: z.number().nonnegative().nullable().optional(),
  aspectRatio: z.string().min(1).max(20).default('unknown'),
  folderId: z.string().uuid().nullable().optional(),
  captionText: z.string().max(5000).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export type ConfirmUploadRequest = z.infer<typeof ConfirmUploadRequestSchema>;
export const ConfirmMediaUploadRequestSchema = ConfirmUploadRequestSchema;
export type ConfirmMediaUploadRequest = z.infer<typeof ConfirmMediaUploadRequestSchema>;

// Multipart (resumable) upload — single source of truth for the
// media/multipart routes and the import engine. The initiate
// request enforces the same bounds as the single-PUT upload-url
// route: trimmed filename (max 255) and allowlisted MIMEs.
// fileSize is deliberately NOT part of the initiate request: the
// route never used it (part sizing is client-side), so carrying
// it would be a validated-but-ignored field.
export const MultipartInitiateRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(AllowedMediaMimeTypes),
  thumbnailMimeType: z.enum(AllowedThumbnailMimeTypes).default('image/webp'),
});

export type MultipartInitiateRequest = z.infer<typeof MultipartInitiateRequestSchema>;

export const MultipartPartUrlRequestSchema = z.object({
  key: z.string().min(1),
  uploadId: z.string().min(1),
  partNumber: z.number().int().min(1).max(10_000),
});

export type MultipartPartUrlRequest = z.infer<typeof MultipartPartUrlRequestSchema>;

export const MultipartCompleteRequestSchema = z.object({
  key: z.string().min(1),
  uploadId: z.string().min(1),
  expectedPartCount: z.number().int().min(1).max(10_000),
});

export type MultipartCompleteRequest = z.infer<typeof MultipartCompleteRequestSchema>;

export const MultipartAbortRequestSchema = z.object({
  key: z.string().min(1),
  uploadId: z.string().min(1),
});

export type MultipartAbortRequest = z.infer<typeof MultipartAbortRequestSchema>;

export const MultipartInitiateResponseSchema = z.object({
  mediaId: z.string(),
  mediaKey: z.string(),
  uploadId: z.string(),
  publicMediaUrl: z.string(),
  thumbnailUploadUrl: z.string().nullable(),
  thumbnailKey: z.string().nullable(),
  publicThumbnailUrl: z.string().nullable(),
});

export type MultipartInitiateResponse = z.infer<typeof MultipartInitiateResponseSchema>;

export const MultipartPartUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  expiresInSeconds: z.number(),
});

export type MultipartPartUrlResponse = z.infer<typeof MultipartPartUrlResponseSchema>;

export const MultipartCompleteResponseSchema = z.object({
  key: z.string(),
});

export type MultipartCompleteResponse = z.infer<typeof MultipartCompleteResponseSchema>;

export const MediaItemResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  name: z.string(),
  fileSize: z.number().int().positive(),
  mimeType: z.string(),
  mediaType: z.enum(['video', 'image']),
  storageKey: z.string(),
  url: z.string().url(),
  thumbnailKey: z.string().nullable(),
  thumbnailUrl: z.string().min(1).nullable(),
  durationSeconds: z.number().nullable(),
  aspectRatio: z.string(),
  captionText: z.string().nullable(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type MediaItemResponse = z.infer<typeof MediaItemResponseSchema>;

export const AllowedAspectRatios = ['9:16', '16:9', '1:1', '4:5'] as const;
export type AllowedAspectRatio = (typeof AllowedAspectRatios)[number];

export const MediaListQuerySchema = z.object({
  folderId: z.string().uuid().or(z.literal('unorganized')).optional(),
  mediaType: z.enum(['video', 'image']).optional(),
  aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
  captionStatus: z.enum(['has_caption', 'empty_caption']).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['created_at', 'name', 'file_size']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.string().optional(),
  postFormat: PostFormatSchema.optional(),
});

export type MediaListQuery = z.infer<typeof MediaListQuerySchema>;

export const MediaListResponseSchema = z.object({
  items: z.array(MediaItemResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  nextCursor: z.string().nullable().optional(),
});

export type MediaListResponse = z.infer<typeof MediaListResponseSchema>;

export const UpdateMediaItemRequestSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().uuid().nullable().optional(),
  captionText: z.string().max(5000).nullable().optional(),
  thumbnailKey: z.string().min(1).max(500).nullable().optional(),
  thumbnailUrl: z.string().min(1).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export type UpdateMediaItemRequest = z.infer<typeof UpdateMediaItemRequestSchema>;

export const DeleteMediaItemResponseSchema = z.object({
  success: z.literal(true),
  mediaId: z.string().uuid(),
});

export type DeleteMediaItemResponse = z.infer<typeof DeleteMediaItemResponseSchema>;

export const BatchMediaRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    mediaIds: z.array(z.string().uuid()).min(1).max(500),
    folderId: z.string().uuid().nullable(),
  }),
  z.object({
    action: z.literal('delete'),
    mediaIds: z.array(z.string().uuid()).min(1).max(500),
  }),
  z.object({
    action: z.literal('caption'),
    mediaIds: z.array(z.string().uuid()).min(1).max(500),
    captionText: z.string().max(5000).nullable(),
  }),
]);

export type BatchMediaRequest = z.infer<typeof BatchMediaRequestSchema>;

export const BatchMediaResponseSchema = z.object({
  success: z.literal(true),
  action: z.enum(['move', 'delete', 'caption']),
  affectedCount: z.number().int().min(0),
});

export type BatchMediaResponse = z.infer<typeof BatchMediaResponseSchema>;

// Pre-upload Duplicate Check Schemas
export const CheckDuplicatesEntrySchema = z.object({
  clientKey: z.string().min(1),
  name: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  folderId: z.string().uuid().nullable().optional(),
});

export type CheckDuplicatesEntry = z.infer<typeof CheckDuplicatesEntrySchema>;

export const CheckDuplicatesRequestSchema = z.object({
  folderId: z.string().uuid().nullable().optional(),
  entries: z.array(CheckDuplicatesEntrySchema).min(1).max(500),
});

export type CheckDuplicatesRequest = z.infer<typeof CheckDuplicatesRequestSchema>;

export const DuplicateMatchSchema = z.object({
  clientKey: z.string().min(1),
  existingItem: MediaItemResponseSchema,
});

export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

export const CheckDuplicatesResponseSchema = z.object({
  duplicates: z.array(DuplicateMatchSchema),
});

export type CheckDuplicatesResponse = z.infer<typeof CheckDuplicatesResponseSchema>;
