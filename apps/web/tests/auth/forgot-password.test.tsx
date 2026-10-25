import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { render } from '../components/setup';
import ForgotPasswordPage from '../../src/app/forgot-password/page';
import LoginPage from '../../src/app/login/page';
import { POST as forgotPasswordHandler } from '../../src/app/api/auth/forgot-password/route';
import { POST as resendHandler } from '../../src/app/api/auth/forgot-password/resend/route';
import {
  createPasswordResetOtp,
  _resetOtpStore,
} from '../../src/lib/otp-service';
import { _resetRateLimiter } from '../../src/lib/rate-limiter';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

describe('Password Recovery - Forgot Password (US1 & Spec 018 US3)', () => {
  beforeEach(() => {
    _resetOtpStore();
    _resetRateLimiter();
  });

  describe('LoginPage Integration', () => {
    it('renders a Forgot password link directing to /forgot-password', () => {
      const { hasText, html } = render(<LoginPage />);

      expect(hasText('Forgot password?')).toBe(true);
      expect(html).toContain('href="/forgot-password"');
    });
  });

  describe('ForgotPasswordPage UI Elements', () => {
    it('renders email input, helper text, and submit button in AuthSplitLayout', () => {
      const { hasText, hasAttribute, html } = render(<ForgotPasswordPage />);

      expect(hasText('Reset Password')).toBe(true);
      expect(hasText('Email Address')).toBe(true);
      expect(hasText('Enter your registered Gmail address to receive a 6-digit verification code.')).toBe(true);
      expect(hasText('Send Verification Code')).toBe(true);
      expect(hasAttribute('type', 'email')).toBe(true);
      expect(html).toContain('href="/login"');
    });

    it('contains no robotic developer slop or decorative status dots', () => {
      const { hasText } = render(<ForgotPasswordPage />);
      expect(hasText('Online')).toBe(false);
      expect(hasText('Ready')).toBe(false);
      expect(hasText('Operational')).toBe(false);
      expect(hasText('Database')).toBe(false);
    });

    it('renders success notice and link to /login?reset=success when password reset succeeds', () => {
      const { hasText, html } = render(<ForgotPasswordPage initialSuccess={true} />);
      expect(hasText('Password Updated')).toBe(true);
      expect(html).toContain('href="/login?reset=success"');
    });
  });

  describe('API Route POST /api/auth/forgot-password', () => {
    it('returns 400 when email is missing or invalid', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      });

      const res = await forgotPasswordHandler(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('valid email address');
    });

    it('returns 400 when email is not a Gmail domain', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operator@example.com' }),
      });

      const res = await forgotPasswordHandler(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toContain('Only @gmail.com');
    });

    it('returns 200 with confirmation message for valid email format', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operator@gmail.com' }),
      });

      const res = await forgotPasswordHandler(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.requiresOtp).toBe(true);
      expect(body.message).toBeDefined();
    });
  });

  describe('API Route POST /api/auth/forgot-password/resend', () => {
    it('returns 400 when email is missing or non-Gmail', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/forgot-password/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bad@yahoo.com' }),
      });

      const res = await resendHandler(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Only @gmail.com');
    });

    it('enforces 60-second cooldown on resend attempts', async () => {
      const email = 'cooldown.user@gmail.com';
      await createPasswordResetOtp(email);

      const req = new NextRequest('http://localhost:3000/api/auth/forgot-password/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const res = await resendHandler(req);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toContain('Please wait');
      expect(body.cooldownSecondsRemaining).toBeGreaterThan(0);
    });
  });
});
