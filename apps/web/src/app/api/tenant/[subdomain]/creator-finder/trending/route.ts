import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchTrendingCreators,
  TrendingResponseSchema,
} from '@fbuploadpro/contracts';
import {
  creatorFinderErrorResponse,
  getCreatorFinderKeys,
  requireTenantSession,
} from '../lib';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const authError = await requireTenantSession(request, subdomain);
  if (authError) return authError;
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
    return NextResponse.json(TrendingResponseSchema.parse(result));
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
