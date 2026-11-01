import { type NextRequest, NextResponse } from 'next/server';
import {
  buildTenantUrl,
  getPlatformAccountsPath,
  getSessionSecret,
} from '@fbuploadpro/contracts';
// Side effect: registers the X connect config (spec 127).
import '@/lib/connect/platforms/x';
// Side effect: registers the Threads connect config (spec 124).
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
  persistPickedDestinations,
  resolvePlatformClientCredentials,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import { resolveConnectDbClient } from '@/lib/connect/session';
import { enforceIpRateLimit } from '@/lib/request-body';
import { mapProviderDenial, type ConnectNoticeCode } from '@/lib/connect/errors';
import { buildMagicConnectUrl } from '@/lib/connect/magic-url';
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
      /** The signed-in account, for mismatch / already-connected checks. */
      externalAccountId: string;
      displayName: string;
      /** True when this account row existed before this flow. */
      alreadyExisted: boolean;
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

  let persisted: { accountId: string; alreadyExisted: boolean };
  try {
    persisted = await persistConnectedAccount(client, {
      workspaceId: statePayload.workspaceId,
      platform,
      exchanged,
    });
  } catch (err) {
    console.error('[connect/callback] Failed to persist account:', err);
    return { notice: NOTICE_CONNECT_FAILED };
  }

  try {
    const destinations = await config.fetchDestinations(
      exchanged.accessToken,
      exchanged
    );
    return {
      accountId: persisted.accountId,
      externalAccountId: exchanged.externalAccountId,
      displayName: exchanged.displayName,
      alreadyExisted: persisted.alreadyExisted,
      destinations: destinations ?? [],
    };
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
 * Threads notice redirect (Facebook parity for the Threads page):
 * a failed Threads connect does not land on the generic picker —
 * it lands on Threads accounts with Facebook's `?error=` notice
 * shape, so the Threads shell shows the same banner Facebook's
 * shell shows. A magic-link Threads connect, whose browser holds
 * no session, lands on the public `/connect/threads/error` page
 * instead (same as Facebook's magic error page). Every other
 * platform keeps the picker redirect exactly as before.
 */
function threadsNoticeRedirect(
  request: NextRequest,
  subdomain: string,
  rootDomain: string,
  notice: ConnectNoticeCode,
  isMagic: boolean
): NextResponse {
  if (isMagic) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const errorUrl = buildMagicConnectUrl(
      '/connect/threads/error',
      request.url,
      rootDomain,
      appUrl
    );
    const reason =
      notice === 'denied'
        ? 'cancelled'
        : notice === 'credentials_required'
          ? 'app_not_configured'
          : 'oauth_failed';
    errorUrl.searchParams.set('reason', reason);
    return NextResponse.redirect(errorUrl);
  }
  const url = buildTenantUrl(
    subdomain,
    '/threads/accounts',
    request.url,
    rootDomain
  );
  // The notice code travels verbatim (only the provider denial is
  // renamed to the shell's `access_denied`): collapsing everything
  // to `connect_failed` would lose `expired_link`, `missing_reply`,
  // and `nothing_found`, which the shell and its tests distinguish.
  const errorParam = notice === 'denied' ? 'access_denied' : notice;
  url.searchParams.set('error', errorParam);
  return NextResponse.redirect(url);
}

/**
 * Notice redirect for a verified connect state: Threads flows use
 * the Threads notice redirect above; every other platform uses
 * the picker redirect, unchanged.
 */
function connectNoticeRedirect(
  request: NextRequest,
  subdomain: string,
  platform: Platform,
  rootDomain: string,
  notice: ConnectNoticeCode,
  isMagic: boolean
): NextResponse {
  if (platform === 'threads') {
    return threadsNoticeRedirect(request, subdomain, rootDomain, notice, isMagic);
  }
  return pickerRedirect(request, subdomain, platform, rootDomain, notice);
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
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'expired_link',
      statePayload.isMagic ?? false
    );
  }

  if (errorParam) {
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      mapProviderDenial(errorParam),
      statePayload.isMagic ?? false
    );
  }

  if (!code) {
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'missing_reply',
      statePayload.isMagic ?? false
    );
  }

  const config = getPlatformConnectConfig(platform);
  if (!config) {
    console.error(
      `[connect/callback] No connect config registered for platform "${platform}".`
    );
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      NOTICE_CONNECT_FAILED,
      statePayload.isMagic ?? false
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
      return connectNoticeRedirect(
        request,
        statePayload.tenantSubdomain,
        platform,
        rootDomain,
        'expired_link',
        statePayload.isMagic ?? false
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
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'credentials_required',
      statePayload.isMagic ?? false
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
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      outcome.notice,
      statePayload.isMagic ?? false
    );
  }
  const { accountId, destinations } = outcome;

  if (!destinations || destinations.length === 0) {
    return connectNoticeRedirect(
      request,
      statePayload.tenantSubdomain,
      platform,
      rootDomain,
      'nothing_found',
      statePayload.isMagic ?? false
    );
  }

  // Mismatch / already-connected, Facebook semantics: the signed-in
  // account is persisted either way (a wrong-account reconnect
  // auto-saves as a NEW account; the expected account stays
  // expired) — the warning travels with the redirect instead of
  // silently succeeding.
  const expectedExternalAccountId = statePayload.expectedExternalAccountId;
  const expectedDisplayName =
    statePayload.expectedDisplayName || 'the expired account';
  const isMismatch = Boolean(
    expectedExternalAccountId &&
      outcome.externalAccountId !== expectedExternalAccountId
  );
  const isAlreadyConnected = Boolean(
    !expectedExternalAccountId && outcome.alreadyExisted
  );

  // Magic Threads flow (Facebook magic parity): the browser that
  // opened the link holds no session, so there is no picker to
  // show it — the single Threads destination is confirmed
  // server-side here and the flow finishes on the public magic
  // success page (app host, same host rule as Facebook's).
  if (statePayload.isMagic && platform === 'threads') {
    try {
      await persistPickedDestinations(client, {
        workspaceId: statePayload.workspaceId,
        accountId,
        platform,
        destinations,
      });
    } catch (err) {
      console.error('[connect/callback] Failed to persist magic destinations:', err);
      return threadsNoticeRedirect(
        request,
        statePayload.tenantSubdomain,
        rootDomain,
        NOTICE_CONNECT_FAILED,
        true
      );
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const successUrl = buildMagicConnectUrl(
      '/connect/threads/success',
      request.url,
      rootDomain,
      appUrl
    );
    if (isMismatch) {
      successUrl.searchParams.set('reconnected_mismatch', '1');
      successUrl.searchParams.set('newAccountName', outcome.displayName);
      successUrl.searchParams.set('expectedAccountName', expectedDisplayName);
    } else if (isAlreadyConnected) {
      successUrl.searchParams.set('already_connected', '1');
      successUrl.searchParams.set('accountName', outcome.displayName);
    } else {
      successUrl.searchParams.set('accountName', outcome.displayName);
    }
    return NextResponse.redirect(successUrl);
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
      alreadyExisted: outcome.alreadyExisted,
      ...(expectedExternalAccountId ? { expectedExternalAccountId } : {}),
      ...(statePayload.expectedDisplayName
        ? { expectedDisplayName: statePayload.expectedDisplayName }
        : {}),
      ...(statePayload.isMagic ? { isMagic: true } : {}),
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
  // Audit S6: previously unthrottled OAuth callback; 20/min like initiate.
  // Over the limit the caller gets the standard JSON 429, not a redirect.
  const limited = await enforceIpRateLimit(request, 'connect_platform_callback', 20);
  if (limited) return limited;
  return handleConnectCallback(request, platform);
}
