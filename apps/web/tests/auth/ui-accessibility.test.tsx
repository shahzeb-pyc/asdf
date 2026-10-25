import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '../components/setup';
import LoginPage from '../../src/app/login/page';
import SignupPage from '../../src/app/signup/page';
import ForgotPasswordPage from '../../src/app/forgot-password/page';
import ResetPasswordPage from '../../src/app/reset-password/page';
import { PasswordInput } from '../../src/components/auth/password-input';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('WCAG 2.2 AA Accessibility & Usability (AUTH-08 to AUTH-15 / Spec 017 US5)', () => {
  describe('LoginPage Accessibility (AUTH-08, AUTH-09)', () => {
    it('associates Password label with password input using htmlFor and id', () => {
      const { html, hasAttribute } = render(<LoginPage />);
      expect(html).toContain('for="login-password"');
      expect(html).toContain('id="login-password"');
      expect(hasAttribute('autoComplete', 'current-password')).toBe(true);
    });

    it('displays proactive helper text indicating supported Gmail accounts', () => {
      const { hasText } = render(<LoginPage />);
      expect(hasText('Only @gmail.com (or @googlemail.com) accounts are supported.')).toBe(true);
    });
  });

  // login-fixes migration: SignupPage is now an async server component,
  // so it is awaited before the synchronous static-markup render.
  // Assertions are unchanged — only the rendering harness adapted.
  describe('SignupPage Accessibility & Form Preservation (AUTH-10, AUTH-11)', () => {
    it('renders Terms and Privacy links opening in new tab with noopener noreferrer', async () => {
      const { html } = render(await SignupPage({}));
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('contains no generic or broken links', async () => {
      const { html } = render(await SignupPage({}));
      expect(html).not.toContain('href="#"');
    });
  });

  describe('ForgotPasswordPage Accessibility (AUTH-12, AUTH-13)', () => {
    it('provides autoComplete="email" on email input for autofill assist', () => {
      const { hasAttribute } = render(<ForgotPasswordPage />);
      expect(hasAttribute('autoComplete', 'email')).toBe(true);
    });

    it('provides accessible helper text describing recovery dispatch', () => {
      const { hasText } = render(<ForgotPasswordPage />);
      expect(hasText('Enter your registered Gmail address to receive a 6-digit verification code.')).toBe(true);
    });
  });

  describe('ResetPasswordPage Accessibility (AUTH-14)', () => {
    it('provides accessible redirection guidance to unified recovery flow', () => {
      const { html, hasText } = render(<ResetPasswordPage />);
      expect(hasText('Redirecting to Reset password')).toBe(true);
      expect(html).toContain('href="/forgot-password"');
    });
  });

  describe('Password Toggle (AUTH-15)', () => {
    it('renders toggle button with accessible Show password label', () => {
      // Spec 136 PR-136E: the legacy Input's isPassword toggle (and its
      // fbu-password-toggle class hook) is deleted with components/ui;
      // the password toggle now lives in the shared PasswordInput, whose
      // toggle is identified by its accessible "Show password" label —
      // the same assertion the migrated PasswordInput suite uses.
      const { html } = render(<PasswordInput label="Secret" />);
      expect(html).toContain('aria-label="Show password"');
    });
  });
});
