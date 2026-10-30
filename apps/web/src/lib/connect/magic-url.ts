/**
 * Magic-link outcome URLs, built on the app host (spec 136 / the
 * merged magic-link fix — never hardcoded, never the tenant host).
 *
 * The magic-link browser deliberately holds no `fbup_session`, so
 * building these URLs from `request.url` would inherit the tenant
 * host: on that host the login gate fires and the user lands on
 * /login even though the account just connected. This helper builds
 * them on the app host instead.
 *
 * Local / preview behaviour is preserved, mirroring
 * `buildSubdomainOAuthRedirectUri` / `buildTenantUrl`: on localhost
 * (or with no/local root domain) and on Vercel preview hosts the
 * request origin already is the app host, so it is used as-is and
 * existing localhost expectations stay green. In production the app
 * host comes from `NEXT_PUBLIC_APP_URL` when it is a non-local host,
 * else `app.<rootDomain>` — never hardcoded, never the tenant host.
 *
 * Generalised from the Facebook-only `buildMagicConnectUrl` in
 * `app/api/auth/facebook/callback/route.ts` (which now wraps this
 * function with its original signature): the host-derivation rule
 * is identical; only the pathname varies by platform.
 */
export function buildMagicConnectUrl(
  pathname: string,
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
