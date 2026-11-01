import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUriForCallback,
  getSessionSecret,
  signOAuthState,
  verifySessionToken,
  INSTAGRAM_OAUTH_SCOPES,
} from '@fbuploadpro/contracts';
import { sanitizeAuthErrorMessage } from '@/lib/auth-errors';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';
import { INSTAGRAM_AUTHORIZE_URL } from '@/lib/connect/platforms/instagram';

/**
 * Direct Instagram OAuth initiate — Facebook's `/api/auth/facebook`
 * route, mirrored for Instagram. Session-gated (unlike the magic
 * forwarder): the signed-in user's workspace BYOC Instagram App ID is
 * resolved, a signed OAuth state is minted (not magic), and the user
 * is sent to the Instagram-Login authorize dialog.
 *
 * This is the direct view of the Instagram connect modal (Facebook's
 * modal direct view goes to `/api/auth/facebook` the same way). It is
 * the ONLY Instagram connect entry: the old framework Instagram flow
 * was removed (2026-11-02) — the framework initiate/callback resolve
 * no Instagram config, and the Instagram complete route was deleted.
 */
export async function handleInitiateInstagramOAuth(
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

    // 2. Resolve workspace BYOC Instagram credentials
    const client = dbClient || getSupabaseAdminClient();
    const workspaceId = await resolveTenantWorkspaceId(
      client,
      session.subdomain,
      session.userId,
      session.role
    );
    const credentials =
      workspaceId == null
        ? null
        : await resolvePlatformClientCredentials(client, workspaceId, 'instagram');

    if (!credentials) {
      const settingsUrl = new URL(
        `/tenant/${session.subdomain}/settings`,
        request.url
      );
      settingsUrl.searchParams.set('tab', 'instagram');
      settingsUrl.searchParams.set('error', 'credentials_required');
      return NextResponse.redirect(settingsUrl);
    }

    const effectiveAppId = credentials.clientId;
    const redirectUri = buildSubdomainOAuthRedirectUriForCallback(
      session.subdomain,
      '/api/auth/instagram/callback',
      request.url,
      rootDomain,
      appUrlFallback
    );

    // 3. Generate signed OAuth state
    const expectedInstagramAccountId =
      request.nextUrl.searchParams.get('expectedInstagramAccountId')?.trim() ||
      undefined;
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
        ...(expectedInstagramAccountId ? { expectedInstagramAccountId } : {}),
        ...(expectedDisplayName ? { expectedDisplayName } : {}),
      },
      sessionSecret
    );

    // 4. Construct the Instagram-Login OAuth dialog URL (Instagram-Login
    // ONLY — never the Facebook-Login dialog, spec 124 D2).
    const oauthUrl = new URL(INSTAGRAM_AUTHORIZE_URL);
    oauthUrl.searchParams.set('client_id', effectiveAppId);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('state', state);
    oauthUrl.searchParams.set('scope', [...INSTAGRAM_OAUTH_SCOPES].join(' '));
    oauthUrl.searchParams.set('response_type', 'code');

    return NextResponse.redirect(oauthUrl.toString());
  } catch (err) {
    const safeError = sanitizeAuthErrorMessage(err);
    console.error('[handleInitiateInstagramOAuth] Initialization error:', safeError);
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
  return handleInitiateInstagramOAuth(request);
}
