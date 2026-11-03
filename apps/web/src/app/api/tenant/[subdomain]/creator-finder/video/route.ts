import { type NextRequest, NextResponse } from 'next/server';
import {
  checkCountikVideo,
  CountikError,
  VideoCheckRequestSchema,
  VideoCheckResponseSchema,
} from '@fbuploadpro/contracts';
import {
  getCreatorFinderSession,
} from '../lib';

/**
 * Countik video check, server-side only: POST video/exist with
 * the URL, then GET videoinfo for the returned id. The result
 * carries videoinfo's direct download_link — the page renders it
 * as a direct link, never a server proxy. Video checks are never
 * saved to Saved. Loud failure: a Countik error returns 502 with
 * the API's reason when it gave one, never a silent empty result.
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
  const parsed = VideoCheckRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Enter a TikTok video link to check.' },
      { status: 400 },
    );
  }
  try {
    const result = await checkCountikVideo(parsed.data.url);
    return NextResponse.json(VideoCheckResponseSchema.parse(result));
  } catch (err) {
    if (err instanceof CountikError) {
      return NextResponse.json(
        { error: 'VIDEO_UNAVAILABLE', message: err.message },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: 'VIDEO_UNAVAILABLE',
        message: 'That video could not be checked. Please try again.',
      },
      { status: 502 },
    );
  }
}
