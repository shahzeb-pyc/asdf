/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PageCard, type FacebookPageItem } from './page-card';

function makePage(
  overrides: Partial<FacebookPageItem> = {}
): FacebookPageItem {
  return {
    id: '33333333-3333-4333-a333-333333333333',
    facebookAccountId: '22222222-2222-4222-a222-222222222222',
    accountDisplayName: 'Alex Marketing',
    fbPageId: 'page_a',
    pageName: 'Counted Page',
    category: 'Community',
    startingFollowers: 1000,
    currentFollowers: 1000,
    followersGained: 0,
    status: 'active',
    createdAt: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('PageCard queue counts', () => {
  it('shows Queued / Posted / Failed with the exact numbers, coloured by signal', () => {
    render(
      <PageCard
        page={makePage({
          queueCounts: { queued: 12, posted: 48, failed: 3 },
        })}
        onSelectPage={() => {}}
      />
    );
    const row = screen.getByTestId('page-queue-counts');
    expect(row.textContent).toContain('Queued');
    expect(row.textContent).toContain('Posted');
    expect(row.textContent).toContain('Failed');

    const queued = screen.getByTestId('page-queued-count');
    const posted = screen.getByTestId('page-posted-count');
    const failed = screen.getByTestId('page-failed-count');
    expect(queued.textContent).toBe('12');
    expect(posted.textContent).toBe('48');
    expect(failed.textContent).toBe('3');
    expect(queued.className).toContain('text-signal-queued');
    expect(posted.className).toContain('text-signal-operational');
    expect(failed.className).toContain('text-signal-critical');
  });

  it('shows zeros, never a hidden row, when no counts were fetched', () => {
    render(<PageCard page={makePage()} onSelectPage={() => {}} />);
    expect(screen.getByTestId('page-queued-count').textContent).toBe('0');
    expect(screen.getByTestId('page-posted-count').textContent).toBe('0');
    expect(screen.getByTestId('page-failed-count').textContent).toBe('0');
  });

  it('is display only: the counts row has no link or button, and clicking it is the card action', () => {
    const onSelectPage = vi.fn();
    render(
      <PageCard
        page={makePage({
          queueCounts: { queued: 1, posted: 2, failed: 0 },
        })}
        onSelectPage={onSelectPage}
      />
    );
    const row = screen.getByTestId('page-queue-counts');
    expect(row.querySelectorAll('a,button')).toHaveLength(0);
    fireEvent.click(row);
    expect(onSelectPage).toHaveBeenCalledTimes(1);
  });
});
