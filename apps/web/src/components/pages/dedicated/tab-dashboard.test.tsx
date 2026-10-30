/**
 * Dashboard tab failure-as-empty + timezone tests (Pages audit R4/R5/R8):
 * a failed queue/slots fetch must never render as 0, "Nothing
 * scheduled yet", or "Waiting for a posting time", and estimates /
 * next publication must render in the PAGE timezone, not the
 * browser timezone.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PageTabDashboard, type PageQueueItemSummary } from './tab-dashboard';
import type { FacebookPageItem } from '../page-card';

const PAGE: FacebookPageItem = {
  id: 'page-101',
  facebookAccountId: 'acc-99',
  accountDisplayName: 'John Connor',
  fbPageId: 'fb_101',
  pageName: 'Test Page',
  category: 'Community',
  startingFollowers: 0,
  currentFollowers: 100,
  followersGained: 0,
  status: 'active',
  timezone: 'UTC',
  createdAt: '2026-10-01T00:00:00.000Z',
};

function renderDashboard(
  overrides: Partial<React.ComponentProps<typeof PageTabDashboard>> = {},
) {
  const props: React.ComponentProps<typeof PageTabDashboard> = {
    page: PAGE,
    queueItems: [],
    slots: [],
    onPublishNow: vi.fn().mockResolvedValue(undefined),
    onSwitchTab: vi.fn(),
    ...overrides,
  };
  return render(<PageTabDashboard {...props} />);
}

describe('PageTabDashboard failure-as-empty (R5/R4)', () => {
  it('shows an error state, not 0 / empty copy, when the queue fetch fails', () => {
    renderDashboard({ queueError: true, onRetryData: vi.fn() });
    expect(screen.getByTestId('dashboard-queue-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the queue.")).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-queue-empty')).not.toBeInTheDocument();
    // The queued metric is unknown, not zero.
    expect(screen.getByTestId('metric-queued-count')).toHaveTextContent('—');
    expect(screen.getByTestId('metric-queued-count')).not.toHaveTextContent('0');
    expect(screen.getByTestId('metric-next-post')).toHaveTextContent("Couldn't load");
  });

  it('shows an error state, not "no posting times" / "waiting", when slots fail', () => {
    const queued: PageQueueItemSummary[] = [
      {
        id: 'q1',
        postFormat: 'image',
        caption: 'Waiting post',
        scheduledTime: null,
        estimatedTime: null,
        status: 'queued',
      },
    ];
    renderDashboard({ queueItems: queued, slotsError: true, onRetryData: vi.fn() });
    expect(screen.getByTestId('dashboard-slots-error')).toBeInTheDocument();
    expect(screen.queryByText('No active daily posting times defined yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for a matching posting time')).not.toBeInTheDocument();
    expect(screen.getByText("Posting times couldn't be loaded")).toBeInTheDocument();
    expect(screen.getByTestId('metric-next-post')).toHaveTextContent("Couldn't load");
  });
});

describe('PageTabDashboard page timezone (R8)', () => {
  it('formats the next publication and estimates in the page timezone, not the browser timezone', () => {
    // 14:00 UTC = 10:00 am in America/New_York (EDT). A bare
    // browser-timezone toLocale* in a UTC test env would say 2:00 PM.
    const queued: PageQueueItemSummary[] = [
      {
        id: 'q1',
        postFormat: 'image',
        caption: 'Timed post',
        scheduledTime: null,
        estimatedTime: '2026-10-28T14:00:00.000Z',
        status: 'queued',
      },
    ];
    renderDashboard({
      page: { ...PAGE, timezone: 'America/New_York' },
      queueItems: queued,
      slots: [
        { id: 'slot-1', slotTime: '10:00', timezone: 'America/New_York', isActive: true },
      ],
    });
    expect(screen.getByTestId('metric-next-post')).toHaveTextContent('10:00 am');
    expect(screen.getByTestId('metric-next-post')).not.toHaveTextContent('2:00 PM');
    expect(screen.getByText(/Expected .*10:00 am/)).toBeInTheDocument();
  });
});
