import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUri,
  getSessionSecret,
  signOAuthState,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveWorkspaceFacebookCredentials } from '@/lib/server/byoc-resolver';

export async function handleInitiateFacebookOAuth(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const appUrlFallback =
    process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    // Audit BG14: a session lost before the flow starts must
    // keep a return path. The old code sent every session
    // failure to bare /login, dropping both the explanation
    // and the destination. Now: reason=session-expired always
    // (the login page renders that notice), and next=<tenant
    // accounts path> whenever the tenant is known (a parsed
    // session, including an inactive one). With no cookie or
    // an unverifiable cookie the tenant is unknowable, so no
    // next is sent — the login page defaults sensibly.
    const sessionLossRedirect = (subdomain?: string) => {
      const loginUrl = new URL('/login', request.url);
      if (subdomain) {
        loginUrl.searchParams.set('next', `/tenant/${subdomain}/accounts`);
      }
      loginUrl.searchParams.set('reason', 'session-expired');
      return NextResponse.redirect(loginUrl);
    };
    const sessionCookie = request.cookies.get('fbup_session')?.value;
    if (!sessionCookie) {
      return sessionLossRedirect();
    }

    let session;
    try {
      session = await verifySessionToken(sessionCookie, sessionSecret);
    } catch (_e) {
      return sessionLossRedirect();
    }

    // Audit S1: live session validation — a suspended user or a
    // session issued before a password change cannot start a
    // connect flow, same as an unverifiable session.
    const { validateSessionActive } = await import('@/lib/auth/session');
    if (!(await validateSessionActive(session))) {
      return sessionLossRedirect(session.subdomain);
    }

    // 2. Resolve workspace BYOC Facebook credentials
    const client = dbClient || getSupabaseAdminClient();
    const byocResult = await resolveWorkspaceFacebookCredentials(
      client,
      session.subdomain,
      session.userId
    );

    if (!byocResult.ok) {
      const settingsUrl = new URL(`/tenant/${session.subdomain}/settings`, request.url);
      settingsUrl.searchParams.set('tab', 'byoc');
      settingsUrl.searchParams.set('error', 'credentials_required');
      return NextResponse.redirect(settingsUrl);
    }

    const effectiveAppId = byocResult.fbAppId;
    const redirectUri = buildSubdomainOAuthRedirectUri(
      session.subdomain,
      request.url,
      rootDomain,
      appUrlFallback
    );

    // 3. Generate signed OAuth state
    // Audit N5: query-param hints are bounded to the same 255
    // chars as the magic body before signing (the token schemas
    // now enforce it, so an unbounded hint would throw here).
    // Truncation is the safe direction: a >255 account id can
    // never be a real Facebook id, so the truncated value still
    // mismatches and warns; a truncated display name is cosmetic.
    const boundHint = (value: string | null): string | undefined => {
      const trimmed = value?.trim();
      return trimmed ? trimmed.slice(0, 255) : undefined;
    };
    const expectedFbAccountId = boundHint(
      request.nextUrl.searchParams.get('expectedFbAccountId')
    );
    const expectedDisplayName = boundHint(
      request.nextUrl.searchParams.get('expectedDisplayName')
    );
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const state = await signOAuthState(
      {
        tenantSubdomain: session.subdomain,
        userId: session.userId,
        nonce,
        iat: now,
        exp: now + 600, // 10 minutes
        redirectUri,
        ...(expectedFbAccountId ? { expectedFbAccountId } : {}),
        ...(expectedDisplayName ? { expectedDisplayName } : {}),
      },
      sessionSecret
    );

    // 4. Construct Facebook OAuth Dialog URL (Graph API v26.0)
    const scopes =
      'pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,business_management';
    const oauthUrl = new URL('https://www.facebook.com/v26.0/dialog/oauth');
    oauthUrl.searchParams.set('client_id', effectiveAppId);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('state', state);
    oauthUrl.searchParams.set('scope', scopes);
    oauthUrl.searchParams.set('response_type', 'code');

    return NextResponse.redirect(oauthUrl.toString());
  } catch (err) {
    const safeError = sanitizeAuthErrorMessage(err);
    console.error('[handleInitiateFacebookOAuth] Initialization error:', safeError);
    return NextResponse.json(
      {
        error: {
          code: 'OAUTH_INIT_FAILED',
          message: safeError,
        },
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Audit N9 (see also S6): the direct initiate was the last
  // unthrottled OAuth entry; 20/min like the connect initiate.
  const limited = await enforceIpRateLimit(request, 'auth_facebook_initiate', 20);
  if (limited) return limited;
  return handleInitiateFacebookOAuth(request);
}
