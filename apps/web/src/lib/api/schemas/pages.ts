import { z } from 'zod';

/**
 * Pages resources.
 *
 * Sources: `GET …/pages` and `GET/PATCH …/pages/[pageId]` (responses
 * parsed server-side through the contracts `FacebookPageViewSchema` /
 * `ListFacebookPagesResponseSchema`), the discover/import routes,
 * plus fixtures in `tests/api/facebook-pages.test.ts`.
 */

export const FacebookPageStatusSchema = z.enum([
  'active',
  'paused',
  'fb_rate_limited',
  'page_checkpoint',
  'invalid_token',
  'disconnected',
]);
export type FacebookPageStatus = z.infer<typeof FacebookPageStatusSchema>;

/**
 * Pages list card queue counts, mirroring
 * `PageCardQueueCountsSchema` in @fbuploadpro/contracts: `posted`
 * is the all-time `published` total. Optional so payloads without
 * list counts still parse; the card renders zeros when absent.
 */
export const PageCardQueueCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  posted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PageCardQueueCounts = z.infer<typeof PageCardQueueCountsSchema>;

export const FacebookPageViewSchema = z.object({
  id: z.string().uuid(),
  facebookAccountId: z.string().uuid(),
  // K11: mirrors the contracts view schema — nullable, so a detail
  // payload whose account row is missing (null) parses client-side
  // instead of failing the whole detail fetch as a parse error.
  accountDisplayName: z.string().nullable().optional(),
  accountPictureUrl: z.string().nullable().optional(),
  fbPageId: z.string().min(1),
  pageName: z.string().min(1),
  profilePictureUrl: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  timezone: z.string(),
  startingFollowers: z.number().int().nonnegative(),
  currentFollowers: z.number().int().nonnegative(),
  followersGained: z.number().int(),
  followersCount: z.number().int().nonnegative(),
  status: FacebookPageStatusSchema,
  tasks: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  rateLimitedAt: z.string().nullable().optional(),
  unmatchedPostTypes: z.array(z.string()).optional(),
  queueCounts: PageCardQueueCountsSchema.optional(),
  queueCountsError: z.boolean().optional(),
});
export type FacebookPageView = z.infer<typeof FacebookPageViewSchema>;

export const ListFacebookPagesResponseSchema = z.object({
  pages: z.array(FacebookPageViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  attentionTotal: z.number().int().nonnegative().optional(),
});
export type ListFacebookPagesResponse = z.infer<typeof ListFacebookPagesResponseSchema>;

export const QueueStatusCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  publishing: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type QueueStatusCounts = z.infer<typeof QueueStatusCountsSchema>;

export const PageDetailResponseSchema = z.object({
  page: FacebookPageViewSchema,
  queueCounts: QueueStatusCountsSchema,
});
export type PageDetailResponse = z.infer<typeof PageDetailResponseSchema>;

export const UpdatePageResponseSchema = z.object({
  success: z.boolean(),
  page: FacebookPageViewSchema,
});
export type UpdatePageResponse = z.infer<typeof UpdatePageResponseSchema>;

export const DisconnectPageResponseSchema = z.object({
  success: z.boolean(),
  pageId: z.string().uuid(),
});
export type DisconnectPageResponse = z.infer<typeof DisconnectPageResponseSchema>;

/** Discover / import (add-page flow). */

export const DiscoveredPageSchema = z.object({
  fbPageId: z.string().min(1),
  pageName: z.string().min(1),
  profilePictureUrl: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  currentFollowers: z.number().int().nonnegative(),
  followersCount: z.number().int().nonnegative(),
  tasks: z.array(z.string()),
  isImported: z.boolean(),
});
export type DiscoveredPage = z.infer<typeof DiscoveredPageSchema>;

export const DiscoverPagesResponseSchema = z.object({
  accountId: z.string().uuid(),
  accountDisplayName: z.string(),
  pages: z.array(DiscoveredPageSchema),
  total: z.number().int().nonnegative(),
  // Mirrors the contracts DiscoverPagesResponseSchema (R14/K9):
  // the list is never silently partial. Payload `truncated` is
  // cap-only (500-page Graph cap hit — the modal's capped-list
  // text names the cap specifically); `partial` is a mid-list
  // Graph failure; `droppedCount` counts nodes the discover
  // filter removed. Defaults keep old payloads (and old tests)
  // parsing. NOTE: this payload `truncated` is NOT the helper's
  // either-cause flag — the discover route translates
  // truncationReason === 'page_limit' into it.
  truncated: z.boolean().default(false),
  partial: z.boolean().default(false),
  droppedCount: z.number().int().nonnegative().default(0),
});
export type DiscoverPagesResponse = z.infer<typeof DiscoverPagesResponseSchema>;

export const ImportPagesResponseSchema = z.object({
  success: z.boolean(),
  importedCount: z.number().int().nonnegative(),
  pages: z.array(
    z.object({
      id: z.string().uuid(),
      fbPageId: z.string(),
      pageName: z.string(),
    })
  ),
});
export type ImportPagesResponse = z.infer<typeof ImportPagesResponseSchema>;
