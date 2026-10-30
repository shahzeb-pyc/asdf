import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  verifyMagicLinkToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
// Side effect: registers the Threads connect config (spec 124).
import '@/lib/connect/platforms/threads';
import {
  getPlatformConnectConfig,
} from '@/lib/connect/registry';
import {
  buildConnectCallbackUrl,
  createConnectStatePayload,
  signConnectState,
} from '@/lib/connect/state';

/**
 * GET /connect/threads?token=… — the Threads magic-link entry,
 * following the Facebook pattern exactly
 * (`/connect/facebook?token=…` on main).
 *
 * No session cookie is minted here: the magic token itself carries
 * the tenant + user, and the browser that opens it deliberately
 * holds no `fbup_session`. The token is verified (15-minute
 * expiry), the workspace's Threads BYOC details are resolved, and
 * a signed connect state flagged `isMagic: true` (carrying the
 * expected account, when the link was generated for a reconnect)
 * is built before redirecting to the Threads authorize window.
 * The generic callback then persists the account and, for magic
 * flows, finishes on the public `/connect/threads/success` page —
 * the first device's modal polls the Threads list and confirms
 * there, exactly like Facebook's modal.
 */
export async function handleConnectThreads(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    const errorUrl = new URL('/connect/threads/error', request.url);
    errorUrl.searchParams.set('reason', 'missing_token');
    return NextResponse.redirect(errorUrl);
  }

  // 1. Verify 15-minute magic token
  let payload;
  try {
    payload = await verifyMagicLinkToken(token, sessionSecret);
  } catch (_e) {
    const errorUrl = new URL('/connect/threads/error', request.url);
    errorUrl.searchParams.set('reason', 'expired_or_invalid');
    return NextResponse.redirect(errorUrl);
  }

  // 2. Resolve workspace + Threads BYOC credentials strictly
  // without env fallback (Threads has its own app pair).
  const client = dbClient || getSupabaseAdminClient();
  const workspaceId = await resolveTenantWorkspaceId(
    client,
    payload.tenantSubdomain,
    payload.userId
  );
  if (!workspaceId) {
    const errorUrl = new URL('/connect/threads/error', request.url);
    errorUrl.searchParams.set('reason', 'expired_or_invalid');
    return NextResponse.redirect(errorUrl);
  }
  const credentials = await resolvePlatformClientCredentials(
    client,
    workspaceId,
    'threads'
  );
  if (!credentials) {
    const errorUrl = new URL('/connect/threads/error', request.url);
    errorUrl.searchParams.set('reason', 'app_not_configured');
    return NextResponse.redirect(errorUrl);
  }

  const config = getPlatformConnectConfig('threads');
  if (!config) {
    console.error('[connect/threads] No connect config registered for threads.');
    const errorUrl = new URL('/connect/threads/error', request.url);
    errorUrl.searchParams.set('reason', 'oauth_failed');
    return NextResponse.redirect(errorUrl);
  }

  // 3. Generate signed connect state flagged with isMagic: true,
  // carrying the expected account from the magic token when present.
  const statePayload = createConnectStatePayload({
    workspaceId,
    tenantSubdomain: payload.tenantSubdomain,
    userId: payload.userId,
    platform: 'threads',
    ...(payload.expectedExternalAccountId
      ? { expectedExternalAccountId: payload.expectedExternalAccountId }
      : {}),
    ...(payload.expectedDisplayName
      ? { expectedDisplayName: payload.expectedDisplayName }
      : {}),
    isMagic: true,
  });
  const state = await signConnectState(statePayload, sessionSecret);
  const redirectUri = buildConnectCallbackUrl(request.url, 'threads');

  // 4. Construct the Threads authorize URL (threads.com).
  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', credentials.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('response_type', 'code');
  if (config.scopes.length > 0) {
    authorizeUrl.searchParams.set('scope', config.scopes.join(' '));
  }

  return NextResponse.redirect(authorizeUrl.toString());
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleConnectThreads(request);
}
