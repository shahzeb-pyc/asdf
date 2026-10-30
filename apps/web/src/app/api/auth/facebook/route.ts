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
    const sessionCookie = request.cookies.get('fbup_session')?.value;
    if (!sessionCookie) {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    }

    let session;
    try {
      session = await verifySessionToken(sessionCookie, sessionSecret);
    } catch (_e) {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    }

    // Audit S1: live session validation — a suspended user or a
    // session issued before a password change cannot start a
    // connect flow, same as an unverifiable session.
    const { validateSessionActive } = await import('@/lib/auth/session');
    if (!(await validateSessionActive(session))) {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
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
    const expectedFbAccountId =
      request.nextUrl.searchParams.get('expectedFbAccountId')?.trim() || undefined;
    const expectedDisplayName =
      request.nextUrl.searchParams.get('expectedDisplayName')?.trim() || undefined;
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
  return handleInitiateFacebookOAuth(request);
}
