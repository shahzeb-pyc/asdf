import { z } from 'zod';

import { ValidatedTimezoneSchema } from './queue.js';
import { ThreadsAccountStatusSchema } from './threads-accounts.js';

/**
 * Threads In-app Schedule contracts.
 *
 * Schedule membership is a flag on the existing unified `destinations`
 * row, not a new table: `metadata.threads_schedule_added_at` marks a
 * Threads destination as added to Schedule, and
 * `metadata.threads_schedule_status = 'paused'` (with the destination
 * status `disconnected`, mirroring the Facebook pause pattern) marks
 * a paused one. The claim RPC only claims active/rate-limited
 * destinations, so a paused schedule destination is never published.
 * No migration ships with this feature.
 */

export const THREADS_SCHEDULE_METADATA_ADDED_KEY =
  'threads_schedule_added_at';
export const THREADS_SCHEDULE_METADATA_STATUS_KEY =
  'threads_schedule_status';
export const THREADS_SCHEDULE_PAUSED_VALUE = 'paused';

/** Post formats Threads actually supports (no story, no reel). */
export const ThreadsScheduleFormatSchema = z.enum([
  'text',
  'image',
  'video',
  'carousel',
]);
export type ThreadsScheduleFormat = z.infer<
  typeof ThreadsScheduleFormatSchema
>;
export const THREADS_SCHEDULE_FORMATS: readonly ThreadsScheduleFormat[] = [
  'text',
  'image',
  'video',
  'carousel',
];

/** Wire status of a schedule item, derived from destination + account. */
export const ThreadsScheduleStatusSchema = z.enum([
  'active',
  'paused',
  'expired',
  'disconnected',
  'rate_limited',
  'error',
]);
export type ThreadsScheduleStatus = z.infer<
  typeof ThreadsScheduleStatusSchema
>;

export const ThreadsScheduleQueueCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  posted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type ThreadsScheduleQueueCounts = z.infer<
  typeof ThreadsScheduleQueueCountsSchema
>;

export const ThreadsScheduleItemSchema = z.object({
  /** The destination id — the schedule item's own id. */
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountDisplayName: z.string().min(1),
  threadsAccountId: z.string().min(1),
  name: z.string().min(1),
  handle: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  accountLink: z.string().nullable(),
  timezone: z.string().min(1),
  status: ThreadsScheduleStatusSchema,
  queueCounts: ThreadsScheduleQueueCountsSchema,
  queueCountsError: z.boolean().optional(),
  addedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ThreadsScheduleItem = z.infer<typeof ThreadsScheduleItemSchema>;

export const ListThreadsScheduleResponseSchema = z.object({
  items: z.array(ThreadsScheduleItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
});
export type ListThreadsScheduleResponse = z.infer<
  typeof ListThreadsScheduleResponseSchema
>;

/** One connected Threads account offered as an Add candidate. */
export const ThreadsScheduleCandidateSchema = z.object({
  accountId: z.string().uuid(),
  threadsAccountId: z.string().min(1),
  displayName: z.string().min(1),
  handle: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  destinationId: z.string().uuid().nullable(),
  destinationName: z.string().nullable(),
  destinationTimezone: z.string().nullable(),
  accountStatus: ThreadsAccountStatusSchema,
  scheduleAdded: z.boolean(),
});
export type ThreadsScheduleCandidate = z.infer<
  typeof ThreadsScheduleCandidateSchema
>;

export const ListThreadsScheduleCandidatesResponseSchema = z.object({
  candidates: z.array(ThreadsScheduleCandidateSchema),
});
export type ListThreadsScheduleCandidatesResponse = z.infer<
  typeof ListThreadsScheduleCandidatesResponseSchema
>;

const ThreadsSchedulePostingTimeSchema = z.object({
  time: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):[0-5]\d$/,
      'Posting times must be HH:MM, for example 09:30.'
    ),
  formats: z
    .array(ThreadsScheduleFormatSchema)
    .min(1, 'Each posting time needs at least one post type.'),
});
export type ThreadsSchedulePostingTime = z.infer<
  typeof ThreadsSchedulePostingTimeSchema
>;

/** Add a connected Threads destination to Schedule. */
export const AddThreadsScheduleRequestSchema = z.object({
  destinationId: z.string().uuid(),
  timezone: ValidatedTimezoneSchema,
  postingTimes: z
    .array(ThreadsSchedulePostingTimeSchema)
    .min(1, 'Add at least one posting time.')
    .max(24, 'Add at most 24 posting times.'),
});
export type AddThreadsScheduleRequest = z.infer<
  typeof AddThreadsScheduleRequestSchema
>;

export const AddThreadsScheduleResponseSchema = z.object({
  item: ThreadsScheduleItemSchema,
});
export type AddThreadsScheduleResponse = z.infer<
  typeof AddThreadsScheduleResponseSchema
>;

/** Detail payload for one schedule item. */
export const ThreadsScheduleDetailSchema = ThreadsScheduleItemSchema.extend({
  slots: z.array(
    z.object({
      id: z.string().uuid(),
      slotTime: z.string(),
      isActive: z.boolean(),
      allowedFormats: z.array(ThreadsScheduleFormatSchema),
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
    })
  ),
});
export type ThreadsScheduleDetail = z.infer<
  typeof ThreadsScheduleDetailSchema
>;

export const ThreadsScheduleDetailResponseSchema = z.object({
  item: ThreadsScheduleDetailSchema,
});
export type ThreadsScheduleDetailResponse = z.infer<
  typeof ThreadsScheduleDetailResponseSchema
>;

/** Settings update: timezone and/or pause state. */
export const UpdateThreadsScheduleRequestSchema = z
  .object({
    timezone: ValidatedTimezoneSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((value) => value.timezone !== undefined || value.status !== undefined, {
    message: 'Nothing to update. Change the timezone or the pause state.',
  });
export type UpdateThreadsScheduleRequest = z.infer<
  typeof UpdateThreadsScheduleRequestSchema
>;

export const UpdateThreadsScheduleResponseSchema = z.object({
  item: ThreadsScheduleItemSchema,
});
export type UpdateThreadsScheduleResponse = z.infer<
  typeof UpdateThreadsScheduleResponseSchema
>;

/** A posting-time slot for a Threads schedule item. */
export const ThreadsScheduleSlotSchema = z.object({
  id: z.string().uuid(),
  slotTime: z.string(),
  isActive: z.boolean(),
  allowedFormats: z.array(ThreadsScheduleFormatSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ThreadsScheduleSlot = z.infer<typeof ThreadsScheduleSlotSchema>;

export const ListThreadsScheduleSlotsResponseSchema = z.object({
  slots: z.array(ThreadsScheduleSlotSchema),
  timezone: z.string().min(1),
});
export type ListThreadsScheduleSlotsResponse = z.infer<
  typeof ListThreadsScheduleSlotsResponseSchema
>;

export const CreateThreadsScheduleSlotRequestSchema = z.object({
  time: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):[0-5]\d$/,
      'Posting times must be HH:MM, for example 09:30.'
    ),
  formats: z
    .array(ThreadsScheduleFormatSchema)
    .min(1, 'Each posting time needs at least one post type.'),
});
export type CreateThreadsScheduleSlotRequest = z.infer<
  typeof CreateThreadsScheduleSlotRequestSchema
>;

/** One queue row for a Threads schedule item. */
export const ThreadsScheduleQueueItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['text', 'image', 'video', 'carousel']),
  caption: z.string(),
  mediaName: z.string().nullable(),
  mediaThumbnailUrl: z.string().nullable(),
  scheduledTime: z.coerce.date().nullable(),
  status: z.enum(['queued', 'publishing', 'published', 'failed', 'cancelled']),
  errorMessage: z.string().nullable(),
  externalPostId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ThreadsScheduleQueueItem = z.infer<
  typeof ThreadsScheduleQueueItemSchema
>;

export const ListThreadsScheduleQueueResponseSchema = z.object({
  items: z.array(ThreadsScheduleQueueItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  counts: z.object({
    queued: z.number().int().nonnegative(),
    publishing: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
});
export type ListThreadsScheduleQueueResponse = z.infer<
  typeof ListThreadsScheduleQueueResponseSchema
>;

/**
 * Insights derived from queue_items and publish_logs only. Threads
 * connect scopes are threads_basic + threads_content_publish, so no
 * live follower/reach numbers exist to report — and none are invented.
 * Totals and byKind are post-level queue counts. byDay is attempt-level:
 * publish_logs success/failure attempts per UTC calendar day over the
 * last 14 days (a retried post can therefore appear in more than one
 * attempt, which is why the UI labels byDay as attempts, not posts).
 */
export const ThreadsScheduleInsightsResponseSchema = z.object({
  totals: z.object({
    posted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
  }),
  byKind: z.array(
    z.object({
      kind: z.enum(['text', 'image', 'video', 'carousel']),
      posted: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
  ),
  byDay: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      posted: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
  ),
});
export type ThreadsScheduleInsightsResponse = z.infer<
  typeof ThreadsScheduleInsightsResponseSchema
>;

/** Derive the wire status from destination + account state. */
export function threadsScheduleStatusFromRows(input: {
  destinationStatus: string;
  paused: boolean;
  accountExpired: boolean;
}): ThreadsScheduleStatus {
  if (input.paused) return 'paused';
  if (input.accountExpired) return 'expired';
  if (input.destinationStatus === 'active') return 'active';
  if (input.destinationStatus === 'rate_limited') return 'rate_limited';
  if (input.destinationStatus === 'disconnected') return 'disconnected';
  return 'error';
}

/** True when the metadata bag marks a destination as schedule-added. */
export function isThreadsScheduleAdded(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  const value = metadata?.[THREADS_SCHEDULE_METADATA_ADDED_KEY];
  return typeof value === 'string' && value.length > 0;
}

/** True when the metadata bag marks a destination as schedule-paused. */
export function isThreadsSchedulePaused(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return (
    metadata?.[THREADS_SCHEDULE_METADATA_STATUS_KEY] ===
    THREADS_SCHEDULE_PAUSED_VALUE
  );
}
