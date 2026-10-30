import { describe, expect, it } from 'vitest';
import {
  insightsWindow,
  mapGraphToInsights,
  type GraphInsightsPayload,
} from '@/lib/insights/page-insights';

function dailyEntry(name: string, values: Array<[string, number]>): { name: string; period: string; values: Array<{ value: number; end_time: string }> } {
  return {
    name,
    period: 'day',
    values: values.map(([date, value]) => ({ value, end_time: `${date}T07:00:00+0000` })),
  };
}

const DAILY: GraphInsightsPayload = {
  data: [
    dailyEntry('page_media_view', [
      ['2026-10-26', 100],
      ['2026-10-27', 150],
    ]),
    dailyEntry('page_total_media_view_unique', [
      ['2026-10-26', 80],
      ['2026-10-27', 90],
    ]),
    dailyEntry('page_post_engagements', [
      ['2026-10-26', 20],
      ['2026-10-27', 30],
    ]),
    dailyEntry('page_actions_post_reactions_like_total', [
      ['2026-10-26', 10],
      ['2026-10-27', 15],
    ]),
    dailyEntry('page_actions_post_reactions_love_total', [
      ['2026-10-26', 5],
      ['2026-10-27', 5],
    ]),
    dailyEntry('page_actions_post_reactions_wow_total', [
      ['2026-10-26', 0],
      ['2026-10-27', 0],
    ]),
    dailyEntry('page_actions_post_reactions_haha_total', [
      ['2026-10-26', 2],
      ['2026-10-27', 3],
    ]),
    dailyEntry('page_actions_post_reactions_sorry_total', [
      ['2026-10-26', 0],
      ['2026-10-27', 1,
      ],
    ]),
    dailyEntry('page_actions_post_reactions_anger_total', [
      ['2026-10-26', 1],
      ['2026-10-27', 0],
    ]),
    dailyEntry('page_daily_follows', [
      ['2026-10-26', 12],
      ['2026-10-27', 8],
    ]),
    dailyEntry('page_daily_unfollows', [
      ['2026-10-26', 3],
      ['2026-10-27', 2],
    ]),
    dailyEntry('page_video_view_time', [
      ['2026-10-26', 3_600_000],
      ['2026-10-27', 1_800_000],
    ]),
  ],
};

const AUDIENCE: GraphInsightsPayload = {
  data: [
    {
      name: 'page_follows_country',
      period: 'lifetime',
      values: [{ value: { US: 500, PK: 300, GB: 200, CA: 50, DE: 40, FR: 10 } }],
    },
    {
      name: 'page_follows_city',
      period: 'lifetime',
      values: [{ value: { Karachi: 120, Lahore: 80 } }],
    },
  ],
};

const NOW = new Date('2026-10-27T12:00:00.000Z');

describe('page insights Graph mapping (research-based, range-consistent)', () => {
  it('builds a 7d window ending today', () => {
    const w = insightsWindow('7d', NOW);
    expect(w.days).toBe(7);
    expect(w.until).toBe('2026-10-27');
    expect(w.since).toBe('2026-10-21');
    expect(w.dates).toHaveLength(7);
  });

  it('generates exactly one daily point per day for every range (28d is 28 points, not 27)', () => {
    for (const [range, days] of [
      ['7d', 7],
      ['14d', 14],
      ['28d', 28],
      ['90d', 90],
    ] as const) {
      const w = insightsWindow(range, NOW);
      expect(w.days).toBe(days);
      expect(w.dates).toHaveLength(days);
      expect(w.since).toBe(w.dates[0]);
      expect(w.until).toBe(w.dates[days - 1]);
    }
  });

  it('sums the daily series, fills missing days with zero, and derives rate + growth + watch time', () => {
    const out = mapGraphToInsights({
      pageId: 'page-1',
      range: '7d',
      raw: { daily: DAILY, audience: AUDIENCE, followersCount: 1234 },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      now: NOW,
    });
    expect(out.kpis.mediaViews).toBe(250);
    expect(out.kpis.uniqueViewersDailySum).toBe(170);
    expect(out.kpis.engagements).toBe(50);
    expect(out.kpis.engagementRatePct).toBe(20);
    expect(out.kpis.followers).toBe(1234);
    expect(out.kpis.netFollowerGrowth).toBe(15);
    expect(out.kpis.videoWatchTimeMinutes).toBe(90);
    expect(out.trend).toHaveLength(7);
    expect(out.trend.find((p) => p.date === '2026-10-21')).toEqual({
      date: '2026-10-21',
      views: 0,
      viewers: 0,
    });
    expect(out.trend.find((p) => p.date === '2026-10-27')).toEqual({
      date: '2026-10-27',
      views: 150,
      viewers: 90,
    });
  });

  it('totals reactions over the window with shares of the reaction total', () => {
    const out = mapGraphToInsights({
      pageId: 'page-1',
      range: '7d',
      raw: { daily: DAILY, audience: AUDIENCE, followersCount: 0 },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      now: NOW,
    });
    const byKind = new Map(out.reactions.map((r) => [r.kind, r]));
    expect(byKind.get('like')).toEqual({ kind: 'like', count: 25, sharePct: 59.5 });
    expect(byKind.get('sad')).toEqual({ kind: 'sad', count: 1, sharePct: 2.4 });
    expect(byKind.get('angry')).toEqual({ kind: 'angry', count: 1, sharePct: 2.4 });
    expect(out.reactions.reduce((s, r) => s + r.count, 0)).toBe(42);
  });

  it('ranks lifetime audience top-5 with shares, and never uses retired metrics', () => {
    const out = mapGraphToInsights({
      pageId: 'page-1',
      range: '7d',
      raw: { daily: DAILY, audience: AUDIENCE, followersCount: 0 },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      now: NOW,
    });
    expect(out.topCountries.map((c) => c.name)).toEqual(['US', 'PK', 'GB', 'CA', 'DE']);
    expect(out.topCountries[0]).toEqual({ name: 'US', count: 500, sharePct: 45.5 });
    expect(out.topCities.map((c) => c.name)).toEqual(['Karachi', 'Lahore']);
  });

  it('reports a null engagement rate when views are zero (never divides by zero)', () => {
    const out = mapGraphToInsights({
      pageId: 'page-1',
      range: '7d',
      raw: { daily: { data: [] }, audience: { data: [] }, followersCount: 0 },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      now: NOW,
    });
    expect(out.kpis.engagementRatePct).toBeNull();
    expect(out.kpis.mediaViews).toBe(0);
    expect(out.topCountries).toEqual([]);
  });

  // K3: day boundaries follow the page timezone, not UTC.
  it('ends the window on the page-timezone date, not the UTC date', () => {
    // 20:00 UTC on the 27th is already the 28th in Karachi (+5).
    const late = new Date('2026-10-27T20:00:00.000Z');
    expect(insightsWindow('7d', late).until).toBe('2026-10-27');
    expect(insightsWindow('7d', late, 'Asia/Karachi').until).toBe('2026-10-28');
    expect(insightsWindow('7d', late, 'Asia/Karachi').since).toBe('2026-10-22');
    // 02:00 UTC on the 27th is still the 26th in New York (-4).
    const early = new Date('2026-10-27T02:00:00.000Z');
    expect(insightsWindow('7d', early, 'America/New_York').until).toBe('2026-10-26');
  });

  it('buckets trend dates in the page timezone through the mapper', () => {
    const out = mapGraphToInsights({
      pageId: 'page-1',
      range: '7d',
      raw: { daily: DAILY, audience: AUDIENCE, followersCount: 1234 },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      now: new Date('2026-10-27T20:00:00.000Z'),
      timeZone: 'Asia/Karachi',
    });
    expect(out.trend.map((p) => p.date)).toContain('2026-10-28');
    expect(out.trend).toHaveLength(7);
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    const w = insightsWindow('7d', new Date('2026-10-27T20:00:00.000Z'), 'Not/AZone');
    expect(w.until).toBe('2026-10-27');
  });
});
