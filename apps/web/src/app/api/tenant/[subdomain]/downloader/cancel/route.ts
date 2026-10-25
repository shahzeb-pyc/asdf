import { type NextRequest, NextResponse } from 'next/server';
import { handleCancelDownloadJob } from '../route';

/** POST …/downloader/cancel — cancel one open job (spec 149). */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleCancelDownloadJob(request, subdomain);
}
