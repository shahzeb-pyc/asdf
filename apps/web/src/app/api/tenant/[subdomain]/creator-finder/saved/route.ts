import { type NextRequest, NextResponse } from 'next/server';
import {
  filterSavedCreators,
  paginateSavedCreators,
  SavedCreatorDeleteResponseSchema,
  SavedCreatorListQuerySchema,
  SavedCreatorListResponseSchema,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteSavedCreator,
  getCreatorFinderSession,
  getCreatorFinderSupabase,
  getCreatorFinderWorkspaceId,
  listSavedCreators,
  logCreatorFinderDbError,
} from '../lib';

type Resolved =
  | {
      session: SessionPayload;
      supabase: SupabaseClient;
      workspaceId: string;
    }
  | { errorResponse: NextResponse };

async function resolveWorkspace(
  request: NextRequest,
  subdomain: string,
): Promise<Resolved> {
  const { session, errorResponse } = await getCreatorFinderSession(
    request,
    subdomain,
  );
  if (errorResponse) return { errorResponse };
  const supabase = getCreatorFinderSupabase();
  const workspaceId = await getCreatorFinderWorkspaceId(
    supabase,
    subdomain,
    session,
  );
  if (!supabase || !workspaceId) {
    return {
      errorResponse: NextResponse.json(
        {
          error: 'SAVED_UNAVAILABLE',
          message: 'Saved creators could not be loaded. Please try again.',
        },
        { status: 502 },
      ),
    };
  }
  return { session, supabase, workspaceId };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const resolved = await resolveWorkspace(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  // Server-side search + source filter + pagination. Filtering and
  // paging happen in this route (not in lib.ts, which this change
  // deliberately leaves untouched): the full saved list for this
  // user + workspace is fetched, filtered, then sliced to one page.
  // Export stays unpaginated — it reads the full list directly.
  const queryParsed = SavedCreatorListQuerySchema.safeParse({
    q: request.nextUrl.searchParams.get('q') ?? undefined,
    source: request.nextUrl.searchParams.get('source') ?? undefined,
    page: request.nextUrl.searchParams.get('page') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Saved list filters are invalid.' },
      { status: 400 },
    );
  }
  const creators = await listSavedCreators(
    resolved.supabase,
    resolved.workspaceId,
    resolved.session.userId,
  );
  if (!creators) {
    return NextResponse.json(
      {
        error: 'SAVED_UNAVAILABLE',
        message: 'Saved creators could not be loaded. Please try again.',
      },
      { status: 502 },
    );
  }
  const filtered = filterSavedCreators(creators, queryParsed.data);
  const page = paginateSavedCreators(filtered, queryParsed.data.page);
  return NextResponse.json(
    SavedCreatorListResponseSchema.parse(page),
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const resolved = await resolveWorkspace(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  // Clear-all: deletes EVERY saved creator for this user + workspace.
  // Scoped by workspace_id + user_id in the query itself, so no other
  // user's rows can ever be touched. The UI gates this behind a
  // confirmation dialogue; the route itself takes no other action.
  if (request.nextUrl.searchParams.get('clearAll') === 'true') {
    const { error } = await resolved.supabase
      .from('creator_finder_saved_creators')
      .delete()
      .eq('workspace_id', resolved.workspaceId)
      .eq('user_id', resolved.session.userId);
    if (error) {
      logCreatorFinderDbError('saved clear-all delete', error);
      return NextResponse.json(
        {
          error: 'SAVED_UNAVAILABLE',
          message: 'Saved creators could not be cleared. Please try again.',
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      SavedCreatorDeleteResponseSchema.parse({ removed: true }),
    );
  }
  const handle = request.nextUrl.searchParams.get('handle');
  if (!handle?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Pick a saved creator to remove.' },
      { status: 400 },
    );
  }
  const removed = await deleteSavedCreator(
    resolved.supabase,
    resolved.workspaceId,
    resolved.session.userId,
    handle,
  );
  if (!removed) {
    return NextResponse.json(
      {
        error: 'SAVED_UNAVAILABLE',
        message: 'That saved creator could not be removed. Please try again.',
      },
      { status: 502 },
    );
  }
  return NextResponse.json(
    SavedCreatorDeleteResponseSchema.parse({ removed: true }),
  );
}
