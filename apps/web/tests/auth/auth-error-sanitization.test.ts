import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeAuthErrorMessage,
  formatAuthErrorResponse,
  EMAIL_RATE_LIMIT_MESSAGE,
  isEmailRateLimitError,
} from '../../src/lib/auth-errors';

describe('Auth Error Sanitization & Zero Leakage (T001, T002)', () => {
  describe('sanitizeAuthErrorMessage', () => {
    it('scrubs connection refused errors and returns safe fallback', () => {
      const leaked = 'connect ECONNREFUSED 127.0.0.1:5432';
      const clean = sanitizeAuthErrorMessage(leaked);
      expect(clean).toBe('Unable to complete your request at this moment. Please try again shortly.');
      expect(clean).not.toContain('ECONNREFUSED');
      expect(clean).not.toContain('127.0.0.1');
      expect(clean).not.toContain('5432');
    });

    it('scrubs raw SQL syntax and relation errors', () => {
      const leaked = 'relation "users" does not exist at character 15 in SELECT * FROM users';
      const clean = sanitizeAuthErrorMessage(leaked);
      expect(clean).toBe('Unable to complete your request at this moment. Please try again shortly.');
      expect(clean).not.toContain('SELECT');
      expect(clean).not.toContain('users');
    });

    it('scrubs socket timeout and stack trace dumps', () => {
      const leaked = 'Socket timed out after 5000ms at PgPool.connect';
      const clean = sanitizeAuthErrorMessage(leaked);
      expect(clean).toBe('Unable to complete your request at this moment. Please try again shortly.');
      expect(clean).not.toContain('socket');
      expect(clean).not.toContain('PgPool');
    });

    it('preserves clean, customer-safe error messages', () => {
      const safe = 'Please enter a valid email address.';
      expect(sanitizeAuthErrorMessage(safe)).toBe(safe);
    });

    it('uses custom fallback message if provided', () => {
      const leaked = 'connect ECONNREFUSED 127.0.0.1:5432';
      const clean = sanitizeAuthErrorMessage(leaked, 'Unable to sign in at this moment. Please try again shortly.');
      expect(clean).toBe('Unable to sign in at this moment. Please try again shortly.');
    });
  });

  describe('formatAuthErrorResponse', () => {
    it('returns 500 with sanitized message when given an ECONNREFUSED error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dbError = new Error('connect ECONNREFUSED 127.0.0.1:5432');

      const response = formatAuthErrorResponse(dbError, {
        fallbackMessage: 'Unable to sign in at this moment. Please try again shortly.',
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('Unable to sign in at this moment. Please try again shortly.');
      expect(data.error).not.toContain('ECONNREFUSED');
      expect(data.error).not.toContain('127.0.0.1');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('returns 401 with clean message for invalid credentials', async () => {
      const credError = new Error('Invalid email or password');
      const response = formatAuthErrorResponse(credError);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Invalid email or password');
    });

    it('returns 403 with redirectUrl for suspended accounts', async () => {
      const suspendedError = new Error('Account is suspended');
      (suspendedError as unknown as { code: string }).code = 'ACCOUNT_SUSPENDED';

      const response = formatAuthErrorResponse(suspendedError);

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe('Account is suspended');
      expect(data.redirectUrl).toBe('/account-suspended');
    });

    it('returns 409 for already registered emails', async () => {
      const dupError = new Error('Email is already registered');
      const response = formatAuthErrorResponse(dupError);

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toBe('Email is already registered');
    });

    it('returns 429 with retryAfterSeconds for GoTrue security rate limit', async () => {
      const rateLimitError = new Error('For security purposes, you can only request this after 47 seconds.');
      const response = formatAuthErrorResponse(rateLimitError);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('47');
      const data = await response.json();
      expect(data.retryAfterSeconds).toBe(47);
      expect(data.cooldownSecondsRemaining).toBe(47);
      expect(data.error).toBe('For security purposes, please wait 47 seconds before requesting another verification code.');
    });

    it('returns 429 when error has RATE_LIMITED code', async () => {
      const err = new Error('Too many requests');
      (err as unknown as { code: string; retryAfterSeconds: number }).code = 'RATE_LIMITED';
      (err as unknown as { retryAfterSeconds: number }).retryAfterSeconds = 30;

      const response = formatAuthErrorResponse(err);
      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.retryAfterSeconds).toBe(30);
    });

    it('returns 400 for Password cannot exceed 128 characters', async () => {
      const err = new Error('Password cannot exceed 128 characters');
      const response = formatAuthErrorResponse(err);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Password cannot exceed 128 characters');
    });

    it('returns 429 instead of 400 when message contains Too many incorrect attempts', async () => {
      const err = new Error('Too many incorrect attempts. Verification is temporarily locked for 15 minutes.');
      const response = formatAuthErrorResponse(err);
      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.error).toMatch(/temporarily locked/i);
    });

    it('handles REQUIRES_OTP code returning 403 with requiresOtp and email', async () => {
      const err = new Error('Please verify your email address to complete registration.');
      (err as unknown as { code: string; requiresOtp: boolean; email: string }).code = 'REQUIRES_OTP';
      (err as unknown as { requiresOtp: boolean }).requiresOtp = true;
      (err as unknown as { email: string }).email = 'alex.user@gmail.com';

      const response = formatAuthErrorResponse(err);
      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('verify your email address');
      expect((data as { requiresOtp?: boolean }).requiresOtp).toBe(true);
      expect((data as { email?: string }).email).toBe('alex.user@gmail.com');
    });

    it('does not falsely censor conversational English sentences containing select, insert, update, delete, or stack', () => {
      const msg1 = 'Please select a valid option from the dropdown.';
      expect(sanitizeAuthErrorMessage(msg1)).toBe(msg1);

      const msg2 = 'Please insert your card to continue.';
      expect(sanitizeAuthErrorMessage(msg2)).toBe(msg2);

      const msg3 = 'Please update your billing profile.';
      expect(sanitizeAuthErrorMessage(msg3)).toBe(msg3);

      const msg4 = 'Please delete unnecessary files and retry.';
      expect(sanitizeAuthErrorMessage(msg4)).toBe(msg4);

      const msg5 = 'The full technology stack is operational.';
      expect(sanitizeAuthErrorMessage(msg5)).toBe(msg5);
    });
  });
});

describe('Supabase Auth hourly email budget (over_email_send_rate_limit)', () => {
  it('detects the raw GoTrue message and the GoTrue code', () => {
    expect(isEmailRateLimitError(new Error('email rate limit exceeded'))).toBe(true);
    const coded = new Error('something failed') as Error & { code: string };
    coded.code = 'over_email_send_rate_limit';
    expect(isEmailRateLimitError(coded)).toBe(true);
    const flagged = new Error(EMAIL_RATE_LIMIT_MESSAGE) as Error & { code: string };
    flagged.code = 'EMAIL_RATE_LIMITED';
    expect(isEmailRateLimitError(flagged)).toBe(true);
    expect(isEmailRateLimitError(new Error('For security purposes, please wait 45 seconds'))).toBe(
      false
    );
  });

  it('maps the raw GoTrue message to a 429 with the plain message, flag, and no countdown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = formatAuthErrorResponse(new Error('email rate limit exceeded'), {
      fallbackMessage: 'Unable to initiate account registration. Please try again shortly.',
    });
    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error).toBe(EMAIL_RATE_LIMIT_MESSAGE);
    expect(data.error).not.toContain('email rate limit exceeded');
    expect(data.emailRateLimited).toBe(true);
    expect(data.retryAfterSeconds).toBeUndefined();
    expect(data.cooldownSecondsRemaining).toBeUndefined();
    expect(response.headers.get('Retry-After')).toBeNull();
    consoleSpy.mockRestore();
  });

  it('maps the EMAIL_RATE_LIMITED code the same way, never the raw dump', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error(EMAIL_RATE_LIMIT_MESSAGE) as Error & { code: string };
    err.code = 'EMAIL_RATE_LIMITED';
    const response = formatAuthErrorResponse(err);
    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error).toBe(EMAIL_RATE_LIMIT_MESSAGE);
    expect(data.emailRateLimited).toBe(true);
    expect(data.retryAfterSeconds).toBeUndefined();
    consoleSpy.mockRestore();
  });
});

