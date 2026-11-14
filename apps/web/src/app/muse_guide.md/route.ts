import { NextRequest, NextResponse } from 'next/server';
import { resolveBrandFromHost } from '@fbuploadpro/contracts';
import { buildMuseGuide } from '@/lib/muse-guide';

/**
 * Muse guide — served as plain markdown at /muse_guide.md
 * on the app host. This is a reference
 * for Muse to read in full, then use to guide the user step by
 * step. It is not a user tutorial page.
 *
 * The text lives in `@/lib/muse-guide` and is brand-aware: the
 * white-label brand gets the same guide with its own name and
 * guide address, and the billing parts replaced (there is no
 * billing section on that brand).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const brand = resolveBrandFromHost(request.headers.get('host'));
  return new NextResponse(buildMuseGuide(brand), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
