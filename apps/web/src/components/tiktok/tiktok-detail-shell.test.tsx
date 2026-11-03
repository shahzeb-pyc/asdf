/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TikTokDetailShell } from './tiktok-detail-shell';
import { IgAutoRepostDetailShell } from '@/components/instagram/auto-repost/ig-auto-repost-detail-shell';

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

const replaceMock = vi.fn();
let searchString = 'tab=history&status=failed';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchString),
}));

const getMock = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => getMock(...args),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const MIRROR = {
  sourceUsername: 'babybossdiaries',
  sourcePlatform: 'tiktok',
  sourceDisplayName: null,
  sourceAvatarUrl: null,
  targetPlatform: 'facebook',
  targetExternalId: 'fb-1',
  targetDisplayName: 'Baby Boss Diaries',
  targetAvatarUrl: null,
  targetDestinationId: null,
  status: 'active',
  lastMirroredPost: null,
  lastCheckedAt: null,
  nextCheckAt: null,
  lastError: null,
  createdAt: '2026-10-12T00:00:00.000Z',
  targetAddedAt: null,
  targetFollowers: null,
  targetCategory: null,
  targetAccountDisplayName: null,
  targetAccountAvatarUrl: null,
  targetStartingFollowers: null,
};

const DETAIL = {
  mirror: MIRROR,
  posts: [],
  postCounts: { posted: 5, failed: 1, skipped: 0 },
  postCountsError: false,
  postsHasMore: false,
};

const HISTORY_POST = {
  id: '00000000-0000-4000-8000-000000000001',
  mirror_id: '00000000-0000-4000-8000-000000000000',
  source_post_id: 'vid-1',
  caption: 'Failed history reel',
  video_url: null,
  cover_url: null,
  source_created_at: null,
  status: 'failed',
  published_post_id: null,
  error: null,
  created_at: '2026-11-03T08:12:00.000Z',
};

afterEach(() => { cleanup(); });

beforeEach(() => {
  vi.clearAllMocks();
  searchString = 'tab=history&status=failed';
  getMock.mockImplementation((path: string) => {
    // History fetches carry ?page=; the shell detail fetch does not.
    if (path.includes('page=')) {
      return Promise.resolve({ ...DETAIL, posts: [HISTORY_POST], postsHasMore: false });
    }
    return Promise.resolve(DETAIL);
  });
});

function renderWithClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('mirror detail shells ?tab= state', () => {
  it('Facebook shell opens on History with the Failed filter from the URL', async () => {
    renderWithClient(
      <TikTokDetailShell subdomain="creatorstack" mirrorId="00000000-0000-4000-8000-000000000000" />
    );
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-history-tab')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tiktok-history-filter-failed')).toBeInTheDocument();
    // Dashboard content (totals) is not the active tab's content.
    expect(screen.queryByTestId('tiktok-dashboard-tab')).not.toBeInTheDocument();
  });

  it('Instagram shell opens on History with the Failed filter from the URL and no Insights tab', async () => {
    renderWithClient(
      <IgAutoRepostDetailShell subdomain="creatorstack" mirrorId="00000000-0000-4000-8000-000000000000" />
    );
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-history-tab')).toBeInTheDocument();
    });
    expect(screen.queryByText('Insights')).not.toBeInTheDocument();
  });

  it('Facebook shell defaults to Dashboard when no ?tab= is given', async () => {
    searchString = '';
    renderWithClient(
      <TikTokDetailShell subdomain="creatorstack" mirrorId="00000000-0000-4000-8000-000000000000" />
    );
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-dashboard-tab')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('tiktok-history-tab')).not.toBeInTheDocument();
  });
});
