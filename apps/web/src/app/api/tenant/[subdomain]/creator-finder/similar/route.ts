import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchSimilarCreators,
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
  startServerTiming,
} from '../lib';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const timing = startServerTiming();
  const { session, errorResponse } = await getCreatorFinderSession(
    request,
    subdomain,
  );
  if (errorResponse) return errorResponse;
  timing.split('session');
  const username = request.nextUrl.searchParams.get('username');
  if (!username?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a TikTok username.' },
      { status: 400 },
    );
  }
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
    timing.split('gate');
    const result = await fetchSimilarCreators(username, {
      apiKeys: getCreatorFinderKeys(),
      onUpstreamCall: gate.onUpstreamCall,
    });
    timing.split('tikwm');
    // Return-first (spec 169): the response carries the TikWM
    // creators immediately, unenriched. The page POSTs them to
    // /creator-finder/enrich, which enriches and saves them —
    // a slow Countik lookup no longer holds a whole search.
    return NextResponse.json(SimilarResponseSchema.parse(result), {
      headers: { 'Server-Timing': timing.header() },
    });
  } catch (err) {
    return (
      creatorFinderUsageErrorResponse(err) ?? creatorFinderErrorResponse(err)
    );
  }
}
