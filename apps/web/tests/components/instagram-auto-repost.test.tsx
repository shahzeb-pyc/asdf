/** @vitest-environment jsdom */
/**
 * Instagram Auto Repost UI: list renders cards (or the empty state)
 * for Instagram targets only, and the dedicated view renders the
 * Dashboard with the linked Instagram account — and no Insights tab
 * (there is no Instagram destination insights panel).
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const apiGetMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: (...args: unknown[]) => apiGetMock(...args),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

import { IgAutoRepostShell } from '@/components/instagram/auto-repost/ig-auto-repost-shell';
import { IgAutoRepostDetailShell } from '@/components/instagram/auto-repost/ig-auto-repost-detail-shell';

function mirrorView(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-a444-444444444444',
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    targetPlatform: 'instagram',
    targetExternalId: '17841400008460056',
    targetDestinationId: '33333333-3333-4333-a333-333333333333',
    targetDisplayName: 'Alice on IG',
    targetAvatarUrl: null,
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: 'https://example.com/a.jpg',
    status: 'active',
    lastPostedSourceId: 'v1',
    lastCheckedAt: '2026-10-29T11:00:00.000Z',
    nextCheckAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    lastMirroredPost: {
      id: '55555555-5555-4555-a555-555555555555',
      sourcePostId: 'v1',
      caption: 'My exact caption',
      coverUrl: null,
      status: 'posted',
      publishedPostId: 'ig_media_1',
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

describe('Instagram Auto Repost list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders mirror cards with username and linked Instagram account, filtered to Instagram', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView()],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
    });
    renderWithQuery(<IgAutoRepostShell subdomain="acme" />);
    expect(await screen.findByTestId('ig-auto-repost-mirrors-grid')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText(/Alice on IG/)).toBeTruthy();
    const listUrl = String(apiGetMock.mock.calls[0]?.[0] ?? '');
    expect(listUrl).toContain('targetPlatform=instagram');
  });

  it('renders the empty state when there are no mirrors', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [],
      total: 0,
      page: 1,
      limit: 30,
      totalPages: 0,
    });
    renderWithQuery(<IgAutoRepostShell subdomain="acme" />);
    expect(await screen.findByTestId('ig-auto-repost-empty-state')).toBeTruthy();
    expect(screen.getByText('No mirrors yet')).toBeTruthy();
  });
});

describe('Instagram Auto Repost detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Dashboard with the linked Instagram account and no Insights tab', async () => {
    apiGetMock.mockResolvedValue({
      mirror: mirrorView(),
      posts: [],
    });
    renderWithQuery(
      <IgAutoRepostDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('ig-auto-repost-detail-page')).toBeTruthy();
    expect(screen.getByText('Mirroring to Alice on IG')).toBeTruthy();
    expect(screen.queryByText('Insights')).toBeNull();
    const detailUrl = String(apiGetMock.mock.calls[0]?.[0] ?? '');
    expect(detailUrl).toContain('targetPlatform=instagram');
  });
});
