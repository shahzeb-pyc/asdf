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
  MediaLibraryPicker: (props: {
    open: boolean;
    onSingleAttach: (media: unknown) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() =>
          props.onSingleAttach({
            id: '22222222-2222-4222-a222-222222222222',
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

let mockAccountsData: typeof ACCOUNTS = ACCOUNTS;
let mockDiscoverShouldFail = false;
let mockAccountsShouldFail = false;

vi.mock('@/lib/api', () => ({
  api: {
    get: async (path: string) => {
      if (path.includes('/pages/discover')) {
        if (mockDiscoverShouldFail) {
          throw new Error('discover failed');
        }
        return { accountId: '11111111-1111-4111-a111-111111111111', accountDisplayName: 'Shahzeb Malik', pages: DISCOVERED, total: 2 };
      }
      if (path.endsWith('/pages')) {
        return { pages: [], total: 0 };
      }
      if (path.includes('/settings/byoc')) {
        return { fbAppId: null, hasSecret: false };
      }
      if (path.includes('/accounts')) {
        if (mockAccountsShouldFail) {
          throw new Error('accounts failed');
        }
        return { accounts: mockAccountsData, total: mockAccountsData.length };
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

  it('publishes, shows per-page results, and retries only the failed page', { timeout: 15000 }, async () => {
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

  it('does not re-publish already published pages on a second Publish, but publishes a newly added page', { timeout: 15000 }, async () => {
    const publishCalls: Array<{ path: string; body: unknown }> = [];
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (path: string, body: unknown) => {
        publishCalls.push({ path, body });
        const targets = (body as { targets: Array<{ fbPageId: string; pageName: string }> }).targets;
        return {
          results: targets.map((target) => ({
            accountId: '11111111-1111-4111-a111-111111111111',
            fbPageId: target.fbPageId,
            pageName: target.pageName,
            status: 'published',
            postId: `post-${target.fbPageId}`,
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
    // First run: only Maddie Lippy.
    fireEvent.click(screen.getByText('Maddie Lippy'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(1 page\)/ })
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Maddie Lippy' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(screen.getByText('Published')).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(publishCalls).toHaveLength(1);

    // The skipped-page note shows, and Publish is guarded while
    // every selected page is already published in this run.
    expect(
      screen.getByText(
        'Page already published in this run will not be published again.'
      )
    ).toBeTruthy();
    const publishButton = screen.getByRole('button', {
      name: 'Publish Now',
    }) as HTMLButtonElement;
    expect(publishButton.disabled).toBe(true);
    fireEvent.click(publishButton);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publishCalls).toHaveLength(1);

    // Add Sunnie James via Change selection (caption is kept),
    // then Publish again: only the new page is sent.
    fireEvent.click(
      screen.getByRole('button', { name: 'Change selection' })
    );
    await waitFor(
      () => expect(screen.getByText(/2 pages found/)).toBeTruthy(),
      { timeout: 5000 }
    );
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
    expect(
      screen.getByRole('button', { name: 'Publish Now' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(publishCalls).toHaveLength(2),
      { timeout: 5000 }
    );
    const secondBody = publishCalls[1].body as {
      targets: Array<{ fbPageId: string }>;
    };
    expect(secondBody.targets).toHaveLength(1);
    expect(secondBody.targets[0].fbPageId).toBe('page-222');

    // Results merge: both pages still show Published, nothing
    // from the first run is lost by the second publish.
    await waitFor(
      () => expect(screen.getByText(/2 of 2 pages published/)).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getAllByText('Published')).toHaveLength(2);
  });

  it('attaches library media, prefills its caption, and clears it on type switch', { timeout: 15000 }, async () => {
    const publishCalls: Array<{ path: string; body: unknown }> = [];
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (path: string, body: unknown) => {
        publishCalls.push({ path, body });
        return {
          results: [
            {
              accountId: '11111111-1111-4111-a111-111111111111',
              fbPageId: 'page-111',
              pageName: 'Maddie Lippy',
              status: 'published',
              postId: 'photo-post-111',
              reason: null,
              graphCode: null,
              graphSubcode: null,
              step: null,
              httpStatus: null,
              fbtraceId: null,
              firstCommentFailed: null,
              firstCommentReason: null,
            },
          ],
        };
      });

    await reachComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    expect(screen.getByText('photo.jpg')).toBeTruthy();
    expect(screen.getByText(/from Media Library/)).toBeTruthy();
    // The library caption prefills an empty composer.
    expect(
      (
        screen.getByPlaceholderText(
          "What's on your mind?"
        ) as HTMLTextAreaElement
      ).value
    ).toBe('A photo caption');

    // Removing clears the preview; switching type clears attached media.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('photo.jpg')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.queryByText('photo.jpg')).toBeNull();

    // Re-attach as an image and publish: the request carries library media.
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(() => expect(publishCalls.length).toBe(1), {
      timeout: 5000,
    });
    const body = publishCalls[0].body as {
      postType: string;
      media: { source: string; mediaId: string };
    };
    expect(body.postType).toBe('image');
    expect(body.media.source).toBe('library');
    expect(body.media.mediaId).toBe('22222222-2222-4222-a222-222222222222');
  });

  it('shows restriction results, diagnostics, and a disabled retry', { timeout: 15000 }, async () => {
    const restricted = (fbPageId: string, pageName: string) => ({
      accountId: '11111111-1111-4111-a111-111111111111',
      fbPageId,
      pageName,
      status: 'failed',
      postId: null,
      reason:
        'Facebook has restricted this account from posting. Check Account Status on Facebook for the reason and to appeal — retrying won\'t work until the restriction is lifted.',
      graphCode: 1,
      graphSubcode: 2424009,
      step: 'feed',
      httpStatus: 400,
      fbtraceId: 'trace-9',
      firstCommentFailed: null,
      firstCommentReason: null,
    });
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async () => ({
        results: [
          restricted('page-111', 'Maddie Lippy'),
          restricted('page-222', 'Sunnie James'),
        ],
      }));

    await reachComposer();
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/One or more accounts are restricted by Facebook/)
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByText(/Retry is disabled/)).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry failed only' });
    expect((retry as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      screen.getAllByRole('button', { name: 'View details' })[0]
    );
    expect(screen.getByText(/Facebook error #1/)).toBeTruthy();
    expect(screen.getByText(/trace: trace-9/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByText(/trace: trace-9/)).toBeNull();
  });

  it('keeps the caption when changing the selection', { timeout: 15000 }, async () => {
    await reachComposer();
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'Keep me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    await waitFor(
      () => expect(screen.getByText(/2 pages found/)).toBeTruthy(),
      { timeout: 5000 }
    );
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
    expect(
      (
        screen.getByPlaceholderText(
          "What's on your mind?"
        ) as HTMLTextAreaElement
      ).value
    ).toBe('Keep me');
  });

  it('shows expired accounts as non-selectable and the empty state', async () => {
    renderPage();
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.getByText('Expired User')).toBeTruthy();
    expect(screen.getByText('Session expired')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reconnect' })
    ).toBeTruthy();

    mockAccountsData = [];
    renderPage();
    await waitFor(
      () =>
        expect(
          screen.getByText('No Facebook accounts connected')
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(
      screen.getByRole('link', { name: 'Go to Facebook Accounts' })
    ).toBeTruthy();
    mockAccountsData = ACCOUNTS;
  });

  it('filters accounts and pages, selects all pages, and goes back', { timeout: 15000 }, async () => {
    renderPage();
    await waitFor(
      () => expect(screen.getByText(/3 accounts/)).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.change(screen.getByLabelText('Search accounts'), {
      target: { value: 'ayesha' },
    });
    expect(screen.getByText('Ayesha Khan')).toBeTruthy();
    expect(screen.queryByText('Shahzeb Malik')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search accounts'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No accounts match your search')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search accounts'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(
      screen.getByRole('button', { name: /Continue \(1 account\)/ })
    );
    await waitFor(
      () => expect(screen.getByText(/2 pages found/)).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.change(screen.getByLabelText('Filter pages'), {
      target: { value: 'sunnie' },
    });
    expect(screen.getByText('Sunnie James')).toBeTruthy();
    expect(screen.queryByText('Maddie Lippy')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter pages'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByText(/2 of 2 pages selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deselect All' }));
    expect(screen.getByText(/0 of 2 pages selected/)).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Back' })[0]
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole('heading', { name: 'Select accounts' })
        ).toBeTruthy(),
      { timeout: 5000 }
    );
  });

  it('shows plain banners when publishing and retrying fail', { timeout: 15000 }, async () => {
    const failed = [
      {
        accountId: '11111111-1111-4111-a111-111111111111',
        fbPageId: 'page-111',
        pageName: 'Maddie Lippy',
        status: 'failed',
        postId: null,
        reason: 'Facebook is busy',
        graphCode: null,
        graphSubcode: null,
        step: null,
        httpStatus: null,
        fbtraceId: null,
        firstCommentFailed: null,
        firstCommentReason: null,
      },
    ];
    const postMock = api.post as unknown as {
      mockImplementation: (fn: unknown) => void;
      mockRejectedValueOnce: (error: unknown) => void;
      mockResolvedValueOnce: (value: unknown) => void;
    };
    postMock.mockRejectedValueOnce(new Error('Network down'));
    await reachComposer();
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(screen.getByText('Network down')).toBeTruthy(),
      { timeout: 5000 }
    );
    postMock.mockResolvedValueOnce({ results: failed });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    await waitFor(
      () => expect(screen.getByText('Facebook is busy')).toBeTruthy(),
      { timeout: 5000 }
    );
    postMock.mockRejectedValueOnce(new Error('Retry boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed only' }));
    // The banner shows the error's own message when it has one.
    await waitFor(
      () => expect(screen.getByText('Retry boom')).toBeTruthy(),
      { timeout: 5000 }
    );
  });

  it('guards over-limit text and mismatched device and library media', { timeout: 15000 }, async () => {
    const publishCalls: Array<unknown> = [];
    (api.post as unknown as { mockImplementation: (fn: unknown) => void })
      .mockImplementation(async (_path: string, body: unknown) => {
        publishCalls.push(body);
        return { results: [] };
      });
    await reachComposer();
    // Over-limit reel text never reaches the server.
    fireEvent.click(screen.getByRole('button', { name: 'Reel' }));
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), {
      target: { value: 'x'.repeat(2201) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Now' }));
    expect(publishCalls).toHaveLength(0);

    // Device file of the wrong kind, then of an unsupported type.
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    const fileInput = screen.getByLabelText('Upload file from device');
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })],
      },
    });
    await waitFor(
      () =>
        expect(
          screen.getByText(/This is a video, but the post type is Image/)
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })],
      },
    });
    await waitFor(
      () =>
        expect(
          screen.getByText(/This file type is not supported/)
        ).toBeTruthy(),
      { timeout: 5000 }
    );

    // Library photo attached while the type is Video mismatches.
    fireEvent.click(screen.getByRole('button', { name: 'Video' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Attach from Media Library' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach test photo' }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/This is a photo, but the post type is Video/)
        ).toBeTruthy(),
      { timeout: 5000 }
    );
    expect(screen.queryByText('photo.jpg')).toBeNull();
  });

  it('shows a plain error when accounts fail to load', async () => {
    mockAccountsShouldFail = true;
    try {
      renderPage();
      await waitFor(
        () =>
          expect(
            screen.getByText(/Couldn't load your Facebook accounts/)
          ).toBeTruthy(),
        { timeout: 5000 }
      );
    } finally {
      mockAccountsShouldFail = false;
    }
  });

  it('shows a plain error when page discovery fails', async () => {
    mockDiscoverShouldFail = true;
    try {
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
        () =>
          expect(
            screen.getByText(/Couldn't load pages from this Facebook account/)
          ).toBeTruthy(),
        { timeout: 5000 }
      );
    } finally {
      mockDiscoverShouldFail = false;
    }
  });
});

async function reachComposer() {
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
}
