import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { render } from '../components/setup';
import ResetPasswordPage from '../../src/app/reset-password/page';
import { POST as resetPasswordHandler } from '../../src/app/api/auth/reset-password/route';
import {
  _setMockSupabaseClient,
} from '../../src/lib/auth/clients';
import {
  resetUserPassword,
} from '../../src/lib/auth/password-reset';
import {
  _setResetTokenForTesting,
  _resetAuthStores,
} from '../../src/lib/auth/stores';
import {
  createPasswordResetOtp,
  _resetOtpStore,
} from '../../src/lib/otp-service';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('Password Recovery - Reset Password (US2)', () => {
  const originalWindow = (global as unknown as { window?: unknown }).window;

  beforeEach(() => {
    _resetAuthStores();
    _resetOtpStore();
  });

  afterEach(() => {
    if (originalWindow !== undefined) {
      (global as unknown as { window: unknown }).window = originalWindow;
    } else {
      delete (global as unknown as { window?: unknown }).window;
    }
  });

  describe('ResetPasswordPage UI Guard & States', () => {
    it('renders redirection guidance to /forgot-password with recovery button', () => {
      const { hasText, html } = render(<ResetPasswordPage />);

      expect(hasText('Redirecting to Reset password')).toBe(true);
      expect(hasText('Go to Reset password')).toBe(true);
      expect(html).toContain('href="/forgot-password"');
      expect(html).toContain('href="/login"');
    });

    it('contains no robotic developer slop or decorative status dots', () => {
      const { hasText } = render(<ResetPasswordPage />);
      expect(hasText('Online')).toBe(false);
      expect(hasText('Ready')).toBe(false);
      expect(hasText('Operational')).toBe(false);
    });
  });

  describe('API Route POST /api/auth/reset-password', () => {
    it('returns 400 when password is under 8 characters', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'some-token',
          password: 'short',
        }),
      });

      const res = await resetPasswordHandler(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('8 characters');
    });

    it('returns 400 when token or verification code is missing', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'super-secure-password-123',
        }),
      });

      const res = await resetPasswordHandler(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('verification code or recovery token is required');
    });

    it('returns 200 when valid token and password are provided', async () => {
      const token = 'valid-token-abc-123';
      const verifyOtpMock = vi.fn().mockResolvedValue({
        data: { session: { access_token: 'fake-session-token' }, user: { id: 'user-abc' } },
        error: null,
      });
      const updateUserMock = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-abc' } },
        error: null,
      });
      const mockSupabase = {
        auth: {
          verifyOtp: verifyOtpMock,
          updateUser: updateUserMock,
        },
      };
      _setMockSupabaseClient(mockSupabase as any);

      const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.1',
        },
        body: JSON.stringify({
          token,
          password: 'super-secure-password-123',
        }),
      });

      const res = await resetPasswordHandler(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('successfully updated');
      expect(verifyOtpMock).toHaveBeenCalledWith({
        token_hash: token,
        type: 'recovery',
      });
      expect(updateUserMock).toHaveBeenCalledWith({
        password: 'super-secure-password-123',
      });

      _setMockSupabaseClient(null);
    });

    it('returns 200 when valid 6-digit OTP, email, and password are provided', async () => {
      const email = 'alex.otp.testuser@gmail.com';
      const { otp } = await createPasswordResetOtp(email);

      const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.5',
        },
        body: JSON.stringify({
          email,
          otp,
          password: 'new-valid-password-789',
        }),
      });

      const res = await resetPasswordHandler(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('successfully updated');
    });

    it('rejects reused reset tokens (single-use token enforcement)', async () => {
      const token = 'single-use-token-456';
      let consumed = false;
      const verifyOtpMock = vi.fn().mockImplementation(async () => {
        if (consumed) {
          return { data: null, error: { message: 'Token has already been consumed or is invalid' } };
        }
        consumed = true;
        return {
          data: { session: { access_token: 'fake-session' }, user: { id: 'user-1' } },
          error: null,
        };
      });
      const updateUserMock = vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1' } },
        error: null,
      });
      const mockSupabase = {
        auth: {
          verifyOtp: verifyOtpMock,
          updateUser: updateUserMock,
        },
      };
      _setMockSupabaseClient(mockSupabase as any);

      // First use succeeds
      const req1 = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.2',
        },
        body: JSON.stringify({
          token,
          password: 'super-secure-password-123',
        }),
      });

      const res1 = await resetPasswordHandler(req1);
      expect(res1.status).toBe(200);

      // Second use with identical token must fail
      const req2 = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '198.51.100.2',
        },
        body: JSON.stringify({
          token,
          password: 'another-secure-password-456',
        }),
      });

      const res2 = await resetPasswordHandler(req2);
      expect(res2.status).toBe(400);
      const body2 = await res2.json();
      expect(body2.error).toContain('Invalid or expired');

      _setMockSupabaseClient(null);
    });

    it('enforces IP rate limiting after 5 attempts per minute', async () => {
      const clientIp = '203.0.113.99';

      for (let i = 0; i < 5; i++) {
        const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': clientIp,
          },
          body: JSON.stringify({
            token: `token-${i}`,
            password: 'super-secure-password-123',
          }),
        });
        await resetPasswordHandler(req);
      }

      // 6th attempt should trigger 429
      const req6 = new NextRequest('http://localhost:3000/api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': clientIp,
        },
        body: JSON.stringify({
          token: 'token-6',
          password: 'super-secure-password-123',
        }),
      });

      const res6 = await resetPasswordHandler(req6);
      expect(res6.status).toBe(429);
      const body6 = await res6.json();
      expect(body6.error).toContain('Too many password reset attempts');
    });

    describe('Supabase Client Token Recovery (Issue 04)', () => {
      it('confirms password reset with token parameter succeeds against mocked Supabase', async () => {
        const verifyOtpMock = vi.fn().mockResolvedValue({
          data: { session: { access_token: 'fake-session-token' }, user: { id: 'user-abc' } },
          error: null,
        });
        const updateUserMock = vi.fn().mockResolvedValue({
          data: { user: { id: 'user-abc' } },
          error: null,
        });

        const mockSupabase = {
          auth: {
            verifyOtp: verifyOtpMock,
            updateUser: updateUserMock,
          },
        };

        _setMockSupabaseClient(mockSupabase as any);

        const result = await resetUserPassword({
          token: 'recovery-token-xyz-789',
          password: 'new-valid-secure-pass-123',
        });

        expect(verifyOtpMock).toHaveBeenCalledWith({
          token_hash: 'recovery-token-xyz-789',
          type: 'recovery',
        });
        expect(updateUserMock).toHaveBeenCalledWith({
          password: 'new-valid-secure-pass-123',
        });
        expect(result.message).toBe('Your password has been successfully updated.');

        _setMockSupabaseClient(null);
      });

      it('throws clear user-safe error if token verification fails against mocked Supabase', async () => {
        const verifyOtpMock = vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Token has expired or is invalid' },
        });
        const updateUserMock = vi.fn();

        const mockSupabase = {
          auth: {
            verifyOtp: verifyOtpMock,
            updateUser: updateUserMock,
          },
        };

        _setMockSupabaseClient(mockSupabase as any);

        await expect(
          resetUserPassword({
            token: 'expired-token-xyz',
            password: 'new-valid-secure-pass-123',
          })
        ).rejects.toThrow('Invalid or expired password reset link.');

        expect(verifyOtpMock).toHaveBeenCalledWith({
          token_hash: 'expired-token-xyz',
          type: 'recovery',
        });
        expect(updateUserMock).not.toHaveBeenCalled();

        _setMockSupabaseClient(null);
      });

      it('handles API route POST /api/auth/reset-password with token parameter against mocked Supabase', async () => {
        const verifyOtpMock = vi.fn().mockResolvedValue({
          data: { session: { access_token: 'valid-session' }, user: { id: 'user-123' } },
          error: null,
        });
        const updateUserMock = vi.fn().mockResolvedValue({
          data: { user: { id: 'user-123' } },
          error: null,
        });

        const mockSupabase = {
          auth: {
            verifyOtp: verifyOtpMock,
            updateUser: updateUserMock,
          },
        };

        _setMockSupabaseClient(mockSupabase as any);

        const req = new NextRequest('http://localhost:3000/api/auth/reset-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-forwarded-for': '198.51.100.42',
          },
          body: JSON.stringify({
            token: 'recovery-token-api-hash',
            password: 'valid-super-secret-password-456',
          }),
        });

        const res = await resetPasswordHandler(req);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.message).toContain('successfully updated');
        expect(verifyOtpMock).toHaveBeenCalledWith({
          token_hash: 'recovery-token-api-hash',
          type: 'recovery',
        });
        expect(updateUserMock).toHaveBeenCalledWith({
          password: 'valid-super-secret-password-456',
        });

        _setMockSupabaseClient(null);
      });
    });
  });
});
