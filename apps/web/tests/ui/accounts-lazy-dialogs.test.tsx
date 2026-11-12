/**
 * @file accounts-lazy-dialogs.test.tsx
 * @description Spec 170 F6: the connect + disconnect dialogs load on
 * demand via `next/dynamic`, not in the first-load bundle. This suite
 * pins the shell side: mount-on-first-open, open, and close for both
 * dialogs, through the real `next/dynamic` (no mock — the chunk
 * resolves asynchronously, so opens are awaited with `findBy`, the
 * same pattern as the spec 159 O3 OTP-step test). It pins behaviour
 * preservation, not the bundle split itself: the split is the
 * `next/dynamic` import + the `*Mounted` gates in the shell, verified
 * by code inspection and the build's chunk output. The magic-link view
 * and mismatch handling live inside the dialog components and are
 * pinned by their own suites (accounts.test.tsx,
 * accounts-connect-dialogue.test.tsx).
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/lib/data/query-keys';
import { AccountsShell } from '@/app/tenant/[subdomain]/accounts/accounts-shell';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

// Same neutral-entitlement stub as list-pagination-subtitles.test.tsx:
// the shells under test render the feature-cap hook, which reads the
// shared entitlement; these standalone shell tests do not mount the
// tenant shell, so the hook reads the unproven state instead of
// throwing for a missing provider.
vi.mock('@/components/billing/entitlement-provider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSharedEntitlement: () => ({
      entitlement: null,
      isProven: false,
      isLoading: false,
      isUnproven: true,
      refetch: async () => undefined,
    }),
  };
});

const ACCOUNT: FacebookAccountItem = {
  id: '22222222-2222-4222-8222-000000000001',
  fbAccountId: 'fb_user_1',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

// The card only renders its Reconnect button for expired / error /
// expiring-soon accounts, so the reconnect test seeds this one.
const EXPIRED_ACCOUNT: FacebookAccountItem = {
  ...ACCOUNT,
  id: '22222222-2222-4222-8222-000000000002',
  fbAccountId: 'fb_user_2',
  status: 'expired',
};

function seedClient(accounts: FacebookAccountItem[] = [ACCOUNT]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const tenant = queryKeys.tenant('acme');
  queryClient.setQueryData(
    tenant.accounts.listPage({ page: 1, limit: 30, search: '', status: 'all' }),
    {
      accounts,
      total: accounts.length,
      page: 1,
      limit: 30,
      totalPages: 1,
      healthCounts: {
        connected: accounts.filter((a) => a.status === 'active').length,
        expired: accounts.filter((a) => a.status === 'expired').length,
        error: 0,
      },
    }
  );
  queryClient.setQueryData(tenant.settings.byoc, {
    workspaceId: '33333333-3333-4333-8333-333333333333',
    subdomain: 'acme',
    fbAppId: '123456789',
    fbAppSecret: '',
    hasSecret: true,
    status: 'valid',
    lastTestedAt: null,
    connectedAt: null,
  });
  return queryClient;
}

function renderShell(accounts?: FacebookAccountItem[]) {
  render(
    <QueryClientProvider client={seedClient(accounts)}>
      <AccountsShell subdomain="acme" />
    </QueryClientProvider>
  );
}

describe('spec 170 F6: connect + disconnect dialogs load on demand', () => {
  it('neither dialog is mounted on first load', () => {
    renderShell();
    expect(screen.getByTestId('accounts-grid')).toBeTruthy();
    expect(screen.queryByTestId('connect-account-modal')).toBeNull();
    expect(screen.queryByText('Disconnect Sarah Connor?')).toBeNull();
  });

  it('Connect opens the lazy modal and closes it again', async () => {
    renderShell();
    fireEvent.click(screen.getByTestId('header-connect-button'));
    // The chunk loads asynchronously after the first open.
    expect(await screen.findByTestId('connect-account-modal')).toBeTruthy();
    expect(screen.getByText('Connect Facebook Account')).toBeTruthy();
    expect(screen.getByTestId('connect-option-direct')).toBeTruthy();
    expect(screen.getByTestId('connect-option-magic')).toBeTruthy();

    fireEvent.click(screen.getByTestId('connect-close-btn'));
    await waitFor(() =>
      expect(screen.queryByTestId('connect-account-modal')).toBeNull()
    );
  });

  it('Reconnect opens the lazy modal with the account context', async () => {
    renderShell([EXPIRED_ACCOUNT]);
    fireEvent.click(screen.getByTestId('account-reconnect-button'));
    expect(await screen.findByTestId('connect-account-modal')).toBeTruthy();
    expect(screen.getByText('Reconnect Sarah Connor')).toBeTruthy();
  });

  it('Disconnect opens the lazy dialog and cancels cleanly', async () => {
    renderShell();
    fireEvent.click(screen.getByTestId('account-disconnect-button'));
    // The chunk loads asynchronously after the first open.
    expect(await screen.findByText('Disconnect Sarah Connor?')).toBeTruthy();
    expect(screen.getByTestId('disconnect-confirm-btn')).toBeTruthy();

    fireEvent.click(screen.getByTestId('disconnect-cancel-btn'));
    await waitFor(() =>
      expect(screen.queryByText('Disconnect Sarah Connor?')).toBeNull()
    );
  });
});
