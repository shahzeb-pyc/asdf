/**
 * Spec 241 — stored analytics contracts.
 *
 * - Valid 1d/7d/28d/locations payloads parse.
 * - A payload carrying a dead-metric field, a negative count, or a
 *   bad date fails. The dead metrics (page_fan_adds,
 *   page_video_views_unique, page_video_views_10s) are rejected by
 *   the strict object — they must never be stored or requested.
 * - A short `days` array (young page, first fetch) parses.
 * - The aggregate query rejects a bad period / workspace.
 */
import { describe, expect, it } from 'vitest';
import {
  Analytics1dSchema,
  Analytics28dSchema,
  Analytics7dSchema,
  AnalyticsAggregateQuerySchema,
  AnalyticsAggregateResponseSchema,
  AnalyticsDayEntrySchema,
  AnalyticsLocationsSchema,
} from './analytics.js';

const DAY = {
  date: '2026-11-22',
  media_views: 6210,
  unique_viewers: 3480,
  profile_views: 188,
  engagement: 402,
  video_views: 5120,
  video_view_time_ms: 13_900_000,
  total_actions: 82,
  new_follows: 64,
  unfollows: 18,
  video_complete_views_30s: 1150,
};

const DAY2 = { ...DAY, date: '2026-11-21', media_views: 6540, unique_viewers: 3610 };

describe('AnalyticsDayEntrySchema', () => {
  it('parses a full daily entry', () => {
    expect(AnalyticsDayEntrySchema.safeParse(DAY).success).toBe(true);
  });

  it('rejects a negative count and a bad date', () => {
    expect(AnalyticsDayEntrySchema.safeParse({ ...DAY, media_views: -1 }).success).toBe(false);
    expect(AnalyticsDayEntrySchema.safeParse({ ...DAY, date: '22/11/2026' }).success).toBe(false);
  });

  it('rejects a dead-metric field (strict object — it must never be stored)', () => {
    for (const dead of ['page_fan_adds', 'page_video_views_unique', 'page_video_views_10s']) {
      expect(AnalyticsDayEntrySchema.safeParse({ ...DAY, [dead]: 5 }).success).toBe(false);
    }
  });
});

describe('Analytics1dSchema / Analytics7dSchema / Analytics28dSchema', () => {
  it('parses the 1-day flat object', () => {
    expect(Analytics1dSchema.safeParse(DAY).success).toBe(true);
  });

  it('parses 7d/28d payloads with their stored deduplicated values', () => {
    const seven = { days: [DAY2, DAY], unique_viewers_7d: 19_800 };
    expect(Analytics7dSchema.safeParse(seven).success).toBe(true);
    const twentyEight = { days: [DAY2, DAY], unique_viewers_28d: 74_500 };
    expect(Analytics28dSchema.safeParse(twentyEight).success).toBe(true);
  });

  it('accepts a short days array (young page, first fetch)', () => {
    expect(
      Analytics7dSchema.safeParse({ days: [DAY], unique_viewers_7d: 3480 }).success
    ).toBe(true);
    expect(
      Analytics28dSchema.safeParse({ days: [], unique_viewers_28d: 0 }).success
    ).toBe(true);
  });

  it('rejects more days than the window holds', () => {
    const days = Array.from({ length: 8 }, (_, i) => ({ ...DAY, date: `2026-11-${15 + i}` }));
    expect(Analytics7dSchema.safeParse({ days, unique_viewers_7d: 1 }).success).toBe(false);
  });
});

describe('AnalyticsLocationsSchema', () => {
  it('parses full country/city lists (ISO codes for countries)', () => {
    const parsed = AnalyticsLocationsSchema.safeParse({
      countries: [
        { country: 'PK', followers: 9860 },
        { country: 'US', followers: 1940 },
      ],
      cities: [{ city: 'Karachi', followers: 3420 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts empty lists (Facebook can return no location data)', () => {
    expect(
      AnalyticsLocationsSchema.safeParse({ countries: [], cities: [] }).success
    ).toBe(true);
  });

  it('rejects a negative follower count', () => {
    expect(
      AnalyticsLocationsSchema.safeParse({
        countries: [{ country: 'PK', followers: -1 }],
        cities: [],
      }).success
    ).toBe(false);
  });
});

describe('AnalyticsAggregateQuerySchema', () => {
  it('accepts all / a workspace uuid with a valid period', () => {
    expect(
      AnalyticsAggregateQuerySchema.safeParse({ workspace: 'all', period: '28' }).success
    ).toBe(true);
    expect(
      AnalyticsAggregateQuerySchema.safeParse({
        workspace: '7811b89e-92c8-4e7e-a069-44248230fc05',
        period: '7',
      }).success
    ).toBe(true);
  });

  it('rejects a bad period and a non-uuid workspace', () => {
    expect(
      AnalyticsAggregateQuerySchema.safeParse({ workspace: 'all', period: '90' }).success
    ).toBe(false);
    expect(
      AnalyticsAggregateQuerySchema.safeParse({ workspace: 'not-a-workspace', period: '28' })
        .success
    ).toBe(false);
  });
});

describe('AnalyticsAggregateResponseSchema', () => {
  it('parses a full aggregate response, including a negative net follows', () => {
    const parsed = AnalyticsAggregateResponseSchema.safeParse({
      success: true,
      workspace: 'all',
      period: '28',
      dateRangeLabel: '26 Oct – 22 Nov 2026',
      periodLabel: 'Last 28 days · combined',
      pagesIncluded: 5,
      updatedAt: '2026-11-23T03:00:00.000Z',
      followers: { total: 60_975, gained: 59_803 },
      mediaViews: 590_700,
      uniqueViewers: 250_100,
      profileViews: 13_600,
      engagement: 43_740,
      videoViews: 458_000,
      videoCompleteViews30s: 101_000,
      watchTimeMs: 1_339_200_000,
      totalActions: 7600,
      newFollows: 6100,
      unfollows: 1370,
      netFollows: -12,
      chart: [{ date: '2026-11-22', mediaViews: 20_260, uniqueViewers: 11_580 }],
      topCountries: [{ name: 'Pakistan', count: 40_244, sharePct: 66 }],
      topCities: [{ name: 'Karachi', count: 13_415, sharePct: 22 }],
      hasNoData: false,
    });
    expect(parsed.success).toBe(true);
  });
});
