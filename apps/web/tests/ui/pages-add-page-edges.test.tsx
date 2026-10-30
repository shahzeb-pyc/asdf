/**
 * Add Page / Pages list edges (Area 3: R14, R16–R18, K9).
 *
 * - R17: the modal shows a loading state, never the dead-end
 *   "No active Facebook accounts connected" notice, while the
 *   parent's accounts read is still pending.
 * - K9 error-health: wire-disconnected accounts render with a
 *   reconnect recovery instead of vanishing.
 * - K9 discover: a failed discover renders an error + Retry (never
 *   the "no discovered pages" empty state), a truncated discover
 *   warns, and dropped nodes are counted.
 * - R16: two accounts sharing a display name stay two filter
 *   options (id values, one label each).
 * - K9 secondary failures: a failed accounts/BYOC read surfaces
 *   a notice + Retry above the grid instead of a silent stale list.
 * - K9 imported-card visibility: after an import, the shell lands
 *   the list on the imported account instead of leaving the user
 *   on the filter they came from.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/lib/data/query-keys';
import { AddPageModal } from '@/components/pages/add-page-modal';
import { PagesScaleToolbar } from '@/components/pages/pages-toolbar';
import { PagesShell } from '@/app/tenant/[subdomain]/pages/pages-shell';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import type { FacebookPageItem } from '@/components/pages/page-card';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => currentSearchParams,
}));

const sarahAccount: FacebookAccountItem = {
  id: '11111111-1111-4111-8111-111111111111',
  fbAccountId: 'fb_user_sarah',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const johnAccount: FacebookAccountItem = {
  id: '22222222-2222-4222-8222-222222222222',
  fbAccountId: 'fb_user_john',
  displayName: 'John Doe',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

const errorAccount: FacebookAccountItem = {
  id: '33333333-3333-4333-8333-333333333333',
  fbAccountId: 'fb_user_err',
  displayName: 'Broken Account',
  profilePictureUrl: null,
  status: 'disconnected',
  connectedPagesCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePage(overrides: Partial<FacebookPageItem>): FacebookPageItem {
  return {
    id: 'page-1',
    facebookAccountId: sarahAccount.id,
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

describe('Add Page edges', () => {
  const fetchMock = vi.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPush.mockReset();
    mockReplace.mockReset();
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('R17: shows loading, not the dead-end notice, while accounts are pending', () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[]}
        accountsPending={true}
      />
    );
    expect(screen.getByTestId('loading-accounts-state')).toBeTruthy();
    expect(screen.queryByTestId('no-active-accounts-notice')).toBeNull();
  });

  it('R17: shows the dead-end notice only once loading has finished with no accounts', () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[]}
        accountsPending={false}
      />
    );
    expect(screen.queryByTestId('loading-accounts-state')).toBeNull();
    expect(screen.getByTestId('no-active-accounts-notice')).toBeTruthy();
  });

  it('K9: error-health accounts render with a reconnect recovery instead of vanishing', () => {
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[errorAccount]}
      />
    );
    expect(screen.getByTestId('error-accounts-list')).toBeTruthy();
    expect(
      screen.getByTestId(`reconnect-account-${errorAccount.id}`)
    ).toBeTruthy();
    expect(screen.queryByTestId('no-active-accounts-notice')).toBeNull();
  });

  it('K9: a failed discover shows an error + Retry, never the empty state, and Retry recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          accountId: sarahAccount.id,
          accountDisplayName: sarahAccount.displayName,
          pages: [
            {
              fbPageId: 'fb_page_201',
              pageName: 'Recovered Page',
              profilePictureUrl: null,
              category: 'Tech',
              currentFollowers: 10,
              followersCount: 10,
              tasks: [],
              isImported: false,
            },
          ],
          total: 1,
          truncated: false,
          partial: false,
          droppedCount: 0,
        })
      );
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[sarahAccount]}
      />
    );
    fireEvent.click(screen.getByTestId(`select-account-${sarahAccount.id}`));
    const error = await screen.findByTestId('discover-error-state');
    expect(error.textContent).toContain(
      "Couldn't load pages from this Facebook account."
    );
    expect(screen.queryByTestId('no-discovered-pages-state')).toBeNull();
    fireEvent.click(screen.getByTestId('discover-retry-btn'));
    await screen.findByTestId('discovered-pages-list');
    expect(screen.queryByTestId('discover-error-state')).toBeNull();
  });

  it('R14/K9: a truncated discover warns instead of presenting a partial list as complete', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        accountId: sarahAccount.id,
        accountDisplayName: sarahAccount.displayName,
        pages: [
          {
            fbPageId: 'fb_page_201',
            pageName: 'First Page',
            profilePictureUrl: null,
            category: 'Tech',
            currentFollowers: 10,
            followersCount: 10,
            tasks: [],
            isImported: false,
          },
        ],
        total: 1,
        truncated: true,
        partial: false,
        droppedCount: 2,
      })
    );
    render(
      <AddPageModal
        subdomain="acme"
        open={true}
        onOpenChange={vi.fn()}
        accounts={[sarahAccount]}
      />
    );
    fireEvent.click(screen.getByTestId(`select-account-${sarahAccount.id}`));
    await screen.findByTestId('discovered-pages-list');
    expect(screen.getByTestId('discover-truncated-warning')).toBeTruthy();
    expect(screen.getByTestId('discover-dropped-note').textContent).toContain(
      '2 items'
    );
  });

  it('R16: two accounts sharing a display name stay two filter options', async () => {
    const user = userEvent.setup();
    render(
      <PagesScaleToolbar
        searchQuery=""
        onSearchChange={vi.fn()}
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
        accountFilter="all"
        onAccountFilterChange={vi.fn()}
        accountOptions={[
          { value: 'acc-1', label: 'Sam' },
          { value: 'acc-2', label: 'Sam' },
        ]}
      />
    );
    await user.click(screen.getByTestId('pages-account-filter'));
    const options = await screen.findAllByRole('option', { name: 'Sam' });
    expect(options).toHaveLength(2);
  });
});

describe('Pages shell secondary failures + import visibility', () => {
  const fetchMock = vi.fn();
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockPush.mockReset();
    mockReplace.mockReset();
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function seedShellClient(pagesByAccount: Record<string, FacebookPageItem[]>) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const tenant = queryKeys.tenant('acme');
    for (const [account, pages] of Object.entries(pagesByAccount)) {
      queryClient.setQueryData(
        tenant.pages.listPage({
          page: 1,
          limit: 30,
          search: '',
          status: 'all',
          account,
        }),
        {
          pages,
          total: pages.length,
          page: 1,
          limit: 30,
          totalPages: 1,
          attentionTotal: 0,
        }
      );
    }
    queryClient.setQueryData(tenant.accounts.listAll, {
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
    return queryClient;
  }

  it('K9: failed accounts/BYOC reads surface a notice + Retry above the grid', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PagesShell subdomain="acme" />
      </QueryClientProvider>
    );
    const notice = await screen.findByTestId('pages-secondary-error');
    expect(notice.textContent).toContain(
      "couldn't be refreshed, so account filters may be incomplete"
    );
    expect(screen.getByTestId('pages-secondary-retry-btn')).toBeTruthy();
  });

  it('K9: after an import the shell lands on the imported account, not the filter it came from', async () => {
    const sarahPage = makePage({ id: 'page-sarah', pageName: 'Sarah Page' });
    const johnPage = makePage({
      id: 'page-john',
      pageName: 'John Page',
      facebookAccountId: johnAccount.id,
      accountDisplayName: 'John Doe',
      fbPageId: 'fb_page_john',
    });
    const queryClient = seedShellClient({
      all: [sarahPage, johnPage],
      [johnAccount.id]: [johnPage],
      [sarahAccount.id]: [sarahPage],
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/pages/discover')) {
        return jsonResponse({
          accountId: sarahAccount.id,
          accountDisplayName: sarahAccount.displayName,
          pages: [
            {
              fbPageId: 'fb_page_201',
              pageName: 'New Sarah Page',
              profilePictureUrl: null,
              category: 'Tech',
              currentFollowers: 5,
              followersCount: 5,
              tasks: [],
              isImported: false,
            },
          ],
          total: 1,
          truncated: false,
          partial: false,
          droppedCount: 0,
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
              pageName: 'New Sarah Page',
            },
          ],
        });
      }
      return jsonResponse({
        pages: [sarahPage],
        total: 1,
        page: 1,
        limit: 30,
        totalPages: 1,
        attentionTotal: 0,
      });
    });
    currentSearchParams = new URLSearchParams(`account=${johnAccount.id}`);
    render(
      <QueryClientProvider client={queryClient}>
        <PagesShell subdomain="acme" />
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('page-card-page-john')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('header-add-page-btn'));
    await screen.findByTestId('add-page-modal');
    fireEvent.click(screen.getByTestId(`select-account-${sarahAccount.id}`));
    await screen.findByTestId('discovered-pages-list');
    fireEvent.click(
      screen.getByTestId('discovered-page-checkbox-fb_page_201')
    );
    const toTimezone = screen.getByTestId('continue-to-timezone-btn');
    await waitFor(() =>
      expect((toTimezone as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(toTimezone);
    fireEvent.click(
      await screen.findByTestId('add-page-timezone-option-Asia/Karachi')
    );
    const toPostingTimes = screen.getByTestId('continue-to-posting-times-btn');
    await waitFor(() =>
      expect((toPostingTimes as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(toPostingTimes);
    const confirm = screen.getByTestId('confirm-add-pages-btn');
    await waitFor(() =>
      expect((confirm as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        `/tenant/acme/pages?account=${sarahAccount.id}`
      );
    });
  });
});
