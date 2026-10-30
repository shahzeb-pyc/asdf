/**
 * Unified destination queue schemas (spec 134 PR-134-3, T25).
 *
 * The client-side contract for the unified queue surfaces: the
 * per-destination queue list + item actions and the destination
 * posting-slots writes, all served from the unified tables
 * (`queue_items` / `posting_slots`) by the routes under
 * `api/tenant/[subdomain]/destinations/[destinationId]/…`.
 *
 * This module is deliberately separate from `lib/api/schemas/queue.ts`:
 * that file is the LEGACY page-queue shape (spec 134 §3.7 — the legacy
 * schemas stay untouched until Phase 7) and the two item shapes differ
 * (a unified item belongs to a destination on any platform, carries a
 * `kind` + `platformFormat` pair instead of a single page `postFormat`,
 * and its primary media is denormalised onto the row).
 *
 * Strict on rendered fields; no passthrough.
 */
import { z } from 'zod';
import { PlatformSchema } from '@fbuploadpro/contracts';

/** Unified queue kinds (`queue_items.kind`), the enqueue vocabulary. */
export const UnifiedQueueKindSchema = z.enum([
  'text',
  'image',
  'video',
  'story',
  'carousel',
]);
export type UnifiedQueueKind = z.infer<typeof UnifiedQueueKindSchema>;

/** Unified queue item lifecycle (`queue_items.status`). */
export const UnifiedQueueItemStatusSchema = z.enum([
  'queued',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);
export type UnifiedQueueItemStatus = z.infer<
  typeof UnifiedQueueItemStatusSchema
>;

/**
 * The item's primary media as the panel renders it. Present when the
 * library row still exists (name/thumbnail come from it); the row's
 * denormalised `mediaUrl` keeps the post displayable on its own.
 */
export const UnifiedQueueItemMediaSchema = z.object({
  name: z.string(),
  mediaType: z.enum(['video', 'image']),
  url: z.string(),
  thumbnailUrl: z.string().nullable(),
  durationSeconds: z.number().nullable(),
});
export type UnifiedQueueItemMedia = z.infer<
  typeof UnifiedQueueItemMediaSchema
>;

/** One unified queue item as the destination queue surfaces render it. */
export const UnifiedQueueItemSchema = z.object({
  id: z.string().uuid(),
  destinationId: z.string().uuid(),
  platform: PlatformSchema,
  kind: UnifiedQueueKindSchema,
  platformFormat: z.string().nullable(),
  caption: z.string(),
  title: z.string().nullable(),
  firstComment: z.string().nullable(),
  linkUrl: z.string().nullable(),
  mediaItemId: z.string().uuid().nullable(),
  mediaUrl: z.string().nullable(),
  media: UnifiedQueueItemMediaSchema.nullable(),
  platformOptions: z.record(z.string(), z.unknown()),
  // Nullable under publisher-driven scheduling: Facebook queued
  // posts store no time (the posting times are the schedule).
  scheduledTime: z.string().datetime({ offset: true }).nullable(),
  slotId: z.string().uuid().nullable(),
  status: UnifiedQueueItemStatusSchema,
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  /**
   * The stored publish error, used ONLY as input to the panel's
   * plain-language reason mapper (spec 134 §3.5) — raw platform error
   * text is never rendered.
   */
  errorDetail: z.string().nullable(),
  externalPostId: z.string().nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type UnifiedQueueItem = z.infer<typeof UnifiedQueueItemSchema>;

/**
 * K10: the destinations queue-list schemas (D5 limit state + list
 * response) were deleted with the GET route they served — no UI,
 * API, worker, or other route consumed them. The item schemas above
 * stay: retry/publish-now still return the unified item view.
 */

/**
 * K10: the destinations item-PATCH request schema was deleted with
 * the PATCH route it served — the Pages UI edits through
 * `publishing/queue/[itemId]` instead. (K7 note: that deletion is
 * also what closes the PATCH path that could write a carousel kind
 * for Facebook; the publishing PATCH's postFormat enum has no
 * carousel, so it cannot introduce one.)
 */

/** Ack for the item actions that do not return the item (delete, publish-now). */
export const DestinationQueueActionResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  itemId: z.string().uuid().optional(),
});
export type DestinationQueueActionResponse = z.infer<
  typeof DestinationQueueActionResponseSchema
>;

// NOTE: the destinations posting-slots write schemas lived here until
// the destinations slot surface was deleted (no live UI called it
// after PR #16 removed destinations pages). The pages slots routes
// under pages/[pageId]/slots are the single slot surface now.
