import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loginTenantUser } from '../../src/lib/auth/login';
import { _resetAuthStores, _seedTestUser } from '../../src/lib/auth/stores';

const TEST_SECRET = 'test-secret-that-is-at-least-32-chars-long';

describe('admin login redirect', () => {
  beforeAll(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  beforeEach(() => {
    _resetAuthStores();
  });

  it('lands an admin on the approvals panel, not Home, for a Home-bound returnUrl', async () => {
    await _seedTestUser(
      {
        id: '33333333-3333-4333-a333-333333333333',
        email: 'adminlogin@gmail.com',
        name: 'Admin',
        phone: null,
        subdomain: 'e2e',
        role: 'admin',
        status: 'active',
      },
      'Password123!'
    );
    const { redirectUrl } = await loginTenantUser({
      email: 'adminlogin@gmail.com',
      password: 'Password123!',
      returnUrl: '/tenant/e2e',
    });
    // The sanitizer absolutizes to the tenant host first; the admin
    // helper then rewrites the Home path to the panel, keeping the
    // prefixed form.
    expect(redirectUrl).toBe('http://e2e.localhost:3000/tenant/e2e/billing');
  });

  it('keeps Home landing for a non-admin with the same returnUrl', async () => {
    await _seedTestUser(
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'userlogin@gmail.com',
        name: 'User',
        phone: null,
        subdomain: 'e2e',
        role: 'user',
        status: 'active',
      },
      'Password123!'
    );
    const { redirectUrl } = await loginTenantUser({
      email: 'userlogin@gmail.com',
      password: 'Password123!',
      returnUrl: '/tenant/e2e',
    });
    expect(redirectUrl).toBe('http://e2e.localhost:3000/tenant/e2e');
  });

  it('keeps a deeper admin returnUrl unchanged', async () => {
    await _seedTestUser(
      {
        id: '33333333-3333-4333-a333-333333333333',
        email: 'adminlogin@gmail.com',
        name: 'Admin',
        phone: null,
        subdomain: 'e2e',
        role: 'admin',
        status: 'active',
      },
      'Password123!'
    );
    const { redirectUrl } = await loginTenantUser({
      email: 'adminlogin@gmail.com',
      password: 'Password123!',
      returnUrl: '/tenant/e2e/sellers',
    });
    expect(redirectUrl).toBe('http://e2e.localhost:3000/tenant/e2e/sellers');
  });
});
