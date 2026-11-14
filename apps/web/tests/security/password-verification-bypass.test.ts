/**
 * @file password-verification-bypass.test.ts
 * @description Security regression tests for ISSUE-04: Password Verification Bypass in Local/Fallback loginTenantUser
 * Verifies that loginTenantUser strictly enforces password verification and never skips it when storedHash is undefined.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as authModule from '@/lib/auth/index';

describe('ISSUE-04: Password Verification Bypass in Local/Fallback loginTenantUser', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authModule._resetAuthStores();
    authModule._setMockSupabaseClient(null); // Ensure fallback mode
  });

  it('rejects login when user exists in localUserStore but has no stored password hash', async () => {
    const testEmail = 'usertnohash@gmail.com';
    // Seed user in local store without setting a password hash in localPasswordStore
    await authModule._seedTestUser({
      id: '00000000-0000-4000-a000-000000000099',
      email: testEmail,
      name: 'No Password User',
      phone: null,
      subdomain: 'test-ws',
      role: 'user',
      status: 'active',
        brand: 'fbuploadpro',
    });

    // Attempting login with ANY password (or empty password) must fail with 'Invalid email or password'
    await expect(
      authModule.loginTenantUser({
        email: testEmail,
        password: 'RandomAttemptedPassword123!',
      })
    ).rejects.toThrow('Invalid email or password');
  });

  it('verifies correct password when storedHash exists and rejects incorrect password', async () => {
    const testEmail = 'validuser@gmail.com';
    const correctPassword = 'CorrectPassword123!';

    await authModule._seedTestUser(
      {
        id: '00000000-0000-4000-a000-000000000100',
        email: testEmail,
        name: 'Valid User',
        phone: null,
        subdomain: 'valid-ws',
        role: 'user',
        status: 'active',
        brand: 'fbuploadpro',
      },
      correctPassword
    );

    // Wrong password must throw
    await expect(
      authModule.loginTenantUser({
        email: testEmail,
        password: 'WrongPassword!',
      })
    ).rejects.toThrow('Invalid email or password');

    // Correct password must succeed and return valid token
    const result = await authModule.loginTenantUser({
      email: testEmail,
      password: correctPassword,
    });
    expect(result).toBeDefined();
    expect(result.user.email).toBe(testEmail);
    expect(typeof result.token).toBe('string');
  });
});
