/**
 * @file connect-pages.test.tsx
 * @description Spec 123 Part C: the picker landing page (server component,
 * fed by the signed pending cookie). The destination dedicated-section
 * landing page and its frame were removed with the Destinations pages;
 * the old /destinations/<id> route now redirects to the Pages section.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { signPendingDestinations } from '@/lib/connect/state';
import { render } from './setup';

const TEST_SECRET = 'test_session_secret_at_least_32_chars_long_value';

const cookieStore: { value: string | null } = { value: null };

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'fbup_connect_pending' && cookieStore.value
        ? { name, value: cookieStore.value }
        : undefined,
  }),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ subdomain: 'acme', destinationId: 'dest-row-1' }),
  useRouter: () => ({ push: () => undefined }),
}));

import ConnectPickerPage from '@/app/tenant/[subdomain]/connect/[platform]/page';
import InstagramAccountsPage from '@/app/tenant/[subdomain]/instagram/accounts/page';
import ThreadsAccountsPage from '@/app/tenant/[subdomain]/threads/accounts/page';
import YouTubeAccountsPage from '@/app/tenant/[subdomain]/youtube/accounts/page';
import TikTokAccountsPage from '@/app/tenant/[subdomain]/tiktok/accounts/page';
import XTwitterAccountsPage from '@/app/tenant/[subdomain]/x/accounts/page';

describe('Connect picker page', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    cookieStore.value = null;
  });

  it('renders the picker with the destinations from the pending cookie', async () => {
    cookieStore.value = await signPendingDestinations(
      {
        accountId: 'acct-1',
        workspaceId: 'ws-1',
        tenantSubdomain: 'acme',
        platform: 'instagram',
        destinations: [
          { externalDestinationId: 'dest-1001', name: 'My Brand', handle: 'mybrand' },
          { externalDestinationId: 'dest-2002', name: 'Second', handle: 'second' },
        ],
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_SECRET
    );

    const element = await ConnectPickerPage({
      params: Promise.resolve({ subdomain: 'acme', platform: 'instagram' }),
      searchParams: Promise.resolve({}),
    });
    const { html, hasText } = render(element);
    expect(html).toContain('data-testid="connect-picker-page"');
    expect(hasText('Choose what to add')).toBe(true);
    expect(hasText('My Brand')).toBe(true);
    expect(hasText('Second')).toBe(true);
    expect(html).toContain('data-testid="destination-picker"');
  });

  it('shows the plain-language denial message when the notice is denied', async () => {
    const element = await ConnectPickerPage({
      params: Promise.resolve({ subdomain: 'acme', platform: 'instagram' }),
      searchParams: Promise.resolve({ notice: 'denied' }),
    });
    const { html, hasText } = render(element);
    expect(hasText('Connection canceled. No changes were made.')).toBe(true);
    expect(hasText('Go to Accounts')).toBe(true);
    // Per-platform landing page: the Instagram picker links to the
    // Instagram accounts page, not Facebook's.
    expect(html).toContain('/tenant/acme/instagram/accounts');
    expect(html).not.toMatch(/oauth|scope|endpoint/i);
  });

  it('shows the expired message when there is no pending cookie', async () => {
    const element = await ConnectPickerPage({
      params: Promise.resolve({ subdomain: 'acme', platform: 'instagram' }),
      searchParams: Promise.resolve({}),
    });
    const { hasText } = render(element);
    expect(
      hasText('This connection link has expired. Please start again from Accounts.')
    ).toBe(true);
  });
});

describe('Per-platform accounts pages', () => {
  // NOTE: the Instagram page is covered behaviourally in
  // tests/ui/instagram-accounts-page.test.tsx. The stale assertion
  // that lived here (placeholder ByocGate + `instagram-connect-link`)
  // was deleted with the placeholder page when the real Instagram
  // list shell shipped; it cannot render under this legacy static
  // helper (the shell suspends on useSearchParams).

  it('renders the gated Threads connect action', () => {
    const { html, hasText } = render(<ThreadsAccountsPage />);
    expect(hasText('Threads Accounts')).toBe(true);
    expect(html).toContain('data-testid="threads-connect-link"');
    expect(html).toContain('/api/connect/threads?subdomain=acme');
  });

  it('explains the YouTube connect model with no keys to paste', () => {
    const { hasText } = render(<YouTubeAccountsPage />);
    expect(hasText('through our publishing partner')).toBe(true);
    expect(hasText('nothing to set up or paste here')).toBe(true);
  });

  it('explains the TikTok connect model with no keys to paste', () => {
    const { hasText } = render(<TikTokAccountsPage />);
    expect(hasText('through our publishing partner')).toBe(true);
  });

  it('explains the X connect model as a simple sign-in', () => {
    const { hasText } = render(<XTwitterAccountsPage />);
    expect(hasText('Simply sign in with X and approve the connection')).toBe(
      true
    );
    expect(hasText('no keys to create or paste')).toBe(true);
  });

});
