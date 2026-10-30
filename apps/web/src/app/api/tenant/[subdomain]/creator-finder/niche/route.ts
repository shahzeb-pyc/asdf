import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchCreatorsByKeyword,
  NicheResponseSchema,
} from '@fbuploadpro/contracts';
import {
  creatorFinderErrorResponse,
  getCreatorFinderKeys,
  getCreatorFinderSession,
  getCreatorFinderSupabase,
  getCreatorFinderWorkspaceId,
  saveCreatorsToDb,
} from '../lib';

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
  const keyword = request.nextUrl.searchParams.get('keyword');
  if (!keyword?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a niche or keyword to search.' },
      { status: 400 },
    );
  }
  try {
    const result = await fetchCreatorsByKeyword(keyword, {
      apiKeys: getCreatorFinderKeys(),
    });
    // Auto-save: results still render if the save fails; the
    // response carries saveFailed so the page warns visibly.
    let saveFailed = false;
    try {
      const supabase = getCreatorFinderSupabase();
      const workspaceId = await getCreatorFinderWorkspaceId(
        supabase,
        subdomain,
        session,
      );
      if (!supabase || !workspaceId) {
        saveFailed = true;
      } else {
        saveFailed = !(await saveCreatorsToDb(
          supabase,
          workspaceId,
          session.userId,
          result.creators,
          'niche',
          result.keyword,
        ));
      }
    } catch {
      saveFailed = true;
    }
    return NextResponse.json(
      NicheResponseSchema.parse({ ...result, saveFailed }),
    );
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
