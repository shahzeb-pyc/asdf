import { z } from 'zod';

/**
 * Publishing queue + page queue-slot resources.
 *
 * Sources: `GET/POST …/publishing/queue`, `…/publishing/queue/bulk`,
 * `…/publishing/queue/[itemId]`, `…/pages/[pageId]/slots[/…]` — all
 * parsed server-side through the contracts queue schemas
 * (`QueueItemSchema`, `ListQueueItemsResponseSchema`,
 * `PageQueueSlotSchema`, `ListQueueSlotsResponseSchema`,
 * `BulkEnqueueResponseSchema`) — plus fixtures in
 * `tests/api/publishing-queue*.test.ts` and `queue-slots.test.ts`.
 *
 * Passthrough choices: none. The queue item's nested `media` object
 * is rendered (thumbnail, name, duration), so it is strict.
 */

export const PostFormatSchema = z.enum(['text', 'image', 'reel', 'video', 'story']);
export type PostFormat = z.infer<typeof PostFormatSchema>;

export const QueueItemStatusSchema = z.enum([
  'queued',
  'publishing',
  'published',
  'failed',
  'skipped',
  'cancelled',
]);
export type QueueItemStatus = z.infer<typeof QueueItemStatusSchema>;

export const QueueItemMediaSchema = z.object({
  name: z.string(),
  mediaType: z.enum(['video', 'image']),
  thumbnailUrl: z.string().nullable(),
  url: z.string(),
  aspectRatio: z.string(),
  durationSeconds: z.number().nullable(),
});
export type QueueItemMedia = z.infer<typeof QueueItemMediaSchema>;

export const QueueItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  pageId: z.string().uuid(),
  slotId: z.string().uuid().nullable(),
  mediaId: z.string().uuid().nullable(),
  postFormat: PostFormatSchema,
  linkUrl: z.string().nullable().optional(),
  // Nullable under publisher-driven scheduling: Facebook queued
  // posts store no time (the posting times are the schedule).
  scheduledTime: z.string().nullable(),
  caption: z.string(),
  firstComment: z.string().nullable(),
  status: QueueItemStatusSchema,
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  fbPostId: z.string().nullable(),
  fbCommentId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  media: QueueItemMediaSchema.nullable().optional(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

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
  publishingCount: z.number().int().nonnegative().optional(),
});
export type ListQueueItemsResponse = z.infer<typeof ListQueueItemsResponseSchema>;

export const BulkEnqueueItemResultSchema = z.object({
  ok: z.boolean(),
  itemId: z.string().optional(),
  error: z.string().optional(),
});
export type BulkEnqueueItemResult = z.infer<typeof BulkEnqueueItemResultSchema>;

export const BulkEnqueueResponseSchema = z.object({
  results: z.array(BulkEnqueueItemResultSchema),
});
export type BulkEnqueueResponse = z.infer<typeof BulkEnqueueResponseSchema>;

/** Queue slots (posting times). */

export const PageQueueSlotSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  pageId: z.string().uuid(),
  slotTime: z.string(),
  timezone: z.string(),
  isActive: z.boolean(),
  allowedFormats: z.array(PostFormatSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PageQueueSlot = z.infer<typeof PageQueueSlotSchema>;

export const ListQueueSlotsResponseSchema = z.object({
  slots: z.array(PageQueueSlotSchema),
  total: z.number().int().nonnegative(),
});
export type ListQueueSlotsResponse = z.infer<typeof ListQueueSlotsResponseSchema>;

export const UpdateScheduleTimezoneResponseSchema = z.object({
  success: z.boolean(),
  timezone: z.string(),
  updatedCount: z.number().int().nonnegative(),
  // No realigned count: under publisher-driven scheduling, queued
  // posts store no times, so a timezone change rewrites nothing.
});
export type UpdateScheduleTimezoneResponse = z.infer<
  typeof UpdateScheduleTimezoneResponseSchema
>;
