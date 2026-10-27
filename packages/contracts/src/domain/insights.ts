import { z } from 'zod';

/**
 * Page Insights response contract — rebuilt 2026-10-27 from live Facebook
 * research (Graph API v26.0, Media Views / Media Viewers framework).
 *
 * Design notes (research-driven, not inherited from the deleted tab):
 * - Legacy Reach / Impressions metrics retired by Meta on 2026-06-15 are
 *   NOT in this contract. Headline distribution is Media Views
 *   (`page_media_view`) and Unique Viewers (`page_total_media_view_unique`).
 * - Every range-dependent figure is computed from the SAME selected window
 *   (daily series summed over since/until). The single exception is the
 *   audience breakdown, which Facebook only supplies as a lifetime
 *   distribution — the UI must label it "All-time" and never present it
 *   as a range figure.
 * - Daily unique viewers summed over a window are NOT de-duplicated
 *   unique people. The contract therefore names the field
 *   `uniqueViewersDailySum`, and the engagement rate is defined against
 *   media views (engagements / views), never against that sum.
 * - Age/gender breakdowns are NOT offered: Meta removed those dimensions
 *   from the Page Insights API in 2024.
 * - Nothing in this contract is stored server-side. The server returns it
 *   fresh from Facebook; the client may cache it locally for one hour.
 */

export const PageInsightsRangeSchema = z.enum(['7d', '14d', '28d', '90d']);
export type PageInsightsRange = z.infer<typeof PageInsightsRangeSchema>;

export const InsightsTrendPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  views: z.number().int().nonnegative(),
  viewers: z.number().int().nonnegative(),
});
export type InsightsTrendPoint = z.infer<typeof InsightsTrendPointSchema>;

export const InsightsReactionSchema = z.object({
  kind: z.enum(['like', 'love', 'wow', 'haha', 'sad', 'angry']),
  count: z.number().int().nonnegative(),
  sharePct: z.number().min(0).max(100),
});
export type InsightsReaction = z.infer<typeof InsightsReactionSchema>;

export const InsightsAudienceItemSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  sharePct: z.number().min(0).max(100),
});
export type InsightsAudienceItem = z.infer<typeof InsightsAudienceItemSchema>;

export const InsightsKpisSchema = z.object({
  followers: z.number().int().nonnegative(),
  mediaViews: z.number().int().nonnegative(),
  uniqueViewersDailySum: z.number().int().nonnegative(),
  engagements: z.number().int().nonnegative(),
  /** Engagements per media view, percent, 1 decimal — null when views are 0. */
  engagementRatePct: z.number().nullable(),
  /** New follows minus unfollows over the selected window (may be negative). */
  netFollowerGrowth: z.number().int(),
  /** Total video watch time over the window, whole minutes. */
  videoWatchTimeMinutes: z.number().int().nonnegative(),
});
export type InsightsKpis = z.infer<typeof InsightsKpisSchema>;

export const PageInsightsResponseSchema = z.object({
  success: z.literal(true),
  pageId: z.string(),
  range: PageInsightsRangeSchema,
  /** ISO timestamp of the live fetch this payload came from. */
  fetchedAt: z.string(),
  kpis: InsightsKpisSchema,
  trend: z.array(InsightsTrendPointSchema),
  reactions: z.array(InsightsReactionSchema),
  /** Lifetime distribution — NOT limited to `range`. UI must label it so. */
  topCountries: z.array(InsightsAudienceItemSchema),
  /** Lifetime distribution — NOT limited to `range`. UI must label it so. */
  topCities: z.array(InsightsAudienceItemSchema),
});
export type PageInsightsResponse = z.infer<typeof PageInsightsResponseSchema>;

export const PageInsightsQuerySchema = z.object({
  range: PageInsightsRangeSchema.default('28d'),
});
export type PageInsightsQuery = z.infer<typeof PageInsightsQuerySchema>;
