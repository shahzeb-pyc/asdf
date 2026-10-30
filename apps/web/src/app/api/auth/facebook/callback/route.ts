import { type NextRequest, NextResponse } from 'next/server';
import {
  buildSubdomainOAuthRedirectUri,
  buildTenantUrl,
  encryptToken,
  fetchAllFacebookPagesWithMeta,
  FacebookTokenExchangeResponseSchema,
  type FacebookUserProfileResponse,
  FacebookUserProfileResponseSchema,
  getSessionSecret,
  getTokenEncryptionKey,
  type OAuthStatePayload,
  peekOAuthStatePayload,
  verifyOAuthState,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveWorkspaceFacebookCredentials } from '@/lib/server/byoc-resolver';
import {
  GRAPH_API_TIMEOUT_MS,
  fetchWithTimeout,
} from '@/lib/http/fetch-with-timeout';

/**
 * Magic-link connect pages live on the app host only
 * (`app.<root>/connect/facebook/{success,error}`) — there is no
 * tenant-subdomain copy of them. The Facebook callback, however, runs
 * on the workspace-subdomain host, so building these URLs from
 * `request.url` inherits the tenant host: on that host the login gate
 * fires (the magic-link browser deliberately holds no `fbup_session`)
 * and the user lands on /login even though the account just
 * connected. This helper builds them on the app host instead.
 *
 * Local / preview behaviour is preserved, mirroring
 * `buildSubdomainOAuthRedirectUri` / `buildTenantUrl`: on localhost
 * (or with no/local root domain) and on Vercel preview hosts the
 * request origin already is the app host, so it is used as-is and
 * existing localhost expectations stay green. In production the app
 * host comes from `NEXT_PUBLIC_APP_URL` when it is a non-local host,
 * else `app.<rootDomain>` — never hardcoded, never the tenant host.
 */
export function buildMagicConnectUrl(
  pathname: '/connect/facebook/success' | '/connect/facebook/error',
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
  // Parse failure is recorded explicitly as "no app origin", not
  // swallowed: the fallback below then derives app.<root> (or, with
  // no root at all, keeps the request origin) via an explicit branch.
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
  // No app host derivable at all: keep the previous behaviour rather
  // than inventing a host.
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
  let target = new URL('/accounts', requestUrl);
  if (state) {
    try {
      const statePayload = await verifyOAuthState(state, sessionSecret);
      if (statePayload.isMagic) {
        const magicErrorUrl = buildMagicConnectUrl(
          '/connect/facebook/error',
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
      target = buildTenantUrl(
        statePayload.tenantSubdomain,
        '/accounts',
        requestUrl,
        rootDomain
      );
    } catch (err) {
      // Fallback to /accounts if state cannot be verified — logged
      // (spec 139 B3), not silent. Audit BG13: before falling
      // back, peek the signed (possibly expired) state for the
      // explicit magic signal — an expired magic state still
      // routes to the magic error page instead of the tenant
      // accounts page whose login gate would swallow the error.
      // A tampered state peeks to null and keeps the fallback:
      // with no signal, magic cannot be proven.
      logServerError('[FacebookOAuth] Callback state verification failed', err, {
        source: 'facebook-oauth-callback',
      });
      const peeked = await peekOAuthStatePayload(state, sessionSecret);
      if (peeked?.isMagic) {
        const magicErrorUrl = buildMagicConnectUrl(
          '/connect/facebook/error',
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
    const magicErrorUrl = buildMagicConnectUrl(
      '/connect/facebook/error',
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

/**
 * Hard-error redirect for a failed account save (BL1 fix). The user must
 * never see a success page for an account that was not persisted, so a
 * save failure redirects here instead of falling through to
 * buildPostConnectRedirect. Magic flows land on the app-host error page
 * with a dedicated reason; direct flows land on Accounts with a
 * dedicated error param handled by resolveOAuthRedirectNotice. No
 * page-token refresh runs on this path — there is no saved account to
 * refresh for.
 */
function buildAccountSaveErrorRedirect(
  requestUrl: string,
  destinationUrl: URL,
  isMagic: boolean | undefined,
  rootDomain?: string,
  appUrl?: string
): NextResponse {
  if (isMagic) {
    const magicErrorUrl = buildMagicConnectUrl(
      '/connect/facebook/error',
      requestUrl,
      rootDomain ?? '',
      appUrl ?? ''
    );
    magicErrorUrl.searchParams.set('reason', 'account_save_failed');
    return NextResponse.redirect(magicErrorUrl);
  }
  destinationUrl.searchParams.set('error', 'account_save_failed');
  return NextResponse.redirect(destinationUrl);
}

async function fetchGraphPageTokenMap(
  longAccessToken: string
): Promise<Map<string, string>> {
  const tokenMap = new Map<string, string>();
  // Audit BG6: a truncated list refreshes only a subset of page
  // tokens while the callback still reports success. The refresh
  // stays best-effort (a partial refresh must not fail the
  // connect), but truncation is now logged loudly instead of
  // silently — the BG5 worker fallback covers the publish path
  // for any page whose token stayed stale.
  const { pages, truncated, truncationReason } =
    await fetchAllFacebookPagesWithMeta(longAccessToken, 'id,access_token');
  if (truncated) {
    console.warn(
      `[FacebookOAuth] Page token refresh truncated (${truncationReason}): refreshed ${pages.length} pages, further pages unseen — their stored tokens stay stale until the next reconnect or a publish-time BG5 re-discovery.`
    );
  }
  for (const item of pages) {
    if (
      typeof item?.id === 'string' &&
      item.id &&
      typeof item?.access_token === 'string' &&
      item.access_token
    ) {
      tokenMap.set(item.id, item.access_token);
    }
  }
  return tokenMap;
}

export async function refreshConnectedPageTokens(
  db: DatabaseClient | SupabaseClient | null | undefined,
  userId: string,
  workspaceId: string,
  accountRowId: string,
  longAccessToken: string,
  expiresAt: Date,
  encryptionKey: string
): Promise<void> {
  const supabase =
    db && 'from' in db
      ? (db as SupabaseClient)
      : !db || !('query' in db)
        ? getSupabaseAdminClient()
        : null;
  const legacyDb = db && 'query' in db && typeof db.query === 'function' ? db : null;

  try {
    let validPages: Array<{ id: string; fb_page_id?: string; fbPageId?: string; status?: string }> = [];

    if (supabase) {
      const { data: linkedPages, error: fetchPagesError } = await supabase
        .from('destinations')
        .select('id, external_destination_id, status, metadata')
        .eq('account_id', accountRowId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook');

      if (fetchPagesError) {
        console.warn(
          '[FacebookOAuth] Failed to fetch linked pages:',
          fetchPagesError.message
        );
      }

      // Disconnected destinations are skipped; paused pages (stored
      // as disconnected + the fb_status marker) still refresh, as
      // they did when 'paused' was its own status.
      validPages = Array.isArray(linkedPages)
        ? (linkedPages
            .filter(
              (p) =>
                Boolean(p?.external_destination_id) &&
                (p.status !== 'disconnected' ||
                  (p.metadata as Record<string, unknown> | null)?.fb_status ===
                    'paused')
            )
            .map((p) => ({
              id: p.id,
              fb_page_id: p.external_destination_id,
              status: p.status,
            })) as Array<{ id: string; fb_page_id?: string; fbPageId?: string; status?: string }>)
        : [];
    } else if (legacyDb) {
      const linkedPages = (await legacyDb.query(
        `SELECT id, external_destination_id AS fb_page_id, status
         FROM destinations
         WHERE account_id = $1
           AND workspace_id = $2
           AND platform = 'facebook'
           AND (status != 'disconnected' OR metadata->>'fb_status' = 'paused')`,
        [accountRowId, workspaceId]
      )) as Array<{ id: string; fb_page_id?: string; fbPageId?: string; status?: string }>;

      validPages = Array.isArray(linkedPages)
        ? linkedPages.filter((p) => Boolean(p?.fb_page_id || p?.fbPageId))
        : [];
    }

    if (validPages.length === 0) {
      return;
    }

    const tokenMap = await fetchGraphPageTokenMap(longAccessToken);
    if (tokenMap.size === 0) {
      return;
    }

    await Promise.all(
      validPages.map(async (linkedPage) => {
        const fbPageId = linkedPage.fb_page_id ?? linkedPage.fbPageId ?? '';
        const rawPageToken = tokenMap.get(fbPageId);
        if (!rawPageToken) {
          return;
        }
        const encryptedPageToken = await encryptToken(rawPageToken, encryptionKey);
        if (supabase) {
          const { error: updateError } = await supabase
            .from('destinations')
            .update({
              encrypted_destination_token: encryptedPageToken,
              // 'error' is the unified invalid-token state; a fresh
              // token reactivates the destination.
              status: linkedPage.status === 'error' ? 'active' : linkedPage.status,
              updated_at: new Date().toISOString(),
            })
            .eq('id', linkedPage.id)
            .eq('workspace_id', workspaceId);

          if (updateError) {
            console.warn(
              '[FacebookOAuth] Failed to update destination token:',
              updateError.message
            );
          }
        } else if (legacyDb) {
          await legacyDb.query(
            `UPDATE destinations
             SET encrypted_destination_token = $1,
                 status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
                 updated_at = now()
             WHERE id = $2 AND workspace_id = $3`,
            [encryptedPageToken, linkedPage.id, workspaceId]
          );
        }
      })
    );
  } catch (err) {
    console.warn(
      '[FacebookOAuth] Page token sync skipped:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

function buildPostConnectRedirect(
  requestUrl: string,
  destinationUrl: URL,
  statePayload: OAuthStatePayload,
  meProfile: { id: string; name: string },
  alreadyExisted: boolean,
  rootDomain?: string,
  appUrl?: string
): NextResponse {
  const isReconnectMismatch = Boolean(
    statePayload.expectedFbAccountId &&
      meProfile.id !== statePayload.expectedFbAccountId
  );
  // Audit UX8: the copy must follow the outcome, not the path.
  // Re-authorizing an account that already existed is a session
  // refresh whether it came through a card Reconnect (expected id
  // set) or a fresh magic link (no expected id) — the old
  // !expectedFbAccountId condition made the same outcome read
  // "connected" on one path and "session refreshed" on the other.
  const isAlreadyConnected = Boolean(alreadyExisted);

  if (statePayload.isMagic) {
    const magicSuccessUrl = buildMagicConnectUrl(
      '/connect/facebook/success',
      requestUrl,
      rootDomain ?? '',
      appUrl ?? ''
    );
    if (isReconnectMismatch) {
      magicSuccessUrl.searchParams.set('reconnected_mismatch', '1');
      magicSuccessUrl.searchParams.set('newAccountName', meProfile.name);
      magicSuccessUrl.searchParams.set(
        'expectedAccountName',
        statePayload.expectedDisplayName || ''
      );
    } else if (isAlreadyConnected) {
      magicSuccessUrl.searchParams.set('already_connected', '1');
      magicSuccessUrl.searchParams.set('accountName', meProfile.name);
    } else {
      // Fresh magic connect: carry the name so the success page can
      // confirm "[Name] connected" instead of a generic line.
      magicSuccessUrl.searchParams.set('accountName', meProfile.name);
    }
    return NextResponse.redirect(magicSuccessUrl);
  }

  if (isReconnectMismatch) {
    destinationUrl.searchParams.set('reconnected_mismatch', '1');
    destinationUrl.searchParams.set('newAccountName', meProfile.name);
    destinationUrl.searchParams.set(
      'expectedAccountName',
      statePayload.expectedDisplayName || 'the expired account'
    );
  } else if (isAlreadyConnected) {
    destinationUrl.searchParams.set('connected', 'already');
    destinationUrl.searchParams.set('accountName', meProfile.name);
  } else {
    destinationUrl.searchParams.set('connected', '1');
    destinationUrl.searchParams.set('accountName', meProfile.name);
  }

  return NextResponse.redirect(destinationUrl);
}

function getCallbackEnvConfig() {
  const sessionSecret = getSessionSecret();
  const encryptionKey = getTokenEncryptionKey();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || '';
  const redirectUri = `${appUrl}/api/auth/facebook/callback`;

  return {
    sessionSecret,
    encryptionKey,
    appUrl,
    rootDomain,
    redirectUri,
  };
}

async function upsertConnectedFacebookAccount(
  db: DatabaseClient | SupabaseClient | null | undefined,
  userId: string,
  workspaceId: string,
  meProfile: FacebookUserProfileResponse,
  encryptedToken: string,
  expiresAt: Date
): Promise<{ accountRowId: string | undefined; alreadyExisted: boolean }> {
  const supabase =
    db && 'from' in db
      ? (db as SupabaseClient)
      : !db || !('query' in db)
        ? getSupabaseAdminClient()
        : null;
  const legacyDb = db && 'query' in db && typeof db.query === 'function' ? db : null;

  if (supabase) {
    const { data: existing, error: existingError } = await supabase
      .from('social_accounts')
      .select('id, status, metadata')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .eq('external_account_id', meProfile.id)
      .maybeSingle();

    // BL1 fix: a failed lookup is a hard error, not a signal to proceed
    // with empty metadata and hope the upsert succeeds. The caller
    // redirects to the save-error surface instead of success.
    if (existingError) {
      throw new Error(
        `Failed to look up connected Facebook account: ${existingError.message}`
      );
    }

    const alreadyExisted = Boolean(existing && typeof existing.status === 'string');
    const profilePictureUrl = meProfile.picture?.data?.url ?? null;
    const gender = meProfile.gender ?? null;
    const accountLink = meProfile.link ?? null;

    // gender / account_link live in metadata on the unified row
    // (spec 120 §7b); merge over whatever is already stored there.
    const metadata: Record<string, unknown> = {
      ...((existing?.metadata as Record<string, unknown> | null) ?? {}),
    };
    if (gender !== null) metadata.gender = gender;
    if (accountLink !== null) metadata.account_link = accountLink;

    const { data: upserted, error: upsertError } = await supabase
      .from('social_accounts')
      .upsert(
        {
          workspace_id: workspaceId,
          platform: 'facebook',
          external_account_id: meProfile.id,
          display_name: meProfile.name,
          encrypted_access_token: encryptedToken,
          token_expires_at: expiresAt.toISOString(),
          avatar_url: profilePictureUrl,
          metadata,
          status: 'active',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id,platform,external_account_id' }
      )
      .select('id')
      .single();

    // BL1 fix: never swallow an upsert error and redirect to success.
    // This throws into the caller's save-error handling, which logs the
    // failure and redirects to the error surface — for a brand-new
    // account and for an existing account whose token update failed
    // alike. No "connected with the old token" fallback.
    if (upsertError) {
      throw new Error(
        `Failed to save connected Facebook account: ${upsertError.message}`
      );
    }

    const accountRowId = upserted?.id ?? existing?.id;
    if (!accountRowId) {
      // An upsert that reports success but yields no row is the same
      // failure mode: nothing was persisted, so success is a lie.
      throw new Error('Failed to save connected Facebook account: no row returned');
    }
    return { accountRowId, alreadyExisted };
  }

  if (!legacyDb) {
    return { accountRowId: undefined, alreadyExisted: false };
  }

  const effectiveDb = legacyDb;
  const existingRows = (await effectiveDb.query(
    "SELECT id, status FROM social_accounts WHERE workspace_id = $1 AND platform = 'facebook' AND external_account_id = $2",
    [workspaceId, meProfile.id]
  )) as Array<{ id: string; status?: string }>;
  const alreadyExisted =
    Array.isArray(existingRows) &&
    existingRows.some((row) => typeof row?.status === 'string');

  const profilePictureUrl = meProfile.picture?.data?.url ?? null;
  const gender = meProfile.gender ?? null;
  const accountLink = meProfile.link ?? null;

  const upsertRows = (await effectiveDb.query(
    `INSERT INTO social_accounts (
      workspace_id, platform, external_account_id, display_name, encrypted_access_token, token_expires_at, avatar_url, metadata, status, updated_at
    ) VALUES ($1, 'facebook', $2, $3, $4, $5, $6,
      jsonb_strip_nulls(jsonb_build_object('gender', $7::text, 'account_link', $8::text)),
      'active', now())
    ON CONFLICT (workspace_id, platform, external_account_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      token_expires_at = EXCLUDED.token_expires_at,
      avatar_url = EXCLUDED.avatar_url,
      metadata = social_accounts.metadata || EXCLUDED.metadata,
      status = 'active',
      updated_at = now()
    RETURNING id`,
    [
      workspaceId,
      meProfile.id,
      meProfile.name,
      encryptedToken,
      expiresAt,
      profilePictureUrl,
      gender,
      accountLink,
    ]
  )) as Array<{ id: string }>;

  const accountRowId = upsertRows?.[0]?.id ?? existingRows?.[0]?.id;
  if (!accountRowId) {
    // Same BL1 rule as the Supabase path: no persisted row, no success.
    throw new Error('Failed to save connected Facebook account: no row returned');
  }
  return { accountRowId, alreadyExisted };
}

export async function handleFacebookCallback(
  request: NextRequest,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const {
    sessionSecret,
    encryptionKey,
    appUrl,
    rootDomain,
  } = getCallbackEnvConfig();

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
    const target = new URL('/accounts', request.url);
    target.searchParams.set('error', 'missing_code_or_state');
    return NextResponse.redirect(target);
  }

  // 1. Verify signed OAuth state
  let statePayload: OAuthStatePayload;
  try {
    statePayload = await verifyOAuthState(state, sessionSecret);
  } catch (_e) {
    // Audit BG13: an expired-but-signed magic state routes to
    // the magic error page (reason expired_or_invalid → the
    // page's default "link expired, generate a fresh link"
    // copy), not to the tenant accounts page whose login gate
    // would drop the user at /login with the error lost. A
    // tampered state peeks to null and keeps the tenant
    // fallback — magic cannot be proven from it.
    const peeked = await peekOAuthStatePayload(state, sessionSecret);
    if (peeked?.isMagic) {
      const magicErrorUrl = buildMagicConnectUrl(
        '/connect/facebook/error',
        request.url,
        rootDomain,
        appUrl
      );
      magicErrorUrl.searchParams.set('reason', 'expired_or_invalid');
      return NextResponse.redirect(magicErrorUrl);
    }
    const target = new URL('/accounts', request.url);
    target.searchParams.set('error', 'invalid_oauth_state');
    return NextResponse.redirect(target);
  }

  const { tenantSubdomain, userId } = statePayload;
  const destinationUrl = buildTenantUrl(
    tenantSubdomain,
    '/accounts',
    request.url,
    rootDomain
  );

  // CSRF validation for direct OAuth flows (Spec Issue 8)
  if (!statePayload.isMagic) {
    // Audit BG14: a session lost mid-flow must keep a return
    // path. The old code sent every session failure to the
    // tenant accounts page, which itself requires a session —
    // so the user bounced to /login with the error lost and no
    // way back. Expiry-like failures (missing, unverifiable, or
    // inactive session) now go to /login directly with
    // next=<tenant accounts path> and reason=session-expired:
    // the login page shows the session-expired notice and
    // returns the user to accounts after sign-in, where they
    // can click Connect again. A session_mismatch keeps the
    // accounts error banner: a session exists there, so the
    // banner renders (the specific mismatch detail is only
    // lost for the login-bound cases, where the accounts page
    // cannot render at all).
    const sessionLossRedirect = () => {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set(
        'next',
        `/tenant/${tenantSubdomain}/accounts`
      );
      loginUrl.searchParams.set('reason', 'session-expired');
      return NextResponse.redirect(loginUrl);
    };
    const sessionCookie = request.cookies.get('fbup_session')?.value;
    if (!sessionCookie) {
      return sessionLossRedirect();
    }
    try {
      const session = await verifySessionToken(sessionCookie, sessionSecret);
      if (session.userId !== userId) {
        destinationUrl.searchParams.set('error', 'session_mismatch');
        return NextResponse.redirect(destinationUrl);
      }
      // Audit S1: live session validation on the DIRECT flow only.
      // The magic flow has no session by design (the magic token
      // is its credential, and magic links stay reusable per
      // owner decision on BL3), so it is deliberately untouched.
      const { validateSessionActive } = await import('@/lib/auth/session');
      if (!(await validateSessionActive(session))) {
        return sessionLossRedirect();
      }
    } catch {
      return sessionLossRedirect();
    }
  }

  try {
    const db = dbClient ?? null;
    const byocResult = await resolveWorkspaceFacebookCredentials(
      db,
      tenantSubdomain,
      userId
    );

    if (!byocResult.ok) {
      if (statePayload.isMagic) {
        const magicErrorUrl = buildMagicConnectUrl(
          '/connect/facebook/error',
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

    const { fbAppId: effectiveAppId, decryptedAppSecret: effectiveAppSecret, workspaceId } = byocResult;

    // Audit N6: the fallback argument is a bare app URL, not the
    // full redirect URI — passing redirectUri here made the local
    // branch append /api/auth/facebook/callback a second time.
    const effectiveRedirectUri =
      statePayload.redirectUri ||
      buildSubdomainOAuthRedirectUri(
        tenantSubdomain,
        request.url,
        rootDomain,
        appUrl
      );

    // 2. Exchange temporary code for short-lived token (Graph API v26.0)
    const codeExchangeUrl = new URL(
      'https://graph.facebook.com/v26.0/oauth/access_token'
    );
    codeExchangeUrl.searchParams.set('client_id', effectiveAppId);
    codeExchangeUrl.searchParams.set('client_secret', effectiveAppSecret);
    codeExchangeUrl.searchParams.set('redirect_uri', effectiveRedirectUri);
    codeExchangeUrl.searchParams.set('code', code);

    const shortTokenRes = await fetchWithTimeout(
      codeExchangeUrl.toString(),
      { method: 'POST' },
      GRAPH_API_TIMEOUT_MS
    );
    if (!shortTokenRes.ok) {
      return buildOAuthStepErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        'token_exchange_failed',
        rootDomain,
        appUrl
      );
    }
    const shortTokenJson = await shortTokenRes.json();
    const shortTokenData =
      FacebookTokenExchangeResponseSchema.parse(shortTokenJson);

    // 3. Exchange short-lived token for 60-day long-lived token
    const longTokenUrl = new URL(
      'https://graph.facebook.com/v26.0/oauth/access_token'
    );
    longTokenUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longTokenUrl.searchParams.set('client_id', effectiveAppId);
    longTokenUrl.searchParams.set('client_secret', effectiveAppSecret);
    longTokenUrl.searchParams.set(
      'fb_exchange_token',
      shortTokenData.access_token
    );

    const longTokenRes = await fetchWithTimeout(
      longTokenUrl.toString(),
      { method: 'GET' },
      GRAPH_API_TIMEOUT_MS
    );
    if (!longTokenRes.ok) {
      return buildOAuthStepErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        'long_token_exchange_failed',
        rootDomain,
        appUrl
      );
    }
    const longTokenJson = await longTokenRes.json();
    const longTokenData =
      FacebookTokenExchangeResponseSchema.parse(longTokenJson);

    // 4. Fetch user profile from /me
    const meUrl = new URL('https://graph.facebook.com/v26.0/me');
    meUrl.searchParams.set('fields', 'id,name,gender,link,picture{url}');
    const meRes = await fetchWithTimeout(
      meUrl.toString(),
      {
        headers: {
          Authorization: `Bearer ${longTokenData.access_token}`,
        },
      },
      GRAPH_API_TIMEOUT_MS
    );
    if (!meRes.ok) {
      return buildOAuthStepErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        'profile_fetch_failed',
        rootDomain,
        appUrl
      );
    }
    const meJson = await meRes.json();
    const meProfile = FacebookUserProfileResponseSchema.parse(meJson);

    // 5. Encrypt long-lived token using Web Crypto AES-256-GCM
    const encryptedToken = await encryptToken(
      longTokenData.access_token,
      encryptionKey
    );

    const expiresInSeconds =
      longTokenData.expires_in && longTokenData.expires_in > 0
        ? longTokenData.expires_in
        : 5184000; // ~60 days
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // 6. Check existing & upsert into database with workspace_id isolation.
    // BL1 fix: a save failure is a hard error. Do not redirect to
    // success and do not refresh page tokens on this path.
    let accountRowId: string | undefined;
    let alreadyExisted = false;
    try {
      ({ accountRowId, alreadyExisted } = await upsertConnectedFacebookAccount(
        db,
        userId,
        workspaceId,
        meProfile,
        encryptedToken,
        expiresAt
      ));
    } catch (err) {
      logServerError(
        '[FacebookOAuth] Failed to save connected Facebook account',
        err,
        {
          source: 'facebook-oauth-callback',
          workspaceId,
          tenantSubdomain,
        }
      );
      return buildAccountSaveErrorRedirect(
        request.url,
        destinationUrl,
        statePayload.isMagic,
        rootDomain,
        appUrl
      );
    }

    if (accountRowId) {
      await refreshConnectedPageTokens(
        db,
        userId,
        workspaceId,
        accountRowId,
        longTokenData.access_token,
        expiresAt,
        encryptionKey
      );
    }

    return buildPostConnectRedirect(
      request.url,
      destinationUrl,
      statePayload,
      meProfile,
      alreadyExisted,
      rootDomain,
      appUrl
    );
  } catch (err) {
    // Redirect to destination with safe generic error parameter rather than leaking internal details
    console.warn('[FacebookOAuth] Callback exchange error:', err instanceof Error ? err.message : String(err));
    if (statePayload?.isMagic) {
      const magicErrorUrl = buildMagicConnectUrl(
        '/connect/facebook/error',
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
  // Audit S6: previously unthrottled OAuth callback; 20/min like initiate.
  // Over the limit the caller gets the standard JSON 429, not a redirect.
  const limited = await enforceIpRateLimit(request, 'auth_facebook_callback', 20);
  if (limited) return limited;
  return await handleFacebookCallback(request);
}


