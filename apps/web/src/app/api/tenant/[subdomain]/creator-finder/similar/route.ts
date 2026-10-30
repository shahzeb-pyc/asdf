import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchSimilarCreators,
  SimilarResponseSchema,
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
  const username = request.nextUrl.searchParams.get('username');
  if (!username?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a TikTok username.' },
      { status: 400 },
    );
  }
  try {
    const result = await fetchSimilarCreators(username, {
      apiKeys: getCreatorFinderKeys(),
    });
    return NextResponse.json(SimilarResponseSchema.parse(result));
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
