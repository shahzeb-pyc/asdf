import { z } from 'zod';

/**
 * Pages resources.
 *
 * Sources: `GET …/pages` and `GET/PATCH …/pages/[pageId]` (responses
 * parsed server-side through the contracts `FacebookPageViewSchema` /
 * `ListFacebookPagesResponseSchema`), `…/pages/[pageId]/insights`
 * (contracts `PageInsightsResponseSchema`), the discover/import routes,
 * plus fixtures in `tests/api/facebook-pages.test.ts` and the
 * page-insights suites.
 *
 * Passthrough choices: none. Insights' nested objects (overview,
 * time-series points, reactions, demographics) are all rendered by
 * the insights tab, so all of them are strict.
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

/** Page insights. */

export const PageInsightsRangeSchema = z.enum(['7d', '14d', '28d', '90d']);
export type PageInsightsRange = z.infer<typeof PageInsightsRangeSchema>;

export const PageInsightsOverviewSchema = z.object({
  pageName: z.string().nullable(),
  pageImage: z.string().nullable(),
  fanCount: z.number().int().nonnegative(),
  followersCount: z.number().int().nonnegative(),
  totalMediaViews: z.number().int().nonnegative(),
  totalVideoViews: z.number().int().nonnegative(),
  totalPostEngagements: z.number().int().nonnegative(),
});
export type PageInsightsOverview = z.infer<typeof PageInsightsOverviewSchema>;

export const PageInsightsTimeSeriesPointSchema = z.object({
  date: z.string(),
  pageFollows: z.number().int(),
  dailyFollowsUnique: z.number().int(),
  dailyUnfollowsUnique: z.number().int(),
  mediaViews: z.number().int(),
  videoViews: z.number().int(),
  videoCompleteViews30s: z.number().int(),
  videoViewTimeMinutes: z.number(),
});
export type PageInsightsTimeSeriesPoint = z.infer<
  typeof PageInsightsTimeSeriesPointSchema
>;

export const PageInsightsReactionsSchema = z.object({
  like: z.number().int().nonnegative(),
  love: z.number().int().nonnegative(),
  wow: z.number().int().nonnegative(),
  haha: z.number().int().nonnegative(),
  sorry: z.number().int().nonnegative(),
  anger: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type PageInsightsReactions = z.infer<typeof PageInsightsReactionsSchema>;

export const DemographicItemSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  percentage: z.number().min(0).max(100),
});
export type DemographicItem = z.infer<typeof DemographicItemSchema>;

export const PageInsightsDemographicsSchema = z.object({
  topCountries: z.array(DemographicItemSchema),
  topCities: z.array(DemographicItemSchema),
});
export type PageInsightsDemographics = z.infer<typeof PageInsightsDemographicsSchema>;

export const PageInsightsHealthStatusSchema = z.enum([
  'active',
  'invalid_token',
  '2fa_required_on_BM',
  'fb_verification_required',
  'rate_limited',
  'account_suspended',
]);
export type PageInsightsHealthStatus = z.infer<typeof PageInsightsHealthStatusSchema>;

export const PageInsightsResponseSchema = z.object({
  success: z.literal(true),
  fbPageId: z.string(),
  dateRange: PageInsightsRangeSchema,
  cachedAt: z.string(),
  cacheHit: z.boolean(),
  overview: PageInsightsOverviewSchema,
  timeSeries: z.array(PageInsightsTimeSeriesPointSchema),
  reactions: PageInsightsReactionsSchema,
  demographics: PageInsightsDemographicsSchema,
  healthStatus: PageInsightsHealthStatusSchema,
});
export type PageInsightsResponse = z.infer<typeof PageInsightsResponseSchema>;
