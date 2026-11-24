/**
 * Spec 241 — combined Analytics aggregation.
 *
 * - 1d reads analytics_1d; 7d/28d event totals are sums of the stored
 *   daily values; unique viewers 7d/28d are the STORED deduplicated
 *   values, never the daily sums.
 * - Followers total/gained are combined; gained skips pages with no
 *   stored starting count (never guessed).
 * - Chart points come from the stored daily values; locations are
 *   top 6 with shares from combined total followers; ISO codes map
 *   to names; empty locations are an empty state, not an error.
 * - Net follows may be negative, never clamped. An unparseable
 *   stored column contributes nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateAnalytics,
  countryName,
  formatDateRangeLabel,
  formatWatchTime,
  parseStoredAnalytics,
  periodLabel,
  type AnalyticsPageRecord,
} from './aggregate.js';

function day(date: string, overrides: Record<string, number> = {}) {
  return {
    date,
    media_views: 100,
    unique_viewers: 50,
    profile_views: 10,
    engagement: 20,
    video_views: 80,
    video_view_time_ms: 60_000,
    total_actions: 5,
    new_follows: 3,
    unfollows: 1,
    video_complete_views_30s: 40,
    ...overrides,
  };
}

function dates(from: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00.000Z`);
  for (let i = 0; i < count; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function record(overrides: Partial<AnalyticsPageRecord> = {}): AnalyticsPageRecord {
  const days7 = dates('2026-11-03', 7).map((d) => day(d));
  const days28 = dates('2026-10-13', 28).map((d) => day(d));
  return {
    facebookPageId: 'fb-page-a',
    workspaceId: 'ws-a',
    startingFollowers: 1000,
    currentFollowers: 1200,
    analytics1d: day('2026-11-09'),
    analytics7d: { days: days7, unique_viewers_7d: 300 },
    analytics28d: { days: days28, unique_viewers_28d: 1200 },
    analyticsLocations: {
      countries: [
        { country: 'PK', followers: 900 },
        { country: 'US', followers: 200 },
      ],
      cities: [{ city: 'Karachi', followers: 400 }],
    },
    analyticsUpdatedAt: '2026-11-10T22:00:00.000Z',
    ...overrides,
  };
}

describe('aggregateAnalytics', () => {
  it('1d reads the flat object; 7d/28d sum the stored days; unique viewers use the stored deduplicated values', () => {
    const a = record();
    const b = record({
      facebookPageId: 'fb-page-b',
      startingFollowers: 500,
      currentFollowers: 800,
      analytics1d: day('2026-11-09', { media_views: 200, unique_viewers: 70 }),
      analytics7d: {
        days: dates('2026-11-03', 7).map((d) => day(d, { media_views: 200 })),
        unique_viewers_7d: 500,
      },
      analytics28d: {
        days: dates('2026-10-13', 28).map((d) => day(d, { media_views: 200 })),
        unique_viewers_28d: 2000,
      },
      analyticsLocations: {
        countries: [{ country: 'PK', followers: 100 }],
        cities: [{ city: 'Lahore', followers: 50 }],
      },
    });

    const one = aggregateAnalytics([a, b], '1');
    expect(one.mediaViews).toBe(300);
    expect(one.uniqueViewers).toBe(120); // 50 + 70, the 1-day values
    expect(one.chart).toEqual([{ date: '2026-11-09', mediaViews: 300, uniqueViewers: 120 }]);

    const seven = aggregateAnalytics([a, b], '7');
    // 7 days × (100 + 200) media views.
    expect(seven.mediaViews).toBe(2100);
    // NOT the daily sums (7 × 50 + 7 × 50 = 700): the stored values.
    expect(seven.uniqueViewers).toBe(800);
    expect(seven.chart).toHaveLength(7);
    expect(seven.chart[0]).toEqual({ date: '2026-11-03', mediaViews: 300, uniqueViewers: 100 });

    const twentyEight = aggregateAnalytics([a, b], '28');
    expect(twentyEight.mediaViews).toBe(28 * 300);
    expect(twentyEight.uniqueViewers).toBe(3200);
    expect(twentyEight.chart).toHaveLength(28);
  });

  it('followers total and gained are combined; a page with no stored starting is excluded from gained, not guessed', () => {
    const a = record(); // 1200 current, 1000 starting → +200
    const b = record({
      facebookPageId: 'fb-page-b',
      startingFollowers: null,
      currentFollowers: 800,
    });
    const out = aggregateAnalytics([a, b], '28');
    expect(out.followers.total).toBe(2000);
    expect(out.followers.gained).toBe(200);
    expect(out.pagesIncluded).toBe(2);
    expect(out.updatedAt).toBe('2026-11-10T22:00:00.000Z');
  });

  it('net follows is new minus unfollows and may be negative', () => {
    const a = record({
      analytics1d: day('2026-11-09', { new_follows: 2, unfollows: 9 }),
    });
    const out = aggregateAnalytics([a], '1');
    expect(out.newFollows).toBe(2);
    expect(out.unfollows).toBe(9);
    expect(out.netFollows).toBe(-7);
  });

  it('locations are top 6 with shares from combined total followers, ISO codes mapped to names', () => {
    const a = record(); // PK 900, US 200; total followers 1200
    const b = record({
      facebookPageId: 'fb-page-b',
      startingFollowers: 0,
      currentFollowers: 800,
      analyticsLocations: {
        countries: [
          { country: 'PK', followers: 100 },
          { country: 'GB', followers: 50 },
          { country: 'IN', followers: 40 },
          { country: 'BD', followers: 30 },
          { country: 'AU', followers: 20 },
          { country: 'CA', followers: 10 },
          { country: 'AE', followers: 5 },
        ],
        cities: [
          { city: 'Karachi', followers: 400 },
          { city: 'Lahore', followers: 50 },
        ],
      },
    });
    const out = aggregateAnalytics([a, b], '28');
    // Total followers 2000; PK 1000 → 50%.
    expect(out.topCountries).toHaveLength(6);
    expect(out.topCountries[0]).toEqual({ name: 'Pakistan', count: 1000, sharePct: 50 });
    expect(out.topCountries[1]).toEqual({ name: 'United States', count: 200, sharePct: 10 });
    // AE (7th) is cut off — display top 6 only.
    expect(out.topCountries.map((c) => c.name)).not.toContain('United Arab Emirates');
    // Karachi appears on both pages: 400 + 400 = 800 → 40%.
    expect(out.topCities[0]).toEqual({ name: 'Karachi', count: 800, sharePct: 40 });
    expect(out.topCities[1]).toEqual({ name: 'Lahore', count: 50, sharePct: 2.5 });
  });

  it('a location count above the current follower total clamps its share at 100, the count stays exact', () => {
    const a = record({
      startingFollowers: 0,
      currentFollowers: 800,
      analyticsLocations: {
        countries: [{ country: 'PK', followers: 900 }],
        cities: [],
      },
    });
    const out = aggregateAnalytics([a], '28');
    expect(out.topCountries).toEqual([{ name: 'Pakistan', count: 900, sharePct: 100 }]);
  });

  it('empty locations are an empty state, and no stored analytics at all is hasNoData', () => {
    const a = record({
      analytics1d: null,
      analytics7d: null,
      analytics28d: null,
      analyticsLocations: { countries: [], cities: [] },
    });
    const out = aggregateAnalytics([a], '28');
    expect(out.topCountries).toEqual([]);
    expect(out.topCities).toEqual([]);
    expect(out.hasNoData).toBe(true);
    expect(out.mediaViews).toBe(0);
    expect(out.chart).toEqual([]);
    expect(out.pagesIncluded).toBe(1); // the page is listed, its followers count
    expect(out.followers.total).toBe(1200);
  });

  it('an unparseable stored column contributes nothing (never a crash, never a guess)', () => {
    const a = record({ analytics1d: { date: 'not-a-date', media_views: -5 } });
    expect(parseStoredAnalytics(a).one).toBeNull();
    const out = aggregateAnalytics([a], '1');
    expect(out.mediaViews).toBe(0);
    expect(out.hasNoData).toBe(false); // the 7d/28d columns still parse
  });
});

describe('display helpers', () => {
  it('countryName maps ISO codes and passes unknown codes through', () => {
    expect(countryName('PK')).toBe('Pakistan');
    expect(countryName('US')).toBe('United States');
    expect(countryName('GB')).toBe('United Kingdom');
    expect(countryName('XX')).toBe('XX');
  });

  it('periodLabel matches the contract wording', () => {
    expect(periodLabel('1')).toBe('Yesterday · combined');
    expect(periodLabel('7')).toBe('Last 7 days · combined');
    expect(periodLabel('28')).toBe('Last 28 days · combined');
  });

  it('formatDateRangeLabel collapses same-month ranges and handles a single day', () => {
    expect(formatDateRangeLabel(['2026-10-26', '2026-11-22'])).toBe('26 Oct 2026 – 22 Nov 2026');
    expect(formatDateRangeLabel(['2026-11-16', '2026-11-22'])).toBe('16 – 22 Nov 2026');
    expect(formatDateRangeLabel(['2026-11-22'])).toBe('22 Nov 2026');
    expect(formatDateRangeLabel([])).toBe('');
  });

  it('formatWatchTime shows hours, singular for one hour, minutes below an hour', () => {
    expect(formatWatchTime(1_339_200_000)).toBe('372 hours');
    expect(formatWatchTime(3_600_000)).toBe('1 hour');
    expect(formatWatchTime(2_700_000)).toBe('45 min');
  });
});
