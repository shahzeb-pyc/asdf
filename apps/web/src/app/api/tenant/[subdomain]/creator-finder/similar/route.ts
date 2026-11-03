import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchSimilarCreators,
  enrichCreators,
  SimilarResponseSchema,
} from '@fbuploadpro/contracts';
import {
  creatorFinderDailyLimitResponse,
  creatorFinderUsageErrorResponse,
  startCreatorFinderDiscovery,
} from '@/lib/creator-finder-usage';
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
  const username = request.nextUrl.searchParams.get('username');
  if (!username?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a TikTok username.' },
      { status: 400 },
    );
  }
  const searchTerm = username.trim().replace(/^@/, '');
  try {
    // Daily cap, checked at request start: at the limit this
    // returns 429 with no upstream call made. A request that
    // starts under the cap is never stopped mid-flight.
    const gate = await startCreatorFinderDiscovery({
      supabase: getCreatorFinderSupabase(),
      userId: session.userId,
      role: session.role,
    });
    if (gate.blocked) return creatorFinderDailyLimitResponse();
    const result = await fetchSimilarCreators(username, {
      apiKeys: getCreatorFinderKeys(),
      onUpstreamCall: gate.onUpstreamCall,
    });
    // Countik enrichment, awaited before responding or saving:
    // a search shows NO cards until every creator's enrichment
    // is back (wait-for-all), and Saved stores the enriched data
    // as it was at search time. Per-creator Countik failures are
    // isolated inside enrichCreators and never fail the search.
    const enrichedCreators = await enrichCreators(result.creators);
    const enrichedResult = { ...result, creators: enrichedCreators };
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
          enrichedResult.creators,
          'similar',
          searchTerm,
        ));
      }
    } catch {
      saveFailed = true;
    }
    return NextResponse.json(
      SimilarResponseSchema.parse({ ...enrichedResult, saveFailed }),
    );
  } catch (err) {
    return (
      creatorFinderUsageErrorResponse(err) ?? creatorFinderErrorResponse(err)
    );
  }
}
