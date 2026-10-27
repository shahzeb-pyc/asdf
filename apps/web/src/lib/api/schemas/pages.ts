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

export const FacebookPageViewSchema = z.object({
  id: z.string().uuid(),
  facebookAccountId: z.string().uuid(),
  accountDisplayName: z.string().optional(),
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
