import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../src/middleware';

describe('Middleware public /privacy route', () => {
  beforeAll(() => {
    process.env.SESSION_SECRET = 'x'.repeat(40);
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  it('serves /privacy on a tenant subdomain without a session (no login redirect)', async () => {
    const req = new NextRequest('http://acme.localhost:3000/privacy', {
      headers: { host: 'acme.localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('serves /privacy on the app host without a session', async () => {
    const req = new NextRequest('http://app.localhost:3000/privacy', {
      headers: { host: 'app.localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('still redirects other tenant routes to login without a session', async () => {
    const req = new NextRequest('http://acme.localhost:3000/settings', {
      headers: { host: 'acme.localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('does not rewrite /privacy to a tenant path (root route serves on any host)', async () => {
    const req = new NextRequest('http://acme.localhost:3000/privacy', {
      headers: { host: 'acme.localhost:3000' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
