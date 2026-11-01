import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { authenticateSellerRoute, sellerErrorResponse } from './route-seller';
import { SellerError } from './billing/sellers';

const TEST_SECRET = 'route-seller-test-secret-0123456789abcdef';

const sessionState = vi.hoisted(() => ({ active: true }));
vi.mock('@/lib/auth/session', () => ({
  validateSessionActive: vi.fn(async () => sessionState.active),
}));

describe('authenticateSellerRoute', () => {
  let sellerToken: string;

  beforeAll(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
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
  });

  beforeEach(() => {
    sessionState.active = true;
  });

  function reqWithCookie(cookie: string | null): NextRequest {
    return new NextRequest('http://app.localhost:3000/api/seller/dashboard', {
      headers: cookie ? { cookie: `fbup_session=${cookie}` } : {},
    });
  }

  it('401s on a token that fails verification', async () => {
    const res = await authenticateSellerRoute(reqWithCookie('not-a-token'));
    expect(res.errorResponse?.status).toBe(401);
  });

  it('401s when the session is no longer active', async () => {
    sessionState.active = false;
    const res = await authenticateSellerRoute(reqWithCookie(sellerToken));
    expect(res.errorResponse?.status).toBe(401);
  });

  it('returns the session for an active seller', async () => {
    const res = await authenticateSellerRoute(reqWithCookie(sellerToken));
    expect(res.session?.userId).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('sellerErrorResponse', () => {
  it.each([
    ['SELLER_NOT_FOUND', 404],
    ['PAYOUT_REQUEST_NOT_FOUND', 404],
    ['SELLER_EMAIL_EXISTS', 409],
    ['REFERRAL_CODE_TAKEN', 409],
    ['PAYOUT_REQUEST_ALREADY_DECIDED', 409],
    ['SELLER_HAS_UNPAID_COMMISSIONS', 409],
    ['PAYOUT_BELOW_MINIMUM', 400],
    ['PAYOUT_DETAILS_MISSING', 400],
    ['SELLERS_UNAVAILABLE', 500],
  ] as const)('maps %s to %s', (code, status) => {
    const res = sellerErrorResponse(new SellerError(code, 'test'));
    expect(res.status).toBe(status);
  });
});
