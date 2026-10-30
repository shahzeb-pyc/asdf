import { RESERVED_SUBDOMAINS, type ReservedSubdomain } from './user.js';

export interface SubdomainExtractionResult {
  hostname: string;
  subdomain: string | null;
  isApex: boolean;
  isReserved: boolean;
}

export function extractSubdomain(
  hostHeader: string | null | undefined,
  rootDomain: string = 'fbuploadpro.com'
): SubdomainExtractionResult {
  if (!hostHeader) {
    return {
      hostname: '',
      subdomain: null,
      isApex: true,
      isReserved: false,
    };
  }

  // Strip port if present (e.g. client.localhost:3000 -> client.localhost)
  const normalizedHost = hostHeader.toLowerCase().split(':')[0]!;
  const normalizedRoot = rootDomain.toLowerCase().split(':')[0]!;

  // Handle localhost apex or raw IP
  if (
    normalizedHost === 'localhost' ||
    normalizedHost === '127.0.0.1' ||
    normalizedHost === normalizedRoot ||
    normalizedHost === `www.${normalizedRoot}`
  ) {
    return {
      hostname: normalizedHost,
      subdomain: null,
      isApex: true,
      isReserved: false,
    };
  }

  // Handle localhost subdomains (e.g. acme.localhost)
  if (normalizedHost.endsWith('.localhost')) {
    const subdomain = normalizedHost.slice(0, -'.localhost'.length);
    const isReserved = RESERVED_SUBDOMAINS.includes(subdomain as ReservedSubdomain);
    return {
      hostname: normalizedHost,
      subdomain,
      isApex: false,
      isReserved,
    };
  }

  // Handle domain subdomains (e.g. acme.fbuploadpro.com)
  const domainSuffix = `.${normalizedRoot}`;
  if (normalizedHost.endsWith(domainSuffix)) {
    const subdomain = normalizedHost.slice(0, -domainSuffix.length);
    if (subdomain === 'www') {
      return {
        hostname: normalizedHost,
        subdomain: null,
        isApex: true,
        isReserved: false,
      };
    }
    const isReserved = RESERVED_SUBDOMAINS.includes(subdomain as ReservedSubdomain);
    return {
      hostname: normalizedHost,
      subdomain,
      isApex: false,
      isReserved,
    };
  }

  // Fallback: external or apex host
  return {
    hostname: normalizedHost,
    subdomain: null,
    isApex: true,
    isReserved: false,
  };
}

export function getTenantRewriteUrl(
  subdomain: string,
  pathname: string,
  baseUrl: string | URL
): URL {
  const url = typeof baseUrl === 'string' ? new URL(baseUrl) : new URL(baseUrl.toString());
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const tenantPrefix = `/tenant/${subdomain}`;

  // If already prefixed, do not duplicate
  if (normalizedPath.startsWith(tenantPrefix)) {
    url.pathname = normalizedPath;
  } else if (normalizedPath === '/') {
    url.pathname = tenantPrefix;
  } else {
    url.pathname = `${tenantPrefix}${normalizedPath}`;
  }

  return url;
}

export function buildTenantUrl(
  subdomain: string,
  pathname: string,
  requestUrl: string | URL,
  rootDomain?: string | null
): URL {
  const url =
    typeof requestUrl === 'string'
      ? new URL(requestUrl)
      : new URL(requestUrl.toString());
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const cleanHost = url.hostname.toLowerCase();
  const cleanRoot = (rootDomain || '').trim().toLowerCase().split(':')[0] || '';

  const isLocalHost =
    cleanHost === 'localhost' ||
    cleanHost === '127.0.0.1' ||
    cleanHost.endsWith('.localhost');
  const isVercelPreview = cleanHost.endsWith('.vercel.app');
  const isLocalRoot =
    !cleanRoot ||
    cleanRoot.includes('localhost') ||
    cleanRoot.includes('127.0.0.1');

  if (isLocalHost || isVercelPreview || isLocalRoot) {
    url.pathname =
      normalizedPath === '/'
        ? `/tenant/${subdomain}`
        : `/tenant/${subdomain}${normalizedPath}`;
    url.search = '';
    url.hash = '';
    return url;
  }

  url.host = `${subdomain}.${cleanRoot}`;
  url.pathname = normalizedPath;
  url.search = '';
  url.hash = '';
  return url;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.localhost') ||
    hostname.includes('localhost') ||
    hostname.includes('127.0.0.1')
  );
}

function resolveGatewayHost(cleanRoot: string, isLocal: boolean, port?: string): string {
  if (isLocal && port) {
    return `app.${cleanRoot}:${port}`;
  }
  return `app.${cleanRoot}`;
}

function resolveRequestGatewayBase(
  parsedUrl: URL,
  cleanRoot: string,
  rootPort?: string
): string | null {
  const cleanHost = parsedUrl.hostname.toLowerCase();
  if (cleanHost.endsWith('.vercel.app')) {
    return parsedUrl.origin;
  }

  const isLocalHost = isLocalHostname(cleanHost);
  const isLocalRoot = isLocalHostname(cleanRoot);
  const isLocal = isLocalHost || isLocalRoot;
  const protocol = isLocal ? 'http:' : 'https:';

  let port = rootPort;
  if (!port && parsedUrl.port) {
    port = parsedUrl.port;
  } else if (!port && isLocalHost) {
    port = '3000';
  }

  // Prevent invalid hybrid host creation (e.g. app.fbuploadpro.com:3000) when running on localhost
  // but cleanRoot defaulted to non-local 'fbuploadpro.com'
  const effectiveRoot = isLocalHost && !isLocalRoot ? 'localhost' : cleanRoot;

  const host = resolveGatewayHost(effectiveRoot, isLocal, port);
  return `${protocol}//${host}`;
}

/**
 * Constructs the canonical absolute central application gateway URL (e.g. app.fbuploadpro.com)
 * for authentication, landing, or sign-out redirection per Principle 6 & Principle 15.
 */
export function buildCentralAppUrl(
  pathname: string = '/login?logout=success',
  requestUrl?: string | URL | null,
  rootDomain?: string | null
): URL {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const cleanRoot = (rootDomain || '').trim().toLowerCase().split(':')[0] || 'fbuploadpro.com';
  const rootPort = (rootDomain || '').trim().toLowerCase().split(':')[1];

  if (requestUrl) {
    try {
      const parsedUrl =
        typeof requestUrl === 'string'
          ? new URL(requestUrl)
          : new URL(requestUrl.toString());
      const base = resolveRequestGatewayBase(parsedUrl, cleanRoot, rootPort);
      if (base) {
        return new URL(normalizedPath, base);
      }
    } catch {
      // Fall through to default base construction
    }
  }

  const isLocalRoot = isLocalHostname(cleanRoot);
  const protocol = isLocalRoot ? 'http:' : 'https:';
  const host = resolveGatewayHost(cleanRoot, isLocalRoot, rootPort);

  return new URL(normalizedPath, `${protocol}//${host}`);
}

function extractUrlProtocol(urlInput?: string | URL | null): string {
  if (!urlInput) return 'https:';
  try {
    const parsed = typeof urlInput === 'string' ? new URL(urlInput) : urlInput;
    return parsed.protocol || 'https:';
  } catch {
    return 'https:';
  }
}

function resolveLocalOAuthRedirectUri(
  requestUrl?: string | URL | null,
  appUrlFallback?: string | null,
  callbackPath: string = '/api/auth/facebook/callback'
): string {
  if (appUrlFallback) {
    let cleanAppUrl = appUrlFallback.endsWith('/')
      ? appUrlFallback.slice(0, -1)
      : appUrlFallback;
    // Audit N6: idempotence — a caller that passes the full
    // redirect URI instead of the bare app URL must not get the
    // callback path appended a second time.
    if (cleanAppUrl.endsWith(callbackPath)) {
      cleanAppUrl = cleanAppUrl.slice(0, -callbackPath.length);
    }
    return `${cleanAppUrl}${callbackPath}`;
  }
  if (requestUrl) {
    try {
      const parsed = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
      return `${parsed.origin}${callbackPath}`;
    } catch {
      // Fall through to default local
    }
  }
  return `http://localhost:3000${callbackPath}`;
}

/**
 * Constructs the canonical OAuth callback URL for a workspace subdomain.
 * In production with a custom root domain (e.g. vinsmokemedia.online), returns:
 * https://{subdomain}.{cleanRoot}/api/auth/facebook/callback
 * In local development or environments without root domain, falls back to:
 * {appUrlFallback}/api/auth/facebook/callback or {requestUrl.origin}/api/auth/facebook/callback
 */
export function buildSubdomainOAuthRedirectUri(
  subdomain: string,
  requestUrl?: string | URL | null,
  rootDomain?: string | null,
  appUrlFallback?: string | null
): string {
  return buildSubdomainOAuthRedirectUriForCallback(
    subdomain,
    '/api/auth/facebook/callback',
    requestUrl,
    rootDomain,
    appUrlFallback
  );
}

/**
 * Generic form of `buildSubdomainOAuthRedirectUri` for a platform OAuth
 * callback path (e.g. `/api/auth/instagram/callback`). The Facebook
 * helper above delegates to this with its own path, so Facebook output
 * is unchanged. `callbackPath` must be an absolute path.
 */
export function buildSubdomainOAuthRedirectUriForCallback(
  subdomain: string,
  callbackPath: string,
  requestUrl?: string | URL | null,
  rootDomain?: string | null,
  appUrlFallback?: string | null
): string {
  const cleanRoot = (rootDomain || '').trim().toLowerCase().split(':')[0] || '';
  if (!cleanRoot || isLocalHostname(cleanRoot)) {
    return resolveLocalOAuthRedirectUri(requestUrl, appUrlFallback, callbackPath);
  }

  const protocol = extractUrlProtocol(requestUrl);
  return `${protocol}//${subdomain}.${cleanRoot}${callbackPath}`;
}

/**
 * Per-platform Accounts landing path (no tenant prefix — callers add
 * `/tenant/<subdomain>` via `buildTenantUrl` / `buildPlatformAccountsUrl`).
 * Facebook keeps the historic `/accounts`; every other platform has its
 * own accounts page. Unknown platforms fall back to Facebook's path,
 * exactly as the framework did before this mapping existed.
 */
export function getPlatformAccountsPath(platform: string): string {
  switch (platform) {
    case 'instagram':
      return '/instagram/accounts';
    case 'threads':
      return '/threads/accounts';
    case 'tiktok':
      return '/tiktok/accounts';
    case 'x':
      return '/x/accounts';
    case 'youtube':
      return '/youtube/accounts';
    default:
      return '/accounts';
  }
}

/**
 * Tenant Accounts landing URL for a platform, following the same
 * host rules as `buildTenantUrl` (localhost/preview keep the request
 * origin with a `/tenant/<subdomain>` prefix; production uses the
 * workspace subdomain host).
 */
export function buildPlatformAccountsUrl(
  subdomain: string,
  platform: string,
  requestUrl: string | URL,
  rootDomain?: string | null
): URL {
  return buildTenantUrl(
    subdomain,
    getPlatformAccountsPath(platform),
    requestUrl,
    rootDomain
  );
}


