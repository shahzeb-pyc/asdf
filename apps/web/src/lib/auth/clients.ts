/**
 * Supabase client factories + test-double gate (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let mockSupabaseClientForTesting: SupabaseClient | null = null;
let mockSupabaseServiceClientForTesting: SupabaseClient | null = null;

/**
 * Default per-request timeout for the admin (service-role) client
 * (spec 139). Applied via a global fetch wrapper — every single Supabase
 * request that hangs is aborted after this long instead of tying up a
 * serverless invocation indefinitely. Callers that pass their own
 * AbortSignal (e.g. a longer/shorter per-call timeout) keep theirs —
 * the wrapper only supplies the default when no signal is present.
 */
export const SUPABASE_ADMIN_FETCH_TIMEOUT_MS = 15_000;

let cachedAdminClient: SupabaseClient | null = null;
let cachedAdminClientConfig: string | null = null;

/**
 * Global fetch for the admin client: delegates to the ambient fetch and
 * defaults the abort signal to SUPABASE_ADMIN_FETCH_TIMEOUT_MS.
 * Exported so the timeout default can be unit-tested directly.
 */
export function fetchWithAdminTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(SUPABASE_ADMIN_FETCH_TIMEOUT_MS),
  });
}

/**
 * Single gate for every test double in this module. Mocks may only take
 * effect outside production — even if a setter is somehow called in
 * production, the mock is never honored by the getters.
 */
function isTestDoubleAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** Throws if test doubles are attempted in production. */
export function assertTestDoubleAllowed(caller: string): void {
  if (!isTestDoubleAllowed()) {
    throw new Error(`${caller} is test-only and must not be called in production.`);
  }
}

export function _setMockSupabaseClient(client: SupabaseClient | null): void {
  assertTestDoubleAllowed('_setMockSupabaseClient');
  mockSupabaseClientForTesting = client;
}

export function _setMockSupabaseServiceClient(client: SupabaseClient | null): void {
  assertTestDoubleAllowed('_setMockSupabaseServiceClient');
  mockSupabaseServiceClientForTesting = client;
}

/**
 * Clears both mock clients and the cached admin client. Called by
 * `_resetAuthStores` (stores.ts) — this is the seam tests use between
 * cases, so clearing the cache here keeps env-swapping tests correct:
 * after a reset, the next getSupabaseAdminClient() re-resolves the
 * (possibly changed) environment instead of reusing a stale client.
 */
export function _resetMockSupabaseClients(): void {
  mockSupabaseClientForTesting = null;
  mockSupabaseServiceClientForTesting = null;
  cachedAdminClient = null;
  cachedAdminClientConfig = null;
}

/**
 * Returns a Supabase client configured with the service-role key (SUPABASE_SERVICE_ROLE_KEY).
 * Exclusively for server-side administrative workflows and system jobs.
 * The name makes the elevated privilege explicit at every call site.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (isTestDoubleAllowed() && mockSupabaseServiceClientForTesting) {
    return mockSupabaseServiceClientForTesting;
  }
  if (isTestDoubleAllowed() && mockSupabaseClientForTesting) {
    return mockSupabaseClientForTesting;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const isProduction = process.env.NODE_ENV === 'production';

  // Production (spec 139): the service-role key is strictly required.
  // The admin client must NEVER silently degrade to the anon key — an
  // anon-key client looks configured but runs under RLS with no elevated
  // privilege, turning admin workflows into confusing partial failures.
  // Fail fast and loudly instead. The anon-key fallback below is kept
  // for non-production only, where local/test setups may legitimately
  // run without a service-role key.
  let key: string | undefined;
  if (isProduction) {
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || url.includes('placeholder') || !key || key.includes('placeholder')) {
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are strictly required in production.'
      );
    }
  } else {
    key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key || url.includes('placeholder') || key.includes('placeholder')) {
      return null;
    }
  }

  // Singleton cache keyed by the resolved config (spec 139): building a
  // fresh client per call churns connections/agents on hot server paths.
  // A config change (tests swapping env) misses the cache and rebuilds;
  // `_resetMockSupabaseClients` clears it via `_resetAuthStores`.
  const configKey = `${url}\n${key}`;
  if (cachedAdminClient && cachedAdminClientConfig === configKey) {
    return cachedAdminClient;
  }

  try {
    const client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: fetchWithAdminTimeout,
      },
    });
    cachedAdminClient = client;
    cachedAdminClientConfig = configKey;
    return client;
  } catch (error) {
    // In production a client that cannot even be constructed is a hard
    // misconfiguration — surface it rather than masking it as "no client".
    if (isProduction) {
      throw error;
    }
    return null;
  }
}

export function getCookieDomain(requestHost?: string | null): string | undefined {
  const rawRoot = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
  const cleanRoot = rawRoot
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    ?.split(':')[0] || 'localhost';

  if (requestHost) {
    const cleanHost = requestHost.trim().toLowerCase().split(':')[0] || '';
    const isLocalHost =
      cleanHost.includes('localhost') || cleanHost.includes('127.0.0.1');
    const isVercelHost = cleanHost.endsWith('.vercel.app');

    // Fail loud, never silently host-only, on a production custom
    // domain. A host-only cookie set on app.<root> can never be read
    // by <workspace>.<root>, so issuing one looks like a successful
    // login on the app host and then fails on every tenant host —
    // which feeds bounces into the login ↔ home loop. A loud error
    // at login time (logged server-side, surfaced by the route's
    // error path) is strictly better than that silent loop.
    // Scoped so local dev and previews are untouched: localhost and
    // *.vercel.app deployments serve tenant paths on the same host,
    // so a host-only cookie works there, and non-production callers
    // keep the old silent fallback.
    if (process.env.NODE_ENV === 'production' && !isLocalHost && !isVercelHost) {
      const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
      const effectiveBase = (cookieDomain ? cookieDomain.replace(/^\./, '') : cleanRoot)
        .toLowerCase();
      const effectiveIsUsable =
        !effectiveBase.includes('localhost') &&
        !effectiveBase.includes('127.0.0.1') &&
        !effectiveBase.endsWith('.vercel.app');
      const coversHost =
        cleanHost === effectiveBase || cleanHost.endsWith(`.${effectiveBase}`);
      if (!effectiveIsUsable || !coversHost) {
        console.error(
          '[auth] getCookieDomain: refusing to issue a host-only session cookie in production — ' +
            'the cookie domain cannot cover tenant subdomains for this host. ' +
            'Check NEXT_PUBLIC_ROOT_DOMAIN and COOKIE_DOMAIN.',
          { host: cleanHost, rootDomain: cleanRoot, cookieDomain: cookieDomain || null }
        );
        throw new Error(
          'Session cookie domain cannot cover tenant subdomains for this host; ' +
            'refusing to issue a host-only fbup_session cookie in production. ' +
            'Check NEXT_PUBLIC_ROOT_DOMAIN and COOKIE_DOMAIN.'
        );
      }
      return cookieDomain || `.${cleanRoot}`;
    }

    if (
      isLocalHost ||
      isVercelHost ||
      (cleanHost !== cleanRoot && !cleanHost.endsWith(`.${cleanRoot}`))
    ) {
      return undefined;
    }
  }

  if (
    cleanRoot.includes('localhost') ||
    cleanRoot.includes('127.0.0.1') ||
    cleanRoot.endsWith('.vercel.app')
  ) {
    return undefined;
  }

  return process.env.COOKIE_DOMAIN?.trim() || `.${cleanRoot}`;
}
