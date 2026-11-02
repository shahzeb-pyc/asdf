/** @vitest-environment jsdom */
/**
 * TikTok mirrors UI: list renders cards (or the empty state),
 * the dedicated view renders Dashboard + Insights tabs, and the
 * dashboard shows the linked page, status, and history.
 * (Insights internals are pre-existing; the panel is stubbed here
 * so this test pins the tab wiring, not the insights fetch.)
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/components/pages/dedicated/insights-panel', () => ({
  PageTabInsights: () => <div data-testid="insights-stub">Insights stub</div>,
}));

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: (...args: unknown[]) => apiGetMock(...args),
      patch: (...args: unknown[]) => apiPatchMock(...args),
      post: (...args: unknown[]) => apiPostMock(...args),
      delete: vi.fn(),
    },
  };
});

import { TikTokShell } from '@/components/tiktok/tiktok-shell';
import { TikTokDetailShell } from '@/components/tiktok/tiktok-detail-shell';

function mirrorView(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-a444-444444444444',
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    targetPlatform: 'facebook',
    targetExternalId: '749557154917108',
    targetDestinationId: '33333333-3333-4333-a333-333333333333',
    targetDisplayName: 'Test Page',
    targetAvatarUrl: null,
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: 'https://example.com/a.jpg',
    status: 'active',
    lastPostedSourceId: 'v1',
    lastCheckedAt: '2026-10-29T11:00:00.000Z',
    nextCheckAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    targetAddedAt: '2026-11-02T00:00:00.000Z',
    targetFollowers: 0,
    targetCategory: 'Digital creator',
    targetAccountDisplayName: 'Shahzeb Malik',
    targetAccountAvatarUrl: null,
    targetStartingFollowers: null,
    postCounts: { posted: 1, failed: 0 },
    postCountsError: false,
    lastMirroredPost: {
      id: '55555555-5555-4555-a555-555555555555',
      sourcePostId: 'v1',
      caption: 'My exact caption',
      coverUrl: null,
      status: 'posted',
      publishedPostId: 'fb_post_1',
      createdAt: '2026-10-29T10:00:00.000Z',
    },
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

function renderWithQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

// The shells under test render the feature-cap hook, which reads the
// shared entitlement. In the app the tenant shell provides it; these
// standalone shell tests do not mount that shell, so the hook reads
// the neutral unproven state (cap renders nothing) instead of
// throwing for a missing provider. The real provider path is covered
// by the feature-cap tests.
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

describe('TikTok list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders mirror cards with the page primary, a source line, and Posted/Failed counts', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView()],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('tiktok-mirrors-grid')).toBeTruthy();
    expect(screen.getByTestId('tiktok-mirror-page-name').textContent).toBe('Test Page');
    expect(screen.getByTestId('tiktok-mirror-page-added').textContent).toBe('Added 2 Nov 2026');
    expect(screen.getByTestId('tiktok-mirror-source').textContent).toBe('source: @alice');
    expect(screen.getByTestId('tiktok-mirror-posted-count').textContent).toBe('1');
    expect(screen.getByTestId('tiktok-mirror-failed-count').textContent).toBe('0');
    expect(screen.queryByTestId('tiktok-mirror-next')).toBeNull();
    expect(screen.queryByText('Queued')).toBeNull();
  });

  it('renders the empty state when there are no mirrors', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [],
      total: 0,
      page: 1,
      limit: 30,
      totalPages: 0,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('tiktok-empty-state')).toBeTruthy();
    expect(screen.getByText('No mirrors yet')).toBeTruthy();
  });

  it('renders pagination when there is more than one page', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView()],
      total: 65,
      page: 1,
      limit: 30,
      totalPages: 3,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('list-pagination')).toBeTruthy();
    expect(screen.getByTestId('pagination-page-3')).toBeTruthy();
  });

  it('shows the plain-language message for a stored raw restriction error on a card', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView({ status: 'error', lastError: raw })],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    const errorEl = await screen.findByTestId('tiktok-mirror-error');
    expect(errorEl.textContent).toContain("can't post right now");
    expect(screen.queryByText(raw)).toBeNull();
  });
});

describe('TikTok dedicated view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const detailResponse = (overrides: Record<string, unknown> = {}) => ({
    mirror: mirrorView(overrides),
    posts: [
      {
        id: '55555555-5555-4555-a555-555555555555',
        mirror_id: '44444444-4444-4444-a444-444444444444',
        source_post_id: 'v1',
        caption: 'My exact caption',
        video_url: 'https://example.com/v1.mp4',
        cover_url: null,
        source_created_at: '2026-10-29T10:00:00.000Z',
        status: 'posted',
        published_post_id: 'fb_post_1' as string | null,
        error: null as string | null,
        created_at: '2026-10-29T10:00:00.000Z',
      },
    ],
  });

  it('renders Dashboard + Insights tabs and the target-first header', async () => {
    apiGetMock.mockResolvedValue(detailResponse());
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.getByTestId('tiktok-detail-tabs')).toBeTruthy();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Insights')).toBeTruthy();
    // Target-first header (Pages-style): the page is the heading,
    // the creator is only the muted source line, and the old
    // "Mirroring to" duplication is gone entirely.
    expect(screen.getByTestId('mirror-detail-target-name').textContent).toBe('Test Page');
    expect(screen.getByTestId('mirror-detail-source').textContent).toBe('source: @alice');
    expect(screen.queryByText(/Mirroring to/)).toBeNull();
    expect(screen.getByTestId('mirror-detail-back-link').textContent).toContain('Auto Repost');
    expect(screen.getByTestId('mirror-detail-platform-tag').textContent).toBe('Facebook');
    expect(screen.getByTestId('mirror-detail-facebook-link')).toBeTruthy();
    expect(screen.getByTestId('mirror-detail-account').textContent).toBe(
      'Connected via Shahzeb Malik'
    );
    expect(screen.getByTestId('mirror-detail-added').textContent).toBe('Added 2 Nov 2026');
    expect(screen.getByTestId('mirror-detail-followers').textContent).toContain('0');
    expect(screen.getByTestId('mirror-detail-followers').textContent).toContain('followers');
    expect(screen.getByTestId('mirror-detail-category').textContent).toBe('Digital creator');
    expect(screen.getByTestId('mirror-detail-mirror-added').textContent).toContain('Mirror added');
    expect(screen.getByTestId('mirror-detail-mirror-added').textContent).toContain('Mirroring for');
    const timing = screen.getByTestId('mirror-detail-timing').textContent ?? '';
    expect(timing).toContain('Last mirrored:');
    expect(timing).toContain('Next check:');
    expect(timing).toContain('Last checked:');
    expect(timing).toContain('Checks hourly');
    // No all-time totals in the header — those belong in the
    // Dashboard tab in a later job, not here.
    expect(screen.queryByTestId('tiktok-mirror-post-counts')).toBeNull();
    expect(screen.getByText('Mirror history')).toBeTruthy();
    expect(screen.getByText('My exact caption')).toBeTruthy();
  });

  it('shows +N gained only with a valid starting baseline and a nonzero gain', async () => {
    apiGetMock.mockResolvedValue(
      detailResponse({ targetFollowers: 120, targetStartingFollowers: 100 })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('mirror-detail-followers-gained')).toBeTruthy();
    expect(screen.getByTestId('mirror-detail-followers-gained').textContent).toContain('+20');
  });

  it('shows a negative gain when followers fell', async () => {
    apiGetMock.mockResolvedValue(
      detailResponse({ targetFollowers: 90, targetStartingFollowers: 100 })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('mirror-detail-followers-gained')).toBeTruthy();
    expect(screen.getByTestId('mirror-detail-followers-gained').textContent).toContain('-10');
  });

  it('hides gained with no starting baseline, and hides a zero gain', async () => {
    apiGetMock.mockResolvedValue(
      detailResponse({ targetFollowers: 120, targetStartingFollowers: null })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.queryByTestId('mirror-detail-followers-gained')).toBeNull();
    apiGetMock.mockResolvedValue(
      detailResponse({ targetFollowers: 100, targetStartingFollowers: 100 })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    // Second render in the same test uses a fresh QueryClient, so
    // the page re-queries with the zero-gain mirror.
    expect(await screen.findAllByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.queryByTestId('mirror-detail-followers-gained')).toBeNull();
  });

  it('pauses from the header menu and opens the delete confirmation', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(detailResponse());
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    await user.click(screen.getByTestId('mirror-detail-menu-btn'));
    await user.click(screen.getByTestId('mirror-detail-menu-pause'));
    expect(apiPatchMock).toHaveBeenCalled();
    const patchCall = apiPatchMock.mock.calls[0] ?? [];
    expect(String(patchCall[0])).toContain('/tiktok-mirrors/44444444-4444-4444-a444-444444444444');
    expect(patchCall[1]).toEqual({ status: 'paused' });
    await user.click(screen.getByTestId('mirror-detail-menu-btn'));
    await user.click(screen.getByTestId('mirror-detail-menu-delete'));
    expect(await screen.findByTestId('tiktok-delete-confirm')).toBeTruthy();
    expect(screen.getByText(/The Facebook page itself is not deleted/)).toBeTruthy();
  });

  it('shows no error banner and no bogus countdown for a healthy paused mirror', async () => {
    apiGetMock.mockResolvedValue(detailResponse({ status: 'paused', nextCheckAt: null }));
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.queryByTestId('tiktok-detail-error')).toBeNull();
    const timing = screen.getByTestId('mirror-detail-timing').textContent ?? '';
    expect(timing).not.toContain('(in ');
    expect(screen.getByTestId('mirror-detail-menu-btn')).toBeTruthy();
  });

  it('degrades gracefully when the target destination is gone', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(
      detailResponse({
        targetDestinationId: null,
        targetAddedAt: null,
        targetFollowers: null,
        targetCategory: null,
        targetAccountDisplayName: null,
        targetAccountAvatarUrl: null,
        targetStartingFollowers: null,
      })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    // Stored target copy still renders as the heading; the
    // destination-derived lines are omitted, not faked.
    expect(screen.getByTestId('mirror-detail-target-name').textContent).toBe('Test Page');
    expect(screen.queryByTestId('mirror-detail-added')).toBeNull();
    expect(screen.queryByTestId('mirror-detail-followers')).toBeNull();
    expect(screen.queryByTestId('mirror-detail-account')).toBeNull();
    await user.click(screen.getByText('Insights'));
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-insights-unavailable')).toBeTruthy();
    });
  });

  it('switches to the Insights tab on click', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(detailResponse());
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    await user.click(screen.getByText('Insights'));
    await waitFor(() => {
      expect(screen.getByTestId('insights-stub')).toBeTruthy();
    });
  });

  it('shows the error text and paused state for an error mirror', async () => {
    apiGetMock.mockResolvedValue(
      detailResponse({ status: 'error', lastError: 'tikwm is down' })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-error')).toBeTruthy();
    expect(screen.getByText('tikwm is down')).toBeTruthy();
  });

  it('shows the plain-language message for a stored raw restriction error', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    apiGetMock.mockResolvedValue(
      detailResponse({
        status: 'error',
        lastError: raw,
      })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    const errorEl = await screen.findByTestId('tiktok-detail-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toContain("can't post right now");
    expect(errorEl.textContent).not.toContain('limited access');
  });

  it('shows the plain-language message for a stored raw restriction on a history post', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    const response = detailResponse({ status: 'error', lastError: null });
    response.posts = [
      {
        ...response.posts[0],
        status: 'pending',
        published_post_id: null,
        error: raw,
      },
    ];
    apiGetMock.mockResolvedValue(response);
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.getByText(/can't post right now/)).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
  });
});

describe('TikTok mirror history retry button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const POST_ID = '55555555-5555-4555-a555-555555555555';
  const MIRROR_ID = '44444444-4444-4444-a444-444444444444';

  const retryDetailResponse = (
    postOverrides: Record<string, unknown> = {},
    mirrorOverrides: Record<string, unknown> = {}
  ) => ({
    mirror: mirrorView(mirrorOverrides),
    posts: [
      {
        id: POST_ID,
        mirror_id: MIRROR_ID,
        source_post_id: 'v1',
        caption: 'My exact caption',
        video_url: 'https://example.com/v1.mp4',
        cover_url: null,
        source_created_at: '2026-10-29T10:00:00.000Z',
        status: 'pending',
        published_post_id: null,
        error: 'A previous failure',
        created_at: '2026-10-29T10:00:00.000Z',
        ...postOverrides,
      },
    ],
  });

  const renderDetail = () =>
    renderWithQuery(<TikTokDetailShell subdomain="acme" mirrorId={MIRROR_ID} />);

  it('shows Retry on failed or pending posts, and only for Facebook/Instagram targets', async () => {
    apiGetMock.mockResolvedValue(retryDetailResponse());
    const first = renderDetail();
    expect(
      await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`)
    ).toBeTruthy();
    first.unmount();

    apiGetMock.mockResolvedValue(
      retryDetailResponse({ status: 'posted', published_post_id: 'fb_post_1', error: null })
    );
    renderDetail();
    await screen.findByTestId('tiktok-detail-page');
    expect(screen.queryByTestId(`tiktok-retry-btn-${POST_ID}`)).toBeNull();

    apiGetMock.mockResolvedValue(retryDetailResponse({ status: 'failed' }));
    const failed = renderDetail();
    expect(
      await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`)
    ).toBeTruthy();
    failed.unmount();
  });

  it('shows Retry for a pending Instagram post but not for an unsupported target', async () => {
    apiGetMock.mockResolvedValue(
      retryDetailResponse({}, { targetPlatform: 'instagram' })
    );
    const first = renderDetail();
    expect(
      await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`)
    ).toBeTruthy();
    first.unmount();

    apiGetMock.mockResolvedValue(
      retryDetailResponse({}, { targetPlatform: 'threads' })
    );
    renderDetail();
    await screen.findByTestId('tiktok-detail-page');
    expect(screen.queryByTestId(`tiktok-retry-btn-${POST_ID}`)).toBeNull();
  });

  it('calls the retry endpoint on click and refetches the detail on success', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    apiPostMock.mockResolvedValue({
      post: { id: POST_ID, status: 'posted', publishedPostId: 'fb_post_999', error: null },
    });
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        `/api/tenant/acme/tiktok-mirrors/${MIRROR_ID}/posts/${POST_ID}/retry`,
        {},
        expect.objectContaining({ schema: expect.anything() })
      )
    );
    await waitFor(() => expect(apiGetMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('disables the button with Retrying… while the retry is in flight', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    let resolvePost: (value: unknown) => void = () => {};
    apiPostMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        })
    );
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', true));
    expect(button.textContent).toBe('Retrying…');
    resolvePost({
      post: { id: POST_ID, status: 'posted', publishedPostId: 'fb_post_999', error: null },
    });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(button.textContent).toBe('Retry');
  });

  it('refetches the detail when the retry outcome stays failed (failure shows on the row)', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    apiPostMock.mockResolvedValue({
      post: { id: POST_ID, status: 'failed', publishedPostId: null, error: 'Facebook rejected this reel.' },
    });
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiGetMock.mock.calls.length).toBeGreaterThan(1));
  });
});
