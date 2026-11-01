import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { middleware } from './middleware';

// Login-cookie-loop fix: a VERIFIED session landing on /login with a
// tenant returnUrl must be redirected to its tenant home — never served
// the login page with clearing cookies, which destroyed the session and
// turned any bounce into an infinite login ↔ home loop. These tests use
// real session tokens (dev secret fallback in the test env) and the real
// middleware, following the session-s1 test pattern.
const DEV_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

async function validSessionToken(): Promise<string> {
  return signSessionToken(
    {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owneruser@gmail.com',
      subdomain: 'acme',
      role: 'user',
      status: 'active',
    },
    DEV_SECRET
  );
}

function requestWithCookie(url: string, token: string | null): NextRequest {
  // In vitest, NextRequest does not populate the Host header from the
  // URL (headers.get('host') is null), but middleware routes on that
  // header — set it explicitly after construction, which the Headers
  // object allows. Production requests always carry a Host header.
  const request = new NextRequest(url, {
    headers: token ? { cookie: `fbup_session=${token}` } : {},
  });
  request.headers.set('host', new URL(url).host);
  return request;
}

describe('middleware bounced-session fix (login-cookie-loop)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'fbuploadpro.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects a valid session with a tenant returnUrl to the tenant home, purging only the host-only cookie', async () => {
    const token = await validSessionToken();
    const response = await middleware(
      requestWithCookie(
        'https://app.fbuploadpro.com/login?returnUrl=https%3A%2F%2Facme.fbuploadpro.com%2F',
        token
      )
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://acme.fbuploadpro.com/');
    // SEND BACK fix: the redirect must ALSO clear just the host-only
    // (app-address) copy of fbup_session, so a user whose only cookie
    // is a stale app-only one can reach the login form and log in
    // fresh instead of bouncing forever. The purge sets no Domain
    // attribute, so it must NOT clear the shared-domain cookie.
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    const purges = setCookies.filter((c) => c.startsWith('fbup_session=;'));
    expect(purges.length).toBe(1);
    expect(purges[0]).toContain('Max-Age=0');
    expect(purges[0]).not.toContain('Domain=');
    expect(setCookies.some((c) => c.includes('Domain='))).toBe(false);
  });

  it('does NOT purge on a preview host with a production root env: the preview host-only cookie IS the session', async () => {
    // SECOND SEND BACK fix: previews are built with the production
    // config (NEXT_PUBLIC_ROOT_DOMAIN=fbuploadpro.com) while serving
    // on a *.vercel.app host. Gating the purge on the configured root
    // alone let it fire here and delete the preview user's ONLY
    // session cookie. The bounced preview user must still get the 307
    // to their same-host tenant path, with zero purges.
    const token = await validSessionToken();
    const response = await middleware(
      requestWithCookie(
        'https://fbuploadpro-git-fix-login-cookie-loop-velocta.vercel.app/login?returnUrl=https%3A%2F%2Ffbuploadpro-git-fix-login-cookie-loop-velocta.vercel.app%2Ftenant%2Facme',
        token
      )
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://fbuploadpro-git-fix-login-cookie-loop-velocta.vercel.app/tenant/acme'
    );
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    expect(setCookies.filter((c) => c.startsWith('fbup_session=;'))).toEqual([]);
    expect(setCookies.some((c) => c.includes('Domain='))).toBe(false);
  });

  it('does NOT purge on a localhost host even with a production root env', async () => {
    const token = await validSessionToken();
    const response = await middleware(
      requestWithCookie('https://localhost:3000/login?returnUrl=%2Ftenant%2Facme', token)
    );
    expect(response.status).toBe(307);
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') ?? ''];
    expect(setCookies.filter((c) => c.startsWith('fbup_session=;'))).toEqual([]);
    expect(setCookies.some((c) => c.includes('Domain='))).toBe(false);
  });

  it('redirects a valid session on /login without a returnUrl to the tenant home (existing behaviour)', async () => {
    const token = await validSessionToken();
    const response = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/login', token)
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://acme.fbuploadpro.com/');
    expect(response.cookies.get('fbup_session')).toBeUndefined();
  });

  it('sends an invalid session on a tenant home to login (no loop, no tenant access)', async () => {
    const response = await middleware(
      requestWithCookie('https://acme.fbuploadpro.com/', 'not-a-valid-token')
    );
    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith('https://app.fbuploadpro.com/login?returnUrl=')).toBe(true);
  });

  it('serves the login page (no redirect) for an invalid session on /login', async () => {
    const response = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/login', 'not-a-valid-token')
    );
    expect(response.headers.get('location')).toBeNull();
  });
});
