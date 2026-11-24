import { z } from 'zod';

/**
 * Stored Facebook insights analytics — spec 241.
 *
 * The worker fills four JSONB columns on each Facebook page record
 * (`destinations`, `adu_configs`, `mirrors`) once a day from the
 * Graph Insights API, and the combined Analytics page reads them —
 * nothing is fetched live from Facebook on page open.
 *
 * Shapes (the PDF `analytics-json-storage` is authoritative; this
 * file is the runtime contract for it):
 * - `analytics_1d`: one flat object, the latest day only.
 * - `analytics_7d` / `analytics_28d`: daily entries (oldest first)
 *   plus ONE stored single value — Facebook's own deduplicated
 *   period unique-viewers count (`period=week` / `period=days_28`).
 *   The page reads that stored value, NEVER the sum of daily values.
 * - `analytics_locations`: EVERY country and city Facebook returns,
 *   complete and untrimmed; counts only, shares computed at read time.
 *
 * Dead metrics — never stored, never requested: `page_fan_adds`
 * (removed 2025-11-15), `page_video_views_unique` (removed 2026),
 * `page_video_views_10s` (dead in v26.0). Each returned HTTP 400,
 * code 100, in the 2026-11-23 live probe. `page_video_complete_views_30s`
 * WORKS and is in the design. One invalid metric name fails the whole
 * insights call, so the worker requests only the verified list.
 *
 * Followers do NOT live here: total followers = sum of
 * `current_followers`, gained = current − starting, counted from the
 * day the page was added to FBUploadPro. New follows
 * (`page_daily_follows_unique`) is a separate number and the two are
 * never used in place of each other.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One day of Facebook values — identical in all three period columns. */
export const AnalyticsDayEntrySchema = z
  .object({
    date: z.string().regex(DATE_RE),
    media_views: z.number().int().nonnegative(),
    unique_viewers: z.number().int().nonnegative(),
    profile_views: z.number().int().nonnegative(),
    engagement: z.number().int().nonnegative(),
    video_views: z.number().int().nonnegative(),
    /** Total video watch time that day, in milliseconds. */
    video_view_time_ms: z.number().int().nonnegative(),
    total_actions: z.number().int().nonnegative(),
    /** page_daily_follows_unique — Facebook's new-follows count. */
    new_follows: z.number().int().nonnegative(),
    unfollows: z.number().int().nonnegative(),
    video_complete_views_30s: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyticsDayEntry = z.infer<typeof AnalyticsDayEntrySchema>;

/** `analytics_1d`: one flat object, the latest day only. No wrapper. */
export const Analytics1dSchema = AnalyticsDayEntrySchema;
export type Analytics1d = z.infer<typeof Analytics1dSchema>;

// A page whose first fetch returned fewer than the full window
// (e.g. a young page) legitimately has fewer entries: cap the
// length, do not hard-fail on a short array. The read code sums
// what is there; a missing day inside the window is zero-filled
// by the worker, not by the contract.
// (Written out twice, not via a helper: a computed key in the
// object literal breaks z.infer — days collapses to unknown.)

/** `analytics_7d`: 7 daily entries + Facebook's own deduplicated week value. */
export const Analytics7dSchema = z
  .object({
    days: z.array(AnalyticsDayEntrySchema).max(7),
    unique_viewers_7d: z.number().int().nonnegative(),
  })
  .strict();
export type Analytics7d = z.infer<typeof Analytics7dSchema>;

/** `analytics_28d`: 28 daily entries + Facebook's own deduplicated days_28 value. */
export const Analytics28dSchema = z
  .object({
    days: z.array(AnalyticsDayEntrySchema).max(28),
    unique_viewers_28d: z.number().int().nonnegative(),
  })
  .strict();
export type Analytics28d = z.infer<typeof Analytics28dSchema>;

/** `analytics_locations`: full lifetime country/city lists, counts only. */
export const AnalyticsLocationsSchema = z
  .object({
    /** Stored as ISO codes (PK, US, …), mapped to names at display. */
    countries: z.array(
      z.object({ country: z.string().min(1), followers: z.number().int().nonnegative() }).strict()
    ),
    /** Stored as names, as Facebook returns them. */
    cities: z.array(
      z.object({ city: z.string().min(1), followers: z.number().int().nonnegative() }).strict()
    ),
  })
  .strict();
export type AnalyticsLocations = z.infer<typeof AnalyticsLocationsSchema>;

/** The three selectable periods on the Analytics page. */
export const AnalyticsPeriodSchema = z.enum(['1', '7', '28']);
export type AnalyticsPeriod = z.infer<typeof AnalyticsPeriodSchema>;

/** `GET /api/tenant/[subdomain]/analytics` query. */
export const AnalyticsAggregateQuerySchema = z.object({
  /** 'all' = every workspace the caller owns; otherwise one workspace id. */
  workspace: z.union([z.literal('all'), z.string().uuid()]),
  period: AnalyticsPeriodSchema,
});
export type AnalyticsAggregateQuery = z.infer<typeof AnalyticsAggregateQuerySchema>;

export const AnalyticsLocationItemSchema = z
  .object({
    name: z.string(),
    count: z.number().int().nonnegative(),
    /** Share of combined total followers, 0–100, 1 decimal. */
    sharePct: z.number().min(0).max(100),
  })
  .strict();
export type AnalyticsLocationItem = z.infer<typeof AnalyticsLocationItemSchema>;

export const AnalyticsChartPointSchema = z
  .object({
    date: z.string().regex(DATE_RE),
    mediaViews: z.number().int().nonnegative(),
    uniqueViewers: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyticsChartPoint = z.infer<typeof AnalyticsChartPointSchema>;

export const AnalyticsAggregateResponseSchema = z
  .object({
    success: z.literal(true),
    /** 'all' or the workspace id that was aggregated. */
    workspace: z.union([z.literal('all'), z.string().uuid()]),
    period: AnalyticsPeriodSchema,
    /** "26 Oct – 22 Nov 2026" for the selected period, "" when no data. */
    dateRangeLabel: z.string(),
    /** "Last 28 days · combined" / "Yesterday · combined". */
    periodLabel: z.string(),
    /** Number of distinct Facebook pages included (deduped by page id). */
    pagesIncluded: z.number().int().nonnegative(),
    /**
     * Spec 242 — distinct Facebook pages connected in the picked
     * scope: every page except `disconnected`, deduped by page id.
     * Unlike pagesIncluded (100+ followers only), this counts all
     * connected pages, and it never changes with the period picker.
     */
    pagesConnected: z.number().int().nonnegative(),
    /** Latest analytics_updated_at across the included pages, or null. */
    updatedAt: z.string().nullable(),
    followers: z.object({
      total: z.number().int().nonnegative(),
      gained: z.number().int(),
    }),
    mediaViews: z.number().int().nonnegative(),
    uniqueViewers: z.number().int().nonnegative(),
    profileViews: z.number().int().nonnegative(),
    engagement: z.number().int().nonnegative(),
    videoViews: z.number().int().nonnegative(),
    videoCompleteViews30s: z.number().int().nonnegative(),
    /** Combined watch time, milliseconds; display as hours/minutes. */
    watchTimeMs: z.number().int().nonnegative(),
    totalActions: z.number().int().nonnegative(),
    newFollows: z.number().int().nonnegative(),
    unfollows: z.number().int().nonnegative(),
    /** New follows minus unfollows; may be negative, never clamped. */
    netFollows: z.number().int(),
    /** Daily points from analytics_28d.days (28/7 points, or the 1-day pair). */
    chart: z.array(AnalyticsChartPointSchema),
    /** Top 6 by combined count, shares from combined total followers. */
    topCountries: z.array(AnalyticsLocationItemSchema),
    topCities: z.array(AnalyticsLocationItemSchema),
    /** True when no page in scope has any stored analytics. */
    hasNoData: z.boolean(),
  })
  .strict();
export type AnalyticsAggregateResponse = z.infer<typeof AnalyticsAggregateResponseSchema>;
