import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSecureOtp,
  constantTimeEquals,
  createPasswordResetOtp,
  verifyPasswordResetOtp,
  verifySignupOtp,
  resendPasswordResetOtp,
  INVALID_OTP_ERROR,
  _resetOtpStore,
} from '../../src/lib/otp-service';
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
import { _resetRateLimiter } from '../../src/lib/rate-limiter';
import { verifySessionToken } from '@fbuploadpro/contracts';

const SESSION_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Password Reset OTP Flow (Spec 018)', () => {
  beforeEach(() => {
    _resetOtpStore();
    _resetAuthStores();
    _resetRateLimiter();
  });

  describe('OTP Generation & Delivery (US1)', () => {
    it('generates a cryptographically secure 6-digit numeric OTP with 10-minute TTL', async () => {
      const { otp, expiresAt } = await createPasswordResetOtp('John.Doe+security@gmail.com');

      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
      expect(parseInt(otp, 10)).toBeGreaterThanOrEqual(100000);
      expect(parseInt(otp, 10)).toBeLessThanOrEqual(999999);

      const ttlMs = expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
      expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

    });

    it('enforces 60-second resend cooldown', async () => {
      const email = 'speedy@gmail.com';
      await createPasswordResetOtp(email);

      // Attempt immediate resend
      const earlyResend = await resendPasswordResetOtp(email);
      expect(earlyResend.success).toBe(false);
      expect(earlyResend.cooldownSecondsRemaining).toBeGreaterThan(0);
      expect(earlyResend.error).toContain('Please wait');

    });
  });

  describe('OTP Verification, Lockout & Password Mutation (US2)', () => {
    it('verifies correct OTP and consumes it (single-use)', async () => {
      const email = 'alex.reset@gmail.com';
      const { otp } = await createPasswordResetOtp(email);

      const result = await verifyPasswordResetOtp('alexreset@gmail.com', otp);
      expect(result.success).toBe(true);

      // Immediate reuse must fail
      const reuse = await verifyPasswordResetOtp('alexreset@gmail.com', otp);
      expect(reuse.success).toBe(false);
      expect(reuse.error).toContain('No active password reset request found');
    });

    it('locks out after 5 failures, with responses identical to a wrong code', async () => {
      const email = 'lockout.target@gmail.com';
      await createPasswordResetOtp(email);

      for (let i = 0; i < 4; i++) {
        const attempt = await verifyPasswordResetOtp(email, '000000');
        expect(attempt.success).toBe(false);
        // Byte-identical unified error (spec 139 B2): no attempt-count
        // or lockout-state oracle.
        expect(attempt.error).toBe(INVALID_OTP_ERROR);
      }

      // 5th attempt locks out — same bytes as any wrong code
      const finalAttempt = await verifyPasswordResetOtp(email, '000000');
      expect(finalAttempt.success).toBe(false);
      expect(finalAttempt.error).toBe(INVALID_OTP_ERROR);

      // Subsequent attempt blocked even with valid code — identical bytes
      const lockedAttempt = await verifyPasswordResetOtp(email, '123456');
      expect(lockedAttempt.success).toBe(false);
      expect(lockedAttempt.error).toBe(INVALID_OTP_ERROR);
      expect(lockedAttempt.error).toBe(finalAttempt.error);
    });

    it('updates password and invalidates prior sessions', async () => {
      // 1. Register a user
      const signupRes = await signUpTenantUser({
        name: 'Target User',
        phone: '+14155551234',
        email: 'target.user@gmail.com',
        password: 'OriginalPassword123!',
      });
      const verifyRes = await verifySignupOtp('target.user@gmail.com', signupRes.simulatedOtp!);
      expect(verifyRes.success).toBe(true);
      const loginRes = await loginTenantUser({
        email: 'target.user@gmail.com',
        password: 'OriginalPassword123!',
      });
      const originalToken = loginRes.token;
      const initialSession = await verifySessionToken(originalToken, SESSION_SECRET);

      // Original session is initially valid
      const initialActive = await validateSessionDetailed(initialSession);
      expect(initialActive).toBe('active');

      // 2. Request password reset OTP
      const { otp } = await createPasswordResetOtp('target.user@gmail.com');

      // 3. Reset password with OTP
      const resetResult = await resetUserPasswordWithOtp({
        email: 'targetuser@gmail.com',
        otp,
        password: 'NewStrongPassword456!',
      });
      expect(resetResult.message).toContain('successfully updated');

      // 4. Verify previous session token is now INVALID
      const postResetActive = await validateSessionDetailed(initialSession);
      expect(postResetActive).toBe('dead');

      // 5. Verify old password fails and new password succeeds
      await expect(
        loginTenantUser({
          email: 'target.user@gmail.com',
          password: 'OriginalPassword123!',
        })
      ).rejects.toThrow('Invalid email or password');

      const loginResult = await loginTenantUser({
        email: 'target.user@gmail.com',
        password: 'NewStrongPassword456!',
      });
      expect(loginResult.user.email).toBe('targetuser@gmail.com');
      expect(loginResult.token).toBeDefined();

      // 6. Verify new session is valid
      const newSession = await verifySessionToken(loginResult.token, SESSION_SECRET);
      const newActive = await validateSessionDetailed(newSession);
      expect(newActive).toBe('active');
    });
  });
});
