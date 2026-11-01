import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  getSessionSecret,
  extractSubdomain,
  getTenantRewriteUrl,
  verifySessionToken,
  canAccessTenant,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import {
  applyCspHeaders,
  buildContentSecurityPolicy,
  CSP_HEADER_NAME,
  generateNonce,
} from './lib/csp';
import { purgeHostOnlySessionCookie } from './lib/auth/session';
import { isTenantSubdomainHost } from '@/lib/tenant-href';

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * 1. /_next (Next.js internals)
     * 2. /favicon.ico, /icon, /apple-icon, /robots.txt, /sitemap.xml, static files with extensions (.svg, .png, .ico, etc.)
     */
    '/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};

function extractToken(request: NextRequest): string | null {
  const cookieToken = request.cookies.get('fbup_session')?.value;
  if (cookieToken) return cookieToken;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  return null;
}

async function resolveSession(
  request: NextRequest,
  sessionSecret: string
): Promise<SessionPayload | null> {
  const token = extractToken(request);
  if (!token) return null;
  try {
    return await verifySessionToken(token, sessionSecret);
  } catch {
    return null;
  }
}

function buildAuthenticatedWorkspaceRedirect(
  request: NextRequest,
  session: SessionPayload,
  host: string,
  rootDomain: string
): NextResponse {
  const cleanHost = host.toLowerCase().split(':')[0] || '';
  const isLocalRoot = rootDomain.includes('localhost') || rootDomain.includes('127.0.0.1');
  const isLocalHost = cleanHost.includes('localhost') || cleanHost.includes('127.0.0.1');

  if (cleanHost.endsWith('.vercel.app') || (isLocalRoot && !isLocalHost)) {
    return NextResponse.redirect(new URL(`/tenant/${session.subdomain}`, request.url));
  }

  const workspaceUrl = new URL(request.url);
  workspaceUrl.host = `${session.subdomain}.${rootDomain}`;
  workspaceUrl.pathname = '/';
  workspaceUrl.search = '';
  workspaceUrl.hash = '';
  return NextResponse.redirect(workspaceUrl);
}

// Admin landing mirror of buildAuthenticatedWorkspaceRedirect: an
// admin's entry-route redirect goes to the admin section
// (/admin/subscriptions), never to a workspace URL. The admin
// section has one address on every host, so there is no
// tenant-billing vs preview-path split anymore.
function buildAdminSectionRedirect(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL('/admin/subscriptions', request.url));
}

/**
 * Old-admin-URL compat map (shell isolation §4.3): an admin
 * requesting an old tenant location lands on the equivalent new
 * admin page, never on tenant content. Bare tenant-host paths
 * (/billing, /sellers) and /tenant/<sub> prefixed paths map alike
 * — the leading /tenant/<segment> is stripped before matching, and
 * any other tenant path lands on the panel home (subscriptions).
 * Old admin API paths have NO compat layer (they 404).
 */
/**
 * Strip trailing slashes with a plain scan, not a regex: Sonar's
 * super-linear-backtracking rule flags the `/\/+$/` pattern.
 * Exactly equivalent to `value.length > 1 ? value.replace(/\/+$/, '') : value`.
 */
function stripTrailingSlashes(value: string): string {
  if (value.length <= 1) return value;
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function mapOldAdminTenantPathToAdmin(pathname: string): string {
  let tenantPath = pathname;
  const tenantPrefixMatch = pathname.match(/^\/tenant\/[^/]+(\/.*)?$/);
  if (tenantPrefixMatch) {
    tenantPath = tenantPrefixMatch[1] ?? '/';
    if (tenantPath === '') tenantPath = '/';
  }
  const normalized = stripTrailingSlashes(tenantPath);
  if (normalized === '/billing') return '/admin/subscriptions';
  if (normalized === '/sellers') return '/admin/sellers';
  const sellerDetail = normalized.match(/^\/sellers\/(.+)$/);
  if (sellerDetail) return `/admin/sellers/${sellerDetail[1]}`;
  return '/admin/subscriptions';
}

function isReturnUrlTargetingTenant(
  returnUrlParam: string | null | undefined,
  tenantSubdomain: string,
  rootDomain: string
): boolean {
  if (!returnUrlParam) return false;
  try {
    const parsed = new URL(returnUrlParam);
    const host = parsed.hostname.toLowerCase();
    const cleanRoot = rootDomain.toLowerCase().split(':')[0] || '';
    const expectedHost = `${tenantSubdomain}.${cleanRoot}`.toLowerCase();
    if (host === expectedHost) return true;
    if (
      host.endsWith('.vercel.app') &&
      (parsed.pathname === `/tenant/${tenantSubdomain}` ||
        parsed.pathname.startsWith(`/tenant/${tenantSubdomain}/`))
    ) {
      return true;
    }
  } catch {
    if (
      returnUrlParam === `/tenant/${tenantSubdomain}` ||
      returnUrlParam.startsWith(`/tenant/${tenantSubdomain}/`)
    ) {
      return true;
    }
  }
  return false;
}

function stripUserHeaders(request: NextRequest): Headers {
  const requestHeaders = new Headers(request.headers);
  const keysToRemove: string[] = [];
  requestHeaders.forEach((_, key) => {
    if (key.toLowerCase().startsWith('x-user-')) {
      keysToRemove.push(key);
    }
  });
  for (const key of keysToRemove) {
    requestHeaders.delete(key);
  }
  return requestHeaders;
}

// Next.js derives the nonce for its own framework scripts from the CSP
// header carried on the forwarded REQUEST (named by CSP_HEADER_NAME), not
// from x-nonce — Next 16 has no reader of x-nonce. Both are set here with
// the same nonce: the request CSP header drives Next's renderer, and
// x-nonce stays for app code that reads the nonce via headers() (e.g. a
// future inline script). Headers.set overwrites any client-supplied CSP
// request header, so clients cannot inject their own policy or nonce.
function setCspRequestHeaders(requestHeaders: Headers, nonce: string): Headers {
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(CSP_HEADER_NAME, buildContentSecurityPolicy(nonce));
  return requestHeaders;
}

function buildTenantHeaders(
  request: NextRequest,
  subdomain: string,
  pathname: string,
  session: SessionPayload
): Headers {
  const requestHeaders = stripUserHeaders(request);
  requestHeaders.set('x-tenant-subdomain', subdomain);
  requestHeaders.set('x-pathname', pathname);
  requestHeaders.set('x-user-id', session.userId);
  requestHeaders.set('x-user-role', session.role);
  requestHeaders.set('x-user-email', session.email);
  requestHeaders.set('x-user-subdomain', session.subdomain);
  return requestHeaders;
}

function applyNoStoreHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF defence-in-depth for /api routes (spec 139). SameSite=Lax on the
// session cookie already blocks most cross-site cookie sending, but it
// does not cover every same-site subdomain takeover / non-cookie path.
// For mutating requests, when a browser supplies an Origin header, the
// origin must be the request host itself or the configured root domain
// (or a subdomain of it). Requests with no Origin header are NOT
// blocked: Origin is a browser header, so non-browser clients — the
// platform deauthorize / data-deletion webhooks
// (/api/connect/[platform]/deauthorize and .../data-deletion), which
// are unauthenticated server-to-server calls — typically send none.
// /api/csp-report is the exception that proves the rule: it IS called
// by browsers, but a CSP report is generated for the page that served
// the policy, so its Origin (when sent) is that page's own origin —
// the apex or a tenant subdomain — which passes this check; and
// implementations that omit Origin pass via the missing-Origin rule.
function isAllowedApiOrigin(origin: string, host: string, rootDomain: string): boolean {
  let originHostname: string;
  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    originHostname = parsed.hostname.toLowerCase();
    originHost = parsed.host.toLowerCase();
    if (!originHostname) return false;
  } catch {
    return false;
  }
  const requestHost = host.toLowerCase().trim();
  const requestHostname = requestHost.split(':')[0] || '';
  const cleanRoot = rootDomain.toLowerCase().split(':')[0] || '';
  if (originHost === requestHost) return true;
  if (originHostname === requestHostname) return true;
  if (cleanRoot && originHostname === cleanRoot) return true;
  if (cleanRoot && originHostname.endsWith(`.${cleanRoot}`)) return true;
  return false;
}

function buildLoginRedirectWithCleanReturn(
  request: NextRequest,
  targetHost?: string
): NextResponse {
  const loginUrl = new URL(targetHost ? request.url : '/login', request.url);
  if (targetHost) {
    loginUrl.host = targetHost;
    loginUrl.pathname = '/login';
  }
  const cleanReturnUrl = new URL(request.url);
  cleanReturnUrl.searchParams.delete('returnUrl');
  loginUrl.searchParams.set('returnUrl', cleanReturnUrl.toString());
  return NextResponse.redirect(loginUrl, 307);
}

function handleDirectTenantPathOnApex(
  request: NextRequest,
  pathSubdomain: string,
  pathname: string,
  session: SessionPayload | null,
  nonce: string
): NextResponse {
  if (!session) {
    return buildLoginRedirectWithCleanReturn(request);
  }

  if (session.status === 'suspended') {
    return NextResponse.redirect(new URL('/account-suspended', request.url), 307);
  }

  // Sellers have no workspace: a seller session on any /tenant/
  // path belongs on /seller, never on a workspace redirect (their
  // session subdomain is only an email-derived fallback).
  if (session.role === 'seller') {
    return NextResponse.redirect(new URL('/seller', request.url), 307);
  }

  const access = canAccessTenant(session, pathSubdomain);
  if (!access.allowed) {
    if (access.reason === 'mismatch') {
      // Guard (a): when the request host is already the session's own
      // subdomain host, the bounce lands on the CLEAN home, not the
      // prefixed home — one redirect instead of guard → prefixed →
      // clean. (Under correct root-domain config this branch never
      // sees a tenant-own host; it only fires when the host fell
      // through to the apex branch, e.g. a misconfigured root
      // domain. The query string, including notice, is preserved
      // exactly as the prefixed form did.)
      const requestHost = request.headers.get('host') || '';
      if (isTenantSubdomainHost(requestHost, session.subdomain)) {
        const cleanHomeUrl = new URL('/', request.url);
        cleanHomeUrl.searchParams.set('notice', 'tenant_redirect');
        return NextResponse.redirect(cleanHomeUrl, 307);
      }
      const redirectUrl = new URL(`/tenant/${session.subdomain}`, request.url);
      redirectUrl.searchParams.set('notice', 'tenant_redirect');
      return NextResponse.redirect(redirectUrl, 307);
    }
    return NextResponse.redirect(new URL('/login', request.url), 307);
  }

  // Admins never render tenant content: an admin on any /tenant/
  // path (old bookmark, deep link, or tenant home) goes to the
  // equivalent admin-section page via the compat map. This runs
  // BEFORE the tenant rewrite below, and replaces the old
  // admin-home special case (which only covered the Home route).
  if (session.role === 'admin') {
    return NextResponse.redirect(
      new URL(mapOldAdminTenantPathToAdmin(pathname), request.url),
      307
    );
  }

  // Deleted admin-only sellers routes keep their old non-admin
  // behavior (the deleted pages redirected non-admins home): a
  // user on a sellers path goes home instead of hitting a 404.
  // Admins and sellers cannot reach here (returned above).
  if (
    pathname === `/tenant/${pathSubdomain}/sellers` ||
    pathname.startsWith(`/tenant/${pathSubdomain}/sellers/`)
  ) {
    return NextResponse.redirect(new URL(`/tenant/${pathSubdomain}`, request.url), 307);
  }

  const requestHeaders = buildTenantHeaders(request, pathSubdomain, pathname, session);
  setCspRequestHeaders(requestHeaders, nonce);
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  return applyNoStoreHeaders(response);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const nonce = generateNonce();
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') || '';
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
  const sessionSecret = getSessionSecret();

  // System API routes and public static bypass tenant rewriting.
  // /privacy is public on EVERY host (app, apex, and every tenant
  // subdomain as https://<workspace>.fbuploadpro.com/privacy): it must
  // never hit the tenant session/access checks below, which would
  // redirect an unauthenticated visitor to the app login. Passing it
  // through here serves the root /privacy route unchanged, with no
  // tenant rewrite and no user headers.
  if (
    pathname.startsWith('/api') ||
    pathname === '/privacy' ||
    pathname === '/account-suspended' ||
    pathname === '/icon' ||
    pathname === '/apple-icon' ||
    pathname === '/favicon.ico' ||
    pathname.endsWith('.ico')
  ) {
    const isApiRoute = pathname.startsWith('/api');
    if (isApiRoute && MUTATING_METHODS.has(request.method.toUpperCase())) {
      const origin = request.headers.get('origin');
      if (origin && !isAllowedApiOrigin(origin, host, rootDomain)) {
        return applyCspHeaders(
          applyNoStoreHeaders(
            NextResponse.json({ error: 'Forbidden: origin mismatch' }, { status: 403 })
          ),
          nonce
        );
      }
    }
    const requestHeaders = stripUserHeaders(request);
    setCspRequestHeaders(requestHeaders, nonce);
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    if (isApiRoute) {
      applyNoStoreHeaders(response);
    }
    return applyCspHeaders(response, nonce);
  }

  // Extract subdomain and determine routing target
  const { subdomain, isApex, isReserved } = extractSubdomain(host, rootDomain);

  // If apex domain or reserved system subdomain, serve root routes
  if (isApex || isReserved || !subdomain) {
    if (isApex && pathname.startsWith('/tenant/')) {
      const pathSubdomain = pathname.split('/')[2];
      if (pathSubdomain) {
        const session = await resolveSession(request, sessionSecret);
        return applyCspHeaders(
          handleDirectTenantPathOnApex(request, pathSubdomain, pathname, session, nonce),
          nonce
        );
      }
    }

    if (subdomain === 'app' || isApex) {
      const session = await resolveSession(request, sessionSecret);
      const isLogoutSuccess = request.nextUrl.searchParams.get('logout') === 'success';
      // Sellers have no workspace: seller sessions on the app
      // host that are not already on /seller belong on /seller
      // (entry routes, /tenant/ paths, stray root paths alike),
      // and a suspended seller belongs on the suspended page.
      // Logout-success is exempt — the cookie is being cleared.
      if (session && session.role === 'seller' && !isLogoutSuccess) {
        if (session.status === 'suspended') {
          return applyCspHeaders(
            NextResponse.redirect(new URL('/account-suspended', request.url), 307),
            nonce
          );
        }
        if (!pathname.startsWith('/seller')) {
          return applyCspHeaders(NextResponse.redirect(new URL('/seller', request.url), 307), nonce);
        }
      }
      // Admin section guard (shell isolation): /admin/* is the
      // admin section, not a tenant route. Admins pass through to
      // the admin layout (which guards the role); a suspended
      // session goes to the suspended page; unauthenticated
      // visitors go to login with the admin path as returnUrl; a
      // user goes to their own workspace home. Sellers cannot reach
      // here (redirected to /seller above). Logout-success is
      // exempt — the cookie is being cleared.
      if (!isLogoutSuccess && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
        if (session && session.status === 'suspended') {
          return applyCspHeaders(
            NextResponse.redirect(new URL('/account-suspended', request.url), 307),
            nonce
          );
        }
        if (!session) {
          const loginUrl = new URL('/login', request.url);
          loginUrl.searchParams.set('returnUrl', pathname);
          return applyCspHeaders(NextResponse.redirect(loginUrl, 307), nonce);
        }
        if (session.role !== 'admin') {
          return applyCspHeaders(
            buildAuthenticatedWorkspaceRedirect(request, session, host, rootDomain),
            nonce
          );
        }
        // Admin falls through to the admin layout.
      }
      const isEntryOrAuthRoute =
        pathname === '/' || pathname === '/login' || pathname === '/signup';

      if (session && session.status !== 'suspended' && !isLogoutSuccess && isEntryOrAuthRoute) {
        const returnUrlParam = request.nextUrl.searchParams.get('returnUrl');
        const isBouncedFromWorkspace = isReturnUrlTargetingTenant(
          returnUrlParam,
          session.subdomain,
          rootDomain
        );

        if (isBouncedFromWorkspace) {
          // A VERIFIED session must never be destroyed here. The old
          // code served the login page and set clearing cookies for
          // fbup_session (host-only and .<root>), which turned any
          // bounce back to /login into an infinite login ↔ home loop:
          // the tenant sent the user to login with a returnUrl, login
          // destroyed the session, and the next request had no session
          // at all. A bounced user with a valid session belongs on
          // their tenant home, exactly like any other authenticated
          // entry-route visit. Genuinely invalid sessions never reach
          // this branch (resolveSession returns null), so they still
          // land on login untouched.
          //
          // SEND BACK fix: still clear ONLY the host-only (app-address)
          // copy of fbup_session. A user whose only cookie is a stale
          // app-only one would otherwise bounce forever after this
          // fix, with no way to reach the login form: the redirect
          // below sends them to the tenant, the tenant cannot read
          // the app-only cookie, and they bounce back here again.
          // Clearing the host-only copy lets that user land on the
          // login form next time and log in fresh for a working
          // shared-domain cookie. The purge sets no Domain attribute,
          // so a good shared-domain (.fbuploadpro.com) cookie is a
          // separate entry and SURVIVES — a user with a good shared
          // cookie is unaffected. Scoped to requests actually from
          // production custom hosts only: on localhost / vercel
          // preview the host-only cookie IS the session, so purging
          // it there would log those users out.
          //
          // SECOND SEND BACK fix: gate the purge on the REQUEST HOST
          // as well as the configured root domain. The previous gate
          // only looked at the root domain, but previews are built
          // with the production config, so a preview deployment serves
          // on a *.vercel.app host while NEXT_PUBLIC_ROOT_DOMAIN is
          // still fbuploadpro.com — the old gate passed and the purge
          // deleted the preview user's ONLY session cookie. Purge
          // only when the request actually came from a production
          // custom host: the host is the root or a subdomain of it,
          // and it is not localhost, 127.0.0.1, or a *.vercel.app
          // preview host. This mirrors the host test in
          // lib/auth/clients.ts getCookieDomain, which cannot be
          // imported into Edge middleware (it imports
          // @supabase/supabase-js), so the test is mirrored inline.
          const response = buildAuthenticatedWorkspaceRedirect(request, session, host, rootDomain);
          const cleanHost = host.toLowerCase().split(':')[0] || '';
          const cleanRoot = rootDomain.toLowerCase().split(':')[0] || '';
          const isLocalOrPreviewHost =
            cleanHost.includes('localhost') ||
            cleanHost.includes('127.0.0.1') ||
            cleanHost.endsWith('.vercel.app');
          const isProductionCustomHost =
            !!cleanRoot &&
            !isLocalOrPreviewHost &&
            (cleanHost === cleanRoot || cleanHost.endsWith(`.${cleanRoot}`));
          if (isProductionCustomHost) {
            purgeHostOnlySessionCookie(response);
          }
          return applyCspHeaders(response, nonce);
        }

        // Admins never land on Home from an entry route: an
        // already-authenticated admin session goes straight to the
        // admin section instead of the workspace root.
        if (session.role === 'admin') {
          return applyCspHeaders(buildAdminSectionRedirect(request), nonce);
        }

        return applyCspHeaders(
          buildAuthenticatedWorkspaceRedirect(request, session, host, rootDomain),
          nonce
        );
      }

      if (!session && subdomain === 'app' && pathname === '/') {
        return applyCspHeaders(NextResponse.redirect(new URL('/login', request.url)), nonce);
      }

      if (isLogoutSuccess) {
        const logoutHeaders = stripUserHeaders(request);
        setCspRequestHeaders(logoutHeaders, nonce);
        const response = NextResponse.next({
          request: {
            headers: logoutHeaders,
          },
        });
        response.cookies.set('fbup_session', '', {
          path: '/',
          maxAge: 0,
          httpOnly: true,
          sameSite: 'lax',
        });
        const cleanRoot = rootDomain.toLowerCase().split(':')[0];
        if (cleanRoot && !cleanRoot.includes('localhost') && !cleanRoot.includes('127.0.0.1')) {
          response.cookies.set('fbup_session', '', {
            path: '/',
            domain: `.${cleanRoot}`,
            maxAge: 0,
            httpOnly: true,
            sameSite: 'lax',
          });
        }
        return applyCspHeaders(response, nonce);
      }
    }

    const apexHeaders = stripUserHeaders(request);
    setCspRequestHeaders(apexHeaders, nonce);
    return applyCspHeaders(
      NextResponse.next({
        request: {
          headers: apexHeaders,
        },
      }),
      nonce
    );
  }

  // Customer tenant subdomains only host private workspace routes (/, /accounts, etc.).
  const isAuthRoute =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname === '/verify-otp';

  if (isAuthRoute) {
    const gatewayUrl = new URL(request.url);
    gatewayUrl.host = `app.${rootDomain}`;
    return applyCspHeaders(NextResponse.redirect(gatewayUrl, 307), nonce);
  }

  const session = await resolveSession(request, sessionSecret);

  if (!session) {
    return applyCspHeaders(
      buildLoginRedirectWithCleanReturn(request, `app.${rootDomain}`),
      nonce
    );
  }

  if (session.status === 'suspended') {
    return applyCspHeaders(
      NextResponse.redirect(new URL('/account-suspended', request.url), 307),
      nonce
    );
  }

  // Sellers have no workspace: a seller session on a tenant host
  // belongs on the app host's /seller, never on a workspace
  // (their session subdomain is only an email-derived fallback,
  // so the mismatch redirect below would send them to a
  // workspace that does not exist).
  if (session.role === 'seller') {
    const sellerUrl = new URL(request.url);
    sellerUrl.host = `app.${rootDomain}`;
    sellerUrl.pathname = '/seller';
    sellerUrl.search = '';
    sellerUrl.hash = '';
    return applyCspHeaders(NextResponse.redirect(sellerUrl, 307), nonce);
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    if (access.reason === 'mismatch') {
      const authorizedUrl = new URL(request.url);
      authorizedUrl.host = `${session.subdomain}.${rootDomain}`;
      // Guard (b): the target host is by construction the session's
      // own host, so if the preserved path still carries the
      // session's own /tenant/<subdomain> prefix, strip it here —
      // the bounce is a single redirect to the clean path, not
      // guard → prefixed → clean. Any other tenant's prefix is
      // left untouched (it is not the session's own path).
      const ownPrefix = `/tenant/${session.subdomain}`;
      const lowerPath = authorizedUrl.pathname.toLowerCase();
      if (lowerPath === ownPrefix.toLowerCase()) {
        authorizedUrl.pathname = '/';
      } else if (lowerPath.startsWith(`${ownPrefix.toLowerCase()}/`)) {
        authorizedUrl.pathname = authorizedUrl.pathname.slice(ownPrefix.length);
      }
      authorizedUrl.searchParams.set('notice', 'tenant_redirect');
      return applyCspHeaders(NextResponse.redirect(authorizedUrl, 307), nonce);
    }
    return applyCspHeaders(NextResponse.redirect(new URL('/login', request.url), 307), nonce);
  }

  // Admin section on a tenant host: /admin/* is a root route, not
  // a tenant route — it must NOT be rewritten to /tenant/<sub>/*
  // below. Admins pass through (the admin layout guards the role);
  // a user on /admin/* goes to their own tenant home (the mismatch
  // guard above already ensured this is an allowed host); sellers
  // were redirected above.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (session.role === 'admin') {
      const adminHeaders = stripUserHeaders(request);
      setCspRequestHeaders(adminHeaders, nonce);
      return applyCspHeaders(
        NextResponse.next({
          request: { headers: adminHeaders },
        }),
        nonce
      );
    }
    return applyCspHeaders(NextResponse.redirect(new URL('/', request.url), 307), nonce);
  }

  // Admins never render tenant content: an admin on any tenant-host
  // path (bare /billing, /sellers, any user section, or the old
  // prefixed form) goes to the equivalent admin-section page via
  // the compat map. This sits alongside the old admin-home check
  // and BEFORE URL normalization below: an admin requesting an old
  // tenant URL on their own host must reach /admin/*, never
  // normalize to the old tenant path first.
  if (session.role === 'admin') {
    return applyCspHeaders(
      NextResponse.redirect(
        new URL(mapOldAdminTenantPathToAdmin(pathname), request.url),
        307
      ),
      nonce
    );
  }

  // Deleted admin-only sellers routes keep their old non-admin
  // behavior: a user on a sellers path (bare or prefixed) goes to
  // their tenant home instead of hitting a 404. Runs before
  // normalization below so a prefixed sellers path does not
  // normalize first. Admins and sellers cannot reach here
  // (returned above).
  if (
    pathname === '/sellers' ||
    pathname.startsWith('/sellers/') ||
    pathname === `/tenant/${subdomain}/sellers` ||
    pathname.startsWith(`/tenant/${subdomain}/sellers/`)
  ) {
    return applyCspHeaders(NextResponse.redirect(new URL('/', request.url), 307), nonce);
  }

  // URL normalization: on a tenant's OWN subdomain host, the
  // /tenant/<subdomain>/ prefix must never appear in the address
  // bar. When the request path carries the tenant's own prefix —
  // and the path subdomain, the host subdomain, and the session
  // subdomain all match — redirect (307) to the clean path, with
  // the query string (including notice) preserved. This runs AFTER
  // the mismatch guard above, so mismatched requests keep the
  // guard's behavior unchanged, and it never fires on apex,
  // preview, or localhost-root hosts (those never reach this
  // tenant-host branch), where the prefixed form stays required.
  // No redirect loop: the clean target rewrites and serves.
  if (
    (pathname === `/tenant/${subdomain}` || pathname.startsWith(`/tenant/${subdomain}/`)) &&
    session.subdomain === subdomain &&
    isTenantSubdomainHost(host, subdomain)
  ) {
    const cleanUrl = new URL(request.url);
    const remainder = pathname.slice(`/tenant/${subdomain}`.length);
    cleanUrl.pathname = remainder === '' || remainder === '/' ? '/' : remainder;
    return applyCspHeaders(NextResponse.redirect(cleanUrl, 307), nonce);
  }

  // Rewrite to tenant workspace path (/tenant/[subdomain]/*)
  const rewriteUrl = getTenantRewriteUrl(subdomain, pathname, request.url);
  const requestHeaders = buildTenantHeaders(request, subdomain, pathname, session);
  setCspRequestHeaders(requestHeaders, nonce);

  const response = NextResponse.rewrite(rewriteUrl, {
    request: {
      headers: requestHeaders,
    },
  });

  return applyCspHeaders(applyNoStoreHeaders(response), nonce);
}
