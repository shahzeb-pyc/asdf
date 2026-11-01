import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loginTenantUser } from '../../src/lib/auth/login';
import { _resetAuthStores, _seedTestUser } from '../../src/lib/auth/stores';

const TEST_SECRET = 'seller-login-test-secret-0123456789abcdef';

describe('seller login redirect', () => {
  beforeAll(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  beforeEach(() => {
    _resetAuthStores();
  });

  it('lands a seller on /seller, ignoring any returnUrl', async () => {
    await _seedTestUser(
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'sellerlogin@gmail.com',
        name: 'Ali',
        phone: null,
        subdomain: 'sellerlogin',
        role: 'seller',
        status: 'active',
      },
      'Password123!'
    );
    const { redirectUrl } = await loginTenantUser({
      email: 'sellerlogin@gmail.com',
      password: 'Password123!',
      returnUrl: '/tenant/e2e/dashboard',
    });
    expect(redirectUrl).toBe('/seller');
  });
});
