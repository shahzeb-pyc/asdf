import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '../components/setup';
import SignupPage from '../../src/app/signup/page';
import LoginPage from '../../src/app/login/page';
import ForgotPasswordPage from '../../src/app/forgot-password/page';
import ResetPasswordPage from '../../src/app/reset-password/page';
import { Input } from '../../src/components/shared/ui/input';
import { Field } from '../../src/components/shared/ui/form';
import { PasswordInput } from '../../src/components/auth/password-input';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('Auth Inline Error Highlighting & Edge Cases (Spec 016)', () => {
  // login-fixes migration: SignupPage is now an async server component,
  // so it is awaited before the synchronous static-markup render.
  // Assertions are unchanged — only the rendering harness adapted.
  describe('SignupPage Inline Validation & Edge Cases', () => {
    it('does not render PasswordStrengthMeter or strength bars anywhere in signup form', async () => {
      const { html, hasText } = render(await SignupPage({}));

      // PasswordStrengthMeter elements must be absent
      expect(hasText('Password strength:')).toBe(false);
      expect(hasText('Weak')).toBe(false);
      expect(hasText('Fair')).toBe(false);
      expect(hasText('Strong')).toBe(false);
      expect(hasText('At least one symbol')).toBe(false);
      expect(html).not.toContain('fbu-password-meter');
    });

    it('does not render top-level Alert error box on initial render', async () => {
      const { html } = render(await SignupPage({}));
      expect(html).not.toContain('fbu-alert-error');
      expect(html).not.toContain("Couldn't create account");
    });

    it('renders clean helper text without robotic jargon', async () => {
      const { hasText } = render(await SignupPage({}));
      expect(hasText('Include your country code, e.g. +1 or +92.')).toBe(true);
      expect(hasText('Only @gmail.com (or @googlemail.com) accounts are supported.')).toBe(true);
      expect(hasText('Minimum 8 characters')).toBe(true);
    });
  });

  // Spec 136 PR-136C: the `FormErrorCallout` describe that lived here is
  // deleted with the component itself — its last consumer (the forgot
  // page) converted to the form standard's `FormErrorSummary`, and no
  // local error pattern survives (UI Rule 11). Form-level errors on the
  // recovery forms are covered behaviourally in
  // `src/app/forgot-password/page.test.tsx`.

  describe('LoginPage Inline Validation', () => {
    it('does not render top-level Alert error box on initial render', () => {
      const { html } = render(<LoginPage />);
      expect(html).not.toContain('fbu-alert-error');
      expect(html).not.toContain("Couldn't sign you in");
    });
  });

  describe('ForgotPasswordPage Inline Validation', () => {
    it('does not render top-level Alert error box on initial render', () => {
      const { html } = render(<ForgotPasswordPage />);
      expect(html).not.toContain('fbu-alert-error');
      expect(html).not.toContain("Couldn't send recovery link");
    });
  });

  describe('Input and PasswordInput Error States', () => {
    it('Input renders aria-invalid and inline role="alert" message when error is provided via Field', () => {
      // Spec 136 PR-136E: the legacy Input (label/error props of its own)
      // is deleted with components/ui; the shared pattern is the form
      // standard's `Field` wrapper around the shared/ui Input — it wires
      // aria-invalid + the token-coloured inline message, exactly as the
      // rebuilt PasswordInput below does. The legacy `has-error` class /
      // hex assertions belonged to the legacy Input it replaced.
      const { html, hasText, hasAttribute } = render(
        <Field
          id="phone-number"
          label="Phone Number"
          error="Please enter a complete, valid international phone number."
        >
          <Input />
        </Field>
      );

      expect(hasText('Phone Number')).toBe(true);
      expect(hasText('Please enter a complete, valid international phone number.')).toBe(true);
      expect(hasAttribute('aria-invalid', 'true')).toBe(true);
      expect(html).toContain('role="alert"');
      expect(html).toContain('text-brand-rose');
    });

    it('PasswordInput renders aria-invalid and an inline role="alert" message when error prop is provided', () => {
      // Spec 136 PR-136B: the rebuilt shared control (shared/ui Input)
      // carries the error via aria-invalid + the token-coloured inline
      // message — the legacy `has-error` class / hex assertions belonged
      // to the legacy Input it replaced.
      const { html, hasText, hasAttribute } = render(
        <PasswordInput label="Confirm Password" error="Passwords do not match. Enter the same password in both fields." />
      );

      expect(hasText('Confirm Password')).toBe(true);
      expect(hasText('Passwords do not match. Enter the same password in both fields.')).toBe(true);
      expect(hasAttribute('aria-invalid', 'true')).toBe(true);
      expect(html).toContain('role="alert"');
      expect(html).toContain('text-brand-rose');
    });
  });

  describe('ResetPasswordPage Inline Validation', () => {
    it('does not render top-level Alert error box on initial render', () => {
      const { html } = render(<ResetPasswordPage />);
      expect(html).not.toContain('fbu-alert-error');
      expect(html).not.toContain("Couldn't reset password");
    });
  });
});
