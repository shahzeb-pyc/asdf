import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { middleware } from '../../src/middleware';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Next.js Edge Middleware Session Authentication & Tenant Isolation (User Story 2)', () => {
  let userToken: string;
  let otherTenantToken: string;
  let adminToken: string;
  let suspendedToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';

    userToken = await signSessionToken(
      {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'regularuser@gmail.com',
        name: 'Acme User',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );

    otherTenantToken = await signSessionToken(
      {
        userId: '22222222-2222-4222-a222-222222222222',
        email: 'userbeta@gmail.com',
        name: 'Beta User',
        subdomain: 'beta',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );

    adminToken = await signSessionToken(
      {
        userId: '33333333-3333-4333-a333-333333333333',
        email: 'administrator@gmail.com',
        name: 'Admin User',
        subdomain: 'platform-admin',
        role: 'admin',
        status: 'active',
      },
      TEST_SECRET
    );

    suspendedToken = await signSessionToken(
      {
        userId: '44444444-4444-4444-a444-444444444444',
        email: 'suspended@gmail.com',
        name: 'Suspended Acme User',
        subdomain: 'acme',
        role: 'user',
        status: 'suspended',
      },
      TEST_SECRET
    );
  });

  it('redirects unauthenticated request on tenant protected route to login', async () => {
    const req = new NextRequest('http://acme.localhost:3000/dashboard', {
      headers: { host: 'acme.localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('/login');
    expect(location).toContain('returnUrl');
  });

  it('redirects suspended user to account-suspended notice', async () => {
    const req = new NextRequest('http://acme.localhost:3000/dashboard', {
      headers: {
        host: 'acme.localhost:3000',
        cookie: `fbup_session=${suspendedToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/account-suspended');
  });

  it('blocks cross-tenant access and redirects standard user to their own workspace', async () => {
    // User belonging to 'beta' tries to access 'acme'
    const req = new NextRequest('http://acme.localhost:3000/', {
      headers: {
        host: 'acme.localhost:3000',
        cookie: `fbup_session=${otherTenantToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toBe('http://beta.localhost:3000/?notice=tenant_redirect');
  });

  it('redirects authenticated user on central app login/root to their tenant workspace root', async () => {
    const req = new NextRequest('http://app.localhost:3000/login', {
      headers: {
        host: 'app.localhost:3000',
        cookie: `fbup_session=${userToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://acme.localhost:3000/');
  });

  it('allows access for matching tenant subdomain and injects session headers', async () => {
    const req = new NextRequest('http://acme.localhost:3000/', {
      headers: {
        host: 'acme.localhost:3000',
        cookie: `fbup_session=${userToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const rewriteUrl = res.headers.get('x-middleware-rewrite');
    expect(rewriteUrl).not.toBeNull();
    expect(new URL(rewriteUrl!).pathname).toBe('/tenant/acme');
  });

  it('redirects cross-tenant admin Home visits to that tenant\'s panel, never blocks them', async () => {
    // Admin with subdomain 'platform-admin' accessing 'acme' tenant
    // Home: admins never land on Home, so the visit goes to that
    // tenant's admin panel (Billing -> approvals) instead of being
    // blocked or rewritten to Home.
    const req = new NextRequest('http://acme.localhost:3000/', {
      headers: {
        host: 'acme.localhost:3000',
        cookie: `fbup_session=${adminToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://acme.localhost:3000/billing');
  });

  it('still allows cross-tenant inspection access for admin role on deeper routes', async () => {
    // The Home redirect must not become a tenant-isolation block:
    // an admin inspecting another tenant's section still rewrites
    // through to it.
    const req = new NextRequest('http://acme.localhost:3000/pages', {
      headers: {
        host: 'acme.localhost:3000',
        cookie: `fbup_session=${adminToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const rewriteUrl = res.headers.get('x-middleware-rewrite');
    expect(rewriteUrl).not.toBeNull();
    expect(new URL(rewriteUrl!).pathname).toBe('/tenant/acme/pages');
  });

  it('redirects authenticated user on .vercel.app root/login to /tenant/[subdomain]', async () => {
    const req = new NextRequest('https://fbuploadpro.vercel.app/login', {
      headers: {
        host: 'fbuploadpro.vercel.app',
        cookie: `fbup_session=${userToken}`,
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://fbuploadpro.vercel.app/tenant/acme');
  });

  it('protects direct /tenant/[subdomain] access on apex / .vercel.app hosts', async () => {
    const unauthReq = new NextRequest('https://fbuploadpro.vercel.app/tenant/acme', {
      headers: { host: 'fbuploadpro.vercel.app' },
    });
    const unauthRes = await middleware(unauthReq);
    expect(unauthRes.status).toBe(307);
    expect(unauthRes.headers.get('location')).toContain('/login');

    const mismatchReq = new NextRequest('https://fbuploadpro.vercel.app/tenant/acme', {
      headers: {
        host: 'fbuploadpro.vercel.app',
        cookie: `fbup_session=${otherTenantToken}`,
      },
    });
    const mismatchRes = await middleware(mismatchReq);
    expect(mismatchRes.status).toBe(307);
    expect(mismatchRes.headers.get('location')).toBe('https://fbuploadpro.vercel.app/tenant/beta?notice=tenant_redirect');

    const validReq = new NextRequest('https://fbuploadpro.vercel.app/tenant/acme', {
      headers: {
        host: 'fbuploadpro.vercel.app',
        cookie: `fbup_session=${userToken}`,
      },
    });
    const validRes = await middleware(validReq);
    expect(validRes.status).toBe(200);
    expect(validRes.headers.get('Cache-Control')).toContain('no-store');
  });

  const buildAppLoginReq = (targetReturnUrl: string) =>
    new NextRequest(`https://app.vinsmokemedia.online/login?returnUrl=${encodeURIComponent(targetReturnUrl)}`, {
      headers: {
        host: 'app.vinsmokemedia.online',
        cookie: `fbup_session=${userToken}`,
      },
    });

  it('wipes returnUrl query parameters when redirecting authenticated user to workspace root', async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'vinsmokemedia.online';
    const req = buildAppLoginReq('https://other.vinsmokemedia.online/');
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toBe('https://acme.vinsmokemedia.online/');
    expect(location).not.toContain('returnUrl');
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  it('breaks redirect ping-pong loop and clears stale cookies when user is bounced to login from their own workspace', async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'vinsmokemedia.online';
    const req = buildAppLoginReq('https://acme.vinsmokemedia.online/');
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('fbup_session=');
    expect(setCookie).toContain('Max-Age=0');
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  it('prevents nested returnUrl accumulation when unauthenticated user requests protected tenant route', async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'vinsmokemedia.online';
    const req = new NextRequest('https://acme.vinsmokemedia.online/?returnUrl=https://acme.vinsmokemedia.online/', {
      headers: {
        host: 'acme.vinsmokemedia.online',
      },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('https://app.vinsmokemedia.online/login?returnUrl=');
    const url = new URL(location!);
    const returnUrl = url.searchParams.get('returnUrl');
    expect(returnUrl).toBe('https://acme.vinsmokemedia.online/');
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });
});
