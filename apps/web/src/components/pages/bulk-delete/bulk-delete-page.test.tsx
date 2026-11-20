/**
 * Bulk Delete Posts shell (spec 213): discovery, preview pre-select,
 * and the client-driven delete run — against the mocked API client.
 * Fake timers drive the 60-second pause between batches; the clock
 * advances only when the test says so, so the pause is proven rather
 * than waited out. Async UI is awaited by advancing the clock, never
 * by real time.
 */
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BulkDeletePage } from './bulk-delete-page';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const EXPIRED_ID = '22222222-2222-4222-8222-222222222222';

const accountsResponse = {
  accounts: [
    {
      id: ACCOUNT_ID,
      fbAccountId: 'fb-acc-1',
      displayName: 'Shahzeb Malik',
      profilePictureUrl: null,
      gender: null,
      accountLink: null,
      status: 'active',
      tokenExpiresAt: null,
      connectedPagesCount: 1,
      connectedPages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: EXPIRED_ID,
      fbAccountId: 'fb-acc-2',
      displayName: 'Old Account',
      profilePictureUrl: null,
      gender: null,
      accountLink: null,
      status: 'expired',
      tokenExpiresAt: '2025-01-01T00:00:00.000Z',
      connectedPagesCount: 0,
      connectedPages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 2,
};

const discoverResponse = {
  accountId: ACCOUNT_ID,
  accountDisplayName: 'Shahzeb Malik',
  pages: [
    {
      fbPageId: '111',
      pageName: 'Morning Recipes',
      profilePictureUrl: null,
      category: null,
      currentFollowers: 100,
      followersCount: 100,
      tasks: [],
      isImported: false,
    },
  ],
  total: 1,
};

function candidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `111_${i + 1}`,
    type: 'posts' as const,
    title: `Post ${i + 1}`,
    createdTime: '2026-01-01T00:00:00+0000',
    permalinkUrl: null,
    previewImageUrl: null,
  }));
}

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const apiGet = apiMocks.get;
const apiPost = apiMocks.post;

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  isApiError: () => false,
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/image', () => ({
  default: () => null,
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BulkDeletePage subdomain="acme" />
    </QueryClientProvider>,
  );
}

/** Flush pending queries/mutations by advancing the fake clock. */
async function tick(ms = 100) {
  // Fake timers: waitFor would deadlock, and state updates from the
  // async delete run happen outside fireEvent's act() scope — the clock
  // advance itself must be act-wrapped or React never flushes them.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function discoverOnePage() {
  fireEvent.click(screen.getByText('Shahzeb Malik'));
  fireEvent.click(screen.getByRole('button', { name: /Find pages/ }));
  await tick();
  fireEvent.click(screen.getByText('Morning Recipes'));
  expect(screen.getByText('Smart Filter')).toBeInTheDocument();
}

beforeEach(() => {
  vi.useFakeTimers();
  apiGet.mockImplementation(async (path: string) => {
    if (path.includes('/pages/discover')) return discoverResponse;
    if (path.includes('/bulk-delete/content')) {
      return { items: candidates(25), paging: { after: null } };
    }
    return accountsResponse;
  });
  apiPost.mockImplementation(async (path: string, body: unknown) => {
    if (path.includes('/bulk-delete/preview')) {
      return { total: 25, candidates: candidates(25) };
    }
    if (path.includes('/bulk-delete/batch-delete')) {
      const ids = (body as { contentIds: string[] }).contentIds;
      const results = ids.map((id) => {
        if (id === '111_25') return { id, success: false, error: 'Failed to delete' };
        if (id === '111_24') return { id, success: true, alreadyDeleted: true };
        return { id, success: true };
      });
      return {
        total: ids.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('BulkDeletePage', () => {
  it('discovers pages, previews with everything pre-selected, and shows no dialog', async () => {
    renderPage();
    await tick();
    expect(screen.getByText('Shahzeb Malik')).toBeInTheDocument();
    // Expired accounts render but are not selectable (no checkbox).
    expect(screen.getByText('Old Account')).toBeInTheDocument();
    expect(screen.getByText('Session expired')).toBeInTheDocument();

    await discoverOnePage();

    fireEvent.click(screen.getByRole('button', { name: 'Preview Targets' }));
    await tick();
    expect(screen.getByText('Items Found')).toBeInTheDocument();
    expect(screen.getByText('25 items selected')).toBeInTheDocument();
    // No confirmation dialog anywhere before deleting.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument();
  });

  it('deletes in batches of 20 with a 60s pause, and already-deleted counts as success', async () => {
    renderPage();
    await tick();
    await discoverOnePage();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Targets' }));
    await tick();
    expect(screen.getByText('Items Found')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Delete Selected/ }));
    expect(screen.getByText('Executing Deletion')).toBeInTheDocument();

    // First batch (20) runs, then the pause countdown shows.
    await tick();
    expect(screen.getByText(/Waiting 60s/)).toBeInTheDocument();
    const batchCalls = () =>
      apiPost.mock.calls.filter(([path]) => String(path).includes('/bulk-delete/batch-delete'));
    expect(batchCalls()).toHaveLength(1);
    expect((batchCalls()[0]?.[1] as { contentIds: string[] }).contentIds).toHaveLength(20);

    // Advancing the clock through the pause runs the last batch of 5.
    await tick(60_000);
    await tick();
    expect(screen.getByText('Deletion complete')).toBeInTheDocument();
    expect(batchCalls()).toHaveLength(2);
    expect((batchCalls()[1]?.[1] as { contentIds: string[] }).contentIds).toHaveLength(5);

    // 24 succeeded (one of them already-deleted), 1 failed.
    expect(screen.getByText('24 deleted, 1 failed.')).toBeInTheDocument();
    expect(screen.getByText('Failed to delete')).toBeInTheDocument();
    expect(screen.getByText('111_25')).toBeInTheDocument();
    // The already-deleted id is NOT listed as a failure.
    expect(screen.queryByText('111_24')).not.toBeInTheDocument();

    // Closing the overlay leaves only the failed id selected, for retry.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('1 items selected')).toBeInTheDocument();
  });

  it('manual curation loads live content and selection is shared', async () => {
    renderPage();
    await tick();
    await discoverOnePage();
    // Radix Tabs activate on focus (automatic mode); a bare fireEvent.click
    // never focuses the trigger, so the tab stays unselected. Focus first,
    // as a real mouse click would, then click.
    const manualTab = screen.getByRole('tab', { name: 'Manual Curation' });
    fireEvent.focus(manualTab);
    fireEvent.click(manualTab);
    await tick();
    expect(screen.getByText('Post 1')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Post 1'));
    expect(screen.getByText('1 items selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText('25 items selected')).toBeInTheDocument();
  });

  it('hides the floating bar when nothing is selected', async () => {
    renderPage();
    await tick();
    await discoverOnePage();
    fireEvent.click(screen.getByRole('button', { name: 'Preview Targets' }));
    await tick();
    expect(screen.getByText('25 items selected')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByText(/items selected/)).not.toBeInTheDocument();
  });
});
