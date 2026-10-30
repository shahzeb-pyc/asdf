import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchCreatorsByHashtag,
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
  const hashtag = request.nextUrl.searchParams.get('hashtag');
  if (!hashtag?.trim()) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a hashtag or word to search.' },
      { status: 400 },
    );
  }
  const word = request.nextUrl.searchParams.get('word');
  try {
    const result = await fetchCreatorsByHashtag(hashtag, word, {
      apiKeys: getCreatorFinderKeys(),
    });
    return NextResponse.json(NicheResponseSchema.parse(result));
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
