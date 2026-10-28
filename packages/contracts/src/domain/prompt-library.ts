import { z } from 'zod';

/**
 * Prompt Library contracts — the single source of truth for the
 * prompt catalogue. Admin-only writes: prompts are NEVER uploaded
 * by users. Every new prompt is added by US via the backend admin
 * API only; there is no user submission endpoint and no "add
 * prompt" button in the user-facing library.
 *
 * TAXONOMY (tool / category / language) IS FREE TEXT, NOT AN
 * ENUM — since migration 20261028140000_relax_prompt_library_
 * taxonomy.sql dropped the DB CHECK enums for these three
 * columns. A brand-new category, tool, or language needs NO
 * migration: an admin simply uses it in an admin create call,
 * and the dynamic facets pick it up automatically once the
 * prompt is published. Typo risk is controlled at the admin
 * layer (admin-only writes + the normalisation below), not by
 * a DB enum, and no separate taxonomy table is invented.
 * The enums that REMAIN — status, length bucket, format, aspect
 * ratio, media type, sort — are system values, not growing
 * taxonomies, and still match their DB CHECK constraints.
 * Do not add a route-local schema shadowing this file — import
 * from here at every API boundary.
 */

/**
 * Normalised taxonomy text: trimmed, lowercased, single spaces.
 * Applied identically on create, update, and list-query filters,
 * so a stored value and a filter for it always match.
 */
function normalisedTaxonomyText(maxLength: number) {
  return z
    .string()
    .trim()
    .transform((value) => value.toLowerCase().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(maxLength));
}

export const PromptToolSchema = normalisedTaxonomyText(100);
export type PromptTool = z.infer<typeof PromptToolSchema>;

export const PromptCategorySchema = normalisedTaxonomyText(100);
export type PromptCategory = z.infer<typeof PromptCategorySchema>;

/** Language: a lowercase ISO-style code of 2-5 letters. */
export const PromptLanguageSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^[a-z]{2,5}$/, {
    message: 'Language must be a 2-5 letter code',
  }));
export type PromptLanguage = z.infer<typeof PromptLanguageSchema>;

export const PromptLengthSchema = z.enum([
  'under_15s',
  '15_30s',
  '30s_plus',
  '1min_plus',
]);
export type PromptLength = z.infer<typeof PromptLengthSchema>;

/**
 * Exact video length in seconds, exactly as the source states it
 * (e.g. 30 for a source that says 30s). This is SEPARATE from the
 * length bucket above: the bucket stays for filtering, but it must
 * never replace the exact length in display. Nullable: NULL means
 * the exact length is unknown (e.g. prompts that only ever had a
 * bucket) — the UI then falls back to the bucket label.
 * Integer seconds, not free text: the codebase already stores
 * media durations as integer seconds, and seconds are unambiguous,
 * whereas text would invite inconsistent formats ("30s", "30 sec",
 * "0:30"). The rendering rule is formatExactDurationSeconds below.
 */
export const PromptExactDurationSecondsSchema = z
  .number()
  .int()
  .nonnegative();
export type PromptExactDurationSeconds = z.infer<
  typeof PromptExactDurationSecondsSchema
>;

/**
 * Rendering rule for an exact length in seconds: under a minute is
 * "{n}s" (30 -> "30s"); a whole number of minutes is "{m} min"
 * (60 -> "1 min"); anything longer is "{m} min {s}s"
 * (75 -> "1 min 15s"). Every surface must use this helper, so the
 * exact length renders identically on cards and in the detail
 * section — never re-rendered ad hoc, never bucketed.
 */
export function formatExactDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (remainder === 0) return `${minutes} min`;
  return `${minutes} min ${remainder}s`;
}

/**
 * What a card or the detail section shows for a prompt's length:
 * the exact length when it is known, otherwise the bucket label.
 * The bucket is a filter, not a display substitute — a prompt whose
 * source says 30s must show "30s", never "15-30s", once its exact
 * length is recorded.
 */
export function promptLengthDisplay(
  exactDurationSeconds: number | null | undefined,
  bucket: PromptLength,
): string {
  if (exactDurationSeconds !== null && exactDurationSeconds !== undefined) {
    return formatExactDurationSeconds(exactDurationSeconds);
  }
  return PromptLengthLabels[bucket];
}

export const PromptFormatSchema = z.enum(['vertical_reel', 'horizontal_video']);
export type PromptFormat = z.infer<typeof PromptFormatSchema>;

export const PromptStatusSchema = z.enum(['draft', 'published']);
export type PromptStatus = z.infer<typeof PromptStatusSchema>;

export const PromptPreviewMediaTypeSchema = z.enum(['image', 'video']);
export type PromptPreviewMediaType = z.infer<
  typeof PromptPreviewMediaTypeSchema
>;

export const PromptAspectRatioSchema = z.enum(['9:16', '16:9']);
export type PromptAspectRatio = z.infer<typeof PromptAspectRatioSchema>;

export const PromptSortSchema = z.enum(['newest', 'most_copied', 'a_to_z']);
export type PromptSort = z.infer<typeof PromptSortSchema>;

/**
 * Display labels for the values that predate free-text taxonomy.
 * New values have no entry here — the label helpers below fall
 * back to a title-cased display form, so a new value never
 * renders as undefined. The UI must use the helpers, not index
 * these maps directly, for any value that may be new.
 */
export const PromptToolLabels: Record<string, string> = {
  dola_ai: 'Dola AI',
  veo3: 'Veo 3',
  google_flow: 'Google Flow',
};
export const PromptCategoryLabels: Record<string, string> = {
  animals: 'Animals',
  comedy: 'Comedy',
  cinematic: 'Cinematic',
  ugc: 'UGC',
  tutorial: 'Tutorial',
  unboxing: 'Unboxing',
};
export const PromptLanguageLabels: Record<string, string> = {
  en: 'English',
  ur: 'Urdu',
  hi: 'Hindi',
};

function titleCaseTaxonomy(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Display label for any tool, old or brand-new. */
export function promptToolLabel(value: string): string {
  return PromptToolLabels[value] ?? titleCaseTaxonomy(value);
}

/** Display label for any category, old or brand-new. */
export function promptCategoryLabel(value: string): string {
  return PromptCategoryLabels[value] ?? titleCaseTaxonomy(value);
}

/** Display label for any language code, old or brand-new. */
export function promptLanguageLabel(value: string): string {
  return PromptLanguageLabels[value] ?? value.toUpperCase();
}
export const PromptLengthLabels: Record<PromptLength, string> = {
  under_15s: 'Under 15s',
  '15_30s': '15-30s',
  '30s_plus': '30s+',
  '1min_plus': '1 min+',
};
export const PromptFormatLabels: Record<PromptFormat, string> = {
  vertical_reel: 'Vertical reel',
  horizontal_video: 'Horizontal video',
};

/** Format and aspect ratio must agree: vertical is 9:16, horizontal is 16:9. */
export function promptFormatMatchesAspectRatio(
  format: PromptFormat,
  aspectRatio: PromptAspectRatio,
): boolean {
  return (
    (format === 'vertical_reel' && aspectRatio === '9:16') ||
    (format === 'horizontal_video' && aspectRatio === '16:9')
  );
}

/**
 * R2 storage keys for prompt previews. R2 has no folders — this is a
 * key prefix in the shared fbuploadpro-user-media bucket. A prompt's
 * media must live under prompts/{prompt_id}/, never under users/,
 * never loose in the bucket root, never under a title slug.
 */
export const PROMPT_LIBRARY_R2_PREFIX = 'prompts/';

export function isPromptLibraryStorageKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.startsWith(PROMPT_LIBRARY_R2_PREFIX) &&
    key.length > PROMPT_LIBRARY_R2_PREFIX.length &&
    !key.includes('..') &&
    !key.startsWith('/') &&
    !key.includes('\\')
  );
}

export const PromptLibraryStorageKeySchema = z
  .string()
  .min(1)
  .max(500)
  .refine(isPromptLibraryStorageKey, {
    message: 'Storage key must live under the prompts/ prefix in R2',
  });

export const PromptSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase letters, digits, and single hyphens',
  });

/** Derives the public preview URL for an R2 key, exactly as media does. */
export function promptPreviewUrl(publicUrl: string, storageKey: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/${storageKey}`;
}

const promptCoreFields = {
  title: z.string().trim().min(1).max(200),
  shortDescription: z.string().trim().min(1).max(500),
  masterPrompt: z.string().trim().min(1).max(50000),
  tool: PromptToolSchema,
  category: PromptCategorySchema,
  language: PromptLanguageSchema,
  length: PromptLengthSchema,
  /** Exact length in seconds, as the source states it; null = unknown. */
  exactDurationSeconds: PromptExactDurationSecondsSchema.nullable().optional(),
  format: PromptFormatSchema,
  aspectRatio: PromptAspectRatioSchema,
  status: PromptStatusSchema,
};

function withPromptInvariants<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).superRefine((value, ctx) => {
    if (
      value.format !== undefined &&
      value.aspectRatio !== undefined &&
      !promptFormatMatchesAspectRatio(value.format, value.aspectRatio)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aspectRatio'],
        message: 'Aspect ratio must match the format (vertical 9:16, horizontal 16:9)',
      });
    }
  });
}

/**
 * One media item of a prompt. A prompt has MULTIPLE videos/images,
 * not one preview: the list is the whole gallery. Exactly one item
 * must be the main (isMain) — the card preview uses it, and the
 * detail section shows it large first. A video item requires a
 * poster key; every key must live under prompts/ in R2.
 */
export const PromptMediaItemInputSchema = z
  .object({
    position: z.number().int().min(1).max(50),
    mediaType: PromptPreviewMediaTypeSchema,
    storageKey: PromptLibraryStorageKeySchema,
    posterKey: PromptLibraryStorageKeySchema.nullable().optional(),
    durationSeconds: z.number().nonnegative().nullable().optional(),
    isMain: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      value.mediaType === 'video' &&
      (value.posterKey === undefined || value.posterKey === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['posterKey'],
        message: 'A video media item requires a poster key',
      });
    }
  });
export type PromptMediaItemInput = z.infer<typeof PromptMediaItemInputSchema>;

function validPromptMediaList(
  media: readonly PromptMediaItemInput[],
): boolean {
  const positions = media.map((item) => item.position);
  if (new Set(positions).size !== positions.length) return false;
  return media.filter((item) => item.isMain).length === 1;
}

/** Shared media-array rules: unique positions, exactly one main. */
function promptMediaArraySchema() {
  return z
    .array(PromptMediaItemInputSchema)
    .min(1)
    .max(50)
    .refine(validPromptMediaList, {
      message:
        'Media must have unique positions and exactly one main item',
    });
}

export const PromptHowToStepInputSchema = z.object({
  position: z.number().int().min(1).max(50),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
});
export type PromptHowToStepInput = z.infer<typeof PromptHowToStepInputSchema>;

function uniqueStepPositions(
  steps: readonly PromptHowToStepInput[],
): boolean {
  return new Set(steps.map((step) => step.position)).size === steps.length;
}

export const PromptCreateSchema = withPromptInvariants({
  ...promptCoreFields,
  slug: PromptSlugSchema.optional(),
  media: promptMediaArraySchema(),
  steps: z
    .array(PromptHowToStepInputSchema)
    .min(1)
    .max(50)
    .refine(uniqueStepPositions, {
      message: 'How-to step positions must be unique',
    }),
});
export type PromptCreateInput = z.infer<typeof PromptCreateSchema>;

export const PromptUpdateSchema = withPromptInvariants({
  title: promptCoreFields.title.optional(),
  shortDescription: promptCoreFields.shortDescription.optional(),
  masterPrompt: promptCoreFields.masterPrompt.optional(),
  tool: promptCoreFields.tool.optional(),
  category: promptCoreFields.category.optional(),
  language: promptCoreFields.language.optional(),
  length: promptCoreFields.length.optional(),
  exactDurationSeconds: PromptExactDurationSecondsSchema.nullable().optional(),
  format: promptCoreFields.format.optional(),
  aspectRatio: promptCoreFields.aspectRatio.optional(),
  status: promptCoreFields.status.optional(),
  slug: PromptSlugSchema.optional(),
  media: promptMediaArraySchema().optional(),
  steps: z
    .array(PromptHowToStepInputSchema)
    .min(1)
    .max(50)
    .refine(uniqueStepPositions, {
      message: 'How-to step positions must be unique',
    })
    .optional(),
});
export type PromptUpdateInput = z.infer<typeof PromptUpdateSchema>;

/** One media item as returned by the API, with derived public URLs. */
export const PromptMediaSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  mediaType: PromptPreviewMediaTypeSchema,
  storageKey: z.string(),
  posterKey: z.string().nullable(),
  url: z.string().url(),
  posterUrl: z.string().url().nullable(),
  durationSeconds: z.number().nullable(),
  isMain: z.boolean(),
});
export type PromptMedia = z.infer<typeof PromptMediaSchema>;

/**
 * Shared output fields. previewUrl/previewPosterUrl are derived from
 * the MAIN media item only, so cards keep working unchanged.
 */
const promptOutputBase = {
  id: z.string().uuid(),
  slug: PromptSlugSchema,
  title: z.string(),
  shortDescription: z.string(),
  tool: PromptToolSchema,
  category: PromptCategorySchema,
  language: PromptLanguageSchema,
  length: PromptLengthSchema,
  /** Exact length in seconds, as the source states it; null = unknown. */
  exactDurationSeconds: PromptExactDurationSecondsSchema.nullable(),
  format: PromptFormatSchema,
  aspectRatio: PromptAspectRatioSchema,
  /** Main media only: its type (card needs it to choose video vs
   * image), its URL, and its poster URL. */
  previewMediaType: PromptPreviewMediaTypeSchema,
  previewUrl: z.string().url(),
  previewPosterUrl: z.string().url().nullable(),
  copiedCount: z.number().int().nonnegative(),
  status: PromptStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  isFavourite: z.boolean(),
};

/** Full prompt, as the API returns it for the dedicated section. */
export const PromptDetailSchema = z.object({
  ...promptOutputBase,
  masterPrompt: z.string(),
  /** Full gallery, main first, then by position. */
  media: z.array(PromptMediaSchema).min(1),
  steps: z.array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int(),
      title: z.string().nullable(),
      body: z.string(),
    }),
  ),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

/** List item: ONLY the main media (via previewUrl/previewPosterUrl).
 * The master prompt, steps, and full media list are NOT returned
 * here — they belong only to the dedicated section. */
export const PromptListItemSchema = z.object(promptOutputBase);
export type PromptListItem = z.infer<typeof PromptListItemSchema>;

export const PromptListResponseSchema = z.object({
  items: z.array(PromptListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type PromptListResponse = z.infer<typeof PromptListResponseSchema>;

/** Query params arrive as strings — coerce, then bound. pageSize is
 * capped at 50 so a list can never be an unbounded SELECT (PostgREST
 * silently truncates at 1,000 rows; this API never gets near it). */
export const PromptListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  // Query params arrive as strings, so "true"/"false" must be parsed
  // explicitly — z.coerce.boolean would turn the string "false" into
  // true. Anything other than true/"true"/false/"false"/absent is a 400.
  favorites_only: z
    .preprocess(
      (value) =>
        value === true || value === "true"
          ? true
          : value === false || value === "false" || value === undefined
            ? false
            : value,
      z.boolean(),
    )
    .default(false),
  category: PromptCategorySchema.optional(),
  tool: PromptToolSchema.optional(),
  language: PromptLanguageSchema.optional(),
  length: PromptLengthSchema.optional(),
  format: PromptFormatSchema.optional(),
  sort: PromptSortSchema.default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type PromptListQuery = z.infer<typeof PromptListQuerySchema>;

export const PromptCopyResponseSchema = z.object({
  slug: PromptSlugSchema,
  copiedCount: z.number().int().nonnegative(),
});
export type PromptCopyResponse = z.infer<typeof PromptCopyResponseSchema>;

export const PromptFavouriteResponseSchema = z.object({
  slug: PromptSlugSchema,
  isFavourite: z.boolean(),
});
export type PromptFavouriteResponse = z.infer<
  typeof PromptFavouriteResponseSchema
>;

/**
 * Facets — the distinct values ACTUALLY present in published
 * prompts, with counts, for the filter dropdowns (GET
 * /prompts/facets). Only values a published prompt uses appear;
 * an allowed-but-unused value disappears until a prompt uses it,
 * then appears automatically. Sort is NOT a facet: Sort modes are
 * behaviours (newest / most_copied / a_to_z), not data values.
 * Ordering is the server's: count descending, then value
 * alphabetically on ties; the frontend preserves that order.
 * Computed from ALL published prompts, unfiltered by the current
 * search/filters, so selecting one filter never hides the other
 * options. Since migration 20261028140000, taxonomy values are
 * free text: a brand-new category, tool, or language needs NO
 * migration — once an admin uses it in a create call and the
 * prompt is published, it appears here automatically.
 */
const promptFacetCount = z.number().int().nonnegative();
export const PromptFacetsSchema = z.object({
  category: z.array(
    z.object({ value: PromptCategorySchema, count: promptFacetCount }),
  ),
  tool: z.array(
    z.object({ value: PromptToolSchema, count: promptFacetCount }),
  ),
  language: z.array(
    z.object({ value: PromptLanguageSchema, count: promptFacetCount }),
  ),
  length: z.array(
    z.object({ value: PromptLengthSchema, count: promptFacetCount }),
  ),
});
export type PromptFacets = z.infer<typeof PromptFacetsSchema>;
export type PromptFacetKey = keyof PromptFacets;
