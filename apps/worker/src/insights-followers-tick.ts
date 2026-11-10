import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, InternalError } from '@fbuploadpro/contracts';

/**
 * Spec 162 — daily insights-followers worker.
 *
 * The follower numbers on Pages / ADU / mirrors were written only at
 * import time and never refreshed. This tick runs once a day
 * (03:00 PKT = 22:00 UTC) and, per Facebook destination, fetches the
 * live follower total from Graph (`/{page-id}?fields=followers_count`
 * with the per-page destination token, decrypted server-side — the
 * same read pages/import and the live insights route do) and writes
 * ONLY the current total + a last-updated timestamp:
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
 * .range()); per-page Graph calls run at a small concurrency (5)
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
    .range(offset, offset + INSIGHTS_FOLLOWERS_PAGE_SIZE - 1);
  if (error) {
    throw new InternalError(
      `Insights followers scan failed: ${dbErrorDetail(error)}`
    );
  }
  return (data ?? []) as DestinationScanRow[];
}

async function processDestination(
  supabase: SupabaseClient,
  dest: DestinationScanRow,
  masterKey: string,
  nowIso: string,
  fetchFollowers: (fbPageId: string, accessToken: string) => Promise<number>,
  sleep: (ms: number) => Promise<void>
): Promise<{ outcome: 'updated' | 'skipped' | 'failed'; adu: number; mirrors: number }> {
  const fbPageId = dest.external_destination_id;
  if (dest.status !== 'active' || isGatedByFbStatus(dest.metadata)) {
    return { outcome: 'skipped', adu: 0, mirrors: 0 };
  }
  if (!dest.encrypted_destination_token) {
    console.warn(
      `[insights-followers] page ${fbPageId} has no stored token; skipping`
    );
    return { outcome: 'skipped', adu: 0, mirrors: 0 };
  }
  let accessToken: string;
  try {
    accessToken = await decryptToken(dest.encrypted_destination_token, masterKey);
  } catch (err) {
    console.error(
      `[insights-followers] page ${fbPageId} token decrypt failed; leaving stored followers untouched:`,
      err instanceof Error ? err.message : err
    );
    return { outcome: 'failed', adu: 0, mirrors: 0 };
  }
  let live: number;
  try {
    live = await fetchLiveFollowersWithBackoff(
      fbPageId,
      accessToken,
      fetchFollowers,
      sleep
    );
  } catch (err) {
    console.error(
      `[insights-followers] page ${fbPageId} live check failed; leaving stored followers untouched:`,
      err instanceof Error ? err.message : err
    );
    return { outcome: 'failed', adu: 0, mirrors: 0 };
  }

  // Success only from here: every write below is a targeted
  // single-row update of the freshly fetched total. A write error
  // is logged loudly with its code and counts as a failure; the
  // next daily run rewrites the same values (idempotent), so a
  // partial write self-heals instead of inventing data.
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

    const { error: aduError, count: aduCount } = await supabase
      .from('adu_configs')
      .update(
        { current_followers: live, followers_updated_at: nowIso },
        { count: 'exact' }
      )
      .eq('destination_id', dest.id)
      .eq('status', 'active');
    if (aduError) {
      throw new InternalError(`adu_configs update failed: ${dbErrorDetail(aduError)}`);
    }
    // The count is informational only — the row write itself is what
    // matters, and a null count is never treated as a failure.
    const aduUpdated = typeof aduCount === 'number' ? aduCount : 0;

    const { data: mirrorRows, error: mirrorError } = await supabase
      .from('mirrors')
      .select('id, status, fb_status, starting_followers')
      .eq('target_platform', 'facebook')
      .eq('target_external_id', fbPageId);
    if (mirrorError) {
      throw new InternalError(`mirrors scan failed: ${dbErrorDetail(mirrorError)}`);
    }
    let mirrorsUpdated = 0;
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
    return { outcome: 'updated', adu: aduUpdated, mirrors: mirrorsUpdated };
  } catch (err) {
    console.error(
      `[insights-followers] page ${fbPageId} write failed after a successful live check:`,
      err instanceof Error ? err.message : err
    );
    return { outcome: 'failed', adu: 0, mirrors: 0 };
  }
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
  for (;;) {
    const page = await listDestinationPage(supabase, offset);
    result.scanned += page.length;
    for (let i = 0; i < page.length; i += INSIGHTS_FOLLOWERS_CONCURRENCY) {
      const chunk = page.slice(i, i + INSIGHTS_FOLLOWERS_CONCURRENCY);
      const outcomes = await Promise.all(
        chunk.map((dest) =>
          processDestination(supabase, dest, masterKey, nowIso, fetchFollowers, sleep)
        )
      );
      for (const outcome of outcomes) {
        if (outcome.outcome === 'updated') result.updated += 1;
        else if (outcome.outcome === 'skipped') result.skipped += 1;
        else result.failed += 1;
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
