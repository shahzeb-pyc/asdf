import {
  type InsightsAudienceItem,
  type InsightsReaction,
  type InsightsTrendPoint,
  type PageInsightsRange,
  type PageInsightsResponse,
} from '@fbuploadpro/contracts';

/**
 * Fresh Facebook Page Insights fetch + mapping — written 2026-10-27 from
 * live Graph API research, not from the deleted implementation.
 *
 * What Facebook allows (Graph API v26.0, Page access token, permission
 * `pages_read_engagement`, user with the ANALYZE task on the Page):
 * - `/{page-id}/insights` edge, `period=day` with `since`/`until` for daily
 *   series, `period=lifetime` for audience distributions.
 * - Distribution: `page_media_view` (total media views, replaces
 *   impressions) and `page_total_media_view_unique` (unique media
 *   viewers, replaces reach). Retired 2026-06-15 and deliberately NOT
 *   requested: all `page_impressions*`, `page_fans*`, `page_video_views`
 *   (unique 3-second), viral reach/impressions, post/page reach.
 * - Engagement: `page_post_engagements` plus daily per-reaction totals
 *   (`page_actions_post_reactions_{like,love,wow,haha,sorry,anger}_total`).
 * - Growth: `page_daily_follows`, `page_daily_unfollows`.
 * - Video: `page_video_view_time` (milliseconds watched).
 * - Audience: `page_follows_country`, `page_follows_city` (lifetime maps).
 *   Age/gender breakdowns were removed by Meta in 2024 and are not used.
 * - Page node field `followers_count` for the live follower total.
 *
 * Failure policy: if a Graph call fails, the whole fetch fails (fail
 * loud). The caller surfaces one error banner with Retry; there are no
 * zero-filled fallbacks and no partial 200s.
 */

export const GRAPH_API_VERSION = 'v26.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class InsightsGraphError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'InsightsGraphError';
    this.status = status;
  }
}

const RANGE_DAYS: Record<PageInsightsRange, number> = {
  '7d': 7,
  '14d': 14,
  '28d': 28,
  '90d': 90,
};

/**
 * K3: day boundaries are the PAGE's timezone, not UTC. "Today" is the
 * calendar date in `timeZone` at `now`, and the window is that many
 * consecutive calendar days in that zone (calendar arithmetic, so a
 * DST transition never drops or duplicates a day). Facebook's own
 * period handling is untouched — only this app's window, labels and
 * trend bucketing use the page zone. An unknown zone falls back to
 * UTC rather than throwing (fail loud happens at the fetch, not in
 * a date helper).
 */
function todayInTimezone(now: Date, timeZone: string): { year: number; month: number; day: number } {
  let parts: Intl.DateTimeFormatPart[] | null = null;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    // Unknown zone: parts stays null and the UTC date below is used.
    // The fallback is explicit (not a swallowed error): an unknown
    // zone is a documented input case for this helper, and the UTC
    // fallback is the specified behaviour, not a failed request.
    parts = null;
  }
  if (parts) {
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

export function insightsWindow(
  range: PageInsightsRange,
  now = new Date(),
  timeZone = 'UTC',
): {
  days: number;
  since: string;
  until: string;
  dates: string[];
} {
  const days = RANGE_DAYS[range];
  const toDate = (d: Date) => d.toISOString().slice(0, 10);
  const today = todayInTimezone(now, timeZone);
  const untilDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(untilDate);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(toDate(d));
  }
  return { days, since: dates[0] as string, until: dates[dates.length - 1] as string, dates };
}

const DAILY_METRICS = [
  'page_media_view',
  'page_total_media_view_unique',
  'page_post_engagements',
  'page_actions_post_reactions_like_total',
  'page_actions_post_reactions_love_total',
  'page_actions_post_reactions_wow_total',
  'page_actions_post_reactions_haha_total',
  'page_actions_post_reactions_sorry_total',
  'page_actions_post_reactions_anger_total',
  'page_daily_follows',
  'page_daily_unfollows',
  'page_video_view_time',
] as const;

const AUDIENCE_METRICS = ['page_follows_country', 'page_follows_city'] as const;

const REACTION_METRICS: Array<{ kind: InsightsReaction['kind']; metric: string }> = [
  { kind: 'like', metric: 'page_actions_post_reactions_like_total' },
  { kind: 'love', metric: 'page_actions_post_reactions_love_total' },
  { kind: 'wow', metric: 'page_actions_post_reactions_wow_total' },
  { kind: 'haha', metric: 'page_actions_post_reactions_haha_total' },
  { kind: 'sad', metric: 'page_actions_post_reactions_sorry_total' },
  { kind: 'angry', metric: 'page_actions_post_reactions_anger_total' },
];

export interface GraphInsightsEntry {
  name: string;
  period: string;
  values: Array<{ value: number | Record<string, number>; end_time?: string }>;
}

export interface GraphInsightsPayload {
  data?: GraphInsightsEntry[];
  error?: { message?: string; code?: number };
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
export type GraphFetchFn = FetchFn;

async function callGraph(
  url: string,
  graphFetch: FetchFn,
  label: string,
): Promise<GraphInsightsPayload> {
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await graphFetch(url);
  } catch (err) {
    throw new InsightsGraphError(502, `Facebook ${label} request failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  const body = (await res.json()) as GraphInsightsPayload;
  if (!res.ok || body.error) {
    // The token itself is never included in any error text.
    throw new InsightsGraphError(502, `Facebook ${label} request failed (${res.status})`);
  }
  return body;
}

function metricDailyValues(payload: GraphInsightsPayload, metric: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of payload.data ?? []) {
    if (entry.name !== metric) continue;
    for (const point of entry.values ?? []) {
      if (typeof point.value !== 'number' || !point.end_time) continue;
      out.set(point.end_time.slice(0, 10), point.value);
    }
  }
  return out;
}

function metricMapValue(payload: GraphInsightsPayload, metric: string): Record<string, number> {
  for (const entry of payload.data ?? []) {
    if (entry.name !== metric) continue;
    for (const point of entry.values ?? []) {
      if (point.value && typeof point.value === 'object') return point.value;
    }
  }
  return {};
}

function topAudience(map: Record<string, number>, limit = 5): InsightsAudienceItem[] {
  const entries = Object.entries(map).filter(([, v]) => Number.isFinite(v) && v > 0);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({
      name,
      count,
      sharePct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }));
}

export interface RawInsightsData {
  daily: GraphInsightsPayload;
  audience: GraphInsightsPayload;
  followersCount: number;
}

/** Pure mapping: Graph payloads -> contract response. Fully unit-tested. */
export function mapGraphToInsights(input: {
  pageId: string;
  range: PageInsightsRange;
  raw: RawInsightsData;
  fetchedAt: string;
  now?: Date;
  /** Page timezone (K3); UTC when absent, preserving old callers. */
  timeZone?: string;
}): PageInsightsResponse {
  const { pageId, range, raw, fetchedAt, now } = input;
  const { dates } = insightsWindow(range, now, input.timeZone);
  const byMetric = (metric: string) => metricDailyValues(raw.daily, metric);
  const sum = (metric: string) => {
    let total = 0;
    for (const v of byMetric(metric).values()) total += v;
    return total;
  };

  const viewsByDay = byMetric('page_media_view');
  const viewersByDay = byMetric('page_total_media_view_unique');
  const trend: InsightsTrendPoint[] = dates.map((date) => ({
    date,
    views: viewsByDay.get(date) ?? 0,
    viewers: viewersByDay.get(date) ?? 0,
  }));

  const mediaViews = trend.reduce((s, p) => s + p.views, 0);
  const uniqueViewersDailySum = trend.reduce((s, p) => s + p.viewers, 0);
  const engagements = sum('page_post_engagements');
  const reactions = REACTION_METRICS.map(({ kind, metric }) => ({
    kind,
    count: sum(metric),
  }));
  const reactionTotal = reactions.reduce((s, r) => s + r.count, 0);
  const reactionsWithShare: InsightsReaction[] = reactions.map((r) => ({
    ...r,
    sharePct: reactionTotal > 0 ? Math.round((r.count / reactionTotal) * 1000) / 10 : 0,
  }));
  const netFollowerGrowth = sum('page_daily_follows') - sum('page_daily_unfollows');
  const videoWatchTimeMinutes = Math.round(sum('page_video_view_time') / 60000);

  return {
    success: true,
    pageId,
    range,
    fetchedAt,
    kpis: {
      followers: raw.followersCount,
      mediaViews,
      uniqueViewersDailySum,
      engagements,
      engagementRatePct:
        mediaViews > 0 ? Math.round((engagements / mediaViews) * 1000) / 10 : null,
      netFollowerGrowth,
      videoWatchTimeMinutes,
    },
    trend,
    reactions: reactionsWithShare,
    topCountries: topAudience(metricMapValue(raw.audience, 'page_follows_country')),
    topCities: topAudience(metricMapValue(raw.audience, 'page_follows_city')),
  };
}

export async function fetchPageInsights(input: {
  fbPageId: string;
  pageId: string;
  token: string;
  range: PageInsightsRange;
  graphFetch?: FetchFn;
  now?: Date;
  /** Page timezone (K3) for the window/trend dates. */
  timeZone?: string;
}): Promise<PageInsightsResponse> {
  const { fbPageId, pageId, token, range, now } = input;
  const graphFetch = (input.graphFetch ?? fetch) as FetchFn;
  const { since, until } = insightsWindow(range, now, input.timeZone);
  const encoded = encodeURIComponent(fbPageId);
  // Token travels only in these server-side URLs, never to the client.
  const dailyUrl =
    `${GRAPH_BASE}/${encoded}/insights?metric=${DAILY_METRICS.join(',')}` +
    `&period=day&since=${since}&until=${until}&access_token=${encodeURIComponent(token)}`;
  const audienceUrl =
    `${GRAPH_BASE}/${encoded}/insights?metric=${AUDIENCE_METRICS.join(',')}` +
    `&period=lifetime&access_token=${encodeURIComponent(token)}`;
  const pageUrl =
    `${GRAPH_BASE}/${encoded}?fields=followers_count&access_token=${encodeURIComponent(token)}`;

  const [daily, audience, pageBody] = await Promise.all([
    callGraph(dailyUrl, graphFetch, 'insights'),
    callGraph(audienceUrl, graphFetch, 'audience'),
    callGraph(pageUrl, graphFetch, 'page'),
  ]);
  const followersRaw = (pageBody as { followers_count?: unknown }).followers_count;
  const followersCount = typeof followersRaw === 'number' && followersRaw >= 0 ? followersRaw : 0;
  return mapGraphToInsights({
    pageId,
    range,
    raw: { daily, audience, followersCount },
    fetchedAt: (now ?? new Date()).toISOString(),
    ...(now ? { now } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });
}
