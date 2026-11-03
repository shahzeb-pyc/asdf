/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { TikTokDashboardTab } from './tiktok-dashboard-tab';
import type { MirrorDetailResponse, MirrorDashboardCounts } from '@/lib/api/schemas/tiktok-mirrors';

afterEach(() => { cleanup(); });

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

const POSTED = {
  id: '00000000-0000-4000-8000-000000000001',
  mirror_id: '00000000-0000-4000-8000-000000000000',
  source_post_id: 'vid-1',
  caption: 'Latest posted reel',
  video_url: null,
  cover_url: 'https://example.com/cover.jpg',
  source_created_at: null,
  status: 'posted' as const,
  published_post_id: 'fb-1',
  error: null,
  created_at: '2026-11-03T09:12:00.000Z',
};

const FAILED = {
  ...POSTED,
  id: '00000000-0000-4000-8000-000000000002',
  source_post_id: 'vid-2',
  caption: 'Failed reel',
  status: 'failed' as const,
  published_post_id: null,
  error: 'That reel could not be resolved. (Code: MIRROR_RESOLVE_E01)',
  created_at: '2026-11-03T08:12:00.000Z',
};

function renderDashboard(overrides: {
  posts?: MirrorDetailResponse['posts'];
  postCounts?: MirrorDashboardCounts | null;
  postCountsError?: boolean;
} = {}) {
  const onViewFailed = vi.fn();
  render(
    <TikTokDashboardTab
      posts={overrides.posts ?? [FAILED, POSTED]}
      postCounts={'postCounts' in overrides ? (overrides.postCounts ?? null) : { posted: 128, failed: 3, skipped: 11 }}
      postCountsError={overrides.postCountsError ?? false}
      onViewFailed={onViewFailed}
    />
  );
  return { onViewFailed };
}

describe('TikTokDashboardTab', () => {
  it('renders all-time totals', () => {
    renderDashboard();
    expect(screen.getByTestId('tiktok-dashboard-posted')).toHaveTextContent('128');
    expect(screen.getByTestId('tiktok-dashboard-failed')).toHaveTextContent('3');
    expect(screen.getByTestId('tiktok-dashboard-skipped')).toHaveTextContent('11');
  });

  it('renders dashes, never zeros, when the counts query fails', () => {
    renderDashboard({ postCounts: null, postCountsError: true });
    expect(screen.getByTestId('tiktok-dashboard-posted')).toHaveTextContent('—');
    expect(screen.getByTestId('tiktok-dashboard-failed')).toHaveTextContent('—');
    expect(screen.getByTestId('tiktok-dashboard-skipped')).toHaveTextContent('—');
    expect(screen.getByTestId('tiktok-dashboard-counts-error')).toBeInTheDocument();
    // No failed strip when the failed count is unknown.
    expect(screen.queryByTestId('tiktok-dashboard-failed-strip')).not.toBeInTheDocument();
  });

  it('shows the failed strip only when failed > 0 and it calls onViewFailed', () => {
    const { onViewFailed } = renderDashboard();
    expect(screen.getByTestId('tiktok-dashboard-failed-strip')).toHaveTextContent('3 reels failed');
    fireEvent.click(screen.getByRole('button', { name: 'View failed reels' }));
    expect(onViewFailed).toHaveBeenCalledOnce();
  });

  it('hides the failed strip when failed is 0', () => {
    renderDashboard({ postCounts: { posted: 5, failed: 0, skipped: 0 } });
    expect(screen.queryByTestId('tiktok-dashboard-failed-strip')).not.toBeInTheDocument();
  });

  it('shows the latest posted reel', () => {
    renderDashboard();
    expect(screen.getByText('Latest mirrored')).toBeInTheDocument();
    expect(screen.getByText('Latest posted reel')).toBeInTheDocument();
  });

  it('omits the latest section when no post is posted', () => {
    renderDashboard({
      posts: [FAILED],
      postCounts: { posted: 0, failed: 1, skipped: 0 },
    });
    expect(screen.queryByText('Latest mirrored')).not.toBeInTheDocument();
  });
});
