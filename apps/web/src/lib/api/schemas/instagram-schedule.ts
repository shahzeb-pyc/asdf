import { z } from 'zod';

import {
  ListQueueItemsResponseSchema,
  QueueItemSchema,
} from '@/lib/api/schemas/queue';

/**
 * Instagram Schedule wire schemas — the Instagram equivalent of the
 * Facebook Pages list/detail wire shapes, on the unified destination
 * model. A scheduled Instagram destination is a `destinations` row
 * with `platform='instagram'` and `metadata.scheduled = true`; no
 * separate schedule table exists, so these schemas carry the account
 * fields the cards need alongside the destination fields.
 *
 * User-facing copy never uses the word "destination": the UI says
 * "account". These schemas keep the internal name only where the
 * existing queue schemas already do (pageId = destination id).
 */

export const InstagramScheduleStatusSchema = z.enum([
  'active',
  'paused',
  'expired',
  'disconnected',
]);
export type InstagramScheduleStatus = z.infer<
  typeof InstagramScheduleStatusSchema
>;

export const InstagramScheduleQueueCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  posted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type InstagramScheduleQueueCounts = z.infer<
  typeof InstagramScheduleQueueCountsSchema
>;

export const InstagramScheduleItemSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  accountDisplayName: z.string(),
  accountAvatarUrl: z.string().nullable(),
  handle: z.string().nullable(),
  accountType: z.string().nullable(),
  status: InstagramScheduleStatusSchema,
  timezone: z.string(),
  slotCount: z.number().int().nonnegative(),
  counts: InstagramScheduleQueueCountsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InstagramScheduleItem = z.infer<
  typeof InstagramScheduleItemSchema
>;

export const ListInstagramScheduleResponseSchema = z.object({
  items: z.array(InstagramScheduleItemSchema),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export type ListInstagramScheduleResponse = z.infer<
  typeof ListInstagramScheduleResponseSchema
>;

export const InstagramScheduleDetailResponseSchema = z.object({
  item: InstagramScheduleItemSchema,
});
export type InstagramScheduleDetailResponse = z.infer<
  typeof InstagramScheduleDetailResponseSchema
>;

/** Add-to-Schedule request: account, timezone, posting times. */
export const AddInstagramScheduleRequestSchema = z.object({
  accountId: z.string().uuid(),
  timezone: z.string().min(1),
  postingTimes: z
    .array(
      z.object({
        time: z
          .string()
          .regex(
            /^([01]\d|2[0-3]):[0-5]\d$/,
            'Posting times must be HH:MM (24-hour).'
          ),
        formats: z.array(z.string()).min(1).optional(),
      })
    )
    .min(1, 'Add at least one posting time.')
    .max(50, 'At most 50 posting times can be added at once.'),
});
export type AddInstagramScheduleRequest = z.infer<
  typeof AddInstagramScheduleRequestSchema
>;

export const AddInstagramScheduleResponseSchema = z.object({
  destinationId: z.string().uuid(),
  item: InstagramScheduleItemSchema,
});
export type AddInstagramScheduleResponse = z.infer<
  typeof AddInstagramScheduleResponseSchema
>;

/** Pause / resume request for a scheduled destination. */
export const UpdateInstagramScheduleRequestSchema = z.object({
  paused: z.boolean(),
});
export type UpdateInstagramScheduleRequest = z.infer<
  typeof UpdateInstagramScheduleRequestSchema
>;

/** Single posting time for the Posting Times tab. */
export const CreateInstagramScheduleSlotRequestSchema = z.object({
  time: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):[0-5]\d$/,
      'Posting times must be HH:MM (24-hour).'
    ),
  formats: z.array(z.string()).min(1).optional(),
});
export type CreateInstagramScheduleSlotRequest = z.infer<
  typeof CreateInstagramScheduleSlotRequestSchema
>;

/** Timezone change for a scheduled destination. */
export const UpdateInstagramScheduleTimezoneRequestSchema = z.object({
  timezone: z.string().min(1),
});
export type UpdateInstagramScheduleTimezoneRequest = z.infer<
  typeof UpdateInstagramScheduleTimezoneRequestSchema
>;

/**
 * Queue items for one scheduled Instagram destination. Extends the
 * Pages queue wire shape with the real stored kind and a display
 * format the UI can trust: the Pages helper collapses carousels to
 * "image", which would mislabel every carousel in this section.
 * Display format: carousel when kind is carousel, reel when the
 * platform format is reel (or kind is video — every Instagram video
 * is a Reel), otherwise image.
 */
export const InstagramScheduleQueueItemSchema = QueueItemSchema.extend({
  kind: z.string(),
  platformFormat: z.string().nullable(),
  displayFormat: z.enum(['image', 'reel', 'carousel']),
});
export type InstagramScheduleQueueItem = z.infer<
  typeof InstagramScheduleQueueItemSchema
>;

export const ListInstagramScheduleQueueResponseSchema =
  ListQueueItemsResponseSchema.extend({
    items: z.array(InstagramScheduleQueueItemSchema),
  });
export type ListInstagramScheduleQueueResponse = z.infer<
  typeof ListInstagramScheduleQueueResponseSchema
>;

/** Connected Instagram accounts offered by the Add flow (active only). */
export const InstagramScheduleAccountOptionSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  handle: z.string().nullable(),
  accountType: z.string().nullable(),
  status: z.string(),
});
export type InstagramScheduleAccountOption = z.infer<
  typeof InstagramScheduleAccountOptionSchema
>;

export const ListInstagramScheduleAccountsResponseSchema = z.object({
  accounts: z.array(InstagramScheduleAccountOptionSchema),
  total: z.number().int().nonnegative(),
});
export type ListInstagramScheduleAccountsResponse = z.infer<
  typeof ListInstagramScheduleAccountsResponseSchema
>;
