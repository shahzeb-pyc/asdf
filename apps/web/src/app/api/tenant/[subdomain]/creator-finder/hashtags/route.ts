import { type NextRequest, NextResponse } from 'next/server';
import {
  CountikError,
  generateCountikHashtags,
  HashtagGenerateRequestSchema,
  HashtagGenerateResponseSchema,
} from '@fbuploadpro/contracts';
import {
  getCreatorFinderSession,
} from '../lib';

/**
 * Countik hashtag generation, server-side only: POST
 * generateHashtags with the keyword (POST-only; GET returns
 * 405). Generations are never saved to Saved. Loud failure: a
 * Countik error returns 502 with the API's reason when it gave
 * one, never a silent empty result.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const { errorResponse } = await getCreatorFinderSession(request, subdomain);
  if (errorResponse) return errorResponse;
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = HashtagGenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a keyword to generate hashtags.' },
      { status: 400 },
    );
  }
  try {
    const result = await generateCountikHashtags(parsed.data.query);
    return NextResponse.json(HashtagGenerateResponseSchema.parse(result));
  } catch (err) {
    if (err instanceof CountikError) {
      return NextResponse.json(
        { error: 'HASHTAGS_UNAVAILABLE', message: err.message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: 'HASHTAGS_UNAVAILABLE',
        message: 'Hashtags could not be generated. Please try again.',
      },
      { status: 502 },
    );
  }
}
