import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../components/setup';
import { SignupPausedCard } from '@/components/auth/signup-paused-card';
import SignupPage from '@/app/signup/page';

describe('Signup Paused Notice UI (Spec 064)', () => {
  const originalEnv = process.env.NEXT_PUBLIC_SIGNUPS_ENABLED;
  const originalWhatsApp = process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER = '+15551234567';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = originalEnv;
    process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER = originalWhatsApp;
  });

  describe('SignupPausedCard Component', () => {
    it('renders the paused notice banner with the token primary accent border and explanatory message', () => {
      const { hasText, html } = render(<SignupPausedCard />);

      expect(hasText('New registrations are currently closed')).toBe(true);
      expect(
        hasText(
          "We're temporarily pausing new signups while we scale up. Existing users can keep using their workspaces as usual."
        )
      ).toBe(true);
      // Spec 136 PR-136B: the card is rebuilt on tokens — the accent is
      // the token-backed border utility, not an inline style.
      expect(html).toContain('border-l-primary');
      expect(html).not.toContain('border-left:3px');
    });

    it('renders primary CTA button routing to /login', () => {
      const { hasText, html } = render(<SignupPausedCard />);

      expect(hasText('Sign in to workspace')).toBe(true);
      expect(html).toContain('href="/login"');
    });

    it('renders WhatsApp support link when support number is configured', () => {
      const { hasText, html } = render(<SignupPausedCard />);

      expect(hasText('Contact customer support')).toBe(true);
      expect(html).toContain('https://wa.me/15551234567');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('omits WhatsApp support link when support number is not configured', () => {
      delete process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER;
      const { hasText, html } = render(<SignupPausedCard />);

      expect(hasText('Contact customer support')).toBe(false);
      expect(html).not.toContain('https://wa.me');
    });
  });

  // login-fixes migration: SignupPage is now an async server component,
  // so it is awaited before the synchronous static-markup render.
  // Assertions are unchanged — only the rendering harness adapted.
  describe('SignupPage Integration with Guard', () => {
    it('renders regular registration inputs when signups are enabled (default or "true")', async () => {
      process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = 'true';
      const { hasText, hasAttribute } = render(await SignupPage({}));

      expect(hasText('Create Account')).toBe(true);
      expect(hasText('Full Name')).toBe(true);
      expect(hasText('Email Address')).toBe(true);
      expect(hasAttribute('type', 'email')).toBe(true);
      expect(hasText('New registrations are currently closed')).toBe(false);
    });

    it('renders SignupPausedCard and paused header when NEXT_PUBLIC_SIGNUPS_ENABLED="false"', async () => {
      process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = 'false';
      const { hasText, html } = render(await SignupPage({}));

      expect(hasText('Registration Paused')).toBe(true);
      expect(hasText('We are currently not accepting new account registrations.')).toBe(true);
      expect(hasText('New registrations are currently closed')).toBe(true);
      expect(hasText('Sign in to workspace')).toBe(true);
      expect(html).toContain('href="/login"');

      // Regular form inputs must NOT be rendered when signups are paused
      expect(hasText('Full Name')).toBe(false);
      expect(hasText('Confirm Password')).toBe(false);
    });

    it('treats "0", "off", and "disabled" as disabled states', async () => {
      for (const val of ['0', 'off', 'disabled']) {
        process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = val;
        const { hasText } = render(await SignupPage({}));
        expect(hasText('Registration Paused')).toBe(true);
        expect(hasText('New registrations are currently closed')).toBe(true);
      }
    });
  });
});
