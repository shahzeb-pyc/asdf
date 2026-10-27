import {
  PageInsightsResponseSchema,
  type PageInsightsRange,
  type PageInsightsResponse,
} from '@fbuploadpro/contracts';

/**
 * Local-only Insights cache (browser localStorage, 1-hour TTL).
 *
 * Rules (Shahzeb, 2026-10-27):
 * - NO database storage for insights anywhere — no Supabase writes, no
 *   cache table, no server cache. This module is the ONLY cache.
 * - Data lives in the browser only, keyed by page + range (+ version, so
 *   a future response shape can never be mistaken for a current one).
 * - Fresh = fetched less than 1 hour ago. Fresh data shows immediately
 *   with no network call; anything older, corrupt, or from another
 *   version is ignored and triggers a live fetch.
 * - The Sync button always fetches live and overwrites the stored entry,
 *   resetting the 1-hour timer.
 * - localStorage unavailable (private mode) or full → in-memory fallback
 *   with the same TTL. Nothing is ever written anywhere else.
 */

export const INSIGHTS_CACHE_TTL_MS = 3_600_000;
export const INSIGHTS_CACHE_VERSION = 1;

export function insightsCacheKey(pageId: string, range: PageInsightsRange): string {
  return `fbuploadpro:insights:v${INSIGHTS_CACHE_VERSION}:${pageId}:${range}`;
}

export function isInsightsCacheFresh(fetchedAt: string, nowMs: number): boolean {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  return nowMs - fetchedMs < INSIGHTS_CACHE_TTL_MS && nowMs >= fetchedMs;
}

export interface InsightsCacheStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryFallback = new Map<string, string>();
const memoryStore: InsightsCacheStore = {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => {
    memoryFallback.set(key, value);
  },
};

function defaultStore(): InsightsCacheStore {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__fbuploadpro_insights_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (error) {
    // Private mode / disabled storage: surfaced, then fall through to memory.
    console.warn('[insights-cache] browser storage unavailable, using in-memory fallback', error);
  }
  return memoryStore;
}

/** Returns the stored response only when it is fresh and schema-valid. */
export function readCachedInsights(
  pageId: string,
  range: PageInsightsRange,
  store: InsightsCacheStore = defaultStore(),
  nowMs: number = Date.now(),
): PageInsightsResponse | null {
  let raw: string | null;
  try {
    raw = store.getItem(insightsCacheKey(pageId, range));
  } catch (error) {
    console.warn('[insights-cache] cache read failed, treating as a miss', error);
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[insights-cache] corrupt cached entry ignored, refetching live', error);
    return null;
  }
  const checked = PageInsightsResponseSchema.safeParse(parsed);
  if (!checked.success) return null;
  const data = checked.data;
  if (data.pageId !== pageId || data.range !== range) return null;
  if (!isInsightsCacheFresh(data.fetchedAt, nowMs)) return null;
  return data;
}

export function writeCachedInsights(
  data: PageInsightsResponse,
  store: InsightsCacheStore = defaultStore(),
): void {
  try {
    store.setItem(insightsCacheKey(data.pageId, data.range), JSON.stringify(data));
  } catch {
    try {
      memoryStore.setItem(insightsCacheKey(data.pageId, data.range), JSON.stringify(data));
    } catch (error) {
      // Cache is best-effort only; a failed write must never break the tab.
      console.warn('[insights-cache] cache write failed in both stores, continuing without cache', error);
    }
  }
}
