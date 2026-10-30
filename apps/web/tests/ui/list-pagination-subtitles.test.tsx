/**
 * @file list-pagination-subtitles.test.tsx
 * @description Shell-level regression pins for the PR #13 send-back:
 * paginated subtitles must report FULL-SET counts, never the visible
 * page slice. Each shell is seeded with a page-1 slice whose
 * attention/expired items sit beyond it, and the subtitle must still
 * report the full counts. These tests fail on the pre-fix shells
 * (page-slice counts) and pass on the fixed ones.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '@/lib/data/query-keys';
import { computeAccountsSubtitleFromCounts } from '@/components/accounts/accounts-helpers';
import { PagesShell } from '@/app/tenant/[subdomain]/pages/pages-shell';
import { AccountsShell } from '@/app/tenant/[subdomain]/accounts/accounts-shell';
import type { FacebookPageItem } from '@/components/pages/page-card';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

function makePage(i: number): FacebookPageItem {
  return {
    id: `page-${i}`,
    facebookAccountId: '11111111-1111-4111-8111-111111111111',
    accountDisplayName: 'Sarah Connor',
    fbPageId: `fb_page_${i}`,
    pageName: `Page ${i}`,
    profilePictureUrl: null,
    category: 'Tech',
    startingFollowers: 100,
    currentFollowers: 120,
    followersGained: 20,
    status: 'active',
    tasks: [],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
}

function makeAccount(i: number): FacebookAccountItem {
  return {
    id: `22222222-2222-4222-8222-${i.toString(16).padStart(12, '0')}`,
    fbAccountId: `fb_user_${i}`,
    displayName: `Account ${i}`,
    profilePictureUrl: null,
    status: 'active',
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function seedClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function seedByoc(queryClient: QueryClient) {
  const tenant = queryKeys.tenant('acme');
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
}

describe('paginated subtitles report full-set counts', () => {
  it('computeAccountsSubtitleFromCounts formats full-set counts exactly like the array helper', () => {
    expect(
      computeAccountsSubtitleFromCounts(65, {
        connected: 60,
        expired: 4,
        error: 1,
      })
    ).toBe('60 connected · 4 sessions expired · 1 connection error');
    expect(
      computeAccountsSubtitleFromCounts(0, {
        connected: 0,
        expired: 0,
        error: 0,
      })
    ).toBe(
      'Connect your first Facebook account to manage pages and publish reels.'
    );
  });

  it('Pages subtitle keeps the reconnecting fragment when attention pages sit beyond page 1', () => {
    const queryClient = seedClient();
    const tenant = queryKeys.tenant('acme');
    // Page-1 slice: 30 active pages, zero attention on the page —
    // yet 3 attention pages exist in the full filtered set of 65.
    queryClient.setQueryData(
      tenant.pages.listPage({
        page: 1,
        limit: 30,
        search: '',
        status: 'all',
        account: 'all',
      }),
      {
        pages: Array.from({ length: 30 }, (_, i) => makePage(i + 1)),
        total: 65,
        page: 1,
        limit: 30,
        totalPages: 3,
        attentionTotal: 3,
      }
    );
    // R16: the shell reads the complete accounts set (listAll).
    queryClient.setQueryData(tenant.accounts.listAll, {
      accounts: [makeAccount(1)],
      total: 1,
    });
    seedByoc(queryClient);

    render(
      <QueryClientProvider client={queryClient}>
        <PagesShell subdomain="acme" />
      </QueryClientProvider>
    );

    const subtitle = screen.getByTestId('pages-page-subtitle');
    expect(subtitle.textContent).toContain('65 connected pages');
    expect(subtitle.textContent).toContain('3 require reconnecting');
  });

  it('Accounts subtitle reports workspace totals, never the page slice', () => {
    const queryClient = seedClient();
    const tenant = queryKeys.tenant('acme');
    // Page-1 slice: 30 active accounts of a 65-account workspace
    // whose full-set health is 60 connected / 4 expired / 1 error.
    // The pre-fix subtitle read "30 connected" here.
    queryClient.setQueryData(
      tenant.accounts.listPage({ page: 1, limit: 30, search: '', status: 'all' }),
      {
        accounts: Array.from({ length: 30 }, (_, i) => makeAccount(i + 1)),
        total: 65,
        page: 1,
        limit: 30,
        totalPages: 3,
        healthCounts: { connected: 60, expired: 4, error: 1 },
      }
    );
    seedByoc(queryClient);

    render(
      <QueryClientProvider client={queryClient}>
        <AccountsShell subdomain="acme" />
      </QueryClientProvider>
    );

    const subtitle = screen.getByTestId('accounts-page-subtitle');
    expect(subtitle.textContent).toContain('60 connected');
    expect(subtitle.textContent).toContain('4 sessions expired');
    expect(subtitle.textContent).toContain('1 connection error');
    expect(subtitle.textContent).not.toContain('30 connected');
  });
});
