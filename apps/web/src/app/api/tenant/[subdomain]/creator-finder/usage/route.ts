import { type NextRequest, NextResponse } from 'next/server';
import {
  CREATOR_FINDER_DAILY_LIMIT,
  CreatorFinderUsageResponseSchema,
} from '@fbuploadpro/contracts';
import {
  CreatorFinderUsageError,
  creatorFinderUsageErrorResponse,
  getCreatorFinderUsageCount,
  getCreatorFinderUsageDate,
} from '@/lib/creator-finder-usage';
import { getCreatorFinderSession, getCreatorFinderSupabase } from '../lib';

/**
 * Today's Creator Finder usage for the calling user. This
 * endpoint itself is never counted and never gated: it makes
 * no upstream call, and blocking it at the cap would hide the
 * very number that explains the block. Admins bypass the cap,
 * so they always report 0 without touching the counter.
 */
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
  const date = getCreatorFinderUsageDate();
  if (session.role === 'admin') {
    return NextResponse.json(
      CreatorFinderUsageResponseSchema.parse({
        used: 0,
        limit: CREATOR_FINDER_DAILY_LIMIT,
        date,
      }),
    );
  }
  try {
    const supabase = getCreatorFinderSupabase();
    if (!supabase) {
      throw new CreatorFinderUsageError(
        'Creator search is not available right now. Please try again.',
      );
    }
    const used = await getCreatorFinderUsageCount(
      supabase,
      session.userId,
      date,
    );
    return NextResponse.json(
      CreatorFinderUsageResponseSchema.parse({
        used,
        limit: CREATOR_FINDER_DAILY_LIMIT,
        date,
      }),
    );
  } catch (err) {
    return (
      creatorFinderUsageErrorResponse(err) ??
      NextResponse.json(
        {
          error: 'USAGE_UNAVAILABLE',
          message:
            'Creator search usage could not be checked. Please try again.',
        },
        { status: 503 },
      )
    );
  }
}
