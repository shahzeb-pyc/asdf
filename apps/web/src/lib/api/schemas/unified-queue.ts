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
 * The destination's D5 limit state, derived server-side from the
 * contracts limits config (the single source — no numeric limit is
 * ever spelled in UI code) plus the destination's live metering
 * columns. `null` when the platform carries no centred cap.
 */
export const DestinationLimitStateSchema = z.object({
  /** The published-posts cap for the binding window. */
  windowLimit: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  /** Live usage of the binding window, 0–100+ (`destinations.rate_usage_pct`). */
  rateUsagePct: z.number(),
  /** When the destination may publish again, when the worker has pushed it out. */
  nextAllowedPublishAt: z.string().datetime({ offset: true }).nullable(),
});
export type DestinationLimitState = z.infer<
  typeof DestinationLimitStateSchema
>;

/** GET …/destinations/[destinationId]/queue — the full ordered list. */
export const ListDestinationQueueResponseSchema = z.object({
  destinationId: z.string().uuid(),
  platform: PlatformSchema,
  /** The destination's IANA timezone; item times render in it. */
  timezone: z.string(),
  /** The destination's connection status — gates failed-post retry. */
  destinationStatus: z.string(),
  limit: DestinationLimitStateSchema.nullable(),
  /** Ordered by scheduled time (the claim order), then creation. */
  items: z.array(UnifiedQueueItemSchema),
});
export type ListDestinationQueueResponse = z.infer<
  typeof ListDestinationQueueResponseSchema
>;

/**
 * PATCH …/queue/[itemId] — the unified edit-save / reschedule /
 * reorder / requeue write. Mirrors the legacy `UpdateQueueItemRequest`
 * field names and caps where the two shapes overlap; format travels as
 * the unified `kind` + `platformFormat` pair. `status` is the only
 * lifecycle control a client may request: requeue (`queued`) or
 * cancel (`cancelled`) — publishing outcomes are the worker's alone.
 */
export const UpdateDestinationQueueItemRequestSchema = z.object({
  caption: z.string().max(5000).optional(),
  title: z.string().max(500).nullable().optional(),
  firstComment: z.string().max(2000).nullable().optional(),
  linkUrl: z.string().url().nullable().optional(),
  kind: UnifiedQueueKindSchema.optional(),
  platformFormat: z.string().nullable().optional(),
  platformOptions: z.record(z.string(), z.unknown()).optional(),
  scheduledTime: z.string().datetime({ offset: true }).optional(),
  slotId: z.string().uuid().nullable().optional(),
  status: z.enum(['queued', 'cancelled']).optional(),
});
export type UpdateDestinationQueueItemRequest = z.infer<
  typeof UpdateDestinationQueueItemRequestSchema
>;

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
