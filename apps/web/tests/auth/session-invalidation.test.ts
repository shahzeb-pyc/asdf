import { describe, it, expect, beforeEach } from 'vitest';
import { verifySessionToken } from '@fbuploadpro/contracts';
import { verifySignupOtp } from '../../src/lib/otp-service';
import {
  loginTenantUser,
} from '../../src/lib/auth/login';
import {
  resetUserPasswordWithOtp,
} from '../../src/lib/auth/password-reset';
import {
  validateSessionDetailed,
} from '../../src/lib/auth/session';
import {
  signUpTenantUser,
} from '../../src/lib/auth/signup';
import {
  _resetAuthStores,
} from '../../src/lib/auth/stores';

const SESSION_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Session Lifetime Synchronization & Invalidation (AUTH-05 / AUTH-07 / Spec 017 US4)', () => {
  beforeEach(() => {
    _resetAuthStores();
  });

  it('signs session tokens with exactly 30 days (2,592,000s) lifetime', async () => {
    const _signup = await signUpTenantUser({
      name: 'Sarah Connor',
      phone: '+14155552671',
      email: 'sarah.session@gmail.com',
      password: 'SecurePassword123!',
    });
    expect((await verifySignupOtp('sarah.session@gmail.com', _signup.simulatedOtp!)).success).toBe(true);
    const { token } = await loginTenantUser({ email: 'sarah.session@gmail.com', password: 'SecurePassword123!' });

    const payload = await verifySessionToken(token, SESSION_SECRET);
    expect(payload.exp - payload.iat).toBe(86400 * 30); // 30 days in seconds
  });

  it('validates active session and invalidates previous sessions upon password reset', async () => {
    const email = 'john.invalidation@gmail.com';
    const originalPassword = 'InitialSecurePassword123!';
    const newPassword = 'UpdatedSecurePassword456!';

    // 1. Provision account and capture initial session
    const _signup = await signUpTenantUser({
      name: 'John Connor',
      phone: '+14155552671',
      email,
      password: originalPassword,
    });
    expect((await verifySignupOtp(email, _signup.simulatedOtp!)).success).toBe(true);
    const { token: initialToken } = await loginTenantUser({ email, password: originalPassword });

    const initialSession = await verifySessionToken(initialToken, SESSION_SECRET);
    // Password-reset invalidation now lives in the global session
    // check (validateSessionDetailed), not in the per-call check:
    // the claim-only per-call check cannot see the password
    // change, and must not pretend otherwise.
    const isValidInitially = await validateSessionDetailed(initialSession);
    expect(isValidInitially).toBe('active');

    // 2. Perform password reset with OTP
    const { createPasswordResetOtp } = await import('../../src/lib/otp-service');
    const { otp } = await createPasswordResetOtp(email);

    await resetUserPasswordWithOtp({
      email,
      otp,
      password: newPassword,
    });

    // 3. Old session MUST now be invalid (passwordUpdatedAt > iat)
    const isOldSessionValid = await validateSessionDetailed(initialSession);
    expect(isOldSessionValid).toBe('dead');

    // 4. New login after password change succeeds and new session is valid
    const { token: newToken } = await loginTenantUser({
      email: 'johninvalidation@gmail.com',
      password: newPassword,
    });

    const newSession = await verifySessionToken(newToken, SESSION_SECRET);
    const isNewSessionValid = await validateSessionDetailed(newSession);
    expect(isNewSessionValid).toBe('active');
  });

  it('immediately invalidates session issued in the exact same second as password reset without artificial delays', async () => {
    const email = 'samesecond@gmail.com';
    const password = 'Password123!';
    const newPassword = 'NewPassword456!';

    // Register user
    const _signup = await signUpTenantUser({
      name: 'Same Second User',
      phone: '+14155552672',
      email,
      password: 'Password123!',
    });
    expect((await verifySignupOtp(email, _signup.simulatedOtp!)).success).toBe(true);
    const { token: initialToken } = await loginTenantUser({ email, password: 'Password123!' });

    const initialSession = await verifySessionToken(initialToken, SESSION_SECRET);
    expect(await validateSessionDetailed(initialSession)).toBe('active');

    // Reset password in the same second (NO artificial sleep/delay)
    const { createPasswordResetOtp } = await import('../../src/lib/otp-service');
    const { otp } = await createPasswordResetOtp(email);

    await resetUserPasswordWithOtp({
      email,
      otp,
      password: newPassword,
    });

    // Old session MUST be invalid even if session.iat === passwordUpdatedAt
    const isOldValid = await validateSessionDetailed(initialSession);
    expect(isOldValid).toBe('dead');

    // New login immediately in the same second MUST succeed and be active
    const { token: newToken } = await loginTenantUser({
      email,
      password: newPassword,
    });

    const newSession = await verifySessionToken(newToken, SESSION_SECRET);
    const isNewValid = await validateSessionDetailed(newSession);
    expect(isNewValid).toBe('active');
  });
});

