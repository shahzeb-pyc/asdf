import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchCreatorsByKeyword,
  NicheResponseSchema,
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
    return NextResponse.json(NicheResponseSchema.parse(result));
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
