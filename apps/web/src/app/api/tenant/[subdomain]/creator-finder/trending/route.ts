import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchTrendingCreators,
  TrendingResponseSchema,
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
  const region = request.nextUrl.searchParams.get('region');
  if (!region) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Pick a country first.' },
      { status: 400 },
    );
  }
  try {
    const result = await fetchTrendingCreators(region, {
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
          'trending',
          result.region,
        ));
      }
    } catch {
      saveFailed = true;
    }
    return NextResponse.json(
      TrendingResponseSchema.parse({ ...result, saveFailed }),
    );
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
