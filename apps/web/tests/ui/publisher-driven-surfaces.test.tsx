/**
 * Publisher-driven surfaces: the unmatched-posts warning shows as a
 * banner on the dedicated page and a mark on the Pages card ONLY
 * while the page is active (the stored flag survives pausing, but
 * the mark does not show then), and the dashboard shows derived
 * estimates — never stored times.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PageCard, type FacebookPageItem } from '@/components/pages/page-card';
import { DedicatedPageHeader } from '@/components/pages/dedicated/page-header';
import { PageTabDashboard } from '@/components/pages/dedicated/tab-dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function pageWith(overrides: Partial<FacebookPageItem>): FacebookPageItem {
  return {
    id: 'page-1',
    facebookAccountId: 'acc-1',
    accountDisplayName: 'Test Account',
    fbPageId: 'fb_1',
    pageName: 'Test Page',
    startingFollowers: 0,
    currentFollowers: 100,
    followersGained: 0,
    status: 'active',
    timezone: 'UTC',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('unmatched-posts warning', () => {
  it('shows the needs-attention mark on an active card with unmatched posts', () => {
    render(<PageCard page={pageWith({ unmatchedPostTypes: ['image'] })} />);
    expect(screen.getByTestId('page-needs-attention-unmatched')).toBeInTheDocument();
    expect(screen.getByTestId('page-status')).toHaveTextContent('Active');
  });

  it('hides the card mark when paused, even though the flag is stored', () => {
    render(
      <PageCard page={pageWith({ status: 'paused', unmatchedPostTypes: ['image'] })} />
    );
    expect(screen.queryByTestId('page-needs-attention-unmatched')).not.toBeInTheDocument();
  });

  it('hides the card mark when nothing is unmatched', () => {
    render(<PageCard page={pageWith({ unmatchedPostTypes: [] })} />);
    expect(screen.queryByTestId('page-needs-attention-unmatched')).not.toBeInTheDocument();
  });

  it('shows the banner on an active dedicated page with unmatched posts', () => {
    render(
      <DedicatedPageHeader
        page={pageWith({ unmatchedPostTypes: ['image', 'reel'] })}
        subdomain="acme"
        onStatusToggle={vi.fn().mockResolvedValue(undefined)}
        onDisconnectRequest={vi.fn()}
      />
    );
    const banner = screen.getByTestId('unmatched-post-types-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Some queued posts have no posting time');
    expect(banner).toHaveTextContent('Photos');
    expect(banner).toHaveTextContent('Reels');
  });

  it('hides the banner when paused, even though the flag is stored', () => {
    render(
      <DedicatedPageHeader
        page={pageWith({ status: 'paused', unmatchedPostTypes: ['image'] })}
        subdomain="acme"
        onStatusToggle={vi.fn().mockResolvedValue(undefined)}
        onDisconnectRequest={vi.fn()}
      />
    );
    expect(screen.queryByTestId('unmatched-post-types-banner')).not.toBeInTheDocument();
  });
});

describe('dashboard queue estimates', () => {
  const basePage = pageWith({});

  it('shows expected times for estimated posts and a waiting line for unmatched ones', () => {
    render(
      <PageTabDashboard
        page={basePage}
        queueItems={[
          {
            id: 'q1',
            postFormat: 'text',
            caption: 'First',
            scheduledTime: null,
            estimatedTime: '2026-10-28T08:00:00.000Z',
            status: 'queued',
          },
          {
            id: 'q2',
            postFormat: 'image',
            caption: 'Second',
            scheduledTime: null,
            estimatedTime: null,
            status: 'queued',
          },
        ]}
        slots={[]}
        onPublishNow={vi.fn().mockResolvedValue(undefined)}
        onSwitchTab={vi.fn()}
      />
    );
    expect(screen.getByText(/Expected/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for a matching posting time')).toBeInTheDocument();
    // The next-publication metric follows the first ESTIMATED post,
    // not the unmatched post at the head of the list.
    const metric = screen.getByTestId('metric-next-post');
    expect(metric).not.toHaveTextContent('Waiting for a posting time');
  });

  it('shows the waiting state in the next-publication metric when nothing has an estimate', () => {
    render(
      <PageTabDashboard
        page={basePage}
        queueItems={[
          {
            id: 'q1',
            postFormat: 'image',
            caption: 'Only',
            scheduledTime: null,
            estimatedTime: null,
            status: 'queued',
          },
        ]}
        slots={[]}
        onPublishNow={vi.fn().mockResolvedValue(undefined)}
        onSwitchTab={vi.fn()}
      />
    );
    expect(screen.getByTestId('metric-next-post')).toHaveTextContent(
      'Waiting for a posting time'
    );
  });
});
