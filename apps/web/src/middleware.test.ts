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

describe('middleware API hot path (spec 152 O5)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'fbuploadpro.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function apiRequest(
    url: string,
    init: { method?: string; origin?: string } = {}
  ): NextRequest {
    const request = new NextRequest(url, {
      method: init.method ?? 'GET',
      headers: init.origin ? { origin: init.origin } : {},
    });
    request.headers.set('host', new URL(url).host);
    return request;
  }

  it('API GET passes through with no-store but no CSP headers', async () => {
    const response = await middleware(
      apiRequest('https://app.fbuploadpro.com/api/auth/session')
    );
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
    expect(response.headers.get('Reporting-Endpoints')).toBeNull();
  });

  it('API mutating call with a foreign origin still answers 403, without CSP', async () => {
    const response = await middleware(
      apiRequest('https://app.fbuploadpro.com/api/auth/session', {
        method: 'POST',
        origin: 'https://evil.example.com',
      })
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
  });

  it('API mutating call with an allowed origin passes through, without CSP', async () => {
    const response = await middleware(
      apiRequest('https://app.fbuploadpro.com/api/auth/session', {
        method: 'POST',
        origin: 'https://app.fbuploadpro.com',
      })
    );
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
  });

  it('HTML pages keep their CSP headers', async () => {
    const response = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/privacy', null)
    );
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('Content-Security-Policy-Report-Only')).toContain(
      "default-src 'self'"
    );
  });
});

describe('middleware white-label brand (spec 191)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_ROOT_DOMAIN', 'fbuploadpro.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function brandToken(
    brand: 'fbuploadpro' | 'nextrise',
    subdomain = 'student1'
  ): Promise<string> {
    return signSessionToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'owneruser@gmail.com',
        subdomain,
        role: 'user',
        status: 'active',
        brand,
      },
      DEV_SECRET
    );
  }

  function rewriteTarget(response: Response): string | null {
    return response.headers.get('x-middleware-rewrite');
  }

  it('a NextRise session on the white-label gateway goes to its white-label tenant home', async () => {
    const token = await brandToken('nextrise');
    const response = await middleware(
      requestWithCookie('https://app.nextrisehq.com/login', token)
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://student1.app.nextrisehq.com/');
  });

  it('a NextRise session on OUR gateway is not a session there — login renders, no workspace redirect', async () => {
    const token = await brandToken('nextrise');
    const response = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/login', token)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('our session on the white-label gateway is not a session there — login renders, no workspace redirect', async () => {
    const token = await brandToken('fbuploadpro');
    const response = await middleware(
      requestWithCookie('https://app.nextrisehq.com/login', token)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('a pre-brand token (no claim) is our brand and is not a session on the white-label gateway', async () => {
    const token = await validSessionToken();
    const response = await middleware(
      requestWithCookie('https://app.nextrisehq.com/login', token)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('signup and forgot-password on the white-label gateway redirect to login', async () => {
    for (const path of ['/signup', '/forgot-password', '/reset-password', '/verify-otp']) {
      const response = await middleware(
        requestWithCookie(`https://app.nextrisehq.com${path}`, null)
      );
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://app.nextrisehq.com/login');
    }
  });

  it('the Muse guide 404s on the white-label gateway', async () => {
    const response = await middleware(
      requestWithCookie('https://app.nextrisehq.com/muse_guide.md', null)
    );
    expect(rewriteTarget(response)).toBe('https://app.nextrisehq.com/_not-found');
  });

  it('billing and Muse pages 404 on a white-label tenant host, even authenticated', async () => {
    const token = await brandToken('nextrise');
    for (const path of ['/billing', '/my-plan', '/purchase', '/payments', '/refund', '/muse']) {
      const response = await middleware(
        requestWithCookie(`https://student1.app.nextrisehq.com${path}`, token)
      );
      expect(rewriteTarget(response)).toBe(
        `https://student1.app.nextrisehq.com/_not-found`
      );
    }
  });

  it('billing 404s on the white-label gateway in tenant form too', async () => {
    const token = await brandToken('nextrise');
    const response = await middleware(
      requestWithCookie('https://app.nextrisehq.com/tenant/student1/billing', token)
    );
    expect(rewriteTarget(response)).toBe('https://app.nextrisehq.com/_not-found');
  });

  it('an ordinary section still rewrites to the tenant path on a white-label tenant host', async () => {
    const token = await brandToken('nextrise');
    const response = await middleware(
      requestWithCookie('https://student1.app.nextrisehq.com/schedule', token)
    );
    expect(rewriteTarget(response)).toBe(
      'https://student1.app.nextrisehq.com/tenant/student1/schedule'
    );
  });

  it('signup, password-reset, billing and Muse APIs 404 on the white-label brand', async () => {
    for (const path of [
      '/api/auth/signup',
      '/api/auth/signup/verify-otp',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/tenant/student1/billing',
      '/api/tenant/student1/billing/payments',
      '/api/tenant/student1/muse/keys',
      '/api/tenant/student1/muse/keys/abc-123',
      '/api/tenant/student1/muse/activity',
    ]) {
      const response = await middleware(
        requestWithCookie(`https://app.nextrisehq.com${path}`, null)
      );
      expect(response.status).toBe(404);
    }
  });

  it('login and session APIs still pass through on the white-label brand', async () => {
    for (const path of ['/api/auth/login', '/api/auth/session', '/api/auth/logout']) {
      const response = await middleware(
        requestWithCookie(`https://app.nextrisehq.com${path}`, null)
      );
      expect(response.status).not.toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('negative control: signup renders and billing rewrites on OUR brand', async () => {
    const signup = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/signup', null)
    );
    expect(signup.status).toBe(200);
    expect(signup.headers.get('location')).toBeNull();

    const token = await brandToken('fbuploadpro', 'acme');
    const billing = await middleware(
      requestWithCookie('https://acme.fbuploadpro.com/billing', token)
    );
    expect(rewriteTarget(billing)).toBe('https://acme.fbuploadpro.com/tenant/acme/billing');

    // The Muse API still passes through on OUR brand (not a 404).
    const museApi = await middleware(
      requestWithCookie('https://app.fbuploadpro.com/api/tenant/acme/muse/keys', token)
    );
    expect(museApi.status).not.toBe(404);
  });
});
