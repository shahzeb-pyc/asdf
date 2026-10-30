import { type NextRequest, NextResponse } from 'next/server';
import {
  buildTenantUrl,
  getPlatformAccountsPath,
  getSessionSecret,
} from '@fbuploadpro/contracts';
// Side effect: registers the X connect config (spec 127).
import '@/lib/connect/platforms/x';
// Side effect: registers the Instagram + Threads connect configs (spec 124).
import '@/lib/connect/platforms/instagram';
import '@/lib/connect/platforms/threads';
import {
  getPlatformConnectConfig,
  isKnownPlatform,
  type Platform,
  type PlatformConnectConfig,
} from '@/lib/connect/registry';
import {
  buildConnectCallbackUrl,
  signPendingDestinations,
  verifyConnectState,
  verifyPkceCookie,
  CONNECT_PENDING_TTL_SECONDS,
  PENDING_COOKIE_NAME,
  PKCE_COOKIE_NAME,
  type ConnectStatePayload,
} from '@/lib/connect/state';
import {
  persistConnectedAccount,
  resolvePlatformClientCredentials,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import { resolveConnectDbClient } from '@/lib/connect/session';
import { mapProviderDenial, type ConnectNoticeCode } from '@/lib/connect/errors';
// Registers the YouTube connect config (spec 125) into the framework registry.
import '@/lib/connect/platforms/youtube';
// Registers the TikTok connect config (spec 126) into the framework registry.
import '@/lib/connect/tiktok';

/**
 * Reads the PKCE verifier for this flow from its signed cookie, matched to
 * the state nonce. Returns null when the cookie is absent, invalid, or
 * belongs to a different flow.
 */
async function resolvePkceVerifier(
  request: NextRequest,
  stateNonce: string,
  platform: string,
  sessionSecret: string
): Promise<string | null> {
  const pkceCookie = request.cookies.get(PKCE_COOKIE_NAME)?.value;
  if (!pkceCookie) return null;
  try {
    const pkcePayload = await verifyPkceCookie(pkceCookie, sessionSecret);
    if (pkcePayload.nonce === stateNonce && pkcePayload.platform === platform) {
      return pkcePayload.codeVerifier;
    }
  } catch (err) {
    console.error('[connect/callback] PKCE cookie invalid:', err);
  }
  return null;
}

/**
 * Resolves the client credentials for the code exchange: the workspace's
 * own app details for BYOC platforms, our global app otherwise. Returns
 * null when a BYOC workspace has no details saved.
 */
async function resolveExchangeCredentials(
  client: ConnectDbClient,
  config: PlatformConnectConfig,
  platform: string,
  workspaceId: string
): Promise<{ clientId: string; clientSecret: string | null } | null> {
  let clientId = '';
  if (config.resolveClientId) {
    clientId = (await config.resolveClientId({ workspaceId })) ?? '';
  }
  if (config.clientIdSource === 'byoc') {
    const credentials = await resolvePlatformClientCredentials(
      client,
      workspaceId,
      config.platform
    );
    if (!credentials) return null;
    return {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    };
  }
  if (!clientId) {
    const idEnv =
      config.globalClientIdEnv ?? `CONNECT_${platform.toUpperCase()}_CLIENT_ID`;
    const secretEnv =
      config.globalClientSecretEnv ??
      `CONNECT_${platform.toUpperCase()}_CLIENT_SECRET`;
    clientId = process.env[idEnv] ?? '';
    return { clientId, clientSecret: process.env[secretEnv] ?? null };
  }
  return { clientId, clientSecret: null };
}

type ExchangeOutcome =
  | { notice: ConnectNoticeCode }
  | {
      accountId: string;
      destinations: NonNullable<
        Awaited<ReturnType<PlatformConnectConfig['fetchDestinations']>>
      >;
    };

interface ExchangeArgs {
  client: ConnectDbClient;
  config: PlatformConnectConfig;
  platform: Platform;
  statePayload: ConnectStatePayload;
  code: string;
  redirectUri: string;
  codeVerifier: string | null;
  clientId: string;
  clientSecret: string | null;
}

/**
 * Runs the platform exchange, persists the account, and discovers its
 * destinations. Any failure becomes a plain-language notice code.
 */
async function exchangePersistAndDiscover(args: ExchangeArgs): Promise<ExchangeOutcome> {
  const {
    client,
    config,
    platform,
    statePayload,
    code,
    redirectUri,
    codeVerifier,
    clientId,
    clientSecret,
  } = args;
  let exchanged;
  try {
    exchanged = await config.exchangeCode(code, {
      code,
      redirectUri,
      codeVerifier,
      clientId,
      clientSecret,
      workspaceId: statePayload.workspaceId,
      userId: statePayload.userId,
    });
  } catch (err) {
    console.error(
      `[connect/callback] Code exchange failed for platform "${platform}":`,
      err
    );
    return { notice: NOTICE_CONNECT_FAILED };
  }

  let accountId: string;
  try {
    const persisted = await persistConnectedAccount(client, {
      workspaceId: statePayload.workspaceId,
      platform,
      exchanged,
    });
    accountId = persisted.accountId;
  } catch (err) {
    console.error('[connect/callback] Failed to persist account:', err);
    return { notice: NOTICE_CONNECT_FAILED };
  }

  try {
    const destinations = await config.fetchDestinations(
      exchanged.accessToken,
      exchanged
    );
    return { accountId, destinations: destinations ?? [] };
  } catch (err) {
    console.error(
      `[connect/callback] Destination discovery failed for platform "${platform}":`,
      err
    );
    return { notice: NOTICE_CONNECT_FAILED };
  }
}

const NOTICE_CONNECT_FAILED: ConnectNoticeCode = 'connect_failed';

function pickerRedirect(
  request: NextRequest,
  subdomain: string,
  platform: string,
  rootDomain: string,
  notice?: ConnectNoticeCode
): NextResponse {
  const url = buildTenantUrl(
    subdomain,
    `/connect/${platform}`,
    request.url,
    rootDomain
  );
  if (notice) {
    url.searchParams.set('notice', notice);
  }
  return NextResponse.redirect(url);
}

/**
 * GET /api/connect/[platform]/callback — the address platforms return to.
 *
 * Verifies the signed state, surfaces a denial as a plain-language notice,
 * exchanges the code through the registered platform config, persists the
 * account (tokens encrypted; reconnects re-bind the same row), stashes the
 * discovered destinations in a signed cookie, and redirects to the picker.
 */
export async function handleConnectCallback(
  request: NextRequest,
  platformParam: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const sessionSecret = getSessionSecret();
  const params = request.nextUrl.searchParams;
  const errorParam = params.get('error');
  const code = params.get('code');
  const stateParam = params.get('state');

  if (!isKnownPlatform(platformParam)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }
  const platform = platformParam;

  // No-state fallbacks: the platform is known from the URL but the
  // tenant subdomain is not (it rides in the state), so no tenant URL
  // can be built. The fallback is therefore the platform's accounts
  // path on the request host — per-platform, not Facebook's — with the
  // same error param as before.
  if (!stateParam) {
    const fallback = new URL(getPlatformAccountsPath(platform), request.url);
    fallback.searchParams.set('error', NOTICE_CONNECT_FAILED);
    return NextResponse.redirect(fallback);
  }

  let statePayload;
  try {
    statePayload = await verifyConnectState(stateParam, sessionSecret);
  } catch (err) {
    console.error('[connect/callback] State verification failed:', err);
    const fallback = new URL(getPlatformAccountsPath(platform), request.url);
    fallback.searchParams.set('error', NOTICE_CONNECT_FAILED);
    return NextResponse.redirect(fallback);
  }

  if (statePayload.platform !== platform) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'expired_link'
    );
  }

  if (errorParam) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      mapProviderDenial(errorParam)
    );
  }

  if (!code) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'missing_reply'
    );
  }

  const config = getPlatformConnectConfig(platform);
  if (!config) {
    console.error(
      `[connect/callback] No connect config registered for platform "${platform}".`
    );
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      NOTICE_CONNECT_FAILED
    );
  }

  const client = resolveConnectDbClient(dbClient);
  if (!client) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 503 }
    );
  }

  // PKCE verifier, when this flow used PKCE, rides in a signed cookie
  // matched to the state nonce.
  let codeVerifier: string | null = null;
  if (config.usePkce) {
    codeVerifier = await resolvePkceVerifier(
      request,
      statePayload.nonce,
      platform,
      sessionSecret
    );
    if (!codeVerifier) {
      return pickerRedirect(
        request,
        statePayload.tenantSubdomain,
        platform,
        rootDomain,
        'expired_link'
      );
    }
  }

  const credentials = await resolveExchangeCredentials(
    client,
    config,
    platform,
    statePayload.workspaceId
  );
  if (!credentials) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'credentials_required'
    );
  }
  const { clientId, clientSecret } = credentials;

  const redirectUri = buildConnectCallbackUrl(request.url, platform);

  const outcome = await exchangePersistAndDiscover({
    client,
    config,
    platform,
    statePayload,
    code,
    redirectUri,
    codeVerifier,
    clientId,
    clientSecret,
  });
  if ('notice' in outcome) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      outcome.notice
    );
  }
  const { accountId, destinations } = outcome;

  if (!destinations || destinations.length === 0) {
    return pickerRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'nothing_found'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const pendingValue = await signPendingDestinations(
    {
      accountId,
      workspaceId: statePayload.workspaceId,
      tenantSubdomain: statePayload.tenantSubdomain,
      platform,
      destinations,
      exp: now + CONNECT_PENDING_TTL_SECONDS,
    },
    sessionSecret
  );

  const response = pickerRedirect(
    request,
    statePayload.tenantSubdomain,
    platform,
    rootDomain
  );
  response.cookies.set(PENDING_COOKIE_NAME, pendingValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CONNECT_PENDING_TTL_SECONDS,
  });
  if (config.usePkce) {
    response.cookies.set(PKCE_COOKIE_NAME, '', {
      httpOnly: true,
      path: '/api/connect',
      maxAge: 0,
    });
  }
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await context.params;
  return handleConnectCallback(request, platform);
}
