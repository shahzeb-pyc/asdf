import { type NextRequest, NextResponse } from 'next/server';
import {
  CreatorFinderError,
  getSessionSecret,
  parseCreatorFinderKeys,
  verifySessionToken,
  canAccessTenant,
  savedCreatorFromRow,
  savedCreatorUpsertRow,
  type Creator,
  type SavedCreator,
  type SavedCreatorSource,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRouteSupabase } from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';

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

/** Admin client for creator-finder database access, or null. */
export function getCreatorFinderSupabase(): SupabaseClient | null {
  return getRouteSupabase();
}

/** Workspace id for this tenant subdomain and session user, or null. */
export async function getCreatorFinderWorkspaceId(
  supabase: SupabaseClient | null,
  subdomain: string,
  session: SessionPayload,
): Promise<string | null> {
  if (!supabase) return null;
  return resolveTenantWorkspaceId(supabase, subdomain, session.userId, session.role);
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
      .select('handle, follower_count, verified')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .in('handle', handles);
    if (readError) return false;
    const existingByHandle = new Map<
      string,
      { followerCount?: number | undefined; verified?: boolean | undefined }
    >();
    for (const row of existingRows ?? []) {
      const record = row as {
        handle?: unknown;
        follower_count?: unknown;
        verified?: unknown;
      };
      if (typeof record.handle !== 'string') continue;
      existingByHandle.set(record.handle, {
        followerCount:
          typeof record.follower_count === 'number'
            ? record.follower_count
            : undefined,
        verified:
          typeof record.verified === 'boolean' ? record.verified : undefined,
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
    return !upsertError;
  } catch {
    return false;
  }
}

/**
 * Saved creators for this user + workspace, newest first.
 * Returns null on any database failure so the route can fail loud
 * instead of showing an empty list as if nothing were saved.
 */
export async function listSavedCreators(
  supabase: SupabaseClient | null,
  workspaceId: string,
  userId: string,
): Promise<SavedCreator[] | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from(SAVED_CREATORS_TABLE)
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) return null;
    const creators: SavedCreator[] = [];
    for (const row of data ?? []) {
      const creator = savedCreatorFromRow(
        row as Record<string, unknown>,
      );
      if (creator) creators.push(creator);
    }
    return creators;
  } catch {
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
    return !error;
  } catch {
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
        ? 'Creator search is not available yet — no TikTok data key is set up for this workspace.'
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
