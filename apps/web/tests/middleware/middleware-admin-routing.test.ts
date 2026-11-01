/**
 * @file middleware-admin-routing.test.tsx
 * @description Role×location routing table for the shell isolation
 * (spec §9.2), plus the PR #109 ordering proof: the admin 307 map
 * sits alongside the admin-home check, BEFORE URL normalization —
 * so an admin requesting an old tenant URL on their own host must
 * land on /admin/*, never on the normalized old panel path.
 *
 * Host model (rootDomain localhost:3000): tenant hosts are
 * <subdomain>.localhost:3000, the apex is localhost:3000, and the
 * app host is app.localhost:3000.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { middleware } from '../../src/middleware';

const TEST_SECRET = 'test-secret-that-is-at-least-32-chars-long';

type Role = 'admin' | 'user' | 'seller';

async function token(role: Role, subdomain = 'acme'): Promise<string> {
  // Session payload requires a Gmail address whose username is
  // 6–30 characters; role names alone are too short.
  const local = role === 'admin' ? 'adminuser' : role === 'user' ? 'regularuser' : 'selleruser';
  return signSessionToken(
    {
      userId: '11111111-1111-4111-a111-111111111111',
      email: `${local}@gmail.com`,
      name: role,
      subdomain,
      role,
      status: 'active',
    },
    TEST_SECRET
  );
}

async function request(
  url: string,
  host: string,
  role?: Role
): Promise<NextRequest> {
  const headers: Record<string, string> = { host };
  if (role !== undefined) {
    headers.cookie = `fbup_session=${await token(role)}`;
  }
  return new NextRequest(url, { headers });
}

function location(res: Response): string | null {
  return res.headers.get('location');
}

describe('Middleware admin routing (shell isolation)', () => {
  const originalRootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  const originalSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalRootDomain === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    else process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalRootDomain;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  });

  describe('ordering: admin map before normalization (triple match)', () => {
    it('admin on own host /tenant/acme/billing → /admin/subscriptions, NOT normalized /billing', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/tenant/acme/billing', 'acme.localhost:3000', 'admin')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/\/admin\/subscriptions$/);
      expect(location(res)).not.toMatch(/\/billing$/);
    });

    it('admin on own host /tenant/acme/pages → /admin/subscriptions, NOT normalized /pages', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/tenant/acme/pages', 'acme.localhost:3000', 'admin')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/\/admin\/subscriptions$/);
      expect(location(res)).not.toMatch(/\/pages$/);
    });
  });

  describe('admin on tenant host (bare paths)', () => {
    it.each([
      ['/billing', '/admin/subscriptions'],
      ['/sellers', '/admin/sellers'],
      ['/sellers/xyz', '/admin/sellers/xyz'],
      ['/pages', '/admin/subscriptions'],
    ])('%s → %s', async (path, target) => {
      const res = await middleware(
        await request(`http://acme.localhost:3000${path}`, 'acme.localhost:3000', 'admin')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(new RegExp(`${target.replaceAll('/', '\\/')}$`));
    });

    it('admin on /admin/subscriptions passes through (no redirect)', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/admin/subscriptions', 'acme.localhost:3000', 'admin')
      );
      expect(location(res)).toBeNull();
    });

    it('user on /admin/subscriptions is kept out (redirected home)', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/admin/subscriptions', 'acme.localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).not.toContain('/admin/');
    });
  });

  describe('admin on apex', () => {
    it.each([
      ['/tenant/acme/billing', '/admin/subscriptions'],
      ['/tenant/acme/sellers/id1', '/admin/sellers/id1'],
      ['/tenant/acme', '/admin/subscriptions'],
    ])('%s → %s', async (path, target) => {
      const res = await middleware(
        await request(`http://localhost:3000${path}`, 'localhost:3000', 'admin')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(new RegExp(`${target.replaceAll('/', '\\/')}$`));
    });

    it('admin on entry / → /admin/subscriptions', async () => {
      const res = await middleware(
        await request('http://localhost:3000/', 'localhost:3000', 'admin')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/\/admin\/subscriptions$/);
    });
  });

  describe('non-admin roles on /admin/*', () => {
    it('user on apex /admin/subscriptions → own workspace home', async () => {
      const res = await middleware(
        await request('http://localhost:3000/admin/subscriptions', 'localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toBe('http://acme.localhost:3000/');
    });

    it('unauthenticated on apex /admin/subscriptions → login with returnUrl', async () => {
      const res = await middleware(
        await request('http://localhost:3000/admin/subscriptions', 'localhost:3000')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/\/login\?returnUrl=%2Fadmin%2Fsubscriptions$/);
    });

    it('seller on tenant host /admin/subscriptions → app host /seller', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/admin/subscriptions', 'acme.localhost:3000', 'seller')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/^http:\/\/app\.localhost:3000\/seller$/);
    });
  });

  describe('user tenant handling unchanged', () => {
    it('user on own host /tenant/acme/pages triple match → normalizes to /pages', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/tenant/acme/pages', 'acme.localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toBe('http://acme.localhost:3000/pages');
    });

    it('user on another tenant host → own home + notice marker', async () => {
      const res = await middleware(
        await request('http://beta.localhost:3000/pages', 'beta.localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toContain('acme.localhost:3000');
      expect(location(res)).toContain('notice=tenant_redirect');
    });

    it('seller on tenant host /pages → app host /seller', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/pages', 'acme.localhost:3000', 'seller')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toMatch(/^http:\/\/app\.localhost:3000\/seller$/);
    });
  });

  describe('deleted sellers paths still redirect non-admins home', () => {
    it('user on apex /tenant/acme/sellers → /tenant/acme', async () => {
      const res = await middleware(
        await request('http://localhost:3000/tenant/acme/sellers', 'localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toBe('http://localhost:3000/tenant/acme');
    });

    it('user on tenant host /sellers → /', async () => {
      const res = await middleware(
        await request('http://acme.localhost:3000/sellers', 'acme.localhost:3000', 'user')
      );
      expect(res.status).toBe(307);
      expect(location(res)).toBe('http://acme.localhost:3000/');
    });
  });
});
