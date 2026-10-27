import { describe, expect, it } from 'vitest';
import {
  PageInsightsQuerySchema,
  PageInsightsResponseSchema,
} from '@fbuploadpro/contracts';

const VALID = {
  success: true,
  pageId: 'page-1',
  range: '28d',
  fetchedAt: '2026-10-27T12:00:00.000Z',
  kpis: {
    followers: 100,
    mediaViews: 500,
    uniqueViewersDailySum: 300,
    engagements: 40,
    engagementRatePct: 8,
    netFollowerGrowth: -2,
    videoWatchTimeMinutes: 90,
  },
  trend: [{ date: '2026-10-27', views: 10, viewers: 8 }],
  reactions: [{ kind: 'like', count: 30, sharePct: 75 }],
  topCountries: [{ name: 'US', count: 50, sharePct: 50 }],
  topCities: [],
};

describe('rebuilt insights contracts', () => {
  it('parses a full response and defaults the query range', () => {
    const parsed = PageInsightsResponseSchema.parse(VALID);
    expect(parsed.kpis.netFollowerGrowth).toBe(-2);
    expect(PageInsightsQuerySchema.parse({}).range).toBe('28d');
    expect(PageInsightsQuerySchema.parse({ range: '90d' }).range).toBe('90d');
  });

  it('rejects unknown ranges, negative counts, and out-of-range shares', () => {
    expect(() => PageInsightsQuerySchema.parse({ range: '30d' })).toThrow();
    expect(() =>
      PageInsightsResponseSchema.parse({
        ...VALID,
        kpis: { ...VALID.kpis, mediaViews: -1 },
      }),
    ).toThrow();
    expect(() =>
      PageInsightsResponseSchema.parse({
        ...VALID,
        reactions: [{ kind: 'like', count: 1, sharePct: 101 }],
      }),
    ).toThrow();
  });
});
