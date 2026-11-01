/**
 * Tenant-aware navigation hrefs.
 *
 * On tenant subdomains (e.g. shahzebpyc.fbuploadpro.com) the middleware
 * rewrites clean paths (/accounts) to the internal /tenant/[subdomain]
 * route, so links should use clean paths to keep the address bar clean.
 * On Vercel previews (*.vercel.app) and apex-domain access there is no
 * subdomain to rewrite from, so the /tenant/[subdomain] prefix is required.
 */

/** Build a navigation href for a tenant workspace path. */
export function buildTenantHref(
  subdomain: string,
  path: string,
  useCleanPaths: boolean
): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (useCleanPaths) return cleanPath;
  return `/tenant/${subdomain}${cleanPath}`;
}

/**
 * Normalize a pathname for active-state comparisons.
 * Strips the /tenant/[subdomain] prefix when present so the same check
 * works whether the URL is clean (/accounts) or prefixed
 * (/tenant/shahzebpyc/accounts).
 */
export function normalizeTenantPath(pathname: string, subdomain: string): string {
  const prefix = `/tenant/${subdomain}`;
  if (!pathname) return '/';
  if (pathname === prefix || pathname === `${prefix}/`) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/**
 * True when `hostname` is the tenant's OWN subdomain host: exactly
 * `<subdomain>` (bare) or `<subdomain>.<anything>`. The trailing dot
 * on the prefix form prevents partial-label matches
 * (`creatorstack10x...` is not creatorstack10's host).
 * Case-insensitive; ports are stripped. Pure and client-safe: used
 * by middleware and by click-time navigations, never during server
 * rendering (a window-derived hostname would hydrate differently).
 */
export function isTenantSubdomainHost(hostname: string, subdomain: string): boolean {
  const host = hostname.toLowerCase().split(':')[0];
  const sub = subdomain.toLowerCase();
  return host === sub || host.startsWith(`${sub}.`);
}

/**
 * True when `hostname` carries a swappable subdomain label: a
 * `*.localhost` host with a label before it, or any host with at
 * least three labels that is not a `*.vercel.app` preview. Bare
 * localhost / 127.0.0.1, bare apex hosts (two labels), and previews
 * return false — on those hosts a workspace switch must keep the
 * prefixed `/tenant/<subdomain>` form, because there is no own-host
 * label to swap to. Case-insensitive; ports are stripped.
 */
export function hasSwappableSubdomain(hostname: string): boolean {
  const host = hostname.toLowerCase().split(':')[0];
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (host.endsWith('.vercel.app')) return false;
  if (labels[labels.length - 1] === 'localhost') return labels.length >= 2;
  return labels.length >= 3;
}

/**
 * Server-side: determine whether clean tenant paths can be used for the
 * current request. True only when the request host is exactly the tenant's
 * own subdomain (e.g. shahzebpyc.fbuploadpro.com).
 */
export function shouldUseCleanTenantPaths(
  hostHeader: string | null | undefined,
  subdomain: string,
  rootDomain: string = 'fbuploadpro.com'
): boolean {
  if (!hostHeader || !subdomain) return false;
  const host = hostHeader.toLowerCase().split(':')[0] || '';
  const cleanRoot = rootDomain.toLowerCase().split(':')[0] || '';
  return host === `${subdomain.toLowerCase()}.${cleanRoot}`;
}
