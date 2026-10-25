import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from './setup';
import SignupPage from '../../src/app/signup/page';
import LoginPage from '../../src/app/login/page';

describe('Auth Pages UI (Spec 009 & Spec 010)', () => {
  // login-fixes migration: SignupPage is now an async server component,
  // so it is awaited before the synchronous static-markup render.
  // Assertions are unchanged — only the rendering harness adapted.
  describe('SignupPage', () => {
    it('renders all required registration inputs including confirm password without subdomain preview', async () => {
      const { hasText, hasAttribute, html } = render(await SignupPage({}));

      expect(hasText('Create Account')).toBe(true);
      expect(hasText('Full Name')).toBe(true);
      expect(hasText('Phone Number')).toBe(true);
      expect(hasText('Email Address')).toBe(true);
      expect(hasText('Password')).toBe(true);
      expect(hasText('Confirm Password')).toBe(true);
      // Per Spec 010 user directive, subdomain preview is removed
      expect(hasText('Workspace URL:')).toBe(false);

      expect(hasAttribute('type', 'email')).toBe(true);
      expect(hasAttribute('type', 'tel')).toBe(true);
      expect(hasAttribute('type', 'password')).toBe(true);
      expect(html).toContain('href="/login"');
    });

    // Migrated by spec 136 PR-136B: the signup form is on the §3.8 form
    // standard — its submit is the shared/ui Button primitive (token
    // classes), not the legacy inline-styled button this assertion was
    // written against. Behavioural coverage lives in
    // src/app/signup/page.test.tsx.
    it('renders the submit action on the shared/ui Button primitive', async () => {
      const { html } = render(await SignupPage({}));
      expect(html).toContain('data-slot="button"');
      expect(html).toContain('bg-primary');
    });

    it('does not contain robotic developer slop or decorative operational status dots', async () => {
      const { hasText, html } = render(await SignupPage({}));
      expect(html).not.toContain('Dots and plus tags');
      expect(html).not.toContain('Deploy your automated');
      expect(hasText('Ready')).toBe(false);
    });

    it('renders the canonical multi-platform showcase panel by default (Spec 064)', async () => {
      const { hasText, html } = render(await SignupPage({}));
      expect(hasText('CREATE · SCHEDULE · GROW')).toBe(true);
      expect(hasText('Your pages,')).toBe(true);
      expect(hasText('posting themselves —')).toBe(true);
      expect(hasText('100% on the cloud.')).toBe(true);
      expect(hasText('Post from anywhere')).toBe(true);
      expect(hasText('Every platform, one dashboard')).toBe(true);
      expect(hasText('Your accounts stay yours')).toBe(true);
      // login-fixes Option 1: the separate platform line was dropped
      // as approved — the platforms now live in the subhead, with
      // commas, not middle dots.
      expect(hasText('Facebook, Instagram, TikTok, YouTube, Threads, and X')).toBe(true);
      expect(hasText('Official platform logins · Encrypted end-to-end')).toBe(true);
    });
  });

  describe('LoginPage', () => {
    it('renders credentials inputs and updated welcome back description', () => {
      const { hasText, hasAttribute, html } = render(<LoginPage />);

      expect(hasText('Sign In')).toBe(true);
      expect(hasText('Welcome back! Sign in to keep your content flowing across every platform.')).toBe(true);
      expect(hasText('Email Address')).toBe(true);
      expect(hasText('Password')).toBe(true);
      expect(hasAttribute('type', 'email')).toBe(true);
      expect(hasAttribute('type', 'password')).toBe(true);
      expect(html).toContain('href="/signup"');
    });

    // Superseded by spec 137 PR-A6: the login form is the form
    // standard's reference conversion — its submit button is the
    // shared/ui Button primitive (token classes), not the legacy
    // inline-styled button this assertion was written against.
    // Behavioural coverage lives in src/app/login/page.test.tsx.
    it('renders the submit action on the shared/ui Button primitive', () => {
      const { html } = render(<LoginPage />);
      expect(html).toContain('data-slot="button"');
      expect(html).toContain('bg-primary');
    });

    it('does not contain robotic developer slop or decorative operational status dots', () => {
      const { hasText, html } = render(<LoginPage />);
      expect(html).not.toContain('isolated workspace');
      expect(html).not.toContain('Gateway');
      expect(hasText('Online')).toBe(false);
    });

    it('displays success alert when reset=success is present', () => {
      const { hasText } = render(<LoginPage initialResetSuccess={true} />);
      expect(hasText('Password Updated')).toBe(true);
      expect(
        hasText('Your password has been successfully reset. Please sign in with your new credentials.')
      ).toBe(true);
    });
  });
});
