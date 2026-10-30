import { type NextRequest, NextResponse } from 'next/server';
import {
  SavedCreatorDeleteResponseSchema,
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
  return NextResponse.json(
    SavedCreatorListResponseSchema.parse({ creators }),
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const resolved = await resolveWorkspace(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
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
