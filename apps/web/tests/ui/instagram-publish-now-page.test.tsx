import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { InstagramPublishNowPage } from '@/components/instagram/publish-now/instagram-publish-now-page';

/**
 * Instagram Publish Now page — selector counts and selection
 * controls, per-account results, Retry failed only sending only
 * the failed account, and the second-Publish exclusion (already
 * published accounts are never sent again in the same run). The
 * API is mocked; no Instagram or database call happens here.
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
  MediaLibraryPicker: (props: {
    open: boolean;
    onSingleAttach: (media: unknown) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() =>
          props.onSingleAttach({
            id: '33333333-3333-4333-a333-333333333333',
            name: 'photo.jpg',
            mediaType: 'image',
            aspectRatio: '4:5',
            thumbnailUrl: null,
            url: 'https://media.example.com/photo.jpg',
            width: 1080,
            height: 1350,
            captionText: 'A photo caption',
          })
        }
      >
        Attach test photo
      </button>
    ) : null,
}));

const ACCOUNTS = [
  {
    id: '11111111-1111-4111-a111-111111111111',
    externalAccountId: 'ig-user-1',
    displayName: 'Creator One',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-a222-222222222222',
    externalAccountId: 'ig-user-2',
    displayName: 'Creator Two',
    profilePictureUrl: null,
    status: 'active',
    tokenExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-a444-444444444444',
    externalAccountId: 'ig-user-3',
    displayName: 'Expired Creator',
    profilePictureUrl: null,
    status: 'expired',
    tokenExpiresAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    get: async (path: string) => {
      if (path.includes('/instagram/accounts')) {
        return { accounts: ACCOUNTS, total: ACCOUNTS.length };
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
      <InstagramPublishNowPage subdomain="acme" />
    </QueryClientProvider>
  );
}

async function selectAccountsAndContinue() {
  renderPage();
  await waitFor(
    () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
    { timeout: 5000 }
  );
  fireEvent.click(screen.getByText('Creator One'));
  fireEvent.click(
    screen.getByRole('button', { name: /Continue \(1 account\)/ })
  );
  await waitFor(
    () =>
      expect(
        screen.getByRole('heading', { name: 'Creator One' })
      ).toBeTruthy(),
    { timeout: 5000 }
  );
}

describe('InstagramPublishNowPage', () => {
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
    // Expired accounts are shown but never selectable: no checkbox
    // label for them, and the Reconnect link is present instead.
    expect(screen.getByText('Expired Creator')).toBeTruthy();
    expect(screen.getByText('Session expired')).toBeTruthy();
  });

  it('publishes, shows per-account results, and retries only the failed account', { timeout: 15000 }, async () => {
    const publishCalls: Array<{ path: string; body: unknown }> = [];
    const firstRun = [
      {
        accountId: '11111111-1111-4111-a111-111111111111',
        accountName: 'Creator One',
        status: 'published',
        postId: 'media-1',
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
        accountId: '22222222-2222-4222-a222-222222222222',
        accountName: 'Creator Two',
        status: 'failed',
        postId: null,
        reason: 'Instagram is busy',
        graphCode: null,
        graphSubcode: null,
        step: 'media-publish',
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
        postId: 'media-2',
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
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(2 accounts\)/ })
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Creator One + 1 more' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    fireEvent.change(screen.getByPlaceholderText('Write a caption...'), {
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
    expect(screen.getByText('Instagram is busy')).toBeTruthy();
    expect(
      screen.getByText(/First comment could not be posted/)
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Retry failed only' })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed only' }));
    await waitFor(
      () => expect(publishCalls.length).toBe(2),
      { timeout: 5000 }
    );
    const retryBody = publishCalls[1].body as {
      targets: Array<{ accountId: string }>;
    };
    expect(retryBody.targets).toHaveLength(1);
    expect(retryBody.targets[0].accountId).toBe(
      '22222222-2222-4222-a222-222222222222'
    );
    await waitFor(
      () => expect(screen.queryByText('Instagram is busy')).toBeNull(),
      { timeout: 5000 }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
  });

  it('does not re-publish an already published account on a second Publish, but publishes a newly added account', { timeout: 15000 }, async () => {
    const publishCalls: Array<{ path: string; body: unknown }> = [];
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (path: string, body: unknown) => {
        publishCalls.push({ path, body });
        const targets = (body as { targets: Array<{ accountId: string; accountName: string }> }).targets;
        return {
          results: targets.map((target) => ({
            accountId: target.accountId,
            accountName: target.accountName,
            status: 'published',
            postId: `media-${target.accountId.slice(0, 4)}`,
            reason: null,
            graphCode: null,
            graphSubcode: null,
            step: null,
            httpStatus: null,
            fbtraceId: null,
            firstCommentFailed: null,
            firstCommentReason: null,
          })),
        };
      });

    await selectAccountsAndContinue();
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(screen.getByText('Published')).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(publishCalls).toHaveLength(1);
    // A second Publish click with nothing new selected is disabled:
    // the already-published account is never sent again.
    expect(
      screen.getByTestId('instagram-publish-now-already-published-note')
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Publish Now' })
    ).toHaveProperty('disabled', true);

    // Add a new account: only the new account is sent on the next Publish.
    fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByText('Creator Two'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(2 accounts\)/ })
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Creator One + 1 more' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(publishCalls.length).toBe(2),
      { timeout: 5000 }
    );
    const secondBody = publishCalls[1].body as {
      targets: Array<{ accountId: string }>;
    };
    expect(secondBody.targets).toHaveLength(1);
    expect(secondBody.targets[0].accountId).toBe(
      '22222222-2222-4222-a222-222222222222'
    );
  });
});
