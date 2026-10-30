import { type NextRequest, NextResponse } from 'next/server';
import {
  CreatorFinderError,
  getSessionSecret,
  parseCreatorFinderKeys,
  verifySessionToken,
  canAccessTenant,
} from '@fbuploadpro/contracts';

/** Session check matching the other tenant API routes. */
export async function requireTenantSession(
  request: NextRequest,
  subdomain: string,
): Promise<NextResponse | null> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessTenant(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

/** Keys are server-side env only; never sent to the browser. */
export function getCreatorFinderKeys(): string[] {
  return parseCreatorFinderKeys(
    process.env.TIKWMAPI_KEYS,
    process.env.TIKWMAPI_KEY,
  );
}

export function creatorFinderErrorResponse(err: unknown): NextResponse {
  if (err instanceof CreatorFinderError) {
    const status =
      err.code === 'NO_KEYS_CONFIGURED'
        ? 503
        : err.code === 'NOT_FOUND'
          ? 404
          : err.code === 'RATE_LIMITED' || err.code === 'QUOTA_EXHAUSTED'
            ? 429
            : 502;
    const message =
      err.code === 'NO_KEYS_CONFIGURED'
        ? 'Creator search is not available yet — no TikTok data key is set up for this workspace.'
        : err.message;
    return NextResponse.json({ error: err.code, message }, { status });
  }
  return NextResponse.json(
    {
      error: 'FEED_UNAVAILABLE',
      message: 'Creator search could not be completed. Please try again.',
    },
    { status: 502 },
  );
}
