import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUri,
  getSessionSecret,
  signOAuthState,
  verifyMagicLinkToken,
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveWorkspaceFacebookCredentials } from '@/lib/server/byoc-resolver';

export async function handleConnectFacebook(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const appUrlFallback =
    process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    const errorUrl = new URL('/connect/facebook/error', request.url);
    errorUrl.searchParams.set('reason', 'missing_token');
    return NextResponse.redirect(errorUrl);
  }

  // 1. Verify 15-minute magic token
  let payload;
  try {
    payload = await verifyMagicLinkToken(token, sessionSecret);
  } catch (_e) {
    const errorUrl = new URL('/connect/facebook/error', request.url);
    errorUrl.searchParams.set('reason', 'expired_or_invalid');
    return NextResponse.redirect(errorUrl);
  }

  // 2. Resolve App ID: check workspace BYOC credentials strictly without env fallback
  const client = dbClient || getSupabaseAdminClient();
  const byocResult = await resolveWorkspaceFacebookCredentials(
    client,
    payload.tenantSubdomain,
    payload.userId
  );

  if (!byocResult.ok) {
    const errorUrl = new URL('/connect/facebook/error', request.url);
    errorUrl.searchParams.set('reason', 'app_not_configured');
    return NextResponse.redirect(errorUrl);
  }

  const effectiveAppId = byocResult.fbAppId;
  const redirectUri = buildSubdomainOAuthRedirectUri(
    payload.tenantSubdomain,
    request.url,
    rootDomain,
    appUrlFallback
  );

  // 3. Generate signed OAuth state flagged with isMagic: true.
  // Audit BG12 — window composition rule: the magic window
  // bounds the flow end-to-end. The OAuth state for a magic
  // flow never outlives the magic token that admitted it, so a
  // user who enters at minute 14 does NOT get a fresh 10
  // minutes (no ~25-minute composition). Direct flows keep
  // their own 10-minute state (see /api/auth/facebook).
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const state = await signOAuthState(
    {
      tenantSubdomain: payload.tenantSubdomain,
      userId: payload.userId,
      nonce,
      iat: now,
      exp: Math.min(now + 600, payload.exp),
      isMagic: true,
      redirectUri,
      ...(payload.expectedFbAccountId
        ? { expectedFbAccountId: payload.expectedFbAccountId }
        : {}),
      ...(payload.expectedDisplayName
        ? { expectedDisplayName: payload.expectedDisplayName }
        : {}),
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
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleConnectFacebook(request);
}
