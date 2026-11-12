import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchTrendingCreators,
  TrendingResponseSchema,
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
  const region = request.nextUrl.searchParams.get('region');
  if (!region) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Pick a country first.' },
      { status: 400 },
    );
  }
  try {
    // Daily cap, checked at request start: at the limit this
    // returns 429 with no upstream call made. A request that
    // starts under the cap is never stopped mid-flight, even if
    // its calls push the count past the cap.
    const gate = await startCreatorFinderDiscovery({
      supabase: getCreatorFinderSupabase(),
      userId: session.userId,
      role: session.role,
    });
    if (gate.blocked) return creatorFinderDailyLimitResponse();
    timing.split('gate');
    const result = await fetchTrendingCreators(region, {
      apiKeys: getCreatorFinderKeys(),
      onUpstreamCall: gate.onUpstreamCall,
    });
    timing.split('tikwm');
    // Return-first (spec 169): the response carries the TikWM
    // creators immediately, unenriched. The page POSTs them to
    // /creator-finder/enrich, which enriches and saves them —
    // a slow Countik lookup no longer holds a whole search.
    return NextResponse.json(TrendingResponseSchema.parse(result), {
      headers: { 'Server-Timing': timing.header() },
    });
  } catch (err) {
    return (
      creatorFinderUsageErrorResponse(err) ?? creatorFinderErrorResponse(err)
    );
  }
}
