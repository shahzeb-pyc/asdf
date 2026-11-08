/**
 * Threads Auto Download/Upload detail — ADU statuses behaviour.
 *
 * The toggle writes paused/active (never inactive), locks for
 * invalid_token / completed / fb_rate_limited, and the creator-suspended
 * banner shows the decided all-time-50 copy even when the server alert
 * still carries the old source-change wording.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { ThreadsAduDetailPage } from '@/components/threads/auto-download-upload/threads-adu-detail-page';

const fetchMock = vi.fn();

const CONFIG = {
  id: 'cfg-1',
  destinationId: 'dest-1',
  destinationName: 'My Threads Account',
  destinationExternalId: 'th-123',
  destinationAvatarUrl: null,
  destinationHandle: 'mythreads',
  destinationPlatform: 'threads',
  accountName: 'My Threads Account',
  sourcePlatform: 'instagram',
  sourceUsername: 'creator_one',
  sourceLink: 'https://www.instagram.com/creator_one',
  sourceIdentity: '@creator_one',
  timezone: 'Asia/Karachi',
  postsPerDay: 2,
  scheduleType: 'dailyrandom',
  postingTimes: [],
  status: 'active',
  syncStatus: 'synced',
  displayStatus: 'Active',
  alert: null,
  followersCount: 1000,
  followersGained: 1250,
  createdAt: '2026-10-20T00:00:00.000Z',
  postedCount: 10,
  pendingCount: 3,
  failedCount: 1,
  postedToday: 2,
  pendingToday: 1,
  failedToday: 0,
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

describe('ThreadsAduDetailPage', () => {
  let configOverrides: Record<string, unknown> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    configOverrides = {};
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (String(url).includes('/reels')) return jsonResponse({ reels: [] });
      if (String(url).includes('/failed')) return jsonResponse({ jobs: [] });
      if (init?.method) return jsonResponse({ ok: true });
      return jsonResponse({ config: { ...CONFIG, ...configOverrides } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turning automation off writes paused, never inactive', async () => {
    render(<ThreadsAduDetailPage subdomain="acme" configId="cfg-1" />);
    await screen.findByText('My Threads Account');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[1]?.method === 'PATCH' && !String(c[0]).includes('/reels')
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body as string)).toEqual({ status: 'paused' });
    });
  });

  it.each(['invalid_token', 'completed', 'fb_rate_limited'])(
    'locks the toggle for %s',
    async (status) => {
      configOverrides = { status, displayStatus: status };
      render(<ThreadsAduDetailPage subdomain="acme" configId="cfg-1" />);
      await screen.findByText('My Threads Account');
      expect(screen.getByRole('switch')).toBeDisabled();
    }
  );

  it('shows the decided creator-suspended copy, not the stale source-change copy', async () => {
    configOverrides = {
      status: 'creator_suspended',
      displayStatus: 'Creator suspended',
      alert:
        'This source is unavailable after too many download failures. Change the source in Settings, then reactivate.',
    };
    render(<ThreadsAduDetailPage subdomain="acme" configId="cfg-1" />);
    await screen.findByText('My Threads Account');
    expect(screen.getByText(/more than 50 failed downloads/i)).toBeTruthy();
    expect(screen.getByText(/Turn automation on to check/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Change the source in Settings');
  });

  it('marks a new status with colour + icon + text', async () => {
    configOverrides = {
      status: 'missing_page_access',
      displayStatus: 'Missing page access',
      alert: 'The account no longer has access to this page.',
    };
    render(<ThreadsAduDetailPage subdomain="acme" configId="cfg-1" />);
    const mark = await screen.findByTestId('adu-detail-status-mark');
    expect(mark.getAttribute('data-status')).toBe('critical');
    expect(mark.textContent).toContain('Missing page access');
    expect(screen.getByText('The account no longer has access to this page.')).toBeTruthy();
  });
});
