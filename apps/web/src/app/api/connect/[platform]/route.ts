import { type NextRequest, NextResponse } from 'next/server';
import {
  buildPlatformAccountsUrl,
  buildTenantUrl,
  getSessionSecret,
} from '@fbuploadpro/contracts';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { enforceIpRateLimit } from '@/lib/request-body';
// Side effect: registers the X connect config (spec 127).
import '@/lib/connect/platforms/x';
// Side effect: registers the Instagram + Threads connect configs (spec 124).
import '@/lib/connect/platforms/instagram';
import '@/lib/connect/platforms/threads';
import {
  getPlatformConnectConfig,
  isByocPlatform,
  isKnownPlatform,
  type Platform,
  type PlatformConnectConfig,
} from '@/lib/connect/registry';
import {
  buildConnectCallbackUrl,
  createConnectStatePayload,
  generatePkcePair,
  signConnectState,
  signPkceCookie,
  CONNECT_STATE_TTL_SECONDS,
  PKCE_COOKIE_NAME,
} from '@/lib/connect/state';
import {
  resolvePlatformClientCredentials,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import {
  extractConnectSession,
  resolveConnectDbClient,
  sessionCanAccessTenant,
} from '@/lib/connect/session';
// Registers the YouTube connect config (spec 125) into the framework registry.
import '@/lib/connect/platforms/youtube';
// Registers the TikTok connect config (spec 126) into the framework registry.
import '@/lib/connect/tiktok';

const CONNECT_FAILED = 'connect_failed';

type ClientIdResolution =
  | { clientId: string }
  | { redirect: NextResponse };

interface ResolveInitiateClientIdArgs {
  client: ConnectDbClient;
  config: PlatformConnectConfig;
  platform: Platform;
  workspaceId: string;
  request: NextRequest;
  subdomain: string;
  rootDomain: string;
  accountsUrl: URL;
}

/**
 * Resolves the client ID for a connect attempt: platform override, then
 * the workspace's own app details (BYOC), then our global app (env). A
 * BYOC workspace without saved details is sent to Settings first.
 */
async function resolveInitiateClientId(
  args: ResolveInitiateClientIdArgs
): Promise<ClientIdResolution> {
  const {
    client,
    config,
    platform,
    workspaceId,
    request,
    subdomain,
    rootDomain,
    accountsUrl,
  } = args;
  let clientId: string | null = null;
  if (config.resolveClientId) {
    clientId = await config.resolveClientId({ workspaceId });
  } else if (config.clientIdSource === 'byoc') {
    const credentials = await resolvePlatformClientCredentials(
      client,
      workspaceId,
      platform
    );
    clientId = credentials?.clientId ?? null;
    if (!clientId && isByocPlatform(platform)) {
      const settingsUrl = buildTenantUrl(
        subdomain,
        '/settings',
        request.url,
        rootDomain
      );
      settingsUrl.searchParams.set('tab', platform);
      settingsUrl.searchParams.set('error', 'credentials_required');
      return { redirect: NextResponse.redirect(settingsUrl) };
    }
  } else {
    const envName =
      config.globalClientIdEnv ?? `CONNECT_${platform.toUpperCase()}_CLIENT_ID`;
    clientId = process.env[envName] ?? null;
  }

  if (!clientId) {
    console.error(
      `[connect] No client ID available for platform "${platform}" in workspace ${workspaceId}.`
    );
    accountsUrl.searchParams.set('error', CONNECT_FAILED);
    return { redirect: NextResponse.redirect(accountsUrl) };
  }
  return { clientId };
}

/**
 * GET /api/connect/[platform] — starts a platform connect flow.
 *
 * Resolves the signed-in user's workspace, builds the platform's authorize
 * URL from the registered connect config (signed state, plus PKCE when the
 * config asks for it), and redirects the user to the platform.
 */
export async function handleConnectInitiate(
  request: NextRequest,
  platformParam: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';

  const session = await extractConnectSession(request);
  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const subdomain =
    request.nextUrl.searchParams.get('subdomain')?.trim() ||
    session.subdomain;
  if (!sessionCanAccessTenant(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Per-platform Accounts landing page (facebook → `/accounts`,
  // instagram → `/instagram/accounts`, …). Unknown platforms fall back
  // to `/accounts`, as before — this URL is only used for error
  // redirects when the platform is unknown or has no client id.
  const accountsUrl = buildPlatformAccountsUrl(
    subdomain,
    platformParam,
    request.url,
    rootDomain
  );

  if (!isKnownPlatform(platformParam)) {
    accountsUrl.searchParams.set('error', CONNECT_FAILED);
    return NextResponse.redirect(accountsUrl);
  }
  const platform = platformParam;

  const config = getPlatformConnectConfig(platform);
  if (!config) {
    console.error(
      `[connect] No connect config registered for platform "${platform}".`
    );
    accountsUrl.searchParams.set('error', CONNECT_FAILED);
    return NextResponse.redirect(accountsUrl);
  }

  const client = resolveConnectDbClient(dbClient);
  if (!client) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 503 }
    );
  }

  const workspaceId = await resolveTenantWorkspaceId(
    client,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'Workspace not found' },
      { status: 404 }
    );
  }

  const resolution = await resolveInitiateClientId({
    client,
    config,
    platform,
    workspaceId,
    request,
    subdomain,
    rootDomain,
    accountsUrl,
  });
  if ('redirect' in resolution) {
    return resolution.redirect;
  }
  const clientId = resolution.clientId;

  const sessionSecret = getSessionSecret();
  // Expected-account hint for a targeted reconnect: the modal (or a
  // magic link) carries the account the user means to reconnect, so
  // the callback can warn when a different account signs in instead
  // of silently succeeding. Only Threads sends these today; any
  // other platform's flow is unchanged (no fields in the state).
  // Blank or over-long values are dropped, never trusted.
  const expectedExternalAccountId =
    request.nextUrl.searchParams.get('expectedExternalAccountId')?.trim() ||
    undefined;
  const expectedDisplayName =
    request.nextUrl.searchParams.get('expectedDisplayName')?.trim() ||
    undefined;
  const statePayload = createConnectStatePayload({
    workspaceId,
    tenantSubdomain: subdomain,
    userId: session.userId,
    platform,
    ...(expectedExternalAccountId &&
    expectedExternalAccountId.length <= 255
      ? { expectedExternalAccountId }
      : {}),
    ...(expectedDisplayName && expectedDisplayName.length <= 255
      ? { expectedDisplayName }
      : {}),
  });
  const state = await signConnectState(statePayload, sessionSecret);
  const redirectUri = buildConnectCallbackUrl(request.url, platform);

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('response_type', 'code');
  if (config.scopes.length > 0) {
    authorizeUrl.searchParams.set('scope', config.scopes.join(' '));
  }

  let pkceCookieValue: string | null = null;
  if (config.usePkce) {
    const { verifier, challenge } = await generatePkcePair();
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    pkceCookieValue = await signPkceCookie(
      {
        nonce: statePayload.nonce,
        platform,
        codeVerifier: verifier,
        exp: statePayload.iat + CONNECT_STATE_TTL_SECONDS,
      },
      sessionSecret
    );
  }

  if (config.extraAuthorizeParams) {
    for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
      authorizeUrl.searchParams.set(key, value);
    }
  }

  const response = NextResponse.redirect(authorizeUrl.toString());
  if (pkceCookieValue) {
    response.cookies.set(PKCE_COOKIE_NAME, pkceCookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/connect',
      maxAge: CONNECT_STATE_TTL_SECONDS,
    });
  }
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await context.params;
  const limited = await enforceIpRateLimit(request, 'connect_initiate', 20);
  if (limited) return limited;
  return handleConnectInitiate(request, platform);
}
