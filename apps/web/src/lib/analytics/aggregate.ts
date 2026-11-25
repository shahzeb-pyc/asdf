/**
 * Spec 241 — combined Analytics aggregation (pure helpers).
 *
 * The worker stores per-page analytics as four JSON columns on the
 * page record (destinations / adu_configs / mirrors). This module
 * turns a deduped set of those records into the combined dashboard
 * numbers — never a live Facebook call, never a guessed value.
 *
 * Read rules (owner decisions, spec 241):
 * - 1-day card reads analytics_1d; 7d/28d event-count totals are the
 *   SUMS of the stored daily values.
 * - Unique viewers 7d/28d read the stored single values
 *   (unique_viewers_7d / unique_viewers_28d — Facebook's own
 *   deduplicated week/days_28 numbers), NEVER the sums of daily
 *   values. Combined unique viewers double-count a person who
 *   viewed two pages — no cross-page deduplication exists.
 * - Net follows = new follows − unfollows (may be negative, never
 *   clamped). New follows is Facebook's count in the period, NOT
 *   the gained number (gained = current − starting since the page
 *   was added to FBUploadPro).
 * - Locations: top 6 by combined count; shares are count ÷ combined
 *   total followers, computed at read time; ISO codes mapped to
 *   names at display.
 * - A record whose stored columns do not parse contributes nothing
 *   (the worker validates before writing, so a parse failure is
 *   corruption — the route logs it and the page is skipped here).
 */
import {
  Analytics1dSchema,
  Analytics28dSchema,
  Analytics7dSchema,
  AnalyticsLocationsSchema,
  type Analytics1d,
  type Analytics28d,
  type Analytics7d,
  type AnalyticsLocations,
  type AnalyticsPeriod,
} from '@fbuploadpro/contracts';

/** One deduped Facebook page, as the API route hands it over. */
export interface AnalyticsPageRecord {
  facebookPageId: string;
  workspaceId: string;
  /** Null when the row carries no stored count (unknown, never guessed). */
  startingFollowers: number | null;
  currentFollowers: number | null;
  /** Raw stored JSON (or null when the worker has not filled it yet). */
  analytics1d: unknown;
  analytics7d: unknown;
  analytics28d: unknown;
  analyticsLocations: unknown;
  analyticsUpdatedAt: string | null;
}

export interface ParsedAnalytics {
  one: Analytics1d | null;
  seven: Analytics7d | null;
  twentyEight: Analytics28d | null;
  locations: AnalyticsLocations | null;
}

/** Parse one record's four stored columns (null = absent or unparseable). */
export function parseStoredAnalytics(record: AnalyticsPageRecord): ParsedAnalytics {
  const one = record.analytics1d == null ? null : Analytics1dSchema.safeParse(record.analytics1d);
  const seven =
    record.analytics7d == null ? null : Analytics7dSchema.safeParse(record.analytics7d);
  const twentyEight =
    record.analytics28d == null ? null : Analytics28dSchema.safeParse(record.analytics28d);
  const locations =
    record.analyticsLocations == null
      ? null
      : AnalyticsLocationsSchema.safeParse(record.analyticsLocations);
  return {
    one: one?.success ? one.data : null,
    seven: seven?.success ? seven.data : null,
    twentyEight: twentyEight?.success ? twentyEight.data : null,
    locations: locations?.success ? locations.data : null,
  };
}

export interface AnalyticsLocationItem {
  name: string;
  count: number;
  sharePct: number;
}

export interface AnalyticsChartPoint {
  date: string;
  mediaViews: number;
  uniqueViewers: number;
}

export interface AnalyticsAggregate {
  pagesIncluded: number;
  updatedAt: string | null;
  followers: { total: number; gained: number };
  mediaViews: number;
  uniqueViewers: number;
  profileViews: number;
  engagement: number;
  videoViews: number;
  videoCompleteViews30s: number;
  watchTimeMs: number;
  totalActions: number;
  newFollows: number;
  unfollows: number;
  netFollows: number;
  chart: AnalyticsChartPoint[];
  topCountries: AnalyticsLocationItem[];
  topCities: AnalyticsLocationItem[];
  hasNoData: boolean;
}

const DAY_FIELDS = [
  'media_views',
  'unique_viewers',
  'profile_views',
  'engagement',
  'video_views',
  'video_view_time_ms',
  'total_actions',
  'new_follows',
  'unfollows',
  'video_complete_views_30s',
] as const;

const FIELD_TO_KEY = {
  media_views: 'mediaViews',
  unique_viewers: 'uniqueViewers',
  profile_views: 'profileViews',
  engagement: 'engagement',
  video_views: 'videoViews',
  video_view_time_ms: 'watchTimeMs',
  total_actions: 'totalActions',
  new_follows: 'newFollows',
  unfollows: 'unfollows',
  video_complete_views_30s: 'videoCompleteViews30s',
} as const;

function zeroTotals(): Omit<AnalyticsAggregate, 'pagesIncluded' | 'updatedAt' | 'hasNoData' | 'chart' | 'topCountries' | 'topCities' | 'followers'> {
  return {
    mediaViews: 0,
    uniqueViewers: 0,
    profileViews: 0,
    engagement: 0,
    videoViews: 0,
    videoCompleteViews30s: 0,
    watchTimeMs: 0,
    totalActions: 0,
    newFollows: 0,
    unfollows: 0,
    netFollows: 0,
  };
}

/**
 * Spec 242 — pages connected in the picked scope: distinct Facebook
 * page ids over destination rows, every status except `disconnected`
 * (a disconnected page is not connected — it is hidden from every
 * pages list). Mirrors and ADU configs never add: the destination
 * row is the page, so only destination rows are counted, and a page
 * held in two sections still counts once.
 */
export function countConnectedPages(
  rows: ReadonlyArray<{ externalDestinationId: string; status: string }>
): number {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.status === 'disconnected') continue;
    if (!row.externalDestinationId) continue;
    ids.add(row.externalDestinationId);
  }
  return ids.size;
}

/**
 * Aggregate deduped page records for one period. The records must
 * already be filtered to the listed set (Facebook only, every status
 * except disconnected, deduped by page id) — this function only sums.
 */
export function aggregateAnalytics(
  records: AnalyticsPageRecord[],
  period: AnalyticsPeriod
): AnalyticsAggregate {
  const totals = zeroTotals();
  let followersTotal = 0;
  let followersGained = 0;
  let updatedAt: string | null = null;
  let hasAnyAnalytics = false;
  const perDate = new Map<string, { mediaViews: number; uniqueViewers: number }>();
  const countryCounts = new Map<string, number>();
  const cityCounts = new Map<string, number>();

  for (const record of records) {
    const current = record.currentFollowers;
    if (typeof current === 'number' && Number.isFinite(current)) {
      followersTotal += current;
      const starting = record.startingFollowers;
      if (typeof starting === 'number' && Number.isFinite(starting)) {
        followersGained += current - starting;
      }
    }
    if (record.analyticsUpdatedAt && (updatedAt === null || record.analyticsUpdatedAt > updatedAt)) {
      updatedAt = record.analyticsUpdatedAt;
    }
    const parsed = parseStoredAnalytics(record);
    if (parsed.one !== null || parsed.seven !== null || parsed.twentyEight !== null) {
      hasAnyAnalytics = true;
    }
    if (period === '1') {
      const day = parsed.one;
      if (day) {
        for (const field of DAY_FIELDS) {
          totals[FIELD_TO_KEY[field]] += day[field];
        }
        const point = perDate.get(day.date) ?? { mediaViews: 0, uniqueViewers: 0 };
        point.mediaViews += day.media_views;
        point.uniqueViewers += day.unique_viewers;
        perDate.set(day.date, point);
      }
    } else {
      // Normalise the 7d/28d window to one shape: the stored days
      // plus Facebook's own deduplicated unique-viewer value for
      // the window — never the sum of daily values.
      const windowed =
        period === '7'
          ? parsed.seven && {
              days: parsed.seven.days,
              uniqueViewers: parsed.seven.unique_viewers_7d,
            }
          : parsed.twentyEight && {
              days: parsed.twentyEight.days,
              uniqueViewers: parsed.twentyEight.unique_viewers_28d,
            };
      if (windowed) {
        for (const day of windowed.days) {
          for (const field of DAY_FIELDS) {
            if (field === 'unique_viewers') continue;
            totals[FIELD_TO_KEY[field]] += day[field];
          }
          const point = perDate.get(day.date) ?? { mediaViews: 0, uniqueViewers: 0 };
          point.mediaViews += day.media_views;
          point.uniqueViewers += day.unique_viewers;
          perDate.set(day.date, point);
        }
        totals.uniqueViewers += windowed.uniqueViewers;
      }
    }
    if (parsed.locations) {
      for (const { country, followers } of parsed.locations.countries) {
        countryCounts.set(country, (countryCounts.get(country) ?? 0) + followers);
      }
      for (const { city, followers } of parsed.locations.cities) {
        cityCounts.set(city, (cityCounts.get(city) ?? 0) + followers);
      }
    }
  }

  totals.netFollows = totals.newFollows - totals.unfollows;
  const chart = [...perDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, point]) => ({ date, mediaViews: point.mediaViews, uniqueViewers: point.uniqueViewers }));

  return {
    pagesIncluded: records.length,
    updatedAt,
    followers: { total: followersTotal, gained: followersGained },
    ...totals,
    chart,
    topCountries: topLocations(countryCounts, followersTotal, countryName),
    topCities: topLocations(cityCounts, followersTotal, (name) => name),
    hasNoData: !hasAnyAnalytics,
  };
}

function topLocations(
  counts: Map<string, number>,
  followersTotal: number,
  toName: (key: string) => string
): AnalyticsLocationItem[] {
  return [...counts.entries()]
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({
      name: toName(key),
      count,
      // Clamped at 100: the location counts are Facebook's lifetime
      // follows, which can exceed the CURRENT follower total when
      // followers have dropped since — a share above 100% is
      // meaningless, and the contract caps sharePct at 100. The
      // count itself is never altered.
      sharePct:
        followersTotal > 0 ? Math.min(100, Math.round((count / followersTotal) * 1000) / 10) : 0,
    }));
}

let regionNames: Intl.DisplayNames | null = null;

/** ISO country code → English name ("PK" → "Pakistan"); unknown codes pass through. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Last 28 days · combined" / "Last 7 days · combined" / "Yesterday · combined". */
export function periodLabel(period: AnalyticsPeriod): string {
  if (period === '1') return 'Yesterday · combined';
  if (period === '7') return 'Last 7 days · combined';
  return 'Last 28 days · combined';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDayMonth(iso: string): string {
  const [, month, day] = iso.split('-');
  const m = Number(month);
  return `${Number(day)} ${MONTHS[(Number.isFinite(m) ? m : 1) - 1]}`;
}

function fullDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  const m = Number(month);
  return `${Number(day)} ${MONTHS[(Number.isFinite(m) ? m : 1) - 1]} ${year}`;
}

/**
 * "26 Oct – 22 Nov 2026" for a range, "16 – 22 Nov 2026" within one
 * month, "22 Nov 2026" for a single day, "" when there are no dates.
 */
export function formatDateRangeLabel(dates: string[]): string {
  if (dates.length === 0) return '';
  // ISO dates sort chronologically as strings; the explicit
  // comparator keeps the sort locale-aware (typescript:S2871).
  const sorted = [...dates].sort((a, b) => a.localeCompare(b));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (first === last) return fullDate(first);
  const [firstYear, firstMonth] = first.split('-');
  const [lastYear, lastMonth] = last.split('-');
  if (firstYear === lastYear && firstMonth === lastMonth) {
    return `${Number(first.split('-')[2])} – ${fullDate(last)}`;
  }
  return `${shortDayMonth(first)} ${firstYear} – ${fullDate(last)}`;
}

/** "372 hours" / "13 hours" / "45 min" — the mockup shows hours. */
export function formatWatchTime(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1) {
    const rounded = Math.round(hours);
    return `${rounded.toLocaleString()} ${rounded === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes.toLocaleString()} min`;
}

/** Locale-grouped count ("60,975"), as the Insights tab shows it. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** "+59,803" for a positive number, plain otherwise. */
export function formatSigned(value: number): string {
  if (value > 0) return `+${value.toLocaleString()}`;
  return value.toLocaleString();
}
