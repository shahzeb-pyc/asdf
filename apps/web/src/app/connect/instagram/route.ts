import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUriForCallback,
  getSessionSecret,
  signOAuthState,
  verifyMagicLinkToken,
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';
import { buildInstagramUnifiedDialogUrl } from '@/lib/connect/platforms/instagram-unified';

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

  // Same triple gate as the direct initiate: no Configuration ID, no
  // dialog. A workspace with only an old Instagram Login pair must
  // complete its Unified Login details in Settings first.
  if (!credentials || !credentials.configId) {
    const errorUrl = new URL('/connect/instagram/error', request.url);
    errorUrl.searchParams.set('reason', 'app_not_configured');
    return NextResponse.redirect(errorUrl);
  }

  const effectiveAppId = credentials.clientId;
  const effectiveConfigId = credentials.configId;
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

  // 4. Construct the Unified Login dialog URL (same dialog and triple
  // gate as the direct initiate; the configuration owns the set, so
  // no `scope` parameter is sent).
  const oauthUrl = buildInstagramUnifiedDialogUrl({
    appId: effectiveAppId,
    configId: effectiveConfigId,
    redirectUri,
    state,
  });

  return NextResponse.redirect(oauthUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleConnectInstagram(request);
}
