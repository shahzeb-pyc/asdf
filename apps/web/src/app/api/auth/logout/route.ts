import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { clearSessionCookiesBestEffort } from '@/lib/auth/session';
import { buildCentralAppUrl } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';

/**
 * Logout (session-global-check spec §7).
 *
 * Sign-out must clear the session properly and fully. The session
 * cookie is HttpOnly, so client JS cannot clear it — the server
 * clear below is the one that matters. Two past failure modes are
 * closed here:
 *
 * 1. The old POST called the throwing domain resolver inside its
 *    try block: on a production host the resolver did not cover,
 *    it answered 500 with NO cookie cleared, leaving the user
 *    "signed out" in the UI while the session cookie survived.
 *    The clear below never throws and the route never 500s on
 *    domain resolution.
 * 2. A clear only deletes a cookie whose Domain/Path match, and a
 *    login could have left either a shared-domain or a host-only
 *    copy. `clearSessionCookiesBestEffort` emits every variant
 *    (host-only, shared-domain, exact-host), so no copy survives
 *    on the logout host.
 *
 * POST answers 200 `{ success, redirectUrl }` whenever the clears
 * were attempted (the central-gateway redirect URL shape is
 * unchanged). GET performs the same clears and 307-redirects to
 * the central login URL: it is the degraded-network landing pad —
 * when the POST fails, clients navigate here (same host, so the
 * host-only copy dies too) instead of straight to `/login`, where
 * middleware would see the surviving cookie and bounce the user
 * back home still logged in.
 */

function buildLogoutRedirectUrl(request: NextRequest | undefined): string {
  try {
    const host = request?.headers.get('host');
    const requestUrl = request?.url || (host ? `https://${host}` : undefined);
    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
    return buildCentralAppUrl('/login?logout=success', requestUrl, rootDomain).toString();
  } catch {
    return '/login?logout=success';
  }
}

async function signOutSupabaseBestEffort(): Promise<void> {
  try {
    const supabase = getSupabaseAdminClient();
    if (supabase) {
      await supabase.auth.signOut().catch(() => {});
    }
  } catch {
    // Supabase sign-out is best-effort; the cookie clears below
    // are what actually end the app session.
  }
}

export async function POST(request?: NextRequest) {
  // The clears must run even if anything else in this handler
  // fails: build the response first, clear into it, then fill in
  // the redirect. Nothing in this path throws to a 500.
  const response = NextResponse.json(
    {
      success: true,
      redirectUrl: buildLogoutRedirectUrl(request),
    },
    { status: 200 }
  );
  try {
    await signOutSupabaseBestEffort();
  } catch (error: unknown) {
    logServerError('[auth/logout] Supabase sign-out failed', error, { source: 'auth-logout' });
  }
  try {
    clearSessionCookiesBestEffort(response, request?.headers.get('host'));
  } catch (error: unknown) {
    // The helper itself never throws; this is a belt-and-braces
    // guard so a header failure can never turn logout into a 500.
    logServerError('[auth/logout] Cookie clear failed', error, { source: 'auth-logout' });
  }
  return response;
}

export async function GET(request: NextRequest) {
  const redirectUrl = buildLogoutRedirectUrl(request);
  const response = NextResponse.redirect(redirectUrl, 307);
  try {
    await signOutSupabaseBestEffort();
  } catch (error: unknown) {
    logServerError('[auth/logout] Supabase sign-out failed', error, { source: 'auth-logout' });
  }
  try {
    clearSessionCookiesBestEffort(response, request.headers.get('host'));
  } catch (error: unknown) {
    logServerError('[auth/logout] Cookie clear failed', error, { source: 'auth-logout' });
  }
  return response;
}
