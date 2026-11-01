import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { middleware } from '../../src/middleware';

const TEST_SECRET = 'middleware-seller-test-secret-0123456789abcdef';

describe('middleware seller guards (sellers have no workspace)', () => {
  let sellerToken: string;
  let suspendedSellerToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';

    sellerToken = await signSessionToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'sellerperson@gmail.com',
        name: 'Seller Person',
        subdomain: 'sellerperson',
        role: 'seller',
        status: 'active',
      },
      TEST_SECRET
    );

    suspendedSellerToken = await signSessionToken(
      {
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'suspendedseller@gmail.com',
        name: 'Suspended Seller',
        subdomain: 'suspendedseller',
        role: 'seller',
        status: 'suspended',
      },
      TEST_SECRET
    );
  });

  function sellerReq(url: string, host: string, token: string): NextRequest {
    return new NextRequest(url, {
      headers: { host, cookie: `fbup_session=${token}` },
    });
  }

  it('redirects a seller on the app host to /seller', async () => {
    const res = await middleware(
      sellerReq('http://app.localhost:3000/', 'app.localhost:3000', sellerToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://app.localhost:3000/seller');
  });

  it('lets a seller already on /seller through', async () => {
    const res = await middleware(
      sellerReq('http://app.localhost:3000/seller', 'app.localhost:3000', sellerToken)
    );
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).not.toBe(307);
  });

  it('redirects a suspended seller on the app host to /account-suspended', async () => {
    const res = await middleware(
      sellerReq('http://app.localhost:3000/', 'app.localhost:3000', suspendedSellerToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/account-suspended');
  });

  it('exempts logout-success from the seller redirect', async () => {
    const res = await middleware(
      sellerReq('http://app.localhost:3000/login?logout=success', 'app.localhost:3000', sellerToken)
    );
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects a seller on an apex /tenant/ path to /seller', async () => {
    const res = await middleware(
      sellerReq('http://localhost:3000/tenant/e2e', 'localhost:3000', sellerToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/seller');
  });

  it('redirects a seller on a tenant host to the app host /seller', async () => {
    const res = await middleware(
      sellerReq('http://sellerperson.localhost:3000/dashboard', 'sellerperson.localhost:3000', sellerToken)
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://app.localhost:3000/seller');
  });
});
