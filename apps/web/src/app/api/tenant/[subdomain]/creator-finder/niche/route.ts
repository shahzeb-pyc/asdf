import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchCreatorsByKeyword,
  NicheResponseSchema,
  NicheSearchFiltersQuerySchema,
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
  const keyword = request.nextUrl.searchParams.get('keyword');
  if (!keyword?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a niche or keyword to search.' },
      { status: 400 },
    );
  }
  // Optional filters only: invalid values fail loud, defaults send nothing.
  const filtersParsed = NicheSearchFiltersQuerySchema.safeParse({
    region: request.nextUrl.searchParams.get('region') ?? undefined,
    publish_time:
      request.nextUrl.searchParams.get('publish_time') ?? undefined,
    sort_type: request.nextUrl.searchParams.get('sort_type') ?? undefined,
  });
  if (!filtersParsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Niche filters are invalid.' },
      { status: 400 },
    );
  }
  const filters = filtersParsed.data;
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
    const result = await fetchCreatorsByKeyword(keyword, {
      apiKeys: getCreatorFinderKeys(),
      onUpstreamCall: gate.onUpstreamCall,
      filters: {
        region: filters.region,
        publishTime: filters.publish_time
          ? (Number(filters.publish_time) as 0 | 1 | 7 | 30 | 90 | 180)
          : undefined,
        sortType: filters.sort_type
          ? (Number(filters.sort_type) as 0 | 1 | 3)
          : undefined,
      },
    });
    timing.split('tikwm');
    // Return-first (spec 169): the response carries the TikWM
    // creators immediately, unenriched. The page POSTs them to
    // /creator-finder/enrich, which enriches and saves them —
    // a slow Countik lookup no longer holds a whole search.
    return NextResponse.json(NicheResponseSchema.parse(result), {
      headers: { 'Server-Timing': timing.header() },
    });
  } catch (err) {
    return (
      creatorFinderUsageErrorResponse(err) ?? creatorFinderErrorResponse(err)
    );
  }
}
