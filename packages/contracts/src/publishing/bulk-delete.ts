import { z } from 'zod';

// ==========================================
// Facebook Bulk Delete Posts (spec 213, rebuilt spec 218)
// ==========================================
// Deletes LIVE published Facebook posts only. Nothing is persisted:
// no queue_items, destinations, usage, or history rows. The server
// resolves the account token from `social_accounts`, exchanges it for
// the page token via Graph `/me/accounts` (spec 218 — page endpoints
// reject the user token with 190/2069032), and deletes through the
// Graph API; the client never supplies a token, so the request schemas
// are `.strict()` — a token field in the body is a 400, never silently
// ignored.
//
// Execution is client-driven (owner decision): the browser sends
// batches and waits 60s between them. Closing the tab stops the run;
// already-deleted ids report success so a retry after a lost
// response cannot turn them into new failures.

/** Preview may return at most this many candidates, across all types. */
export const BULK_DELETE_MAX_PREVIEW = 500;
/** Server batch-delete cap: more ids in one request is a 400. */
export const BULK_DELETE_MAX_BATCH = 25;
/** Client batch size: the browser sends at most this many ids per call. */
export const BULK_DELETE_CLIENT_BATCH_SIZE = 20;
/** Client pause between batches, in seconds. */
export const BULK_DELETE_CLIENT_PAUSE_SECONDS = 60;

export const BulkDeleteContentTypeSchema = z.enum(['posts', 'photos', 'reels']);
export type BulkDeleteContentType = z.infer<typeof BulkDeleteContentTypeSchema>;

/** Smart Filter adds `all`: the three types fanned out and merged. */
export const BulkDeletePreviewTypeSchema = z.enum(['all', 'posts', 'photos', 'reels']);
export type BulkDeletePreviewType = z.infer<typeof BulkDeletePreviewTypeSchema>;

export const BulkDeleteSortSchema = z.enum(['oldest_first', 'newest_first']);
export type BulkDeleteSort = z.infer<typeof BulkDeleteSortSchema>;

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/** One live Facebook post/photo/reel, as listed from the Graph API. */
export const BulkDeleteContentItemSchema = z.object({
  id: z.string().min(1).max(200),
  type: BulkDeleteContentTypeSchema,
  title: z.string().min(1).max(1000),
  createdTime: z.string().nullable(),
  permalinkUrl: z.string().nullable(),
  previewImageUrl: z.string().nullable(),
});
export type BulkDeleteContentItem = z.infer<typeof BulkDeleteContentItemSchema>;

/**
 * Smart Filter preview request: one page per call; the client fans out
 * across selected pages and merges. `.strict()` on purpose — a token
 * field (or any other unknown field) is a 400.
 */
export const BulkDeletePreviewRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    pageId: z.string().min(1).max(100),
    type: BulkDeletePreviewTypeSchema,
    sort: BulkDeleteSortSchema,
    dateFrom: dateStringSchema.optional(),
    dateTo: dateStringSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.dateFrom && data.dateTo && data.dateFrom > data.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The start date must be on or before the end date.',
        path: ['dateFrom'],
      });
    }
  });
export type BulkDeletePreviewRequest = z.infer<typeof BulkDeletePreviewRequestSchema>;

export const BulkDeletePreviewResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  candidates: z.array(BulkDeleteContentItemSchema).max(BULK_DELETE_MAX_PREVIEW),
});
export type BulkDeletePreviewResponse = z.infer<typeof BulkDeletePreviewResponseSchema>;

/** Manual Curation list request, parsed from the query string. */
export const BulkDeleteContentRequestSchema = z.object({
  accountId: z.string().uuid(),
  pageId: z.string().min(1).max(100),
  type: BulkDeleteContentTypeSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(500).optional(),
});
export type BulkDeleteContentRequest = z.infer<typeof BulkDeleteContentRequestSchema>;

export const BulkDeleteContentResponseSchema = z.object({
  items: z.array(BulkDeleteContentItemSchema),
  paging: z.object({ after: z.string().nullable() }),
});
export type BulkDeleteContentResponse = z.infer<typeof BulkDeleteContentResponseSchema>;

/**
 * Batch delete request: one account AND one page per call (spec 218 —
 * the delete uses that page's token, resolved via `/me/accounts`).
 * Over the cap is a 400 — never silently truncated.
 */
export const BulkDeleteBatchRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    pageId: z.string().min(1).max(100),
    contentIds: z.array(z.string().min(1).max(200)).min(1).max(BULK_DELETE_MAX_BATCH),
  })
  .strict();
export type BulkDeleteBatchRequest = z.infer<typeof BulkDeleteBatchRequestSchema>;

/**
 * One delete result. `alreadyDeleted` means Facebook reported the
 * object as already gone: it counts as a success, so a retry after a
 * lost response never turns it into a new failure.
 */
export const BulkDeleteBatchItemResultSchema = z.object({
  id: z.string().min(1).max(200),
  success: z.boolean(),
  alreadyDeleted: z.boolean().optional(),
  error: z.string().min(1).max(500).optional(),
});
export type BulkDeleteBatchItemResult = z.infer<typeof BulkDeleteBatchItemResultSchema>;

export const BulkDeleteBatchResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(BulkDeleteBatchItemResultSchema),
});
export type BulkDeleteBatchResponse = z.infer<typeof BulkDeleteBatchResponseSchema>;
