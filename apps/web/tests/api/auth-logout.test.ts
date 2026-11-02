import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as handleLogoutPost, GET as handleLogoutGet } from '../../src/app/api/auth/logout/route';
import { authenticateTenantRoute } from '../../src/lib/route-auth';

function logoutRequest(url: string, method = 'POST', host?: string): NextRequest {
  // NOTE: a manually constructed NextRequest does NOT populate the
  // Host header from its URL; real runtime requests always carry
  // it, so set it explicitly to exercise the host-dependent clears.
  return new NextRequest(url, {
    method,
    headers: host ? { host } : {},
  });
}

function setCookieHeaders(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function clearForDomain(clears: string[], domain: string | null): boolean {
  return clears.some((header) => {
    if (!header.includes('fbup_session=;')) return false;
    if (!header.includes('Path=/')) return false;
    if (!header.includes('Max-Age=0')) return false;
    if (domain === null) return !header.includes('Domain=');
    return header.includes(`Domain=${domain}`);
  });
}

/**
 * Logout cookie clearing (session-global-check spec §7): sign-out
 * must clear BOTH fbup_session copies (shared-domain AND host-only)
 * on every host shape, must never 500 on domain resolution, and
 * must leave no sendable session cookie behind afterwards.
 */
describe('POST /api/auth/logout', () => {
  const originalRoot = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
    delete process.env.COOKIE_DOMAIN;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    else process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalRoot;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it('clears host-only, shared-domain, and exact-host copies on a tenant host', async () => {
    const res = await handleLogoutPost(
      logoutRequest('https://creatorstack10.fbuploadpro.com/api/auth/logout', 'POST', 'creatorstack10.fbuploadpro.com')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.redirectUrl).toBe('https://app.fbuploadpro.com/login?logout=success');

    const clears = setCookieHeaders(res);
    expect(clearForDomain(clears, null)).toBe(true);
    expect(clearForDomain(clears, '.fbuploadpro.com')).toBe(true);
    expect(clearForDomain(clears, 'creatorstack10.fbuploadpro.com')).toBe(true);
  });

  it('clears only the host-only copy on localhost', async () => {
    const res = await handleLogoutPost(
      logoutRequest('http://localhost:3000/api/auth/logout', 'POST', 'localhost:3000')
    );
    expect(res.status).toBe(200);
    const clears = setCookieHeaders(res);
    expect(clears.length).toBe(1);
    expect(clearForDomain(clears, null)).toBe(true);
  });

  it('never 500s on an uncovered production host — still 200 with clears', async () => {
    // The old code threw from the domain resolver here and answered
    // 500 with NOTHING cleared: the exact hole this spec closes.
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const res = await handleLogoutPost(
      logoutRequest('https://other.example.com/api/auth/logout', 'POST', 'other.example.com')
    );
    expect(res.status).toBe(200);
    const clears = setCookieHeaders(res);
    expect(clearForDomain(clears, null)).toBe(true);
    expect(clearForDomain(clears, 'other.example.com')).toBe(true);
  });

  it('answers 200 with a login redirect when called without a request', async () => {
    const res = await handleLogoutPost();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.redirectUrl).toBe('https://app.fbuploadpro.com/login?logout=success');
  });

  it('leaves no sendable session cookie: jar simulation + post-logout 401', async () => {
    // Jar holds both copies a login could have set on the tenant host.
    type JarEntry = { domain: string | null; value: string };
    const jar: JarEntry[] = [
      { domain: '.fbuploadpro.com', value: 'old-shared-copy' },
      { domain: null, value: 'old-host-only-copy' },
    ];
    const res = await handleLogoutPost(
      logoutRequest('https://creatorstack10.fbuploadpro.com/api/auth/logout', 'POST', 'creatorstack10.fbuploadpro.com')
    );
    const clears = setCookieHeaders(res);
    // Apply the clears: a clear deletes jar entries whose Domain
    // matches (host-only clear deletes host-only entries).
    const remaining = jar.filter((entry) => {
      const deleted = clears.some((header) => {
        if (!header.includes('fbup_session=;') || !header.includes('Max-Age=0')) return false;
        const match = header.match(/Domain=([^;]+)/);
        if (!match) return entry.domain === null;
        return entry.domain === match[1];
      });
      return !deleted;
    });
    expect(remaining).toEqual([]);

    // With no cookie left, the next API call is a proven-dead 401.
    const authed = await authenticateTenantRoute(
      new NextRequest('https://creatorstack10.fbuploadpro.com/api/tenant/creatorstack10/pages', {
        method: 'GET',
      }),
      'creatorstack10'
    );
    expect(authed.errorResponse?.status).toBe(401);
  });
});

describe('GET /api/auth/logout (degraded-network landing pad)', () => {
  const originalRoot = process.env.NEXT_PUBLIC_ROOT_DOMAIN;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
    delete process.env.COOKIE_DOMAIN;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    else process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalRoot;
  });

  it('clears and 307-redirects to the central login page', async () => {
    const res = await handleLogoutGet(
      logoutRequest('https://creatorstack10.fbuploadpro.com/api/auth/logout', 'GET', 'creatorstack10.fbuploadpro.com')
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://app.fbuploadpro.com/login?logout=success'
    );
    const clears = setCookieHeaders(res);
    expect(clearForDomain(clears, null)).toBe(true);
    expect(clearForDomain(clears, '.fbuploadpro.com')).toBe(true);
    expect(clearForDomain(clears, 'creatorstack10.fbuploadpro.com')).toBe(true);
  });
});
