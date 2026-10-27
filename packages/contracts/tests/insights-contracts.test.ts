import { describe, it, expect } from 'vitest';
import {
  PageInsightsRangeSchema,
  InsightsTrendPointSchema,
  InsightsReactionSchema,
  InsightsAudienceItemSchema,
  InsightsKpisSchema,
  PageInsightsResponseSchema,
  PageInsightsQuerySchema,
} from '../src/index.js';

/**
 * Contracts for the rebuilt Insights tab (2026-10-27, Graph API v26.0,
 * Media Views / Media Viewers framework). Replaces the old T148/T149
 * contract tests, whose schemas (overview, time series, reactions object,
 * demographics, refresh flag, healthStatus) were deleted with the old tab.
 */
describe('Rebuilt Page Insights Domain Contracts', () => {
  describe('PageInsightsRangeSchema', () => {
    it('accepts valid predefined date ranges', () => {
      expect(PageInsightsRangeSchema.safeParse('7d').success).toBe(true);
      expect(PageInsightsRangeSchema.safeParse('14d').success).toBe(true);
      expect(PageInsightsRangeSchema.safeParse('28d').success).toBe(true);
      expect(PageInsightsRangeSchema.safeParse('90d').success).toBe(true);
    });

    it('rejects unsupported date ranges', () => {
      expect(PageInsightsRangeSchema.safeParse('30d').success).toBe(false);
      expect(PageInsightsRangeSchema.safeParse('1y').success).toBe(false);
      expect(PageInsightsRangeSchema.safeParse('').success).toBe(false);
    });
  });

  describe('InsightsTrendPointSchema', () => {
    it('accepts a valid daily point', () => {
      const result = InsightsTrendPointSchema.safeParse({
        date: '2026-10-01',
        views: 3200,
        viewers: 2800,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.date).toBe('2026-10-01');
        expect(result.data.views).toBe(3200);
      }
    });

    it('rejects malformed dates and negative counts', () => {
      expect(InsightsTrendPointSchema.safeParse({ date: '10/01/2026', views: 1, viewers: 1 }).success).toBe(false);
      expect(InsightsTrendPointSchema.safeParse({ date: 'invalid-date', views: 1, viewers: 1 }).success).toBe(false);
      expect(InsightsTrendPointSchema.safeParse({ date: '2026-10-01', views: -1, viewers: 1 }).success).toBe(false);
    });
  });

  describe('InsightsReactionSchema', () => {
    it('validates a reaction row with a share percentage', () => {
      const result = InsightsReactionSchema.safeParse({ kind: 'love', count: 45, sharePct: 23.9 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kind).toBe('love');
        expect(result.data.count).toBe(45);
      }
    });

    it('uses sad, not sorry, and rejects out-of-range shares and unknown kinds', () => {
      expect(InsightsReactionSchema.safeParse({ kind: 'sad', count: 2, sharePct: 1.1 }).success).toBe(true);
      expect(InsightsReactionSchema.safeParse({ kind: 'sorry', count: 2, sharePct: 1.1 }).success).toBe(false);
      expect(InsightsReactionSchema.safeParse({ kind: 'like', count: 1, sharePct: 120 }).success).toBe(false);
      expect(InsightsReactionSchema.safeParse({ kind: 'like', count: -1, sharePct: 1 }).success).toBe(false);
    });
  });

  describe('InsightsAudienceItemSchema', () => {
    it('validates an audience ranking item', () => {
      const result = InsightsAudienceItemSchema.safeParse({ name: 'United States', count: 1250, sharePct: 65.4 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('United States');
      }
    });

    it('rejects negative counts and shares above 100', () => {
      expect(InsightsAudienceItemSchema.safeParse({ name: 'Canada', count: -1, sharePct: 50 }).success).toBe(false);
      expect(InsightsAudienceItemSchema.safeParse({ name: 'Canada', count: 1, sharePct: 120 }).success).toBe(false);
    });
  });

  describe('InsightsKpisSchema', () => {
    it('validates a complete KPI set, including null engagement rate and negative growth', () => {
      const result = InsightsKpisSchema.safeParse({
        followers: 120,
        mediaViews: 0,
        uniqueViewersDailySum: 0,
        engagements: 0,
        engagementRatePct: null,
        netFollowerGrowth: -3,
        videoWatchTimeMinutes: 0,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.engagementRatePct).toBeNull();
        expect(result.data.netFollowerGrowth).toBe(-3);
      }
    });

    it('rejects negative counts but allows negative net growth only', () => {
      expect(InsightsKpisSchema.safeParse({
        followers: -1, mediaViews: 0, uniqueViewersDailySum: 0, engagements: 0,
        engagementRatePct: null, netFollowerGrowth: 0, videoWatchTimeMinutes: 0,
      }).success).toBe(false);
    });
  });

  describe('PageInsightsResponseSchema', () => {
    it('validates a complete response envelope in the new shape', () => {
      const response = {
        success: true,
        pageId: 'page-123',
        range: '28d',
        fetchedAt: '2026-10-27T15:52:00.000Z',
        kpis: {
          followers: 120,
          mediaViews: 50000,
          uniqueViewersDailySum: 40000,
          engagements: 2500,
          engagementRatePct: 5.0,
          netFollowerGrowth: 18,
          videoWatchTimeMinutes: 60,
        },
        trend: [{ date: '2026-10-01', views: 500, viewers: 400 }],
        reactions: [
          { kind: 'like', count: 100, sharePct: 77.5 },
          { kind: 'love', count: 20, sharePct: 15.5 },
        ],
        topCountries: [{ name: 'US', count: 100, sharePct: 100 }],
        topCities: [{ name: 'New York', count: 100, sharePct: 100 }],
      };
      const result = PageInsightsResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pageId).toBe('page-123');
        expect(result.data.kpis.followers).toBe(120);
      }
    });

    it('rejects a response when success is not literally true', () => {
      expect(PageInsightsResponseSchema.safeParse({ success: false }).success).toBe(false);
    });
  });

  describe('PageInsightsQuerySchema', () => {
    it('defaults range to 28d when omitted', () => {
      const result = PageInsightsQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.range).toBe('28d');
      }
    });

    it('accepts an explicit range and drops the retired refresh flag', () => {
      const result = PageInsightsQuerySchema.safeParse({ refresh: 'true', range: '7d' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.range).toBe('7d');
        // Sync is a client-side cache bypass in the rebuilt tab, not a query param.
        expect((result.data as Record<string, unknown>).refresh).toBeUndefined();
      }
    });

    it('rejects an unsupported range', () => {
      expect(PageInsightsQuerySchema.safeParse({ range: '30d' }).success).toBe(false);
    });
  });
});
