import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../src/middleware';

/**
 * Magic-link connect pages live on the app host only. The Facebook
 * callback therefore redirects magic flows to the app host — and this
 * test pins the reason that host matters: an unauthenticated browser
 * reaching the app-host success page passes straight through, while
 * the same path on a tenant host would hit the login gate (the magic
 * browser deliberately holds no fbup_session).
 */
describe('Middleware magic-link connect pages on the app host', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  });

  it('passes an unauthenticated app-host /connect/facebook/success request through', async () => {
    const req = new NextRequest(
      'https://app.fbuploadpro.com/connect/facebook/success',
      { headers: { host: 'app.fbuploadpro.com' } }
    );
    const res = await middleware(req);

    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('passes an unauthenticated app-host /connect/facebook/error request through', async () => {
    const req = new NextRequest(
      'https://app.fbuploadpro.com/connect/facebook/error?reason=cancelled',
      { headers: { host: 'app.fbuploadpro.com' } }
    );
    const res = await middleware(req);

    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(200);
  });
});
