import { z } from 'zod';

// ==========================================
// Instagram Schedule — the Instagram equivalent of Facebook Pages
// (in-app schedule). Contracts first: web routes and UI consume these
// values, they never re-declare the IG schedule vocabulary.
//
// Source of truth for the supported types: the worker Instagram
// publisher (apps/worker/src/publishers/instagram.ts) publishes a
// single photo, a Reel (video), or a carousel (2-10 items). Text-only
// is refused by the enqueue contract, and stories are refused for
// Creator accounts by the worker's Business-only story guard — so
// neither type appears here, and the Schedule UI never offers them.
// ==========================================

/** Post types the Instagram Schedule composer may create. */
export const IG_SCHEDULE_FORMATS = ['image', 'reel', 'carousel'] as const;
export type InstagramScheduleFormat = (typeof IG_SCHEDULE_FORMATS)[number];

/**
 * Slot `kind` values a Schedule posting time may cover. 'video' is
 * included only for scheduler matching: video posts enqueue with
 * platformFormat 'reel', and the slot scheduler matches on format, so
 * a Reel slot must match both spellings. The UI offers Photo / Reel /
 * Carousel only.
 */
export const IG_SCHEDULE_SLOT_KINDS = [
  'image',
  'reel',
  'video',
  'carousel',
] as const;

/** Default formats for a newly created posting time. */
export const IG_SCHEDULE_DEFAULT_SLOT_KINDS: readonly string[] = [
  'image',
  'reel',
  'carousel',
];

/** destinations.metadata flag marking a destination as added to Schedule. */
export const IG_SCHEDULE_METADATA_FLAG = 'scheduled';

/** destinations.metadata flag marking a scheduled destination as paused. */
export const IG_SCHEDULE_PAUSED_FLAG = 'schedule_paused';

/**
 * Subscription cap on scheduled Instagram accounts. Null means
 * unlimited: the owner decided no cap is enforced now, and the cap
 * hook below exists so a cap can be added later by changing this
 * constant, without touching the add route or UI.
 */
export const IG_SCHEDULE_COUNT_CAP: number | null = null;

/** True when the given format is an Instagram Schedule post type. */
export function isInstagramScheduleFormat(
  value: string
): value is InstagramScheduleFormat {
  return (IG_SCHEDULE_FORMATS as readonly string[]).includes(value);
}

/** True when the given value may appear in a Schedule slot's kind list. */
export function isInstagramScheduleSlotKind(value: string): boolean {
  return (IG_SCHEDULE_SLOT_KINDS as readonly string[]).includes(value);
}

/**
 * Cap check for adding another account to Schedule. Returns an
 * allowed result while the cap is null (unlimited); when a cap is set,
 * adding at or above the cap is refused with a plain message.
 */
export function canAddInstagramSchedule(
  currentCount: number
): { allowed: true } | { allowed: false; message: string } {
  if (IG_SCHEDULE_COUNT_CAP === null) return { allowed: true };
  if (currentCount < IG_SCHEDULE_COUNT_CAP) return { allowed: true };
  return {
    allowed: false,
    message: `You have reached the limit of ${IG_SCHEDULE_COUNT_CAP} scheduled Instagram accounts for your plan.`,
  };
}

/** One posting time as submitted by the Add flow / Posting Times tab. */
export const InstagramScheduleSlotInputSchema = z.object({
  /** Time of day in the destination's timezone, HH:MM (24-hour). */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Posting times must be HH:MM (24-hour).'),
  /** Formats this time covers; defaults to the full IG set. */
  formats: z
    .array(z.string().refine(isInstagramScheduleSlotKind, 'Unsupported posting format.'))
    .min(1, 'A posting time must cover at least one post type.')
    .optional(),
});
export type InstagramScheduleSlotInput = z.infer<
  typeof InstagramScheduleSlotInputSchema
>;

/**
 * Validates a batch of posting times: each time well-formed with
 * IG-only formats, and no duplicate time-of-day (the same rule the
 * Facebook Add Page schedule step enforces). Returns a plain-language
 * error, or null when the batch is valid.
 */
export function validateInstagramScheduleSlots(
  slots: readonly InstagramScheduleSlotInput[]
): string | null {
  const seen = new Set<string>();
  for (const slot of slots) {
    const parsed = InstagramScheduleSlotInputSchema.safeParse(slot);
    if (!parsed.success) {
      return parsed.error.issues[0]?.message ?? 'Invalid posting time.';
    }
    if (seen.has(slot.time)) {
      return `Posting time ${slot.time} is used more than once. Each posting time can only appear once.`;
    }
    seen.add(slot.time);
  }
  return null;
}
