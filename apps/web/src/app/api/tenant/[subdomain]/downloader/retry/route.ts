import { type NextRequest, NextResponse } from 'next/server';
import { handleRetryDownloadJob } from '../route';

/** POST …/downloader/retry — requeue one failed job (spec 149). */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleRetryDownloadJob(request, subdomain);
}
