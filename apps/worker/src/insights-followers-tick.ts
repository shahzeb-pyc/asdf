import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, InternalError } from '@fbuploadpro/contracts';

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
 * (fail loud — the cron invocation reports it, tomorrow retries).
 * No per-run rows are stored, so there is no retention problem.
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

export interface InsightsFollowersOptions {
  db: InsightsFollowersDb;
  masterKey: string;
  now?: Date;
  /**
   * Test seam: single-attempt live-count fetch. Defaults to the
   * Graph read below (global fetch, timeout, 429 surfaced as a
   * status-carrying error for the backoff wrapper).
   */
  fetchFollowers?: (fbPageId: string, accessToken: string) => Promise<number>;
  /** Test seam: delay (429 backoff). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
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

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

interface DestinationScanRow {
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

async function listDestinationPage(
  supabase: SupabaseClient,
  offset: number
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
    .range(offset, offset + INSIGHTS_FOLLOWERS_PAGE_SIZE - 1);
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
}

async function processPage(
  supabase: SupabaseClient,
  dests: DestinationScanRow[],
  masterKey: string,
  nowIso: string,
  fetchFollowers: (fbPageId: string, accessToken: string) => Promise<number>,
  sleep: (ms: number) => Promise<void>,
  fetchedByPage: Map<string, number>
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
  if (eligible.length === 0) {
    return { updated: 0, skipped: dests.length, failed: 0, adu: 0, mirrors: 0 };
  }

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
      return { updated: 0, skipped, failed: eligible.length, adu: 0, mirrors: 0 };
    }
    fetchedByPage.set(fbPageId, live);
  }

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
    for (const mirror of (mirrorRows ?? []) as MirrorScanRow[]) {
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
  return { updated, skipped, failed, adu: aduUpdated, mirrors: mirrorsUpdated };
}

/**
 * Runs one daily follower-refresh cycle: bounded paged scan of
 * Facebook destinations, live Graph check per page (concurrency 5),
 * targeted writes on success only. Returns the run counters and logs
 * one structured counter line (counts only — never tokens, captions,
 * or row contents).
 */
export async function runInsightsFollowersCycle(
  options: InsightsFollowersOptions
): Promise<InsightsFollowersResult> {
  const { db, masterKey, now = new Date() } = options;
  const nowIso = now.toISOString();
  const sleep = options.sleep ?? defaultSleep;
  const fetchFollowers =
    options.fetchFollowers ??
    ((fbPageId: string, accessToken: string) =>
      fetchLiveFollowersFromGraph(fbPageId, accessToken));
  const supabase = db as unknown as SupabaseClient;

  const result: InsightsFollowersResult = {
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    aduUpdated: 0,
    mirrorsUpdated: 0,
  };

  let offset = 0;
  // Spec 174 3A: one Graph fetch per page. Rows are grouped by
  // external id (a page imported into two sections has two rows);
  // a page whose rows straddle two scan pages reuses the fetched
  // total via fetchedByPage instead of fetching again.
  const fetchedByPage = new Map<string, number>();
  for (;;) {
    const page = await listDestinationPage(supabase, offset);
    result.scanned += page.length;
    const groups = new Map<string, DestinationScanRow[]>();
    for (const dest of page) {
      const key = dest.external_destination_id || dest.id;
      const group = groups.get(key);
      if (group) group.push(dest);
      else groups.set(key, [dest]);
    }
    const groupList = [...groups.values()];
    for (let i = 0; i < groupList.length; i += INSIGHTS_FOLLOWERS_CONCURRENCY) {
      const chunk = groupList.slice(i, i + INSIGHTS_FOLLOWERS_CONCURRENCY);
      const outcomes = await Promise.all(
        chunk.map((dests) =>
          processPage(supabase, dests, masterKey, nowIso, fetchFollowers, sleep, fetchedByPage)
        )
      );
      for (const outcome of outcomes) {
        result.updated += outcome.updated;
        result.skipped += outcome.skipped;
        result.failed += outcome.failed;
        result.aduUpdated += outcome.adu;
        result.mirrorsUpdated += outcome.mirrors;
      }
    }
    if (page.length < INSIGHTS_FOLLOWERS_PAGE_SIZE) break;
    offset += INSIGHTS_FOLLOWERS_PAGE_SIZE;
  }

  console.info(
    `[insights-followers] run scanned=${result.scanned} updated=${result.updated} ` +
      `skipped=${result.skipped} failed=${result.failed} adu_updated=${result.aduUpdated} ` +
      `mirrors_updated=${result.mirrorsUpdated}`
  );
  return result;
}
