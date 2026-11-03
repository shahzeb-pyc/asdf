/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TikTokHistoryTab, type HistoryStatusFilter } from './tiktok-history-tab';
import type { MirrorView } from '@/lib/api/schemas/tiktok-mirrors';

afterEach(() => { cleanup(); });

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => getMock(...args),
      post: (...args: unknown[]) => postMock(...args),
      delete: vi.fn(),
    },
  };
});

const MIRROR = {
  sourceUsername: 'babybossdiaries',
  targetPlatform: 'facebook',
  targetDisplayName: 'Baby Boss Diaries',
} as unknown as MirrorView;

function post(id: string, status: 'posted' | 'failed', caption: string) {
  return {
    id,
    mirror_id: '00000000-0000-4000-8000-000000000000',
    source_post_id: `vid-${id}`,
    caption,
    video_url: null,
    cover_url: null,
    source_created_at: null,
    status,
    published_post_id: status === 'posted' ? 'fb-1' : null,
    error: status === 'failed' ? 'That reel could not be resolved. (Code: MIRROR_RESOLVE_E01)' : null,
    created_at: '2026-11-03T09:12:00.000Z',
  };
}

const P1 = post('00000000-0000-4000-8000-000000000001', 'posted', 'First page reel');
const P2 = post('00000000-0000-4000-8000-000000000002', 'failed', 'Second page reel');

function renderHistory(status: HistoryStatusFilter = 'all') {
  const onStatusChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <TikTokHistoryTab
        mirror={MIRROR}
        subdomain="creatorstack"
        mirrorId="00000000-0000-4000-8000-000000000000"
        status={status}
        onStatusChange={onStatusChange}
      />
    </QueryClientProvider>
  );
  return { ...result, onStatusChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Server-side filter + pagination: the mock honours ?status=
  // and ?page= the way the detail route does.
  getMock.mockImplementation((path: string) => {
    const url = new URL(path, 'https://example.com');
    const status = url.searchParams.get('status');
    const page = Number(url.searchParams.get('page') ?? '1');
    const all = [P1, P2];
    const filtered = status ? all.filter((p) => p.status === status) : all;
    if (page === 1) {
      return Promise.resolve({
        mirror: MIRROR,
        posts: [filtered[0]].filter(Boolean),
        postCounts: null,
        postCountsError: true,
        postsHasMore: filtered.length > 1,
      });
    }
    return Promise.resolve({
      mirror: MIRROR,
      posts: filtered.slice(1),
      postCounts: null,
      postCountsError: true,
      postsHasMore: false,
    });
  });
  postMock.mockResolvedValue({
    post: { ...P2, status: 'posted', error: null },
  });
});

describe('TikTokHistoryTab', () => {
  it('applies the status filter server-side and reports the filter click', async () => {
    const { onStatusChange } = renderHistory('all');
    await waitFor(() => {
      expect(screen.getByText('First page reel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tiktok-history-filter-failed'));
    expect(onStatusChange).toHaveBeenCalledWith('failed');

    // Re-rendered with the failed filter: the request carries
    // ?status=failed and only failed rows come back.
    const { unmount } = renderHistory('failed');
    await waitFor(() => {
      expect(screen.getByText('Second page reel')).toBeInTheDocument();
    });
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('status=failed'),
      expect.anything()
    );
    unmount();
  });

  it('appends the next page on Load more', async () => {
    renderHistory('all');
    await waitFor(() => {
      expect(screen.getByText('First page reel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('tiktok-history-load-more'));
    await waitFor(() => {
      expect(screen.getByText('Second page reel')).toBeInTheDocument();
    });
    // The first page's row is still there: pages append, not replace.
    expect(screen.getByText('First page reel')).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('page=2'),
      expect.anything()
    );
  });

  it('retries a failed post from History', async () => {
    renderHistory('failed');
    await waitFor(() => {
      expect(screen.getByText('Second page reel')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`tiktok-retry-btn-${P2.id}`));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        expect.stringContaining('/posts/'),
        expect.anything(),
        expect.anything()
      );
    });
  });
});
