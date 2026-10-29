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
import { sortPagesAttentionFirst } from '@/components/pages/pages-helpers';
import { sortAccountsExpiredFirst } from '@/components/accounts/accounts-helpers';
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

// The fake list server below answers refetches (filter changes hit a
// new query key, so the shell fetches instead of filtering seeded
// cache). shellWrapper records the dataset the fake serves.
let fakeServerPages: FacebookPageItem[] = [];
let fakeServerAccounts: FacebookAccountItem[] = [];

function shellWrapper({
  pages,
  accounts,
  byocConfigured,
}: {
  pages: FacebookPageItem[];
  accounts: FacebookAccountItem[];
  byocConfigured: boolean;
}) {
  fakeServerPages = pages;
  fakeServerAccounts = accounts;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const tenant = queryKeys.tenant('acme');
  // The shell queries the paginated keys (page 1, default filters);
  // seeding the bare list keys no longer reaches it.
  queryClient.setQueryData(
    tenant.pages.listPage({
      page: 1,
      limit: 30,
      search: '',
      status: 'all',
      account: 'all',
    }),
    {
      pages,
      total: pages.length,
      page: 1,
      limit: 30,
      totalPages: pages.length === 0 ? 0 : 1,
    }
  );
  // The pages shell reads accounts at limit 50 (filter options +
  // expired banner), not the paginated 30.
  queryClient.setQueryData(
    tenant.accounts.listPage({ page: 1, limit: 50, search: '', status: 'all' }),
    {
      accounts,
      total: accounts.length,
      page: 1,
      limit: 50,
      totalPages: accounts.length === 0 ? 0 : 1,
    }
  );
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
  const originalFetch = global.fetch;
  beforeEach(() => {
    mockPush.mockReset();
    // Fake paginated list server: mirrors the real routes' contract
    // (filter before paginate, attention/expired-first order, meta).
    global.fetch = (async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      const page = Math.max(
        1,
        Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1
      );
      const limit = Math.max(
        1,
        Number.parseInt(url.searchParams.get('limit') ?? '30', 10) || 30
      );
      if (url.pathname.endsWith('/pages')) {
        const search = (url.searchParams.get('search') ?? '')
          .trim()
          .toLowerCase();
        const status = url.searchParams.get('status') ?? 'all';
        const account = url.searchParams.get('account') ?? 'all';
        const filtered = sortPagesAttentionFirst(
          fakeServerPages.filter((p) => {
            const matchesSearch =
              search.length === 0 ||
              p.pageName.toLowerCase().includes(search) ||
              (p.category ?? '').toLowerCase().includes(search);
            let matchesStatus = true;
            if (status === 'active') matchesStatus = p.status === 'active';
            else if (status === 'needs_attention')
              matchesStatus =
                p.status === 'invalid_token' ||
                p.status === 'page_checkpoint' ||
                p.status === 'fb_rate_limited';
            else if (status === 'paused')
              matchesStatus = p.status === 'paused';
            const matchesAccount =
              account === 'all' ||
              p.facebookAccountId === account ||
              p.accountDisplayName === account;
            return matchesSearch && matchesStatus && matchesAccount;
          })
        );
        const totalPages =
          filtered.length === 0 ? 0 : Math.ceil(filtered.length / limit);
        const clamped = totalPages === 0 ? 1 : Math.min(page, totalPages);
        return jsonResponse({
          pages: filtered.slice((clamped - 1) * limit, clamped * limit),
          total: filtered.length,
          page: clamped,
          limit,
          totalPages,
        });
      }
      if (url.pathname.endsWith('/accounts')) {
        const search = (url.searchParams.get('search') ?? '')
          .trim()
          .toLowerCase();
        const status = url.searchParams.get('status') ?? 'all';
        const filtered = sortAccountsExpiredFirst(
          fakeServerAccounts.filter((a) => {
            const matchesSearch =
              search.length === 0 ||
              a.displayName.toLowerCase().includes(search);
            let matchesStatus = true;
            if (status === 'active') matchesStatus = a.status === 'active';
            else if (status === 'expired')
              matchesStatus = a.status === 'expired';
            return matchesSearch && matchesStatus;
          })
        );
        const totalPages =
          filtered.length === 0 ? 0 : Math.ceil(filtered.length / limit);
        const clamped = totalPages === 0 ? 1 : Math.min(page, totalPages);
        return jsonResponse({
          accounts: filtered.slice((clamped - 1) * limit, clamped * limit),
          total: filtered.length,
          page: clamped,
          limit,
          totalPages,
        });
      }
      return jsonResponse({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
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

  it('filtering to zero shows the typed no-results state and Clear filters restores the grid (UI Rule 23)', async () => {
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
    // Filtering is server-side now: the new page key refetches from
    // the fake server, so the empty state arrives asynchronously.
    await waitFor(() =>
      expect(screen.getByTestId('pages-filter-empty')).toBeTruthy()
    );
    expect(screen.getByText(/Active filters:/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('pages-clear-filters-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('pages-grid')).toBeTruthy()
    );
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
    // Steps 3–4: pick a timezone, then accept the default posting time.
    const toTimezone = screen.getByTestId('continue-to-timezone-btn');
    await waitFor(() => expect((toTimezone as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toTimezone);
    // Steps 3–4 are lazy-loaded, so the timezone list arrives a tick later.
    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    const toPostingTimes = screen.getByTestId('continue-to-posting-times-btn');
    await waitFor(() =>
      expect((toPostingTimes as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(toPostingTimes);
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

  it('pick account → discover → select page → timezone → posting times → import calls onSuccess and closes', async () => {
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
    const toTimezone = screen.getByTestId('continue-to-timezone-btn');
    await waitFor(() =>
      expect((toTimezone as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(toTimezone);

    // Step 3 starts blank: Continue is disabled until a timezone is picked.
    // Steps 3–4 are lazy-loaded, so wait for the timezone list first.
    const toPostingTimes = await screen.findByTestId(
      'continue-to-posting-times-btn'
    );
    expect((toPostingTimes as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    await waitFor(() =>
      expect((toPostingTimes as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(toPostingTimes);

    // Step 4 starts with one time, all post types selected.
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
        timezone: 'Asia/Karachi',
        postingTimes: [
          {
            slotTime: '09:00',
            allowedFormats: ['reel', 'image', 'video', 'story', 'text'],
          },
        ],
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
