import { type NextRequest, NextResponse } from 'next/server';
import { savedCreatorsToCsv } from '@fbuploadpro/contracts';
import {
  getCreatorFinderSession,
  getCreatorFinderSupabase,
  getCreatorFinderWorkspaceId,
  listSavedCreators,
} from '../../lib';

/**
 * Export ALL saved creators for this user + workspace as CSV —
 * not just any page shown, since the Saved tab lists everything.
 * Column order is fixed by savedCreatorsToCsv (RFC 4180 escaping).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const { session, errorResponse } = await getCreatorFinderSession(
    request,
    subdomain,
  );
  if (errorResponse) return errorResponse;
  const supabase = getCreatorFinderSupabase();
  const workspaceId = await getCreatorFinderWorkspaceId(
    supabase,
    subdomain,
    session,
  );
  if (!supabase || !workspaceId) {
    return NextResponse.json(
      {
        error: 'SAVED_UNAVAILABLE',
        message: 'Saved creators could not be exported. Please try again.',
      },
      { status: 502 },
    );
  }
  const creators = await listSavedCreators(
    supabase,
    workspaceId,
    session.userId,
  );
  if (!creators) {
    return NextResponse.json(
      {
        error: 'SAVED_UNAVAILABLE',
        message: 'Saved creators could not be exported. Please try again.',
      },
      { status: 502 },
    );
  }
  return new Response(savedCreatorsToCsv(creators), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="saved-creators.csv"',
    },
  });
}
