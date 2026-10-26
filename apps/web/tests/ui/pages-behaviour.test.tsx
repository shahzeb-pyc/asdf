/**
 * @file pages-behaviour.test.tsx
 * @description Behavioural tests for the spec 131 PR-131-2 rebuilt
 * Pages components (spec §8.7): toolbar interactions, the shell's
 * expired-banner Reconnect routing and filter-to-zero recovery, the
 * PageCard activation contract, and the full Add Page flow
 * (account pick → discover → select → import) against the typed API
 * client with a mocked fetch — rendered live (Testing Library,
 * jsdom project), never static markup. These replace the legacy
 * function-call tree probes in pages.test.tsx, which the §8.4
 * decomposition made inapplicable (named modification 3 there).
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/lib/data/query-keys';
import { PagesShell } from '@/app/tenant/[subdomain]/pages/pages-shell';
import { PagesScaleToolbar } from '@/components/pages/pages-toolbar';
import {
  PageCard,
  type FacebookPageItem,
} from '@/components/pages/page-card';
import { AddPageModal } from '@/components/pages/add-page-modal';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

const activeAccount: FacebookAccountItem = {
  id: '11111111-1111-4111-8111-111111111111',
  fbAccountId: 'fb_user_1',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const expiredAccount: FacebookAccountItem = {
  id: '22222222-2222-4222-8222-222222222222',
  fbAccountId: 'fb_user_2',
  displayName: 'John Doe',
  profilePictureUrl: null,
  status: 'expired',
  connectedPagesCount: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

function makePage(overrides: Partial<FacebookPageItem>): FacebookPageItem {
  return {
    id: 'page-1',
    facebookAccountId: activeAccount.id,
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

function shellWrapper({
  pages,
  accounts,
  byocConfigured,
}: {
  pages: FacebookPageItem[];
  accounts: FacebookAccountItem[];
  byocConfigured: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const tenant = queryKeys.tenant('acme');
  queryClient.setQueryData(tenant.pages.list, { pages, total: pages.length });
  queryClient.setQueryData(tenant.accounts.list, {
    accounts,
    total: accounts.length,
  });
  queryClient.setQueryData(tenant.settings.byoc, {
    workspaceId: '33333333-3333-4333-8333-333333333333',
    subdomain: 'acme',
    fbAppId: byocConfigured ? '123456789' : '',
    fbAppSecret: '',
    hasSecret: byocConfigured,
    status: 'valid',
    lastTestedAt: null,
    connectedAt: null,
  });
  return (
    <QueryClientProvider client={queryClient}>
      <PagesShell subdomain="acme" />
    </QueryClientProvider>
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PagesScaleToolbar behaviour', () => {
  it('typing updates the search, Escape clears it, and status tabs report selection', () => {
    const onSearchChange = vi.fn();
    const onStatusFilterChange = vi.fn();
    render(
      <PagesScaleToolbar
        searchQuery="alp"
        onSearchChange={onSearchChange}
        statusFilter="all"
        onStatusFilterChange={onStatusFilterChange}
        accountFilter="all"
        onAccountFilterChange={vi.fn()}
        accountOptions={['Sarah Connor']}
        attentionCount={2}
      />
    );

    const input = screen.getByTestId('pages-search-input');
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(onSearchChange).toHaveBeenCalledWith('alpha');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSearchChange).toHaveBeenCalledWith('');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search query' }));
    expect(onSearchChange).toHaveBeenCalledWith('');

    expect(
      screen.getByTestId('pages-filter-all').getAttribute('aria-selected')
    ).toBe('true');
    expect(screen.getByText('(2)')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pages-filter-paused'));
    expect(onStatusFilterChange).toHaveBeenCalledWith('paused');
  });
});

describe('PageCard behaviour', () => {
  it('click and Enter/Space fire onSelectPage', () => {
    const onSelectPage = vi.fn();
    const page = makePage({});
    render(<PageCard page={page} subdomain="acme" onSelectPage={onSelectPage} />);

    const card = screen.getByTestId('page-card-page-1');
    fireEvent.click(card);
    expect(onSelectPage).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onSelectPage).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(card, { key: ' ' });
    expect(onSelectPage).toHaveBeenCalledTimes(3);
  });
});

describe('PagesShell behaviour', () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  const fivePages = [
    makePage({ id: 'p-1', pageName: 'Alpha Page', status: 'active', createdAt: '2026-10-01T10:00:00.000Z' }),
    makePage({ id: 'p-2', pageName: 'Beta Page', status: 'paused', fbPageId: 'fb_page_2', createdAt: '2026-10-02T10:00:00.000Z' }),
    makePage({ id: 'p-3', pageName: 'Gamma Page', status: 'invalid_token', fbPageId: 'fb_page_3', createdAt: '2026-10-03T10:00:00.000Z' }),
    makePage({ id: 'p-4', pageName: 'Delta Page', status: 'active', fbPageId: 'fb_page_4', createdAt: '2026-10-04T10:00:00.000Z' }),
    makePage({ id: 'p-5', pageName: 'Epsilon Page', status: 'active', fbPageId: 'fb_page_5', createdAt: '2026-10-05T10:00:00.000Z' }),
  ];

  it('renders no expired-connection banner on the Pages list, even when an account is expired (expired accounts belong in Accounts)', () => {
    render(
      shellWrapper({
        pages: fivePages,
        accounts: [activeAccount, expiredAccount],
        byocConfigured: false,
      })
    );

    expect(screen.queryByTestId('pages-expired-connection-banner')).toBeNull();
    expect(screen.queryByTestId('pages-reconnect-btn')).toBeNull();
  });

  it('filtering to zero shows the typed no-results state and Clear filters restores the grid (UI Rule 23)', () => {
    render(
      shellWrapper({
        pages: fivePages,
        accounts: [activeAccount],
        byocConfigured: true,
      })
    );

    expect(screen.getByTestId('pages-grid')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pages-search-input'), {
      target: { value: 'no-such-page' },
    });
    expect(screen.getByTestId('pages-filter-empty')).toBeTruthy();
    expect(screen.getByText(/Active filters:/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('pages-clear-filters-btn'));
    expect(screen.getByTestId('pages-grid')).toBeTruthy();
  });

  it('subtitle counts attention pages truthfully', () => {
    render(
      shellWrapper({
        pages: fivePages,
        accounts: [activeAccount],
        byocConfigured: true,
      })
    );
    const subtitle = screen.getByTestId('pages-page-subtitle');
    expect(subtitle.textContent).toContain('5 connected pages');
    expect(subtitle.textContent).toContain('1 requires reconnecting');
  });
});

describe('Add Page confirmation redesign (toast + gold highlight, no banner)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const existingView = {
    id: '77777777-7777-4777-8777-777777777777',
    facebookAccountId: activeAccount.id,
    accountDisplayName: 'Sarah Connor',
    fbPageId: 'fb_page_1',
    pageName: 'Alpha Page',
    profilePictureUrl: null,
    category: 'Tech',
    timezone: 'Asia/Karachi',
    startingFollowers: 100,
    currentFollowers: 120,
    followersGained: 20,
    followersCount: 120,
    status: 'active',
    tasks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    rateLimitedAt: null,
  };

  function mockImportFlow(newPages: Array<{ id: string; fbPageId: string; pageName: string }>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pages/discover')) {
        return jsonResponse({
          accountId: activeAccount.id,
          accountDisplayName: activeAccount.displayName,
          pages: newPages.map((p) => ({
            fbPageId: p.fbPageId,
            pageName: p.pageName,
            profilePictureUrl: null,
            category: 'Tech',
            currentFollowers: 100,
            followersCount: 100,
            tasks: [],
            isImported: false,
          })),
          total: newPages.length,
        });
      }
      if (url.endsWith('/pages/import')) {
        return jsonResponse({
          success: true,
          importedCount: newPages.length,
          pages: newPages,
        });
      }
      if (url.includes('/pages') && !url.includes('/accounts')) {
        return jsonResponse({
          pages: [
            existingView,
            ...newPages.map((p, i) => ({
              ...existingView,
              id: p.id,
              fbPageId: p.fbPageId,
              pageName: p.pageName,
              createdAt: '2026-10-06T10:00:00.000Z',
              updatedAt: '2026-10-06T10:00:00.000Z',
              followersGained: 0,
              currentFollowers: 100,
              followersCount: 100,
              startingFollowers: 100,
              category: 'Tech',
              status: 'active',
              tasks: [],
              accountDisplayName: 'Sarah Connor',
              profilePictureUrl: null,
              rateLimitedAt: null,
              timezone: 'Asia/Karachi',
            })),
          ],
          total: 1 + newPages.length,
        });
      }
      if (url.includes('/accounts')) {
        return jsonResponse({ accounts: [], total: 0 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  async function runImport(newPages: Array<{ id: string; fbPageId: string; pageName: string }>) {
    mockImportFlow(newPages);
    render(
      shellWrapper({
        pages: [
          makePage({
            id: existingView.id,
            pageName: 'Alpha Page',
            status: 'active',
            fbPageId: 'fb_page_1',
          }),
        ],
        accounts: [activeAccount],
        byocConfigured: true,
      })
    );
    fireEvent.click(screen.getByTestId('header-add-page-btn'));
    await screen.findByTestId('add-page-modal');
    fireEvent.click(screen.getByTestId(`select-account-${activeAccount.id}`));
    await screen.findByTestId('discovered-pages-list');
    for (const p of newPages) {
      fireEvent.click(screen.getByTestId(`discovered-page-checkbox-${p.fbPageId}`));
    }
    const confirm = screen.getByTestId('confirm-add-pages-btn');
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
  }

  it('one import: toast says "1 Facebook Page added", exactly the new card is gold, no banner, highlight clears', async () => {
    const newPage = {
      id: '66666666-6666-4666-8666-666666666666',
      fbPageId: 'fb_page_201',
      pageName: 'Skynet AI Daily',
    };
    await runImport([newPage]);

    const toastText = await screen.findByText('1 Facebook Page added');
    // Import success toast is visibly green: green-tinted background +
    // green border on the toast element itself (flow-scoped success slot).
    const toastEl = toastText.closest('[data-sonner-toast]');
    expect(toastEl).not.toBeNull();
    expect(toastEl!.className).toContain('border-brand-emerald');
    expect(toastEl!.className).toContain('bg-brand-emerald/15');
    expect(screen.queryByTestId('pages-feedback-banner')).toBeNull();
    expect(screen.getByTestId('pages-grid')).toBeTruthy();

    const newCard = await screen.findByTestId(`page-card-${newPage.id}`);
    expect(newCard.getAttribute('data-highlighted')).toBe('true');
    expect(
      screen.getByTestId(`page-card-${existingView.id}`).getAttribute('data-highlighted')
    ).toBeNull();

    // Highlight lasts while the toast shows (5s), then clears.
    await waitFor(
      () => expect(newCard.getAttribute('data-highlighted')).toBeNull(),
      { timeout: 8000 }
    );
  }, 15000);

  it('three imports: toast says "3 Facebook Pages added" and all three new cards are gold', async () => {
    const newPages = [
      { id: '66666666-6666-4666-8666-666666666666', fbPageId: 'fb_page_201', pageName: 'Page One' },
      { id: '55555555-5555-4555-8555-555555555555', fbPageId: 'fb_page_202', pageName: 'Page Two' },
      { id: '44444444-4444-4444-8444-444444444444', fbPageId: 'fb_page_203', pageName: 'Page Three' },
    ];
    await runImport(newPages);

    await screen.findByText('3 Facebook Pages added');
    expect(screen.queryByTestId('pages-feedback-banner')).toBeNull();
    for (const p of newPages) {
      expect(
        (await screen.findByTestId(`page-card-${p.id}`)).getAttribute('data-highlighted')
      ).toBe('true');
    }
    expect(
      screen.getByTestId(`page-card-${existingView.id}`).getAttribute('data-highlighted')
    ).toBeNull();
  });
});

describe('AddPageModal flow behaviour', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pick account → discover → select page → import calls onSuccess and closes', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pages/discover')) {
        return jsonResponse({
          accountId: activeAccount.id,
          accountDisplayName: activeAccount.displayName,
          pages: [
            {
              fbPageId: 'fb_page_201',
              pageName: 'Skynet AI Daily',
              profilePictureUrl: null,
              category: 'Automation',
              currentFollowers: 4300,
              followersCount: 4300,
              tasks: [],
              isImported: false,
            },
            {
              fbPageId: 'fb_page_101',
              pageName: 'Cyberdyne Reels',
              profilePictureUrl: null,
              category: 'Tech',
              currentFollowers: 11200,
              followersCount: 11200,
              tasks: [],
              isImported: true,
            },
          ],
          total: 2,
        });
      }
      if (url.endsWith('/pages/import')) {
        return jsonResponse({
          success: true,
          importedCount: 1,
          pages: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              fbPageId: 'fb_page_201',
              pageName: 'Skynet AI Daily',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={onOpenChange}
        accounts={[activeAccount]}
        onSuccess={onSuccess}
      />
    );

    fireEvent.click(screen.getByTestId(`select-account-${activeAccount.id}`));

    await screen.findByTestId('discovered-pages-list');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tenant/acme/accounts/${activeAccount.id}/pages/discover`,
      expect.anything()
    );
    expect(screen.getByTestId('already-added-fb_page_101')).toBeTruthy();

    fireEvent.click(screen.getByTestId('discovered-page-checkbox-fb_page_201'));
    const confirm = screen.getByTestId('confirm-add-pages-btn');
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({
        importedCount: 1,
        importedPageIds: ['44444444-4444-4444-8444-444444444444'],
      })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const importCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/pages/import')
    );
    expect(importCall).toBeTruthy();
    expect(importCall?.[1]?.method).toBe('POST');
    expect(importCall?.[1]?.body).toBe(
      JSON.stringify({
        accountId: activeAccount.id,
        selectedPageIds: ['fb_page_201'],
      })
    );
  });

  it('inline Reconnect on an expired account calls onReconnectAccount (Spec 102)', () => {
    const onReconnectAccount = vi.fn();
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[expiredAccount]}
        onReconnectAccount={onReconnectAccount}
      />
    );

    fireEvent.click(screen.getByTestId(`reconnect-account-${expiredAccount.id}`));
    expect(onReconnectAccount).toHaveBeenCalledTimes(1);
    expect(onReconnectAccount.mock.calls[0]?.[0]?.id).toBe(expiredAccount.id);
  });

  it('"Go to Facebook Accounts" closes the dialog and runs the navigation callback (Spec 109)', () => {
    const onNavigateToAccounts = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={onOpenChange}
        accounts={[]}
        onNavigateToAccounts={onNavigateToAccounts}
      />
    );

    const link = screen.getByTestId('go-to-accounts-btn');
    expect(link.getAttribute('href')).toBe('/tenant/acme/accounts');
    fireEvent.click(link);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigateToAccounts).toHaveBeenCalledTimes(1);
  });

  it('discovery failure surfaces the inline error state, never silently', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[activeAccount]}
      />
    );

    fireEvent.click(screen.getByTestId(`select-account-${activeAccount.id}`));
    const error = await screen.findByTestId('add-page-error');
    expect(error.textContent).toContain(
      "Couldn't load pages from this Facebook account."
    );
  });
});
