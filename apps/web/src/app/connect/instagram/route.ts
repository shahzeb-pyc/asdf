import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUriForCallback,
  getSessionSecret,
  signOAuthState,
  verifyMagicLinkToken,
  INSTAGRAM_OAUTH_SCOPES,
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';
import { INSTAGRAM_AUTHORIZE_URL } from '@/lib/connect/platforms/instagram';

/**
 * Instagram magic-link forwarder — Facebook's `/connect/facebook`
 * route, mirrored for Instagram. Verifies the 15-minute magic token,
 * resolves the workspace's Instagram App ID (BYOC only, no env
 * fallback), signs an OAuth state flagged `isMagic: true`, and
 * redirects to the Instagram-Login authorize dialog.
 *
 * Error pages live on the app host (this route itself is app-hosted:
 * the magic URL is built from `NEXT_PUBLIC_APP_URL`), so the error
 * redirects below never inherit a tenant host.
 */
export async function handleConnectInstagram(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const appUrlFallback =
    process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    const errorUrl = new URL('/connect/instagram/error', request.url);
    errorUrl.searchParams.set('reason', 'missing_token');
    return NextResponse.redirect(errorUrl);
  }

  // 1. Verify 15-minute magic token (reusable within its window).
  let payload;
  try {
    payload = await verifyMagicLinkToken(token, sessionSecret);
  } catch (_e) {
    const errorUrl = new URL('/connect/instagram/error', request.url);
    errorUrl.searchParams.set('reason', 'expired_or_invalid');
    return NextResponse.redirect(errorUrl);
  }

  // 2. Resolve App ID: check workspace BYOC credentials strictly without env fallback
  const client = dbClient || getSupabaseAdminClient();
  const workspaceId = await resolveTenantWorkspaceId(
    client,
    payload.tenantSubdomain,
    payload.userId
  );
  const credentials =
    workspaceId == null
      ? null
      : await resolvePlatformClientCredentials(client, workspaceId, 'instagram');

  if (!credentials) {
    const errorUrl = new URL('/connect/instagram/error', request.url);
    errorUrl.searchParams.set('reason', 'app_not_configured');
    return NextResponse.redirect(errorUrl);
  }

  const effectiveAppId = credentials.clientId;
  const redirectUri = buildSubdomainOAuthRedirectUriForCallback(
    payload.tenantSubdomain,
    '/api/auth/instagram/callback',
    request.url,
    rootDomain,
    appUrlFallback
  );

  // 3. Generate signed OAuth state flagged with isMagic: true
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const state = await signOAuthState(
    {
      tenantSubdomain: payload.tenantSubdomain,
      userId: payload.userId,
      nonce,
      iat: now,
      exp: now + 600, // 10 minutes
      isMagic: true,
      redirectUri,
      ...(payload.expectedInstagramAccountId
        ? { expectedInstagramAccountId: payload.expectedInstagramAccountId }
        : {}),
      ...(payload.expectedDisplayName
        ? { expectedDisplayName: payload.expectedDisplayName }
        : {}),
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
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleConnectInstagram(request);
}
