import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Analytics1dSchema,
  Analytics28dSchema,
  Analytics7dSchema,
  AnalyticsLocationsSchema,
  decryptToken,
  InternalError,
  type Analytics1d,
  type Analytics28d,
  type Analytics7d,
  type AnalyticsLocations,
} from '@fbuploadpro/contracts';

/**
 * Spec 162 — daily insights-followers worker.
 *
 * The follower numbers on Pages / ADU / mirrors were written only at
 * import time and never refreshed. This tick runs once a day
 * (03:00 PKT = 22:00 UTC) and, per Facebook PAGE, fetches the
 * live follower total from Graph (`/{page-id}?fields=followers_count`
 * with the per-page destination token, decrypted server-side — the
 * same read pages/import and the live insights route do) and writes
 * ONLY the current total + a last-updated timestamp, to EVERY section
 * row for that page (spec 174 3A: one fetch per page, fanned out —
 * the copies used to drift apart when each row fetched separately):
 *
 *   - destinations.metadata: current_followers + followers_updated_at
 *     (starting_followers untouched — the merge preserves every other
 *     metadata key);
 *   - adu_configs (Facebook, of that destination, status active):
 *     current_followers + followers_updated_at (starting untouched);
 *   - mirrors (target_platform facebook, same external id, status
 *     active, no fb_status): current_followers + timestamp, and on
 *     the FIRST run (starting_followers IS NULL) starting = current =
 *     live, so the mirror gain starts at zero.
 *
 * Failed checks change NOTHING: a status-gated row is skipped, a
 * decrypt failure or Graph error skips that row only (logged +
 * counted, the run continues), and a failed row is never written —
 * no NULL, no 0, no timestamp bump, so the timestamp always means
 * "last SUCCESSFUL check". Facebook only: the scan filters
 * destinations to platform facebook, so Instagram/Threads configs
 * and mirrors are never touched.
 *
 * The scan is bounded and paged (200 rows per page, PostgREST
 * .range(), ordered by id so page boundaries are stable even
 * though the tick mutates destinations.updated_at mid-run); per-page Graph calls run at a small concurrency (5)
 * with exponential backoff on 429. A scan-level DB error throws
 * (fail loud — the queue redelivers it, tomorrow retries).
 * No per-run rows are stored in this module — the run record lives
 * in insights_runs / insights_run_chunks (spec 240, see
 * insights-run-chunks.ts), which owns the cycle now: one queue
 * message per offset page, one chunk per consumer invocation.
 *
 * Spec 241 — stored analytics rides the same chunk: processPage
 * also fetches per-page insights (Calls A–D via
 * fetchPageAnalyticsFromGraph) for pages with 100+ stored
 * followers and wholesale-replaces the four JSON columns
 * (analytics_1d / analytics_7d / analytics_28d /
 * analytics_locations) on every section row for the page. A failed
 * fetch leaves the columns byte-identical; a followers failure
 * never blocks analytics and an analytics failure never blocks
 * followers.
 */

/** Cron expression for the daily follower refresh (wrangler.toml triggers). */
export const INSIGHTS_FOLLOWERS_CRON = '0 22 * * *';

/** Destinations fetched per scan page (PostgREST .range()). */
export const INSIGHTS_FOLLOWERS_PAGE_SIZE = 200;

/** Simultaneous Graph calls per chunk (paced for Facebook rate limits). */
export const INSIGHTS_FOLLOWERS_CONCURRENCY = 5;

/** Graph read timeout per attempt (same budget as the worker's FB publish client). */
export const INSIGHTS_GRAPH_TIMEOUT_MS = 15_000;

/** Graph 429 retries per page (initial attempt + these retries). */
export const INSIGHTS_GRAPH_MAX_RETRIES = 2;

/** First 429 backoff delay; doubled per retry. */
export const INSIGHTS_GRAPH_RETRY_BASE_DELAY_MS = 1000;

const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';

export interface InsightsFollowersDb {
  from: SupabaseClient['from'];
}

export interface InsightsFollowersResult {
  /** Facebook destination rows the scan returned. */
  scanned: number;
  /** Destinations whose current followers were written. */
  updated: number;
  /** Rows skipped by a status gate, a missing token, or a gated mirror/config filter. */
  skipped: number;
  /** Rows whose check failed (decrypt / Graph / write error) — left untouched. */
  failed: number;
  /** ADU config rows updated. */
  aduUpdated: number;
  /** Mirror rows updated. */
  mirrorsUpdated: number;
}

/** A Graph read failure, carrying the HTTP status for the 429 retry rule. */
export class InsightsGraphError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'InsightsGraphError';
    this.status = status;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function dbErrorDetail(error: unknown): string {
  const detail = error as { code?: unknown; message?: unknown };
  const code = typeof detail?.code === 'string' ? detail.code : 'unknown';
  const message = typeof detail?.message === 'string' ? detail.message : '';
  return `${code} ${message}`.trim();
}

/**
 * One Graph read: the page node's followers_count. The token travels
 * only in this server-side URL, never to a log. A non-2xx response
 * (including 429) throws with its status; a malformed body throws
 * without one — both are per-row failures, never a guessed value.
 */
export async function fetchLiveFollowersFromGraph(
  fbPageId: string,
  accessToken: string,
  fetchImpl: FetchFn = fetch,
  timeoutMs: number = INSIGHTS_GRAPH_TIMEOUT_MS
): Promise<number> {
  const url =
    `${GRAPH_BASE_URL}/${encodeURIComponent(fbPageId)}` +
    `?fields=followers_count&access_token=${encodeURIComponent(accessToken)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new InsightsGraphError(
      `Graph followers fetch failed for page ${fbPageId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new InsightsGraphError(
      `Graph followers fetch failed for page ${fbPageId}: HTTP ${res.status}`,
      res.status
    );
  }
  const body = (await res.json().catch(() => null)) as {
    followers_count?: unknown;
  } | null;
  const count = body?.followers_count;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new InsightsGraphError(
      `Graph followers fetch returned no usable followers_count for page ${fbPageId}`
    );
  }
  return Math.trunc(count);
}

/**
 * 429-only retry with exponential backoff. Any other failure (auth,
 * checkpoint, malformed body) is final — retrying it cannot help,
 * and the row is left for tomorrow.
 */
async function fetchLiveFollowersWithBackoff(
  fbPageId: string,
  accessToken: string,
  fetchFollowers: (fbPageId: string, accessToken: string) => Promise<number>,
  sleep: (ms: number) => Promise<void>
): Promise<number> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchFollowers(fbPageId, accessToken);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status !== 429 || attempt >= INSIGHTS_GRAPH_MAX_RETRIES) throw err;
      const delay = INSIGHTS_GRAPH_RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `[insights-followers] page ${fbPageId} rate-limited (429); retry ${attempt + 1}/${INSIGHTS_GRAPH_MAX_RETRIES} after ${delay}ms`
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function withGraphBackoff<T>(
  attempt: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  label: string
): Promise<T> {
  let attempts = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      if (status !== 429 || attempts >= INSIGHTS_GRAPH_MAX_RETRIES) {
        throw err;
      }
      const delay = INSIGHTS_GRAPH_RETRY_BASE_DELAY_MS * 2 ** attempts;
      console.warn(
        `[insights-followers] ${label} rate-limited (429); retry ${attempts + 1}/${INSIGHTS_GRAPH_MAX_RETRIES} after ${delay}ms`
      );
      await sleep(delay);
      attempts += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Spec 241 — stored analytics (Calls A–D)
// ---------------------------------------------------------------------------

/** A page needs at least this many stored followers before analytics is fetched. */
export const ANALYTICS_MIN_FOLLOWERS = 100;

/**
 * Call A metrics — the ONLY insight names the worker may request.
 * Verified live 2026-11-23 (probe against drhealthytips8). Deliberately
 * absent: page_fan_adds, page_video_views_unique, page_video_views_10s —
 * Facebook returns HTTP 400 code 100 for each, and one invalid name fails
 * the whole insights call, so they must never appear in a request.
 */
export const ANALYTICS_DAY_METRICS = [
  'page_media_view',
  'page_total_media_view_unique',
  'page_views_total',
  'page_post_engagements',
  'page_video_views',
  'page_video_view_time',
  'page_total_actions',
  'page_daily_follows_unique',
  'page_daily_unfollows_unique',
  'page_video_complete_views_30s',
] as const;

const ANALYTICS_METRIC_TO_FIELD = {
  page_media_view: 'media_views',
  page_total_media_view_unique: 'unique_viewers',
  page_views_total: 'profile_views',
  page_post_engagements: 'engagement',
  page_video_views: 'video_views',
  page_video_view_time: 'video_view_time_ms',
  page_total_actions: 'total_actions',
  page_daily_follows_unique: 'new_follows',
  page_daily_unfollows_unique: 'unfollows',
  page_video_complete_views_30s: 'video_complete_views_30s',
} as const;

/** The four stored columns for one page, ready to write. */
export interface AnalyticsColumnValues {
  analytics1d: Analytics1d;
  analytics7d: Analytics7d;
  analytics28d: Analytics28d;
  /**
   * null = Call D returned empty data: keep the stored column, write the
   * other three. (Facebook returns HTTP 200 with empty data for
   * page_follows_country / page_follows_city on some pages.)
   */
  locations: AnalyticsLocations | null;
}

/**
 * The page's token returns no insights at all (every call HTTP 200 with
 * empty data — the token lacks read_insights). Not an error: skip the page,
 * keep the old columns.
 */
export class InsightsNoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightsNoDataError';
  }
}

interface InsightsValue {
  value?: unknown;
  end_time?: string;
}

interface InsightsEntry {
  name?: string;
  period?: string;
  values?: InsightsValue[];
}

function insightsEntries(payload: unknown): InsightsEntry[] {
  if (payload === null || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? (data as InsightsEntry[]) : [];
}

/** Fetch one insights edge and return its entries; non-2xx is a loud failure. */
async function fetchInsightsEntries(
  url: string,
  fetchImpl: FetchFn,
  timeoutMs: number
): Promise<InsightsEntry[]> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new InsightsGraphError(
      `Facebook insights call failed (HTTP ${res.status}): ${url.split('access_token=')[0]}`,
      res.status
    );
  }
  return insightsEntries(await res.json());
}

function endTimeDate(entry: InsightsValue): string | null {
  return typeof entry.end_time === 'string' ? entry.end_time.slice(0, 10) : null;
}

/** The 28 calendar dates ending on `lastDay` (UTC), oldest first. */
function analyticsWindowDates(lastDay: Date): string[] {
  const out: string[] = [];
  for (let i = 27; i >= 0; i -= 1) {
    const d = new Date(lastDay);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildDayEntry(date: string, byMetric: Map<string, Map<string, number>>) {
  const entry: Record<string, unknown> = { date };
  for (const metric of ANALYTICS_DAY_METRICS) {
    entry[ANALYTICS_METRIC_TO_FIELD[metric]] = byMetric.get(metric)?.get(date) ?? 0;
  }
  return entry;
}

/**
 * Fetch one page's analytics from the Graph API (Calls A–D) and return the
 * four column values. `now` is the cycle time; the window is the 28 days
 * ending yesterday (the numbers are for yesterday, updated once a day).
 *
 * - Call A (period=day, last 28 days): fills 1d (last day), 7d days
 *   (last 7), 28d days (all 28). A day Facebook does not return is zero.
 * - Call B (period=week) / Call C (period=days_28): Facebook's own
 *   deduplicated unique-viewer values, taken at the window ending
 *   yesterday — never the sum of daily values. Each call passes
 *   since/until for its own window ending yesterday; without them
 *   Facebook's default window ends one day early (spec 252).
 * - Call D (period=lifetime): countries + cities. Empty data → locations
 *   null (keep the stored column), the other three columns still update.
 *
 * Throws InsightsNoDataError when Call A returns no entries at all, and
 * InsightsGraphError on any other Graph failure. On any throw, the caller
 * writes NOTHING for the page.
 */
export async function fetchPageAnalyticsFromGraph(
  fbPageId: string,
  accessToken: string,
  fetchImpl: FetchFn = fetch,
  timeoutMs: number = INSIGHTS_GRAPH_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: Date = new Date()
): Promise<AnalyticsColumnValues> {
  const encId = encodeURIComponent(fbPageId);
  const encToken = encodeURIComponent(accessToken);
  const lastDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const lastDayStr = lastDay.toISOString().slice(0, 10);
  const dates = analyticsWindowDates(lastDay);
  const since = dates[0]!;
  const until = lastDayStr;

  // Call A — one call, all 10 day metrics, last 28 days.
  const dayEntries = await withGraphBackoff(
    () =>
      fetchInsightsEntries(
        `${GRAPH_BASE_URL}/${encId}/insights?metric=${ANALYTICS_DAY_METRICS.join(',')}&period=day&since=${since}&until=${until}&access_token=${encToken}`,
        fetchImpl,
        timeoutMs
      ),
    sleep,
    'analytics day metrics'
  );
  if (dayEntries.length === 0) {
    throw new InsightsNoDataError(
      `Facebook returned no insights data for page ${fbPageId} (token likely lacks read_insights)`
    );
  }
  const byMetric = new Map<string, Map<string, number>>();
  for (const entry of dayEntries) {
    if (entry.period !== 'day' || typeof entry.name !== 'string') continue;
    const perDay = new Map<string, number>();
    for (const value of entry.values ?? []) {
      const date = endTimeDate(value);
      if (date !== null && typeof value.value === 'number' && Number.isFinite(value.value)) {
        perDay.set(date, value.value);
      }
    }
    byMetric.set(entry.name, perDay);
  }
  for (const metric of ANALYTICS_DAY_METRICS) {
    if (!byMetric.has(metric)) {
      console.warn(
        `[insights-followers] analytics day metrics missing ${metric} for page ${fbPageId}; treating as zero`
      );
    }
  }
  const days28 = dates.map((date) => buildDayEntry(date, byMetric));
  const days7 = days28.slice(21);
  const analytics1d = Analytics1dSchema.parse(days28[27]!);
  const analytics7d = Analytics7dSchema.parse({
    days: days7,
    unique_viewers_7d: await fetchDeduplicatedUniqueViewers(
      fbPageId,
      encId,
      encToken,
      'week',
      lastDayStr,
      dates[21]!,
      fetchImpl,
      timeoutMs,
      sleep
    ),
  });
  const analytics28d = Analytics28dSchema.parse({
    days: days28,
    unique_viewers_28d: await fetchDeduplicatedUniqueViewers(
      fbPageId,
      encId,
      encToken,
      'days_28',
      lastDayStr,
      dates[0]!,
      fetchImpl,
      timeoutMs,
      sleep
    ),
  });

  // Call D — lifetime countries + cities. Empty data keeps the old column.
  const locationEntries = await withGraphBackoff(
    () =>
      fetchInsightsEntries(
        `${GRAPH_BASE_URL}/${encId}/insights?metric=page_follows_country,page_follows_city&period=lifetime&access_token=${encToken}`,
        fetchImpl,
        timeoutMs
      ),
    sleep,
    'analytics locations'
  );
  const locations = parseLocations(locationEntries);

  return { analytics1d, analytics7d, analytics28d, locations };
}

/**
 * Calls B/C — one deduplicated unique-viewer value for the window ending
 * `lastDay`. The call passes since/until for its own window (without them
 * Facebook's default window ends one day early — spec 252). Takes the
 * latest value whose end_time is on or before that date; a missing value
 * is a loud failure (the column cannot be completed without it).
 */
async function fetchDeduplicatedUniqueViewers(
  fbPageId: string,
  encId: string,
  encToken: string,
  period: 'week' | 'days_28',
  lastDay: string,
  since: string,
  fetchImpl: FetchFn,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<number> {
  const entries = await withGraphBackoff(
    () =>
      fetchInsightsEntries(
        `${GRAPH_BASE_URL}/${encId}/insights?metric=page_total_media_view_unique&period=${period}&since=${since}&until=${lastDay}&access_token=${encToken}`,
        fetchImpl,
        timeoutMs
      ),
    sleep,
    `analytics unique viewers (${period})`
  );
  let best: { date: string; value: number } | null = null;
  for (const entry of entries) {
    if (entry.name !== 'page_total_media_view_unique' || entry.period !== period) continue;
    for (const value of entry.values ?? []) {
      const date = endTimeDate(value);
      if (date === null || date > lastDay) continue;
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) continue;
      if (best === null || date > best.date) best = { date, value: value.value };
    }
  }
  if (best === null) {
    throw new InsightsGraphError(
      `Facebook returned no ${period} unique-viewer value ending ${lastDay} for page ${fbPageId}`
    );
  }
  return best.value;
}

/**
 * Parse Call D. Returns null when Facebook returned no usable location
 * data on EITHER side (no entries, or either dictionary empty) — the
 * caller keeps the stored column whole. A one-sided answer must not
 * overwrite the stored other side with an empty list: the stored
 * column is replaced only when both sides came back non-empty.
 */
function parseLocations(entries: InsightsEntry[]): AnalyticsLocations | null {
  const dicts = new Map<string, Record<string, number>>();
  for (const entry of entries) {
    if (entry.period !== 'lifetime' || typeof entry.name !== 'string') continue;
    const first = entry.values?.[0]?.value;
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      const dict: Record<string, number> = {};
      for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) dict[key] = value;
      }
      dicts.set(entry.name, dict);
    }
  }
  const countriesDict = dicts.get('page_follows_country') ?? {};
  const citiesDict = dicts.get('page_follows_city') ?? {};
  if (Object.keys(countriesDict).length === 0 || Object.keys(citiesDict).length === 0) {
    return null;
  }
  return AnalyticsLocationsSchema.parse({
    countries: Object.entries(countriesDict).map(([country, followers]) => ({
      country,
      followers,
    })),
    cities: Object.entries(citiesDict).map(([city, followers]) => ({ city, followers })),
  });
}

export interface DestinationScanRow {
  id: string;
  external_destination_id: string;
  encrypted_destination_token: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

interface MirrorScanRow {
  id: string;
  status: string;
  fb_status: string | null;
  starting_followers: number | null;
}

/** Any metadata.fb_status value gates the row out: paused, checkpoint, invalid token, rate-limited, … */
function isGatedByFbStatus(metadata: Record<string, unknown> | null): boolean {
  const marker = metadata?.fb_status;
  return typeof marker === 'string' && marker.length > 0;
}

export async function listDestinationPage(
  supabase: SupabaseClient,
  offset: number,
  limit: number = INSIGHTS_FOLLOWERS_PAGE_SIZE
): Promise<DestinationScanRow[]> {
  const { data, error } = await supabase
    .from('destinations')
    .select(
      'id, external_destination_id, encrypted_destination_token, status, metadata'
    )
    .eq('platform', 'facebook')
    // Spec 162 (send-back fix): offset paging WITHOUT a stable order
    // can silently skip rows — PostgREST returns rows in no
    // guaranteed order, and this tick mutates destinations.updated_at
    // mid-run, which can shift the order between page fetches. Order
    // by the immutable id so every page boundary is stable.
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) {
    throw new InternalError(
      `Insights followers scan failed: ${dbErrorDetail(error)}`
    );
  }
  return (data ?? []) as DestinationScanRow[];
}

/**
 * Spec 174 3A: one Graph fetch per PAGE, fanned out to every section
 * row for that page. A page imported into two sections has two
 * destination rows; the old per-row processing fetched the live
 * total once per row at slightly different moments, so the copies
 * drifted apart (Gate 2A finding 1: Mineralsrock 17525/17528/17530).
 * Now the total is fetched once and the SAME value is written to
 * every eligible row. Counters stay per-row (updated/skipped/failed
 * count destination rows, as before); the fetch itself is per page.
 *
 * Eligible rows are the active, ungated, token-carrying ones. A
 * group with no eligible row is skipped whole. Tokens are tried in
 * row order until one decrypts and fetches — a 429 is platform-wide,
 * so it stops the token walk instead of burning the other copies.
 * A page fetched earlier in this run (its rows straddled two scan
 * pages) reuses the cached total via fetchedByPage instead of
 * fetching again.
 */
interface PageOutcome {
  updated: number;
  skipped: number;
  failed: number;
  adu: number;
  mirrors: number;
  /** Spec 241 analytics — per eligible destination row. */
  analyticsUpdated: number;
  analyticsSkipped: number;
  analyticsFailed: number;
  analyticsAdu: number;
  analyticsMirrors: number;
}

export async function processPage(
  supabase: SupabaseClient,
  dests: DestinationScanRow[],
  masterKey: string,
  nowIso: string,
  fetchFollowers: (fbPageId: string, accessToken: string) => Promise<number>,
  sleep: (ms: number) => Promise<void>,
  fetchedByPage: Map<string, number>,
  fetchAnalytics: (fbPageId: string, accessToken: string) => Promise<AnalyticsColumnValues>,
  analyticsByPage: Map<string, AnalyticsColumnValues>
): Promise<PageOutcome> {
  const fbPageId = dests[0]!.external_destination_id;
  const eligible = dests.filter(
    (d) =>
      d.status === 'active' &&
      !isGatedByFbStatus(d.metadata) &&
      typeof d.encrypted_destination_token === 'string' &&
      d.encrypted_destination_token.length > 0
  );
  const skipped = dests.length - eligible.length;
  const outcome: PageOutcome = {
    updated: 0,
    skipped,
    failed: 0,
    adu: 0,
    mirrors: 0,
    analyticsUpdated: 0,
    analyticsSkipped: 0,
    analyticsFailed: 0,
    analyticsAdu: 0,
    analyticsMirrors: 0,
  };
  if (eligible.length === 0) {
    outcome.skipped = dests.length;
    return outcome;
  }

  // Spec 241 gate, taken NOW from the stored counts as scanned at
  // the start of the run — never from the live count the followers
  // phase below is about to fetch. A page crossing 100 followers
  // starts being fetched on the NEXT daily run, not this one.
  const gateFollowers = maxStoredCurrentFollowers(eligible);

  // --- Followers (existing concern, unchanged) ---
  // writtenMetadata carries the metadata the followers write actually
  // stored, per row. The analytics phase below writes metadata too
  // (analytics_updated_at); it must build on THIS, not on the stale
  // local snapshot — the Supabase client never mutates the caller's
  // row objects, so re-reading dest.metadata would clobber the
  // followers write's current_followers / followers_updated_at.
  const writtenMetadata = new Map<string, Record<string, unknown>>();
  let live = fetchedByPage.get(fbPageId);
  if (live === undefined) {
    let lastErr: unknown = null;
    for (const row of eligible) {
      let accessToken: string;
      try {
        accessToken = await decryptToken(row.encrypted_destination_token!, masterKey);
      } catch (err) {
        lastErr = err;
        continue;
      }
      try {
        live = await fetchLiveFollowersWithBackoff(
          fbPageId,
          accessToken,
          fetchFollowers,
          sleep
        );
        break;
      } catch (err) {
        lastErr = err;
        // A 429 is a platform-wide limit, not a bad token — do not
        // burn the other copies' tokens on it.
        if ((err as { status?: unknown }).status === 429) break;
      }
    }
    if (live === undefined) {
      console.error(
        `[insights-followers] page ${fbPageId} live check failed; leaving stored followers untouched:`,
        lastErr instanceof Error ? lastErr.message : lastErr
      );
      outcome.failed = eligible.length;
    } else {
      fetchedByPage.set(fbPageId, live);
    }
  }

  if (live !== undefined) {
    // Success only from here: every write below is a targeted update
    // of the freshly fetched total. A write error is logged loudly
    // and fails only the store it hit; the next daily run rewrites
    // the same values (idempotent), so a partial write self-heals
    // instead of inventing data.
    let updated = 0;
    let failed = 0;
    for (const dest of eligible) {
      try {
        const nextMetadata: Record<string, unknown> = {
          ...(dest.metadata ?? {}),
          current_followers: live,
          followers_updated_at: nowIso,
        };
        const { error: destError } = await supabase
          .from('destinations')
          .update({ metadata: nextMetadata, updated_at: nowIso })
          .eq('id', dest.id);
        if (destError) {
          throw new InternalError(`destinations update failed: ${dbErrorDetail(destError)}`);
        }
        writtenMetadata.set(dest.id, nextMetadata);
        updated += 1;
      } catch (err) {
        console.error(
          `[insights-followers] page ${fbPageId} write failed after a successful live check:`,
          err instanceof Error ? err.message : err
        );
        failed += 1;
      }
    }

    // ADU configs attach to the adu copy only, so the IN-list over the
    // group's rows hits exactly that row's configs, once per page.
    let aduUpdated = 0;
    try {
      const { error: aduError, count: aduCount } = await supabase
        .from('adu_configs')
        .update(
          { current_followers: live, followers_updated_at: nowIso },
          { count: 'exact' }
        )
        .in('destination_id', eligible.map((d) => d.id))
        .eq('status', 'active');
      if (aduError) {
        throw new InternalError(`adu_configs update failed: ${dbErrorDetail(aduError)}`);
      }
      // The count is informational only — the row write itself is what
      // matters, and a null count is never treated as a failure.
      aduUpdated = typeof aduCount === 'number' ? aduCount : 0;
    } catch (err) {
      console.error(
        `[insights-followers] page ${fbPageId} adu write failed after a successful live check:`,
        err instanceof Error ? err.message : err
      );
    }

    // Mirrors are keyed by external id (as before), now once per page
    // instead of once per section row.
    let mirrorsUpdated = 0;
    try {
      const { data: mirrorRows, error: mirrorError } = await supabase
        .from('mirrors')
        .select('id, status, fb_status, starting_followers')
        .eq('target_platform', 'facebook')
        .eq('target_external_id', fbPageId);
      if (mirrorError) {
        throw new InternalError(`mirrors scan failed: ${dbErrorDetail(mirrorError)}`);
      }
      for (const mirror of mirrorRows as MirrorScanRow[]) {
        if (mirror.status !== 'active') continue;
        if (typeof mirror.fb_status === 'string' && mirror.fb_status.length > 0) {
          continue;
        }
        const patch =
          mirror.starting_followers === null
            ? {
                starting_followers: live,
                current_followers: live,
                followers_updated_at: nowIso,
                updated_at: nowIso,
              }
            : {
                current_followers: live,
                followers_updated_at: nowIso,
                updated_at: nowIso,
              };
        const { error: mirrorUpdateError } = await supabase
          .from('mirrors')
          .update(patch)
          .eq('id', mirror.id);
        if (mirrorUpdateError) {
          throw new InternalError(
            `mirrors update failed: ${dbErrorDetail(mirrorUpdateError)}`
          );
        }
        mirrorsUpdated += 1;
      }
    } catch (err) {
      console.error(
        `[insights-followers] page ${fbPageId} mirror write failed after a successful live check:`,
        err instanceof Error ? err.message : err
      );
    }
    outcome.updated = updated;
    outcome.failed = failed;
    outcome.adu = aduUpdated;
    outcome.mirrors = mirrorsUpdated;
  }

  // --- Analytics (spec 241) — an independent concern: a followers
  // failure above never blocks it, and an analytics failure never
  // touches the followers write.
  const analyticsOutcome = await processPageAnalytics(
    supabase,
    eligible,
    fbPageId,
    masterKey,
    nowIso,
    fetchAnalytics,
    analyticsByPage,
    writtenMetadata,
    gateFollowers
  );
  outcome.analyticsUpdated = analyticsOutcome.updated;
  outcome.analyticsSkipped = analyticsOutcome.skipped;
  outcome.analyticsFailed = analyticsOutcome.failed;
  outcome.analyticsAdu = analyticsOutcome.aduUpdated;
  outcome.analyticsMirrors = analyticsOutcome.mirrorsUpdated;
  return outcome;
}

/** The stored current-followers count for the 100-follower gate. */
function storedCurrentFollowers(metadata: Record<string, unknown> | null): number | null {
  const value = metadata?.current_followers;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Highest stored count across the group's rows, or null when none has one. */
function maxStoredCurrentFollowers(eligible: DestinationScanRow[]): number | null {
  const stored = eligible
    .map((d) => storedCurrentFollowers(d.metadata))
    .filter((v): v is number => v !== null);
  return stored.length > 0 ? Math.max(...stored) : null;
}

interface AnalyticsPageOutcome {
  updated: number;
  skipped: number;
  failed: number;
  aduUpdated: number;
  mirrorsUpdated: number;
}

/**
 * Spec 241 — one analytics fetch per page (Calls A–D), fanned out to
 * every section row for that page, wholesale-replaced together.
 *
 * Gate: the STORED current_followers (never a live fetch, never a
 * guess). A page under 100 followers, or with no stored count, is
 * skipped — no Graph call at all — and starts being fetched on the
 * next daily run after it crosses 100.
 *
 * Fetch: tokens are tried in row order until one fetches (a 429 stops
 * the walk, platform-wide). A token returning no insights at all
 * (InsightsNoDataError) is tried next-token, and skips the page only
 * when every token says the same. Any other Graph failure writes
 * NOTHING for the page — all four columns stay exactly as they were.
 * A page fetched earlier in this run reuses the cached columns.
 *
 * Write: all four columns together on every eligible destination row
 * (analytics_updated_at in metadata). A null locations value (Call D
 * returned empty data) keeps the stored locations column and still
 * writes the other three. The same columns fan out to the page's
 * active ADU configs and active, ungated mirrors.
 */
async function processPageAnalytics(
  supabase: SupabaseClient,
  eligible: DestinationScanRow[],
  fbPageId: string,
  masterKey: string,
  nowIso: string,
  fetchAnalytics: (fbPageId: string, accessToken: string) => Promise<AnalyticsColumnValues>,
  analyticsByPage: Map<string, AnalyticsColumnValues>,
  writtenMetadata: Map<string, Record<string, unknown>>,
  gateFollowers: number | null
): Promise<AnalyticsPageOutcome> {
  const zero: AnalyticsPageOutcome = {
    updated: 0,
    skipped: 0,
    failed: 0,
    aduUpdated: 0,
    mirrorsUpdated: 0,
  };
  // Gate on the stored count as scanned at the start of the run
  // (passed in — never the live count this run just fetched, and
  // never a guess). Under 100, or no stored count: skip, no Graph
  // call at all.
  if (gateFollowers === null || gateFollowers < ANALYTICS_MIN_FOLLOWERS) {
    return { ...zero, skipped: eligible.length };
  }

  let columns = analyticsByPage.get(fbPageId);
  if (columns === undefined) {
    let lastErr: unknown = null;
    let sawNoData = false;
    for (const row of eligible) {
      let accessToken: string;
      try {
        accessToken = await decryptToken(row.encrypted_destination_token!, masterKey);
      } catch (err) {
        lastErr = err;
        continue;
      }
      try {
        columns = await fetchAnalytics(fbPageId, accessToken);
        break;
      } catch (err) {
        lastErr = err;
        if (err instanceof InsightsNoDataError) {
          sawNoData = true;
          continue;
        }
        // A 429 is a platform-wide limit, not a bad token — do not
        // burn the other copies' tokens on it.
        if ((err as { status?: unknown }).status === 429) break;
      }
    }
    if (columns === undefined) {
      if (sawNoData && lastErr instanceof InsightsNoDataError) {
        console.info(
          `[insights-followers] page ${fbPageId} analytics skipped: token returns no insights data`
        );
        return { ...zero, skipped: eligible.length };
      }
      console.error(
        `[insights-followers] page ${fbPageId} analytics check failed; leaving stored analytics untouched:`,
        lastErr instanceof Error ? lastErr.message : lastErr
      );
      return { ...zero, failed: eligible.length };
    }
    analyticsByPage.set(fbPageId, columns);
  }

  const analyticsPatch: Record<string, unknown> = {
    analytics_1d: columns.analytics1d,
    analytics_7d: columns.analytics7d,
    analytics_28d: columns.analytics28d,
  };
  if (columns.locations !== null) {
    analyticsPatch.analytics_locations = columns.locations;
  }

  let updated = 0;
  let failed = 0;
  for (const dest of eligible) {
    try {
      // Build on the metadata the followers write stored (if any),
      // never on the stale local snapshot — otherwise this update
      // would clobber the followers write's current_followers.
      const baseMetadata = writtenMetadata.get(dest.id) ?? dest.metadata ?? {};
      const nextMetadata: Record<string, unknown> = {
        ...baseMetadata,
        analytics_updated_at: nowIso,
      };
      const { error: destError } = await supabase
        .from('destinations')
        .update({ ...analyticsPatch, metadata: nextMetadata, updated_at: nowIso })
        .eq('id', dest.id);
      if (destError) {
        throw new InternalError(`destinations analytics update failed: ${dbErrorDetail(destError)}`);
      }
      updated += 1;
    } catch (err) {
      console.error(
        `[insights-followers] page ${fbPageId} analytics write failed:`,
        err instanceof Error ? err.message : err
      );
      failed += 1;
    }
  }

  let aduUpdated = 0;
  try {
    const { error: aduError, count: aduCount } = await supabase
      .from('adu_configs')
      .update({ ...analyticsPatch, analytics_updated_at: nowIso }, { count: 'exact' })
      .in('destination_id', eligible.map((d) => d.id))
      .eq('status', 'active');
    if (aduError) {
      throw new InternalError(`adu_configs analytics update failed: ${dbErrorDetail(aduError)}`);
    }
    aduUpdated = typeof aduCount === 'number' ? aduCount : 0;
  } catch (err) {
    console.error(
      `[insights-followers] page ${fbPageId} adu analytics write failed:`,
      err instanceof Error ? err.message : err
    );
  }

  let mirrorsUpdated = 0;
  try {
    const { data: mirrorRows, error: mirrorError } = await supabase
      .from('mirrors')
      .select('id, status, fb_status')
      .eq('target_platform', 'facebook')
      .eq('target_external_id', fbPageId);
    if (mirrorError) {
      throw new InternalError(`mirrors analytics scan failed: ${dbErrorDetail(mirrorError)}`);
    }
    for (const mirror of mirrorRows as MirrorScanRow[]) {
      if (mirror.status !== 'active') continue;
      if (typeof mirror.fb_status === 'string' && mirror.fb_status.length > 0) {
        continue;
      }
      const { error: mirrorUpdateError } = await supabase
        .from('mirrors')
        .update({ ...analyticsPatch, analytics_updated_at: nowIso, updated_at: nowIso })
        .eq('id', mirror.id);
      if (mirrorUpdateError) {
        throw new InternalError(
          `mirrors analytics update failed: ${dbErrorDetail(mirrorUpdateError)}`
        );
      }
      mirrorsUpdated += 1;
    }
  } catch (err) {
    console.error(
      `[insights-followers] page ${fbPageId} mirror analytics write failed:`,
      err instanceof Error ? err.message : err
    );
  }
  return { updated, skipped: 0, failed, aduUpdated, mirrorsUpdated };
}
