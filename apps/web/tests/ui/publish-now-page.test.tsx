import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PublishNowPage } from '@/components/pages/publish-now/publish-now-page';

/**
 * Publish Now page (PR #33) — wizard counts, selection controls,
 * no Page ID in cards, and the collapsed composer header. The API
 * is mocked; no Facebook or database call happens here.
 */

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    return <img alt={String(props.alt ?? '')} />;
  },
}));

vi.mock('@/components/pages/dedicated/create-posts/media-library-picker', () => ({
  MediaLibraryPicker: () => null,
}));

const ACCOUNTS = [
  {
    id: '11111111-1111-4111-a111-111111111111',
    fbAccountId: 'fb-acc-1',
    displayName: 'Shahzeb Malik',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-a222-222222222222',
    fbAccountId: 'fb-acc-2',
    displayName: 'Ayesha Khan',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-a333-333333333333',
    fbAccountId: 'fb-acc-3',
    displayName: 'Expired User',
    profilePictureUrl: null,
    status: 'expired',
    tokenExpiresAt: null,
    connectedPagesCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

const DISCOVERED = [
  {
    fbPageId: 'page-111',
    pageName: 'Maddie Lippy',
    profilePictureUrl: null,
    category: 'Public figure',
    currentFollowers: 1200,
    followersCount: 1200,
    tasks: ['CREATE_CONTENT'],
    isImported: false,
  },
  {
    fbPageId: 'page-222',
    pageName: 'Sunnie James',
    profilePictureUrl: null,
    category: 'Public figure',
    currentFollowers: 800,
    followersCount: 800,
    tasks: ['CREATE_CONTENT'],
    isImported: false,
  },
];

import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    get: async (path: string) => {
      if (path.includes('/pages/discover')) {
        return { accountId: '11111111-1111-4111-a111-111111111111', accountDisplayName: 'Shahzeb Malik', pages: DISCOVERED, total: 2 };
      }
      if (path.endsWith('/pages')) {
        return { pages: [], total: 0 };
      }
      if (path.includes('/settings/byoc')) {
        return { fbAppId: null, hasSecret: false };
      }
      if (path.includes('/accounts')) {
        return { accounts: ACCOUNTS, total: 3 };
      }
      throw new Error(`unexpected api.get path: ${path}`);
    },
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${subdomain}${path}`,
  isApiError: () => false,
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PublishNowPage subdomain="acme" />
    </QueryClientProvider>
  );
}

describe('PublishNowPage wizard', () => {
  it('shows the account count, selected count, and Select All / Deselect All', async () => {
    renderPage();
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByText(/0 of 2 accounts selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText(/2 of 2 accounts selected/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Deselect All' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deselect All' }));
    expect(screen.getByText(/0 of 2 accounts selected/)).toBeTruthy();
  });

  it('shows the page count without Page IDs, then collapses the composer header', async () => {
    renderPage();
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    // Select the first account only, then continue to the pages step.
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(1 account\)/ })
    );
    await waitFor(
      () => expect(screen.getByText(/2 pages found/)).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByText(/0 of 2 pages selected/)).toBeTruthy();
    // Cards show names and categories only — never a Page ID.
    expect(screen.queryByText(/Page ID/)).toBeNull();
    fireEvent.click(screen.getByText('Maddie Lippy'));
    fireEvent.click(screen.getByText('Sunnie James'));
    expect(screen.getByText(/2 of 2 pages selected/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(2 pages\)/ })
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Maddie Lippy + 1 more' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    // The header names only the first page; the rest are collapsed.
    expect(screen.queryByText('Sunnie James')).toBeNull();
    expect(screen.getByText(/via Shahzeb Malik/)).toBeTruthy();
  });

  it('publishes, shows per-page results, and retries only the failed page', async () => {
    const publishCalls: Array<{ path: string; body: unknown }> = [];
    const firstRun = [
      {
        accountId: '11111111-1111-4111-a111-111111111111',
        fbPageId: 'page-111',
        pageName: 'Maddie Lippy',
        status: 'published',
        postId: 'post-111',
        reason: null,
        graphCode: null,
        graphSubcode: null,
        step: null,
        httpStatus: null,
        fbtraceId: null,
        firstCommentFailed: true,
        firstCommentReason: 'Comment failed',
      },
      {
        accountId: '11111111-1111-4111-a111-111111111111',
        fbPageId: 'page-222',
        pageName: 'Sunnie James',
        status: 'failed',
        postId: null,
        reason: 'Facebook is busy',
        graphCode: 1,
        graphSubcode: null,
        step: 'feed',
        httpStatus: 400,
        fbtraceId: null,
        firstCommentFailed: null,
        firstCommentReason: null,
      },
    ];
    const retryRun = [
      {
        ...firstRun[1],
        status: 'published',
        postId: 'post-222',
        reason: null,
        graphCode: null,
        step: null,
        httpStatus: null,
      },
    ];
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (path: string, body: unknown) => {
        publishCalls.push({ path, body });
        return {
          results: publishCalls.length === 1 ? firstRun : retryRun,
        };
      });

    renderPage();
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(1 account\)/ })
    );
    await waitFor(
      () => expect(screen.getByText(/2 pages found/)).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByText('Maddie Lippy'));
    fireEvent.click(screen.getByText('Sunnie James'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(2 pages\)/ })
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Maddie Lippy + 1 more' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );

    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'Hello' },
    });
    fireEvent.change(screen.getByPlaceholderText('Write a comment...'), {
      target: { value: 'Nice!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));

    await waitFor(
      () => expect(screen.getByText('Published')).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByText('Facebook is busy')).toBeTruthy();
    expect(
      screen.getByText(/First comment could not be posted/)
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Retry failed only' })
    ).toBeTruthy();

    // Retry sends only the failed page, never the published one.
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed only' }));
    await waitFor(
      () => expect(publishCalls.length).toBe(2),
      { timeout: 5000 }
    );
    const retryBody = publishCalls[1].body as {
      targets: Array<{ fbPageId: string }>;
    };
    expect(retryBody.targets).toHaveLength(1);
    expect(retryBody.targets[0].fbPageId).toBe('page-222');
    await waitFor(
      () => expect(screen.queryByText('Facebook is busy')).toBeNull(),
      { timeout: 5000 }
    );
    expect(screen.queryByRole('button', { name: 'Retry failed only' })).toBeNull();

    // Start over returns to the wizard with a clean slate.
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
  });
});
