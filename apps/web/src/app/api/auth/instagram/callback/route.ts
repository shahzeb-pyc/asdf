import { type NextRequest, NextResponse } from 'next/server';
import {
  buildPlatformAccountsUrl,
  buildSubdomainOAuthRedirectUriForCallback,
  DatabaseDestinationMetadataSchema,
  getSessionSecret,
  verifyOAuthState,
  verifySessionToken,
  type Database,
  type DatabaseClient,
  type OAuthStatePayload,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  mergeRowMetadata,
  persistConnectedAccount,
  persistPickedDestinations,
  resolvePlatformClientCredentials,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import { createInstagramConnectConfig } from '@/lib/connect/platforms/instagram';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';

/**
 * Instagram OAuth callback — Facebook's `/api/auth/facebook/callback`
 * route, mirrored for Instagram. It serves BOTH entry points:
 *
 * - Direct: the connect modal's "This Browser" view starts at
 *   `/api/auth/instagram`; the callback lands back on the tenant
 *   Instagram Accounts page with `connected=1` / `connected=already` /
 *   `reconnected_mismatch=1` (+ `accountName`), which the Instagram
 *   shell's OAuth-notice resolver already parses.
 * - Magic: the `/connect/instagram?token=…` forwarder signs a state
 *   with `isMagic: true`; the callback lands on the APP-host
 *   `/connect/instagram/{success,error}` pages instead.
 *
 * Magic-link connect pages live on the app host only
 * (`app.<root>/connect/instagram/{success,error}`) — there is no
 * tenant-subdomain copy of them. The callback, however, runs on the
 * workspace-subdomain host, so building these URLs from `request.url`
 * inherits the tenant host: on that host the login gate fires (the
 * magic-link browser deliberately holds no `fbup_session`) and the
 * user lands on /login even though the account just connected. The
 * `buildInstagramMagicConnectUrl` helper below builds them on the app
 * host instead — the same host logic as Facebook's
 * `buildMagicConnectUrl`, applied to EVERY magic branch here
 * (success, cancel, credentials-required, token-exchange/internal
 * error, catch-all), not just the success path.
 *
 * Local / preview behaviour mirrors Facebook's: on localhost (or
 * with no/local root domain) and on Vercel preview hosts the request
 * origin already is the app host, so it is used as-is.
 *
 * Differences from Facebook, all deliberate: the token exchange runs
 * through the Instagram connect config (code → 1-hour short-lived →
 * 60-day long-lived → profile + Professional-account check, spec 124);
 * the destination row is the account itself (persisted here, since
 * there is no picker in this flow); there is no page-token refresh
 * (Instagram has no pages).
 */
export function buildInstagramMagicConnectUrl(
  pathname: '/connect/instagram/success' | '/connect/instagram/error',
  requestUrl: string,
  rootDomain: string,
  appUrl: string
): URL {
  const requestOrigin = new URL(requestUrl);
  const cleanRoot = (rootDomain || '').trim().toLowerCase().split(':')[0] || '';
  const host = requestOrigin.hostname.toLowerCase();
  const isLocalHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.localhost');
  const isLocalRoot =
    !cleanRoot ||
    cleanRoot.includes('localhost') ||
    cleanRoot.includes('127.0.0.1');
  const isVercelPreview = host.endsWith('.vercel.app');
  if (isLocalHost || isLocalRoot || isVercelPreview) {
    return new URL(pathname, requestOrigin.origin);
  }
  let appOrigin: string | null = null;
  try {
    const app = new URL(appUrl);
    const appHost = app.hostname.toLowerCase();
    const appIsLocal =
      appHost === 'localhost' ||
      appHost === '127.0.0.1' ||
      appHost.endsWith('.localhost');
    if (!appIsLocal) {
      appOrigin = app.origin;
    }
  } catch {
    appOrigin = null;
  }
  if (appOrigin) {
    return new URL(pathname, appOrigin);
  }
  if (cleanRoot) {
    return new URL(pathname, `https://app.${cleanRoot}`);
  }
  // No app host derivable at all: keep the request origin rather than
  // inventing a host.
  return new URL(pathname, requestOrigin.origin);
}

async function resolveOAuthErrorTarget(
  requestUrl: string,
  state: string | null,
  sessionSecret: string,
  rootDomain: string,
  appUrl: string,
  error: string,
  errorDescription: string | null
): Promise<URL> {
  // No state (or unverifiable state) on a magic-less return: there is
  // no tenant to land on, so fall back to the app-host error page
  // rather than a tenant host that would login-gate the user.
  let target = buildInstagramMagicConnectUrl(
    '/connect/instagram/error',
    requestUrl,
    rootDomain,
    appUrl
  );
  target.searchParams.set('reason', 'oauth_failed');
  if (state) {
    try {
      const statePayload = await verifyOAuthState(state, sessionSecret);
      if (statePayload.isMagic) {
        const magicErrorUrl = buildInstagramMagicConnectUrl(
          '/connect/instagram/error',
          requestUrl,
          rootDomain,
          appUrl
        );
        const isCancelled =
          error === 'access_denied' || error === 'user_cancelled';
        magicErrorUrl.searchParams.set(
          'reason',
          isCancelled ? 'cancelled' : 'oauth_failed'
        );
        return magicErrorUrl;
      }
      target = buildPlatformAccountsUrl(
        statePayload.tenantSubdomain,
        'instagram',
        requestUrl,
        rootDomain
      );
    } catch (err) {
      // Fallback to the app-host error page if state cannot be
      // verified — logged, not silent.
      logServerError('[InstagramOAuth] Callback state verification failed', err, {
        source: 'instagram-oauth-callback',
      });
      return target;
    }
  }
  target.searchParams.set('error', error);
  if (errorDescription) {
    target.searchParams.set('error_description', errorDescription);
  }
  return target;
}

function buildOAuthStepErrorRedirect(
  requestUrl: string,
  destinationUrl: URL,
  isMagic: boolean | undefined,
  errorCode: string,
  rootDomain?: string,
  appUrl?: string
): NextResponse {
  if (isMagic) {
    const magicErrorUrl = buildInstagramMagicConnectUrl(
      '/connect/instagram/error',
      requestUrl,
      rootDomain ?? '',
      appUrl ?? ''
    );
    magicErrorUrl.searchParams.set('reason', 'oauth_failed');
    return NextResponse.redirect(magicErrorUrl);
  }
  destinationUrl.searchParams.set('error', errorCode);
  return NextResponse.redirect(destinationUrl);
}

function buildPostConnectRedirect(
  requestUrl: string,
  destinationUrl: URL,
  statePayload: OAuthStatePayload,
  profile: { id: string; displayName: string },
  alreadyExisted: boolean,
  rootDomain?: string,
  appUrl?: string
): NextResponse {
  const isReconnectMismatch = Boolean(
    statePayload.expectedInstagramAccountId &&
      profile.id !== statePayload.expectedInstagramAccountId
  );
  const isAlreadyConnected = Boolean(
    !statePayload.expectedInstagramAccountId && alreadyExisted
  );

  if (statePayload.isMagic) {
    const magicSuccessUrl = buildInstagramMagicConnectUrl(
      '/connect/instagram/success',
      requestUrl,
      rootDomain ?? '',
      appUrl ?? ''
    );
    if (isReconnectMismatch) {
      magicSuccessUrl.searchParams.set('reconnected_mismatch', '1');
      magicSuccessUrl.searchParams.set('newAccountName', profile.displayName);
      magicSuccessUrl.searchParams.set(
        'expectedAccountName',
        statePayload.expectedDisplayName || ''
      );
    } else if (isAlreadyConnected) {
      magicSuccessUrl.searchParams.set('already_connected', '1');
      magicSuccessUrl.searchParams.set('accountName', profile.displayName);
    } else {
      magicSuccessUrl.searchParams.set('accountName', profile.displayName);
    }
    return NextResponse.redirect(magicSuccessUrl);
  }

  if (isReconnectMismatch) {
    destinationUrl.searchParams.set('reconnected_mismatch', '1');
    destinationUrl.searchParams.set('newAccountName', profile.displayName);
    destinationUrl.searchParams.set(
      'expectedAccountName',
      statePayload.expectedDisplayName || 'the expired account'
    );
  } else if (isAlreadyConnected) {
    destinationUrl.searchParams.set('connected', 'already');
    destinationUrl.searchParams.set('accountName', profile.displayName);
  } else {
    destinationUrl.searchParams.set('connected', '1');
    destinationUrl.searchParams.set('accountName', profile.displayName);
  }

  return NextResponse.redirect(destinationUrl);
}

function getCallbackEnvConfig() {
  const sessionSecret = getSessionSecret();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const redirectUri = `${appUrl}/api/auth/instagram/callback`;

  return {
    sessionSecret,
    appUrl,
    rootDomain,
    redirectUri,
  };
}

async function instagramAccountExistedBefore(
  db: DatabaseClient | SupabaseClient | null | undefined,
  workspaceId: string,
  externalAccountId: string
): Promise<boolean> {
  if (isLegacyClient(db ?? undefined)) {
    const rows = (await (db as DatabaseClient).query(
      "SELECT id FROM social_accounts WHERE workspace_id = $1 AND platform = 'instagram' AND external_account_id = $2 LIMIT 1",
      [workspaceId, externalAccountId]
    )) as Array<{ id: string }>;
    return Array.isArray(rows) && rows.length > 0;
  }
  const supabase = getRouteSupabase(db ?? undefined);
  if (!supabase) return false;
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .eq('external_account_id', externalAccountId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

/**
 * The provider-reported account type, validated against the contracts
 * metadata schema before it is written — the twin of `accountTypeOf`
 * in `/api/connect/instagram/complete` (which writes the same key for
 * framework connects). A malformed value is never persisted.
 */
function accountTypeOf(destination: { accountType?: unknown }): string | null {
  const raw = destination.accountType;
  if (typeof raw !== 'string') return null;
  const parsed = DatabaseDestinationMetadataSchema.safeParse({
    account_type: raw,
  });
  if (!parsed.success) {
    console.error(
      '[connect/instagram] Provider reported an account type the contracts reject; not persisting it:',
      raw
    );
    return null;
  }
  return parsed.data.account_type ?? null;
}

export async function handleInstagramCallback(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient<Database>,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<NextResponse> {
  const { sessionSecret, appUrl, rootDomain, redirectUri } =
    getCallbackEnvConfig();

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // Handle upstream OAuth cancellation or error
  if (error) {
    const target = await resolveOAuthErrorTarget(
      request.url,
      state,
      sessionSecret,
      rootDomain,
      appUrl,
      error,
      errorDescription
    );
    return NextResponse.redirect(target);
  }

  if (!code || !state) {
    // No code/state and no error: nothing to verify, so no tenant is
    // known — land on the app-host error page, never a tenant host.
    const target = buildInstagramMagicConnectUrl(
      '/connect/instagram/error',
      request.url,
      rootDomain,
      appUrl
    );
    target.searchParams.set('reason', 'missing_code_or_state');
    return NextResponse.redirect(target);
  }

  // 1. Verify signed OAuth state
  let statePayload: OAuthStatePayload;
  try {
    statePayload = await verifyOAuthState(state, sessionSecret);
  } catch (_e) {
    const target = buildInstagramMagicConnectUrl(
      '/connect/instagram/error',
      request.url,
      rootDomain,
      appUrl
    );
    target.searchParams.set('reason', 'expired_or_invalid');
    return NextResponse.redirect(target);
  }

  const { tenantSubdomain, userId } = statePayload;
  const destinationUrl = buildPlatformAccountsUrl(
    tenantSubdomain,
    'instagram',
    request.url,
    rootDomain
  );

  // CSRF validation for direct OAuth flows (mirror of Facebook's):
  // magic flows carry no session by design.
  if (!statePayload.isMagic) {
    const sessionCookie = request.cookies.get('fbup_session')?.value;
    if (!sessionCookie) {
      destinationUrl.searchParams.set('error', 'unauthorized');
      return NextResponse.redirect(destinationUrl);
    }
    try {
      const session = await verifySessionToken(sessionCookie, sessionSecret);
      if (session.userId !== userId) {
        destinationUrl.searchParams.set('error', 'session_mismatch');
        return NextResponse.redirect(destinationUrl);
      }
    } catch {
      destinationUrl.searchParams.set('error', 'unauthorized');
      return NextResponse.redirect(destinationUrl);
    }
  }

  try {
    const db = dbClient ?? null;
    const workspaceId = await resolveTenantWorkspaceId(
      db,
      tenantSubdomain,
      userId
    );
    const credentials =
      workspaceId == null
        ? null
        : await resolvePlatformClientCredentials(db, workspaceId, 'instagram');

    // A missing workspace means no credentials can resolve either, so
    // both collapse to the same branch (and narrow workspaceId below).
    if (workspaceId == null || !credentials) {
      if (statePayload.isMagic) {
        const magicErrorUrl = buildInstagramMagicConnectUrl(
          '/connect/instagram/error',
          request.url,
          rootDomain,
          appUrl
        );
        magicErrorUrl.searchParams.set('reason', 'credentials_required');
        return NextResponse.redirect(magicErrorUrl);
      }
      destinationUrl.searchParams.set('error', 'credentials_required');
      return NextResponse.redirect(destinationUrl);
    }

    const effectiveRedirectUri =
      statePayload.redirectUri ||
      buildSubdomainOAuthRedirectUriForCallback(
        tenantSubdomain,
        '/api/auth/instagram/callback',
        request.url,
        rootDomain,
        redirectUri
      );

    // 2. Exchange the code through the Instagram connect config
    // (code → 1-hour short-lived → 60-day long-lived → profile +
    // Professional-account check). Any failure is a step error, never
    // a silent success.
    const config = createInstagramConnectConfig(fetchFn);
    let exchanged;
    try {
      exchanged = await config.exchangeCode(code, {
        code,
        redirectUri: effectiveRedirectUri,
        codeVerifier: null,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        workspaceId,
        userId,
      });
    } catch (err) {
      console.error('[InstagramOAuth] Code exchange failed:', err);
      return buildOAuthStepErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        'token_exchange_failed',
        rootDomain,
        appUrl
      );
    }

    // 3. Check existing & upsert into the unified social_accounts row
    const alreadyExisted = await instagramAccountExistedBefore(
      db,
      workspaceId,
      exchanged.externalAccountId
    );
    let accountId: string;
    try {
      const persisted = await persistConnectedAccount(db as ConnectDbClient, {
        workspaceId,
        platform: 'instagram',
        exchanged,
      });
      accountId = persisted.accountId;
    } catch (err) {
      console.error('[InstagramOAuth] Failed to persist account:', err);
      return buildOAuthStepErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        'token_exchange_failed',
        rootDomain,
        appUrl
      );
    }

    // 4. Persist the destination row (the account itself) — there is
    // no picker in this flow — and the provider-reported account type
    // the story gate reads.
    try {
      const destinations = await config.fetchDestinations(
        exchanged.accessToken,
        exchanged
      );
      if (destinations && destinations.length > 0) {
        await persistPickedDestinations(db as ConnectDbClient, {
          workspaceId,
          accountId,
          platform: 'instagram',
          destinations,
        });
        for (const destination of destinations) {
          const accountType = accountTypeOf(
            destination as { accountType?: unknown }
          );
          if (!accountType) continue;
          await mergeRowMetadata(
            db as ConnectDbClient,
            'destinations',
            {
              account_id: accountId,
              external_destination_id: destination.externalDestinationId,
            },
            { account_type: accountType }
          );
        }
      }
    } catch (err) {
      // The account is saved; a destination write failing must not
      // report the connect as failed — but it must not be silent
      // either. Log loudly; the account appears in the list and a
      // reconnect rewrites the destination.
      console.error('[InstagramOAuth] Destination persist failed:', err);
    }

    return buildPostConnectRedirect(
      request.url,
      destinationUrl,
      statePayload,
      {
        id: exchanged.externalAccountId,
        displayName: exchanged.displayName,
      },
      alreadyExisted,
      rootDomain,
      appUrl
    );
  } catch (err) {
    // Redirect with a safe generic error rather than leaking details.
    console.warn('[InstagramOAuth] Callback exchange error:', err instanceof Error ? err.message : String(err));
    if (statePayload?.isMagic) {
      const magicErrorUrl = buildInstagramMagicConnectUrl(
        '/connect/instagram/error',
        request.url,
        rootDomain,
        appUrl
      );
      magicErrorUrl.searchParams.set('reason', 'internal_oauth_error');
      return NextResponse.redirect(magicErrorUrl);
    }
    destinationUrl.searchParams.set('error', 'internal_oauth_error');
    return NextResponse.redirect(destinationUrl);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return await handleInstagramCallback(request);
}
