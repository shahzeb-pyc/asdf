import { describe, expect, it } from 'vitest';
import type { PageInsightsResponse } from '@fbuploadpro/contracts';
import {
  INSIGHTS_CACHE_TTL_MS,
  insightsCacheKey,
  isInsightsCacheFresh,
  readCachedInsights,
  writeCachedInsights,
  type InsightsCacheStore,
} from '@/lib/insights/insights-local-cache';

function sampleResponse(fetchedAt: string): PageInsightsResponse {
  return {
    success: true,
    pageId: 'page-1',
    range: '28d',
    fetchedAt,
    kpis: {
      followers: 100,
      mediaViews: 500,
      uniqueViewersDailySum: 300,
      engagements: 40,
      engagementRatePct: 8,
      netFollowerGrowth: 5,
      videoWatchTimeMinutes: 120,
    },
    trend: [{ date: '2026-10-27', views: 10, viewers: 8 }],
    reactions: [{ kind: 'like', count: 30, sharePct: 75 }],
    topCountries: [{ name: 'US', count: 50, sharePct: 50 }],
    topCities: [],
  };
}

function mapStore(): InsightsCacheStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

describe('insights local cache (1-hour TTL, local only)', () => {
  it('keys entries by page + range + version', () => {
    expect(insightsCacheKey('page-1', '7d')).toBe('fbuploadpro:insights:v1:page-1:7d');
    expect(insightsCacheKey('page-1', '28d')).not.toBe(insightsCacheKey('page-1', '7d'));
    expect(insightsCacheKey('page-2', '28d')).not.toBe(insightsCacheKey('page-1', '28d'));
  });

  it('treats data under one hour old as fresh and at/over one hour as stale', () => {
    expect(isInsightsCacheFresh('2026-10-27T11:00:01.000Z', NOW)).toBe(true);
    expect(isInsightsCacheFresh('2026-10-27T11:00:00.000Z', NOW)).toBe(false);
    expect(isInsightsCacheFresh('2026-10-27T10:59:59.000Z', NOW)).toBe(false);
    expect(isInsightsCacheFresh('not-a-date', NOW)).toBe(false);
    expect(INSIGHTS_CACHE_TTL_MS).toBe(3_600_000);
  });

  it('round-trips a fresh write and ignores a stale write', () => {
    const store = mapStore();
    writeCachedInsights(sampleResponse('2026-10-27T11:30:00.000Z'), store);
    expect(readCachedInsights('page-1', '28d', store, NOW)?.kpis.mediaViews).toBe(500);
    writeCachedInsights(sampleResponse('2026-10-27T10:00:00.000Z'), store);
    expect(readCachedInsights('page-1', '28d', store, NOW)).toBeNull();
  });

  it('separates ranges: a 7d entry never satisfies a 28d read', () => {
    const store = mapStore();
    writeCachedInsights({ ...sampleResponse('2026-10-27T11:30:00.000Z'), range: '7d' }, store);
    expect(readCachedInsights('page-1', '28d', store, NOW)).toBeNull();
    expect(readCachedInsights('page-1', '7d', store, NOW)).not.toBeNull();
  });

  it('ignores corrupt JSON, schema-invalid payloads, and mismatched page/range', () => {
    const store = mapStore();
    store.map.set(insightsCacheKey('page-1', '28d'), '{not json');
    expect(readCachedInsights('page-1', '28d', store, NOW)).toBeNull();
    store.map.set(
      insightsCacheKey('page-1', '28d'),
      JSON.stringify({ ...sampleResponse('2026-10-27T11:30:00.000Z'), kpis: { followers: -1 } }),
    );
    expect(readCachedInsights('page-1', '28d', store, NOW)).toBeNull();
    store.map.set(
      insightsCacheKey('page-1', '28d'),
      JSON.stringify({ ...sampleResponse('2026-10-27T11:30:00.000Z'), pageId: 'other-page' }),
    );
    expect(readCachedInsights('page-1', '28d', store, NOW)).toBeNull();
  });

  it('never throws when the store throws (cache is best-effort)', () => {
    const throwing: InsightsCacheStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(() => writeCachedInsights(sampleResponse('2026-10-27T11:30:00.000Z'), throwing)).not.toThrow();
    expect(readCachedInsights('page-1', '28d', throwing, NOW)).toBeNull();
  });
});
