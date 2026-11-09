import { NextResponse, type NextRequest } from 'next/server';
import { getSessionSecret, verifySessionToken } from '@fbuploadpro/contracts';
import { validateSessionDetailed } from '@/lib/auth/session';

/**
 * Session-status endpoint (session-global-check spec §2.2): the
 * single session check, called by the app shell's global session
 * check on mount, every 5 minutes, and on window focus. It is
 * global (no subdomain) so one endpoint serves the user, seller,
 * and admin shells alike.
 *
 * Two modes (spec 152 O4):
 * - `?mode=token` — token-only proof: signature + expiry (from
 *   `verifySessionToken`) + the status claim. No database lookup,
 *   so the mount/focus checks cost one cheap round trip, not a
 *   user-table read. A bad/expired token or a suspended claim
 *   still answers 401 and bounces, exactly like the full check.
 * - default (no mode) — the database-backed verdict: user lookup,
 *   password-change and deactivation detection. Runs on the
 *   5-minute interval only.
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

  // Spec 152 O4 — token-only proof: the status claim is part of
  // the signed token, so a suspended session is dead here without
  // any database read. Password-change / deactivation detection
  // stays on the full check (5-minute interval).
  if (request.nextUrl.searchParams.get('mode') === 'token') {
    if (session.status === 'active') {
      return NextResponse.json({ active: true }, { status: 200 });
    }
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
