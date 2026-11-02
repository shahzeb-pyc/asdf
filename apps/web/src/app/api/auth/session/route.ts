import { NextResponse, type NextRequest } from 'next/server';
import { getSessionSecret, verifySessionToken } from '@fbuploadpro/contracts';
import { validateSessionDetailed } from '@/lib/auth/session';

/**
 * Session-status endpoint (session-global-check spec §2.2): the
 * single database-backed session check, called by the app shell's
 * global session check on mount, every 5 minutes, and on window
 * focus. It is global (no subdomain) so one endpoint serves the
 * user, seller, and admin shells alike.
 *
 * Status contract — the whole point of this endpoint:
 * - 200 `{ active: true }`: session proven alive.
 * - 401: session proven dead (no cookie, bad/expired token,
 *   suspended claim, user genuinely absent, user not active, or
 *   password changed after login). Only this outcome bounces.
 * - 503: the user lookup itself failed (database error/timeout).
 *   Plain message, no internals, and NEVER a 401: a lookup failure
 *   must not look like an expired session.
 *
 * The response carries no user data — just the verdict — so there
 * is nothing sensitive to leak to an unauthenticated caller.
 */
export async function GET(request: NextRequest) {
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

  const verdict = await validateSessionDetailed(session);
  if (verdict === 'active') {
    return NextResponse.json({ active: true }, { status: 200 });
  }
  if (verdict === 'dead') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { error: 'Service temporarily unavailable. Please try again.' },
    { status: 503 }
  );
}
