/**
 * @file pages-account-filter.test.tsx
 * @description ?account= contract for the Pages list (Accounts card
 * "pages linked" link): the shell initialises its account filter
 * from the URL param on arrival and syncs toolbar changes back to
 * the URL. Regression test for the live bug where the param was
 * dropped on arrival and the full unfiltered list showed.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/lib/data/query-keys';
import { PagesShell } from '@/app/tenant/[subdomain]/pages/pages-shell';
import type { FacebookPageItem } from '@/components/pages/page-card';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => currentSearchParams,
}));

const sarahAccount: FacebookAccountItem = {
  id: 'acc-sarah',
  fbAccountId: 'fb_user_sarah',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const johnAccount: FacebookAccountItem = {
  id: 'acc-john',
  fbAccountId: 'fb_user_john',
  displayName: 'John Doe',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

function makePage(overrides: Partial<FacebookPageItem>): FacebookPageItem {
  return {
    id: 'page-1',
    facebookAccountId: 'acc-sarah',
    accountDisplayName: 'Sarah Connor',
    fbPageId: 'fb_page_1',
    pageName: 'Alpha Page',
    profilePictureUrl: null,
    category: 'Tech',
    startingFollowers: 100,
    currentFollowers: 120,
    followersGained: 20,
    status: 'active',
    tasks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

// Six pages (>4) so the toolbar renders: 2 Sarah, 4 John.
const johnPage = {
  facebookAccountId: 'acc-john',
  accountDisplayName: 'John Doe',
};
const sixPages: FacebookPageItem[] = [
  makePage({ id: 'page-alpha', pageName: 'Alpha Page' }),
  makePage({ id: 'page-beta', pageName: 'Beta Page', fbPageId: 'fb_page_2' }),
  makePage({
    id: 'page-gamma',
    pageName: 'Gamma Page',
    fbPageId: 'fb_page_3',
    ...johnPage,
  }),
  makePage({
    id: 'page-delta',
    pageName: 'Delta Page',
    fbPageId: 'fb_page_4',
    ...johnPage,
  }),
  makePage({
    id: 'page-epsilon',
    pageName: 'Epsilon Page',
    fbPageId: 'fb_page_5',
    ...johnPage,
  }),
  makePage({
    id: 'page-zeta',
    pageName: 'Zeta Page',
    fbPageId: 'fb_page_6',
    ...johnPage,
  }),
];

function renderShell(search: string) {
  currentSearchParams = new URLSearchParams(search);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const tenant = queryKeys.tenant('acme');
  queryClient.setQueryData(tenant.pages.list, {
    pages: sixPages,
    total: sixPages.length,
  });
  queryClient.setQueryData(tenant.accounts.list, {
    accounts: [sarahAccount, johnAccount],
    total: 2,
  });
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
  render(
    <QueryClientProvider client={queryClient}>
      <PagesShell subdomain="acme" />
    </QueryClientProvider>
  );
}

describe('Pages ?account= filter contract', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    currentSearchParams = new URLSearchParams();
  });

  it('initialises the account filter from ?account= (display name)', async () => {
    renderShell('account=Sarah+Connor');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('page-card-page-beta')).toBeTruthy();
    expect(screen.queryByTestId('page-card-page-gamma')).toBeNull();
    expect(screen.queryByTestId('page-card-page-delta')).toBeNull();
  });

  it('initialises the account filter from ?account= (account id)', async () => {
    renderShell('account=acc-john');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-gamma')).toBeTruthy();
    });
    expect(screen.queryByTestId('page-card-page-alpha')).toBeNull();
    expect(screen.queryByTestId('page-card-page-beta')).toBeNull();
  });

  it('falls back to all pages for an unknown ?account= value', async () => {
    renderShell('account=Nobody+Here');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('page-card-page-gamma')).toBeTruthy();
    expect(screen.getByTestId('page-card-page-zeta')).toBeTruthy();
  });

  it('shows all pages with no ?account= param', async () => {
    renderShell('');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-alpha')).toBeTruthy();
    });
    expect(screen.getByTestId('page-card-page-gamma')).toBeTruthy();
  });

  it('toolbar account change writes ?account= to the URL via replace', async () => {
    const user = userEvent.setup();
    renderShell('');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-alpha')).toBeTruthy();
    });
    await user.click(screen.getByTestId('pages-account-filter'));
    const option = await screen.findByRole('option', { name: 'John Doe' });
    await user.click(option);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        '/tenant/acme/pages?account=John+Doe'
      );
    });
    // And the list itself is filtered to John's pages.
    expect(screen.getByTestId('page-card-page-gamma')).toBeTruthy();
    expect(screen.queryByTestId('page-card-page-alpha')).toBeNull();
  });

  it("choosing 'All accounts' removes the ?account= param", async () => {
    const user = userEvent.setup();
    renderShell('account=Sarah+Connor');
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-alpha')).toBeTruthy();
    });
    await user.click(screen.getByTestId('pages-account-filter'));
    const option = await screen.findByRole('option', {
      name: 'All accounts',
    });
    await user.click(option);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/tenant/acme/pages');
    });
    expect(screen.getByTestId('page-card-page-gamma')).toBeTruthy();
  });
});
