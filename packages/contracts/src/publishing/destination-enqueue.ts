import { z } from 'zod';
import { PlatformSchema, type Platform } from '../domain/database.js';
import { InstagramPlatformOptionsSchema } from './instagram-options.js';
import { ThreadsPlatformOptionsSchema } from './threads-options.js';
import {
  XPlatformOptionsSchema,
  validateXPlatformOptions,
} from './x-options.js';
import {
  youtubePlatformOptionsSchema,
  YOUTUBE_TITLE_MAX_CHARS,
} from './youtube-options.js';
import { tikTokOptionsSchema } from './tiktok-options.js';

// ==========================================
// Destination enqueue (spec 119/132 enabling backend, 2026-10-24)
// ==========================================
//
// The unified enqueue contract every platform composer (spec 132's
// gated sets) submits against. Until this module landed, nothing in
// the product inserted into the unified `queue_items` for a
// destination and no API served a destination's unified
// `posting_slots` — the only enqueue path was the legacy
// Facebook-page route (`EnqueueMediaRequestSchema`, pageId-based).
//
// Shape decisions:
//   - The request is a discriminated union on `platform`; each
//     variant's `platformOptions` is THAT platform's shipped options
//     schema (specs 124–127) — no parallel definitions. Every one of
//     those schemas is `.strict()`, so an unmodelled key (e.g. a
//     TikTok `isDraft`, deliberately absent per spec 126) fails
//     validation here instead of degrading silently at publish.
//   - `intent` selects the row state the claim pipeline sees:
//       now       → status 'queued', scheduled_time = submission time
//                   (claimable on the claimer's next pass);
//       scheduled → status 'queued', scheduled_time = scheduledAt
//                   (held by the claim RPC's `scheduled_time <= now()`
//                   predicate until its time);
//       queue     → status 'queued', scheduled_time resolved by the
//                   server from the destination's posting_slots (next
//                   vacant slot), slot_id set on the row.
//   - `platform` is carried in the request AND verified server-side
//     against the destination row: a client can never enqueue an item
//     whose platform disagrees with its destination's platform.
//   - Facebook has no per-platform options schema (spec 122's
//     publisher reads its hints from the queue row's columns); the
//     only `platform_options` keys it consumes are the story
//     media-type hints, so the Facebook variant models exactly those.

/** Facebook destination options: the story media-type hints the spec 122 publisher reads. */
export const FacebookDestinationOptionsSchema = z
  .object({
    mediaType: z.enum(['image', 'video']).optional(),
    media_type: z.enum(['image', 'video']).optional(),
  })
  .strict();
export type FacebookDestinationOptions = z.infer<
  typeof FacebookDestinationOptionsSchema
>;

/** The three submission intents (see header for the row-state mapping). */
export const DestinationEnqueueIntentSchema = z.enum([
  'now',
  'scheduled',
  'queue',
]);
export type DestinationEnqueueIntent = z.infer<
  typeof DestinationEnqueueIntentSchema
>;

/** Unified queue-item kinds (`queue_items.kind` vocabulary). */
export const DestinationEnqueueKindSchema = z.enum([
  'text',
  'image',
  'video',
  'story',
  'carousel',
]);
export type DestinationEnqueueKind = z.infer<
  typeof DestinationEnqueueKindSchema
>;

const emptyToNull = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v.trim().length === 0 ? null : (v ?? null);

const destinationEnqueueBaseFields = {
  destinationId: z.string().uuid(),
  kind: DestinationEnqueueKindSchema,
  /** Platform-native format label (`queue_items.platform_format`), e.g. 'reel'. */
  platformFormat: z.string().max(50).nullable().optional(),
  caption: z.string().max(5000).default(''),
  /** Post title (`queue_items.title`); required for YouTube, unused elsewhere in v1. */
  title: z.string().max(500).nullable().optional(),
  firstComment: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .transform(emptyToNull),
  /**
   * Library media backing the post. The unified row carries a single
   * primary media (`media_item_id` + its denormalised url/key), which
   * is the first entry; carousel posts carry their full item list in
   * `platformOptions.carouselItems` per the platform schemas.
   */
  mediaItemIds: z.array(z.string().uuid()).max(10).default([]),
  linkUrl: z.string().url().nullable().optional(),
  intent: DestinationEnqueueIntentSchema,
  /** Required iff intent is 'scheduled'; rejected for the other intents. */
  scheduledAt: z.string().datetime().optional(),
  /** Queue intent only: pin the post to one of the destination's slots. */
  slotId: z.string().uuid().optional(),
};

function destinationEnqueueVariant<OptionsSchema extends z.ZodTypeAny>(
  platform: Platform,
  platformOptions: OptionsSchema,
  captionMax?: number
) {
  return z.object({
    ...destinationEnqueueBaseFields,
    // A variant may raise the shared 5,000-character caption guard
    // when its platform genuinely allows longer text. Only Facebook
    // does so today (feed posts up to 63,206 characters; see the
    // composer limits module for sourcing). Every other variant
    // keeps the shared cap, so no other platform's guard weakens.
    ...(captionMax !== undefined
      ? { caption: z.string().max(captionMax).default('') }
      : {}),
    platform: z.literal(platform),
    platformOptions: platformOptions.optional(),
  });
}

export const DestinationEnqueueRequestSchema = z
  .discriminatedUnion('platform', [
    destinationEnqueueVariant(
      'facebook',
      FacebookDestinationOptionsSchema,
      63206
    ),
    destinationEnqueueVariant('instagram', InstagramPlatformOptionsSchema),
    destinationEnqueueVariant('threads', ThreadsPlatformOptionsSchema),
    destinationEnqueueVariant('youtube', youtubePlatformOptionsSchema),
    destinationEnqueueVariant('x', XPlatformOptionsSchema),
    destinationEnqueueVariant('tiktok', tikTokOptionsSchema),
  ])
  .superRefine((val, ctx) => {
    // --- Facebook caption limits, per post type ---------------------
    // Feed posts/photo/video captions run to 63,206 (the variant cap
    // above), but Reels are a separate publishing API with their own
    // much smaller caption limit of 2,200 — a video post whose
    // platformFormat is 'reel' is held to it. Third-party
    // documented only; see the composer limits module for sourcing.
    if (
      val.platform === 'facebook' &&
      val.kind === 'video' &&
      val.platformFormat === 'reel' &&
      val.caption.length > 2200
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reel captions are limited to 2,200 characters',
        path: ['caption'],
      });
    }
    // --- Intent shape -------------------------------------------------
    if (val.intent === 'scheduled') {
      if (!val.scheduledAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledAt is required for scheduled posts',
          path: ['scheduledAt'],
        });
      } else if (new Date(val.scheduledAt).getTime() <= Date.now()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledAt must be in the future',
          path: ['scheduledAt'],
        });
      }
      if (val.slotId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'slotId only applies to queued posts',
          path: ['slotId'],
        });
      }
    } else {
      if (val.scheduledAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduledAt only applies to scheduled posts',
          path: ['scheduledAt'],
        });
      }
      if (val.intent === 'now' && val.slotId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'slotId only applies to queued posts',
          path: ['slotId'],
        });
      }
    }

    // --- Media / kind shape -------------------------------------------
    const hasMedia = val.mediaItemIds.length > 0;
    if (val.kind === 'text') {
      if (hasMedia) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Text posts cannot include media; use the matching media kind',
          path: ['mediaItemIds'],
        });
      }
      if (!val.caption || val.caption.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Caption is required for text posts',
          path: ['caption'],
        });
      }
    } else if (!hasMedia) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mediaItemIds is required for media posts',
        path: ['mediaItemIds'],
      });
    }

    if (
      val.platform === 'facebook' &&
      val.kind === 'story' &&
      val.firstComment &&
      val.firstComment.trim().length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'First comment is not supported for story posts',
        path: ['firstComment'],
      });
    }

    // --- Per-platform kind rules --------------------------------------
    if (val.platform === 'instagram' && val.kind === 'text') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Instagram posts need media; there is no text-only format',
        path: ['kind'],
      });
    }
    if (val.platform === 'threads' && val.kind === 'story') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Threads does not support stories',
        path: ['kind'],
      });
    }
    if (val.platform === 'youtube') {
      if (val.kind !== 'video') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'YouTube posts are always videos',
          path: ['kind'],
        });
      }
      if (!val.title || val.title.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A title is required for YouTube posts',
          path: ['title'],
        });
      } else if (val.title.length > YOUTUBE_TITLE_MAX_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `YouTube titles can be at most ${YOUTUBE_TITLE_MAX_CHARS} characters`,
          path: ['title'],
        });
      }
    }
    if (
      val.platform === 'tiktok' &&
      val.kind !== 'video' &&
      val.kind !== 'image'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TikTok posts are videos or photo posts',
        path: ['kind'],
      });
    }
    if (
      val.platform === 'x' &&
      (val.kind === 'story' || val.kind === 'carousel')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'X does not support stories or carousels',
        path: ['kind'],
      });
    }

    // --- Carousel items must travel with carousel posts ----------------
    if (
      (val.platform === 'instagram' || val.platform === 'threads') &&
      val.kind === 'carousel'
    ) {
      const options = (val.platformOptions ?? {}) as {
        carouselItems?: unknown;
      };
      if (!Array.isArray(options.carouselItems)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Carousel posts must include their items in platformOptions.carouselItems',
          path: ['platformOptions', 'carouselItems'],
        });
      }
    }

    // --- X cross-field rule (poll XOR media, spec 127) ------------------
    if (val.platform === 'x') {
      const check = validateXPlatformOptions(
        (val.platformOptions ?? {}) as Record<string, unknown>,
        { hasMedia }
      );
      if (!check.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: check.error ?? 'Invalid X options.',
          path: ['platformOptions'],
        });
      }
    }
  });

export type DestinationEnqueueRequest = z.infer<
  typeof DestinationEnqueueRequestSchema
>;

/**
 * Resolves the platform options a queue row must carry for an enqueue
 * request: the platform's own schema applied to the raw value, so an
 * omitted value still has to satisfy the schema (YouTube's required
 * `privacy`/`madeForKids` have no omission path, spec 125) and schema
 * defaults (TikTok's `privacy`) are materialised. Returns the
 * validated options, or the first validation error in plain form.
 */
export function resolveDestinationPlatformOptions(
  platform: Platform,
  raw: Record<string, unknown> | null | undefined
): { ok: true; options: Record<string, unknown> } | { ok: false; error: string } {
  const schemas: Record<Platform, z.ZodTypeAny> = {
    facebook: FacebookDestinationOptionsSchema,
    instagram: InstagramPlatformOptionsSchema,
    threads: ThreadsPlatformOptionsSchema,
    youtube: youtubePlatformOptionsSchema,
    x: XPlatformOptionsSchema,
    tiktok: tikTokOptionsSchema,
  };
  const parsed = schemas[platform].safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues.at(0);
    const where =
      first && first.path.length > 0 ? first.path.join('.') : 'platformOptions';
    return {
      ok: false,
      error: first ? `${where}: ${first.message}` : 'Invalid platform options.',
    };
  }
  return { ok: true, options: parsed.data as Record<string, unknown> };
}

/** The created queue item as the enqueue endpoint returns it. */
export const DestinationEnqueueResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  destinationId: z.string().uuid(),
  platform: PlatformSchema,
  kind: DestinationEnqueueKindSchema,
  platformFormat: z.string().nullable(),
  status: z.enum(['queued', 'publishing', 'published', 'failed', 'cancelled']),
  // Nullable under publisher-driven scheduling: Facebook queued
  // posts store no time (the posting times are the schedule).
  scheduledTime: z.string().datetime({ offset: true }).nullable(),
  slotId: z.string().uuid().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type DestinationEnqueueResponse = z.infer<
  typeof DestinationEnqueueResponseSchema
>;

/** One unified posting slot as the destination posting-times read returns it. */
export const DestinationPostingSlotSchema = z.object({
  id: z.string().uuid(),
  destinationId: z.string().uuid(),
  /** Slot format coverage (`posting_slots.kind`), in queue-kind vocabulary. */
  kind: z.array(z.string()),
  /** Local time of day, 'HH:MM:SS' as stored. */
  timeOfDay: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  isActive: z.boolean(),
});
export type DestinationPostingSlot = z.infer<
  typeof DestinationPostingSlotSchema
>;

export const ListDestinationPostingSlotsResponseSchema = z.object({
  destinationId: z.string().uuid(),
  /** The destination's IANA timezone; slot times are local to it. */
  timezone: z.string(),
  slots: z.array(DestinationPostingSlotSchema),
});
export type ListDestinationPostingSlotsResponse = z.infer<
  typeof ListDestinationPostingSlotsResponseSchema
>;
