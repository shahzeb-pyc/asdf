import { z } from 'zod';

/**
 * Prompt Library contracts — the single source of truth for the
 * prompt catalogue. Admin-only writes: prompts are NEVER uploaded
 * by users. Every new prompt is added by US via the backend admin
 * API only; there is no user submission endpoint and no "add
 * prompt" button in the user-facing library.
 *
 * Enums here must match the CHECK constraints in
 * supabase/migrations/20261028120000_prompt_library.sql exactly.
 * The DB is the enforcement copy; these schemas are the runtime
 * validation copy. Do not add a route-local schema shadowing this
 * file — import from here at every API boundary.
 */

export const PromptToolSchema = z.enum(['dola_ai', 'veo3', 'google_flow']);
export type PromptTool = z.infer<typeof PromptToolSchema>;

export const PromptCategorySchema = z.enum([
  'animals',
  'comedy',
  'cinematic',
  'ugc',
  'tutorial',
  'unboxing',
]);
export type PromptCategory = z.infer<typeof PromptCategorySchema>;

export const PromptLanguageSchema = z.enum(['en', 'ur', 'hi']);
export type PromptLanguage = z.infer<typeof PromptLanguageSchema>;

export const PromptLengthSchema = z.enum([
  'under_15s',
  '15_30s',
  '30s_plus',
  '1min_plus',
]);
export type PromptLength = z.infer<typeof PromptLengthSchema>;

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

/** Display labels — the UI never hardcodes these. */
export const PromptToolLabels: Record<PromptTool, string> = {
  dola_ai: 'Dola AI',
  veo3: 'Veo 3',
  google_flow: 'Google Flow',
};
export const PromptCategoryLabels: Record<PromptCategory, string> = {
  animals: 'Animals',
  comedy: 'Comedy',
  cinematic: 'Cinematic',
  ugc: 'UGC',
  tutorial: 'Tutorial',
  unboxing: 'Unboxing',
};
export const PromptLanguageLabels: Record<PromptLanguage, string> = {
  en: 'English',
  ur: 'Urdu',
  hi: 'Hindi',
};
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
  format: PromptFormatSchema,
  aspectRatio: PromptAspectRatioSchema,
  previewMediaType: PromptPreviewMediaTypeSchema,
  previewStorageKey: PromptLibraryStorageKeySchema,
  previewPosterKey: PromptLibraryStorageKeySchema.nullable().optional(),
  durationSeconds: z.number().nonnegative().nullable().optional(),
  status: PromptStatusSchema,
};

function withPromptInvariants<T extends z.ZodRawShape>(shape: T) {
  return z
    .object(shape)
    .superRefine((value, ctx) => {
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
      if (
        value.previewMediaType === 'video' &&
        (value.previewPosterKey === undefined || value.previewPosterKey === null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['previewPosterKey'],
          message: 'A video preview requires a poster key',
        });
      }
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
  format: promptCoreFields.format.optional(),
  aspectRatio: promptCoreFields.aspectRatio.optional(),
  previewMediaType: promptCoreFields.previewMediaType.optional(),
  previewStorageKey: promptCoreFields.previewStorageKey.optional(),
  previewPosterKey: promptCoreFields.previewPosterKey.optional(),
  durationSeconds: promptCoreFields.durationSeconds.optional(),
  status: promptCoreFields.status.optional(),
  slug: PromptSlugSchema.optional(),
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

/** Full DB row, as the API returns it for the dedicated section. */
export const PromptDetailSchema = z.object({
  id: z.string().uuid(),
  slug: PromptSlugSchema,
  title: z.string(),
  shortDescription: z.string(),
  masterPrompt: z.string(),
  tool: PromptToolSchema,
  category: PromptCategorySchema,
  language: PromptLanguageSchema,
  length: PromptLengthSchema,
  format: PromptFormatSchema,
  aspectRatio: PromptAspectRatioSchema,
  previewMediaType: PromptPreviewMediaTypeSchema,
  previewStorageKey: z.string(),
  previewPosterKey: z.string().nullable(),
  previewUrl: z.string().url(),
  previewPosterUrl: z.string().url().nullable(),
  durationSeconds: z.number().nullable(),
  copiedCount: z.number().int().nonnegative(),
  status: PromptStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  isFavourite: z.boolean(),
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

/** List item: the master prompt and steps are NOT returned here — they
 * belong only to the dedicated section. */
export const PromptListItemSchema = PromptDetailSchema.omit({
  masterPrompt: true,
  steps: true,
});
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
