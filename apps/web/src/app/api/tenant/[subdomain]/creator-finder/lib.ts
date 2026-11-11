import { type NextRequest, NextResponse } from 'next/server';
import {
  CreatorFinderError,
  getSessionSecret,
  parseCreatorFinderKeys,
  SAVED_PAGE_SIZE,
  verifySessionToken,
  canAccessTenant,
  savedCreatorFromRow,
  savedCreatorUpsertRow,
  type Creator,
  type CreatorEnrichment,
  type SavedCreator,
  type SavedCreatorSource,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRouteSupabase } from '@/lib/route-auth';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';

/** Session check matching the other tenant API routes. */
export async function requireTenantSession(
  request: NextRequest,
  subdomain: string,
): Promise<NextResponse | null> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessTenant(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

/**
 * Same check as requireTenantSession, but returns the verified
 * session so routes can scope database writes/reads to the
 * calling user. Callers that only need the check keep using
 * requireTenantSession; routes that need the user use this.
 */
export async function getCreatorFinderSession(
  request: NextRequest,
  subdomain: string,
): Promise<
  | { session: SessionPayload; errorResponse?: never }
  | { session?: never; errorResponse: NextResponse }
> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  let session: SessionPayload;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  if (!canAccessTenant(session, subdomain)) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  return { session };
}

/**
 * Log a database failure server-side with its error code + reason
 * (never secrets, never user data) so a failed persist can be
 * diagnosed from the log. User-facing messages stay plain and are
 * produced by the calling route; this log is the diagnosis trail.
 */
export function logCreatorFinderDbError(
  context: string,
  error: unknown,
): void {
  const record = error as { code?: unknown; message?: unknown } | null;
  const code =
    record && typeof record.code === 'string' ? record.code : 'UNKNOWN';
  const message =
    record && typeof record.message === 'string'
      ? record.message
      : 'unknown database error';
  console.error(
    `[creator-finder] ${context} failed: code=${code} message=${message}`,
  );
}

/** Admin client for creator-finder database access, or null. */
export function getCreatorFinderSupabase(): SupabaseClient | null {
  return getRouteSupabase();
}

/**
 * Per-phase timing for the `Server-Timing` response header, so a slow
 * Creator Finder call can be attributed to a phase (session / gate /
 * TikWM / enrich / save) instead of inferred from payload sizes.
 * Usage: create once per request, `split()` after each phase, pass
 * `timing.header()` in the response headers.
 */
export function startServerTiming(): {
  split(label: string): void;
  header(): string;
} {
  const start = performance.now();
  const splits: Array<{ label: string; ms: number }> = [];
  let last = start;
  return {
    split(label: string): void {
      const now = performance.now();
      splits.push({ label, ms: now - last });
      last = now;
    },
    header(): string {
      return splits
        .map(({ label, ms }) => `${label};dur=${ms.toFixed(1)}`)
        .join(', ');
    },
  };
}

/** Workspace id for this tenant subdomain and session user, or null. */
export async function getCreatorFinderWorkspaceId(
  supabase: SupabaseClient | null,
  subdomain: string,
  session: SessionPayload,
): Promise<string | null> {
  if (!supabase) return null;
  return resolveWorkspaceIdFromSession(session, subdomain, supabase, session.role);
}

const SAVED_CREATORS_TABLE = 'creator_finder_saved_creators';

/**
 * Upsert one search's creators for this user + workspace. Returns
 * true on success (or when there is nothing to save) and false on
 * ANY failure — callers surface a false result as a visible save
 * warning and never turn it into a search error. A missing table
 * (migration not applied yet) is one such failure, not a crash.
 * Existing rows are read first so a later source that lacks
 * follower_count/verified never overwrites a supplied value.
 */
export async function saveCreatorsToDb(
  supabase: SupabaseClient | null,
  workspaceId: string,
  userId: string,
  creators: ReadonlyArray<Creator>,
  source: SavedCreatorSource,
  searchTerm: string,
): Promise<boolean> {
  if (creators.length === 0) return true;
  if (!supabase) return false;
  try {
    const handles = [...new Set(creators.map((creator) => creator.handle))];
    const { data: existingRows, error: readError } = await supabase
      .from(SAVED_CREATORS_TABLE)
      .select(
        'handle, follower_count, verified, bio, countik_enriched, countik_follower_count, following_count, hearts_count, video_count, countik_verified, engagement_total, engagement_likes, engagement_comments, engagement_shares, average_views, average_likes, average_comments, average_shares, hashtags, mentions',
      )
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .in('handle', handles);
    if (readError) {
      logCreatorFinderDbError('saveCreatorsToDb read existing', readError);
      return false;
    }
    const existingByHandle = new Map<
      string,
      {
        followerCount?: number | undefined;
        verified?: boolean | undefined;
        enrichment?: CreatorEnrichment | null | undefined;
      }
    >();
    for (const row of existingRows ?? []) {
      const record = row as Record<string, unknown>;
      if (typeof record.handle !== 'string') continue;
      // Rebuild the stored enrichment through the same row
      // mapping the Saved list uses, so a re-save without fresh
      // enrichment keeps exactly what was stored before.
      const stored = savedCreatorFromRow(record);
      existingByHandle.set(record.handle, {
        followerCount:
          typeof record.follower_count === 'number'
            ? record.follower_count
            : undefined,
        verified:
          typeof record.verified === 'boolean' ? record.verified : undefined,
        enrichment: stored?.enrichment ?? null,
      });
    }
    const savedAt = new Date().toISOString();
    const seen = new Set<string>();
    const rows = [];
    for (const creator of creators) {
      if (seen.has(creator.handle)) continue;
      seen.add(creator.handle);
      rows.push(
        savedCreatorUpsertRow(
          workspaceId,
          userId,
          creator,
          source,
          searchTerm,
          existingByHandle.get(creator.handle) ?? null,
          savedAt,
        ),
      );
    }
    const { error: upsertError } = await supabase
      .from(SAVED_CREATORS_TABLE)
      .upsert(rows, { onConflict: 'workspace_id,user_id,handle' });
    if (upsertError) {
      logCreatorFinderDbError('saveCreatorsToDb upsert', upsertError);
    }
    return !upsertError;
  } catch (err) {
    logCreatorFinderDbError('saveCreatorsToDb', err);
    return false;
  }
}

/**
 * One Supabase page for the Saved-list fetch. PostgREST silently
 * truncates an unbounded select at 1,000 rows, so a single select
 * can never be trusted for a list auto-save can grow past that
 * (one Similar search alone can save ~520 creators).
 */
const SAVED_CREATORS_PAGE_SIZE = 1000;

/**
 * Saved creators for this user + workspace, newest first.
 * Pages the Supabase fetch with .range() in a loop until a short
 * page, so the result is the true full list — never a silently
 * truncated first 1,000 rows. The Saved route's paging and the
 * CSV export both read through here, so both see every row.
 * Returns null on any database failure so the route can fail loud
 * instead of showing an empty list (or a partial list) as if
 * nothing were saved. A paged-fetch error returns null too —
 * never a partial list as success.
 * Ordering is updated_at desc with handle asc as the tie-break:
 * a whole search batch shares one updated_at, so without the
 * tie-break rows could be duplicated or missed across pages.
 */
export async function listSavedCreators(
  supabase: SupabaseClient | null,
  workspaceId: string,
  userId: string,
): Promise<SavedCreator[] | null> {
  if (!supabase) return null;
  try {
    const creators: SavedCreator[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from(SAVED_CREATORS_TABLE)
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .order('handle', { ascending: true })
        .range(from, from + SAVED_CREATORS_PAGE_SIZE - 1);
      if (error) {
        logCreatorFinderDbError('listSavedCreators', error);
        return null;
      }
      const rows = data ?? [];
      for (const row of rows) {
        const creator = savedCreatorFromRow(
          row as Record<string, unknown>,
        );
        if (creator) creators.push(creator);
      }
      if (rows.length < SAVED_CREATORS_PAGE_SIZE) break;
      from += SAVED_CREATORS_PAGE_SIZE;
    }
    return creators;
  } catch (err) {
    logCreatorFinderDbError('listSavedCreators', err);
    return null;
  }
}

/**
 * LIKE pattern for a Saved search needle, mirroring the media route's
 * `sanitizePostgrestSearchPattern`: LIKE wildcards and the PostgREST
 * `.or()` quoting are escaped, and the pattern is double-quoted so a
 * needle containing a comma cannot split the `.or()` filter.
 */
function escapeSavedSearchPattern(needle: string): string {
  const escaped = needle
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  return `"%${escaped}%"`;
}

/**
 * One Saved page, filtered and paged in the database (spec 169).
 * The old route fetched the full list via listSavedCreators and filtered
 * in memory, so opening Saved paid for every saved creator to show 30
 * rows. Search semantics are preserved: case-insensitive substring over
 * display name or handle (a leading @ is ignored), source filter, newest
 * first (updated_at desc, handle asc tie-break — same as listSavedCreators,
 * so pages are stable), page clamped into range. The count query and the
 * page query must apply identical filters — change both together.
 * Returns null on any database failure so the route can fail loud instead
 * of showing an empty or partial list as success.
 */
export async function listSavedCreatorsPage(
  supabase: SupabaseClient | null,
  workspaceId: string,
  userId: string,
  query: { q?: string | undefined; source?: string | undefined; page: number },
): Promise<{
  creators: SavedCreator[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
} | null> {
  if (!supabase) return null;
  const needle = (query.q ?? '').trim().replace(/^@/, '');
  const source = query.source ?? 'all';
  const pattern = needle ? escapeSavedSearchPattern(needle) : null;
  try {
    let countQuery = supabase
      .from(SAVED_CREATORS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);
    if (source !== 'all') countQuery = countQuery.eq('source', source);
    if (pattern) {
      countQuery = countQuery.or(
        `display_name.ilike.${pattern},handle.ilike.${pattern}`,
      );
    }
    const { count, error: countError } = await countQuery;
    if (countError || count === null) {
      logCreatorFinderDbError(
        'listSavedCreatorsPage count',
        countError ?? new Error('count query returned no count'),
      );
      return null;
    }
    const total = count;
    const totalPages =
      total === 0 ? 0 : Math.ceil(total / SAVED_PAGE_SIZE);
    const page =
      total === 0 ? 1 : Math.min(Math.max(1, query.page), totalPages);
    let pageQuery = supabase
      .from(SAVED_CREATORS_TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);
    if (source !== 'all') pageQuery = pageQuery.eq('source', source);
    if (pattern) {
      pageQuery = pageQuery.or(
        `display_name.ilike.${pattern},handle.ilike.${pattern}`,
      );
    }
    const { data, error } = await pageQuery
      .order('updated_at', { ascending: false })
      .order('handle', { ascending: true })
      .range((page - 1) * SAVED_PAGE_SIZE, page * SAVED_PAGE_SIZE - 1);
    if (error) {
      logCreatorFinderDbError('listSavedCreatorsPage', error);
      return null;
    }
    const creators: SavedCreator[] = [];
    for (const row of data ?? []) {
      const creator = savedCreatorFromRow(row as Record<string, unknown>);
      if (creator) creators.push(creator);
    }
    return { creators, total, page, pageSize: SAVED_PAGE_SIZE, totalPages };
  } catch (err) {
    logCreatorFinderDbError('listSavedCreatorsPage', err);
    return null;
  }
}

/** Delete one saved creator, scoped to user + workspace. */
export async function deleteSavedCreator(
  supabase: SupabaseClient | null,
  workspaceId: string,
  userId: string,
  handle: string,
): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from(SAVED_CREATORS_TABLE)
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('handle', handle);
    if (error) {
      logCreatorFinderDbError('deleteSavedCreator', error);
    }
    return !error;
  } catch (err) {
    logCreatorFinderDbError('deleteSavedCreator', err);
    return false;
  }
}

/** Keys are server-side env only; never sent to the browser. */
export function getCreatorFinderKeys(): string[] {
  return parseCreatorFinderKeys(
    process.env.TIKWMAPI_KEYS,
    process.env.TIKWMAPI_KEY,
  );
}

export function creatorFinderErrorResponse(err: unknown): NextResponse {
  if (err instanceof CreatorFinderError) {
    const status =
      err.code === 'NO_KEYS_CONFIGURED'
        ? 503
        : err.code === 'NOT_FOUND'
          ? 404
          : err.code === 'RATE_LIMITED' || err.code === 'QUOTA_EXHAUSTED'
            ? 429
            : 502;
    const message =
      err.code === 'NO_KEYS_CONFIGURED'
        ? 'Creator search is not available right now. Please try again.'
        : err.message;
    return NextResponse.json({ error: err.code, message }, { status });
  }
  return NextResponse.json(
    {
      error: 'FEED_UNAVAILABLE',
      message: 'Creator search could not be completed. Please try again.',
    },
    { status: 502 },
  );
}
