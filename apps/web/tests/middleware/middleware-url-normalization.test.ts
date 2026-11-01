import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { middleware } from '../../src/middleware';
import {
  buildTenantHref,
  hasSwappableSubdomain,
  isTenantSubdomainHost,
} from '../../src/lib/tenant-href';

const TEST_SECRET = 'test-session-secret-do-not-use-in-production';
const DEFAULT_ROOT_DOMAIN = 'localhost:3000';

function request(url: string, host: string, token?: string): NextRequest {
  return new NextRequest(url, {
    headers: token
      ? { host, cookie: `fbup_session=${token}` }
      : { host },
  });
}

describe('Tenant-host URL normalization', () => {
  let acmeToken: string;
  let betaToken: string;
  let adminToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = DEFAULT_ROOT_DOMAIN;

    acmeToken = await signSessionToken(
      {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'acmeuser@gmail.com',
        name: 'Acme User',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    betaToken = await signSessionToken(
      {
        userId: '22222222-2222-4222-a222-222222222222',
        email: 'betauser@gmail.com',
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
  });

  // The guard-(a) own-host test below temporarily changes the root
  // domain; always restore it so the other tests see the default.
  afterEach(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = DEFAULT_ROOT_DOMAIN;
  });

  it('redirects a matching prefixed path on the tenant host to the clean path, preserving the query', async () => {
    const res = await middleware(
      request(
        'http://acme.localhost:3000/tenant/acme/settings?tab=instagram',
        'acme.localhost:3000',
        acmeToken
      )
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://acme.localhost:3000/settings?tab=instagram'
    );
  });

  it('redirects the prefixed tenant home to the clean root', async () => {
    const bare = await middleware(
      request('http://acme.localhost:3000/tenant/acme', 'acme.localhost:3000', acmeToken)
    );
    expect(bare.status).toBe(307);
    expect(bare.headers.get('location')).toBe('http://acme.localhost:3000/');

    const slashed = await middleware(
      request('http://acme.localhost:3000/tenant/acme/', 'acme.localhost:3000', acmeToken)
    );
    expect(slashed.status).toBe(307);
    expect(slashed.headers.get('location')).toBe('http://acme.localhost:3000/');
  });

  it('preserves the notice marker through normalization', async () => {
    const res = await middleware(
      request(
        'http://acme.localhost:3000/tenant/acme/settings?notice=tenant_redirect',
        'acme.localhost:3000',
        acmeToken
      )
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://acme.localhost:3000/settings?notice=tenant_redirect'
    );
  });

  it('does not normalize a cross-tenant prefixed path on a tenant host (rewrite serves it)', async () => {
    const res = await middleware(
      request(
        'http://acme.localhost:3000/tenant/beta/settings',
        'acme.localhost:3000',
        acmeToken
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/tenant/beta/settings');
  });

  it('keeps guard (b) behavior for a mismatched session, with the session prefix stripped to a single redirect', async () => {
    const res = await middleware(
      request(
        'http://acme.localhost:3000/tenant/beta/settings',
        'acme.localhost:3000',
        betaToken
      )
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://beta.localhost:3000/settings?notice=tenant_redirect'
    );
  });

  it('keeps guard (b) home case as a single redirect to the clean root with notice', async () => {
    const res = await middleware(
      request('http://acme.localhost:3000/tenant/beta/', 'acme.localhost:3000', betaToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://beta.localhost:3000/?notice=tenant_redirect'
    );
  });

  it('keeps the prefixed guard (a) target on apex hosts when the host is not the session host', async () => {
    // Bare localhost is a true apex host (the app host is reserved,
    // not apex, and never reaches the direct-tenant-path handler).
    const res = await middleware(
      request(
        'http://localhost:3000/tenant/acme/settings',
        'localhost:3000',
        betaToken
      )
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/tenant/beta?notice=tenant_redirect'
    );
  });

  it('targets the clean home for guard (a) when the request host is already the session host', async () => {
    // Reachable only when the host falls through to the apex branch
    // (e.g. a misconfigured root domain) while still carrying the
    // session's subdomain label: a foreign host sharing the label.
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
    const res = await middleware(
      request(
        'http://beta.evil.com/tenant/acme/settings',
        'beta.evil.com',
        betaToken
      )
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://beta.evil.com/?notice=tenant_redirect'
    );
  });

  it('serves prefixed paths unchanged on apex and preview hosts (no normalization, no loop)', async () => {
    const apex = await middleware(
      request(
        'http://localhost:3000/tenant/acme/settings',
        'localhost:3000',
        acmeToken
      )
    );
    expect(apex.status).toBe(200);
    expect(apex.headers.get('location')).toBeNull();
    expect(apex.headers.get('x-middleware-rewrite')).toBeNull();

    const preview = await middleware(
      request(
        'http://asdf-git-xyz-velocta.vercel.app/tenant/acme/settings',
        'asdf-git-xyz-velocta.vercel.app',
        acmeToken
      )
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get('location')).toBeNull();
    expect(preview.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('keeps the admin-section redirect ahead of normalization', async () => {
    const res = await middleware(
      request('http://acme.localhost:3000/tenant/acme', 'acme.localhost:3000', adminToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://acme.localhost:3000/admin/subscriptions');
  });

  it('does not redirect clean paths on the tenant host', async () => {
    const res = await middleware(
      request('http://acme.localhost:3000/settings?tab=instagram', 'acme.localhost:3000', acmeToken)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/tenant/acme/settings');
  });
});

describe('tenant-href host helpers', () => {
  it('isTenantSubdomainHost matches only the tenant own host', () => {
    expect(isTenantSubdomainHost('acme.fbuploadpro.com', 'acme')).toBe(true);
    expect(isTenantSubdomainHost('acme.fbuploadpro.com:443', 'acme')).toBe(true);
    expect(isTenantSubdomainHost('acme.localhost:3000', 'acme')).toBe(true);
    expect(isTenantSubdomainHost('ACME.fbuploadpro.com', 'acme')).toBe(true);
    expect(isTenantSubdomainHost('acme', 'acme')).toBe(true);
    expect(isTenantSubdomainHost('beta.fbuploadpro.com', 'acme')).toBe(false);
    expect(isTenantSubdomainHost('acmex.fbuploadpro.com', 'acme')).toBe(false);
    expect(isTenantSubdomainHost('fbuploadpro.com', 'acme')).toBe(false);
    expect(isTenantSubdomainHost('localhost:3000', 'acme')).toBe(false);
  });

  it('hasSwappableSubdomain is true only where a label can be swapped', () => {
    expect(hasSwappableSubdomain('acme.fbuploadpro.com')).toBe(true);
    expect(hasSwappableSubdomain('acme.localhost:3000')).toBe(true);
    expect(hasSwappableSubdomain('localhost:3000')).toBe(false);
    expect(hasSwappableSubdomain('127.0.0.1:3000')).toBe(false);
    expect(hasSwappableSubdomain('fbuploadpro.com')).toBe(false);
    expect(hasSwappableSubdomain('asdf-git-xyz-velocta.vercel.app')).toBe(false);
  });

  it('buildTenantHref keeps query strings on both forms', () => {
    expect(buildTenantHref('acme', '/settings?tab=instagram', true)).toBe(
      '/settings?tab=instagram'
    );
    expect(buildTenantHref('acme', '/settings?tab=instagram', false)).toBe(
      '/tenant/acme/settings?tab=instagram'
    );
    expect(buildTenantHref('acme', '', true)).toBe('/');
    // Empty path normalizes to '/' inside the helper, so the prefixed
    // form carries a trailing slash (same home route as before).
    expect(buildTenantHref('acme', '', false)).toBe('/tenant/acme/');
  });
});
