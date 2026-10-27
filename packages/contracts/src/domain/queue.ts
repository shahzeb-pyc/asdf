import { z } from 'zod';
import { PostFormatSchema } from './publishing.js';

// ==========================================
// Page Queue Slots (T115)
// ==========================================

// Slot Time regex: HH:MM or HH:MM:SS (24-hour format)
export const SlotTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Invalid time format. Expected HH:MM or HH:MM:SS');

// IANA Timezone validation
export const TimezoneSchema = z.string().min(1).max(50).default('UTC');

// Create Slot Request
export const CreateQueueSlotRequestSchema = z.object({
  pageId: z.string().uuid(),
  slotTime: SlotTimeSchema,
  timezone: TimezoneSchema.optional(),
  allowedFormats: z
    .array(PostFormatSchema)
    .min(1)
    .default(['text', 'image', 'reel', 'video', 'story'])
    .optional(),
});

export type CreateQueueSlotRequest = z.infer<typeof CreateQueueSlotRequestSchema>;

// Update Slot Request
export const UpdateQueueSlotRequestSchema = z.object({
  slotTime: SlotTimeSchema.optional(),
  timezone: TimezoneSchema.optional(),
  isActive: z.boolean().optional(),
  allowedFormats: z.array(PostFormatSchema).min(1).optional(),
});

export type UpdateQueueSlotRequest = z.infer<typeof UpdateQueueSlotRequestSchema>;

// Update Schedule Timezone Request
export const UpdateQueueScheduleTimezoneRequestSchema = z.object({
  timezone: TimezoneSchema,
});

export type UpdateQueueScheduleTimezoneRequest = z.infer<typeof UpdateQueueScheduleTimezoneRequestSchema>;

// Update Schedule Timezone Response
export const UpdateQueueScheduleTimezoneResponseSchema = z.object({
  success: z.boolean(),
  timezone: TimezoneSchema,
  updatedCount: z.number().int().nonnegative(),
  // No realigned count: under publisher-driven scheduling, queued
  // posts store no times, so a timezone change rewrites nothing.
  // Queue estimates simply update with the new zone.
});

export type UpdateQueueScheduleTimezoneResponse = z.infer<typeof UpdateQueueScheduleTimezoneResponseSchema>;

// Queue Slot Domain Model
export const PageQueueSlotSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  pageId: z.string().uuid(),
  slotTime: z.string(),
  timezone: z.string().default('UTC'),
  isActive: z.boolean(),
  allowedFormats: z
    .array(PostFormatSchema)
    .default(['text', 'image', 'reel', 'video', 'story']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PageQueueSlot = z.infer<typeof PageQueueSlotSchema>;

// List Slots Response
export const ListQueueSlotsResponseSchema = z.object({
  slots: z.array(PageQueueSlotSchema),
  total: z.number().int().nonnegative(),
});

export type ListQueueSlotsResponse = z.infer<typeof ListQueueSlotsResponseSchema>;

// ==========================================
// Queue Management & Enqueueing (T116)
// ==========================================

// Queue Item Status
export const QueueItemStatusSchema = z.enum([
  'queued',
  'publishing',
  'published',
  'failed',
  'skipped',
  'cancelled',
]);

export type QueueItemStatus = z.infer<typeof QueueItemStatusSchema>;

// Enqueue Asset Request
export const EnqueueMediaRequestSchema = z
  .object({
    pageId: z.string().uuid(),
    mediaId: z.string().uuid().nullable().optional(),
    postFormat: PostFormatSchema.optional(),
    linkUrl: z.string().url().nullable().optional(),
    slotId: z.string().uuid().optional(),
    scheduledTime: z.string().datetime().optional(), // If omitted, calculated from next vacant slot
    caption: z.string().max(5000).default(''),
    firstComment: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (typeof v === 'string' && v.trim().length === 0 ? null : v)),
  })
  .superRefine((val, ctx) => {
    // If postFormat is omitted, infer 'text' if mediaId is missing/null
    const format = val.postFormat ?? (val.mediaId ? undefined : 'text');

    if (format === 'text') {
      if (!val.caption || val.caption.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Caption is required for text posts',
          path: ['caption'],
        });
      }
    } else if (val.postFormat !== undefined) {
      if (!val.mediaId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'mediaId is required for media posts',
          path: ['mediaId'],
        });
      }
    }

    if (val.postFormat === 'story' && val.firstComment && val.firstComment.trim().length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Facebook Stories do not support comments',
        path: ['firstComment'],
      });
    }
  });

export const EnqueueRequestSchema = EnqueueMediaRequestSchema;
export type EnqueueMediaRequest = z.infer<typeof EnqueueMediaRequestSchema>;
export type EnqueueRequest = z.infer<typeof EnqueueRequestSchema>;

// Update Queue Item Request
export const UpdateQueueItemRequestSchema = z.object({
  caption: z.string().max(5000).optional(),
  firstComment: z.string().max(2000).nullable().optional(),
  scheduledTime: z.string().datetime().optional(),
  status: z.enum(['queued', 'skipped', 'cancelled']).optional(),
  postFormat: PostFormatSchema.optional(),
  linkUrl: z.string().url().nullable().optional(),
});

export type UpdateQueueItemRequest = z.infer<typeof UpdateQueueItemRequestSchema>;

// Queue Item Domain Model
export const QueueItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  pageId: z.string().uuid(),
  slotId: z.string().uuid().nullable(),
  mediaId: z.string().uuid().nullable(),
  postFormat: PostFormatSchema.default('reel'),
  linkUrl: z.string().nullable().optional(),
  // Nullable under publisher-driven scheduling: Facebook queued
  // posts store no time (the posting times are the schedule).
  // Other platforms and already-published rows still carry one.
  scheduledTime: z.string().datetime().nullable(),
  caption: z.string(),
  firstComment: z.string().nullable(),
  status: QueueItemStatusSchema,
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  fbPostId: z.string().nullable(),
  fbCommentId: z.string().nullable(),
  publishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // Expanded media fields for UI display (optional for text posts)
  media: z
    .object({
      name: z.string(),
      mediaType: z.enum(['video', 'image']),
      thumbnailUrl: z.string().nullable(),
      url: z.string(),
      aspectRatio: z.string(),
      durationSeconds: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

export type QueueItem = z.infer<typeof QueueItemSchema>;

// List Queue Items Query
export const ListQueueItemsQuerySchema = z.object({
  pageId: z.string().uuid().optional(),
  status: QueueItemStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type ListQueueItemsQuery = z.infer<typeof ListQueueItemsQuerySchema>;

// List Queue Items Response
export const ListQueueItemsResponseSchema = z.object({
  items: z.array(QueueItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
  queuedCount: z.number().int().nonnegative().optional(),
  publishedCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  skippedCount: z.number().int().nonnegative().optional(),
  cancelledCount: z.number().int().nonnegative().optional(),
});

export type ListQueueItemsResponse = z.infer<typeof ListQueueItemsResponseSchema>;
