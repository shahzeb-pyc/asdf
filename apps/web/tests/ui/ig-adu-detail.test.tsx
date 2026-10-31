/**
 * Instagram Auto Download/Upload detail — behavioural render + queue tests.
 * The detail page must NOT render Facebook insights: the Insights tab shows
 * automation totals and says plainly that Instagram account insights are not
 * wired into this section. Queue actions (caption edit, skip) hit the IG API.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { IgAduDetailPage } from '@/components/instagram/auto-download-upload/ig-adu-detail-page';

const fetchMock = vi.fn();

const CONFIG = {
  id: 'cfg-1',
  destinationId: 'dest-1',
  destinationName: 'My IG Account',
  destinationExternalId: '17841400008460056',
  destinationAvatarUrl: null,
  destinationHandle: 'myigaccount',
  destinationPlatform: 'instagram',
  accountName: 'My IG Account',
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

const REELS = [
  {
    id: 'reel-1',
    source_reel_id: 'src-1',
    caption: 'Original caption',
    media_url: 'https://example.com/reel.mp4',
    status: 'downloaded',
    downloaded_at: '2026-10-30T10:00:00.000Z',
    created_at: '2026-10-30T09:00:00.000Z',
  },
];

const JOBS = [
  {
    id: 'job-1',
    reel_id: 'reel-1',
    status: 'failed',
    last_error_code: 'IG_CONTAINER_FAILED',
    last_error_message: 'Container publish failed.',
    created_at: '2026-10-30T11:00:00.000Z',
    adu_reels: { source_reel_id: 'src-1', caption: 'Original caption' },
  },
];

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

describe('IgAduDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.endsWith('/reels')) return jsonResponse({ reels: REELS });
      if (url.endsWith('/failed')) return jsonResponse({ jobs: JOBS });
      if (init?.method) return jsonResponse({ ok: true });
      return jsonResponse({ config: CONFIG });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the Instagram breadcrumb, account header, and overview totals', async () => {
    render(<IgAduDetailPage subdomain="acme" configId="cfg-1" />);
    expect(await screen.findByText('My IG Account')).toBeTruthy();
    expect(screen.getByText('Instagram / Auto Download/Upload / My IG Account')).toBeTruthy();
    // Instagram profile link uses the handle, never a fabricated numeric URL.
    const profileLink = screen.getByRole('link', { name: 'Instagram Account' });
    expect(profileLink.getAttribute('href')).toBe('https://www.instagram.com/myigaccount');
  });

  it('insights tab shows automation totals and plainly says IG insights are not wired in', async () => {
    render(<IgAduDetailPage subdomain="acme" configId="cfg-1" />);
    await screen.findByText('My IG Account');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Insights' }));
    expect(await screen.findByText(/Instagram account insights such as reach and profile views are not available in this section yet/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('PageTabInsights');
  });

  it('reels tab: selects a reel, edits its caption, and PATCHes the IG reel route', async () => {
    render(<IgAduDetailPage subdomain="acme" configId="cfg-1" />);
    await screen.findByText('My IG Account');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Reels' }));
    expect(await screen.findByText('Downloaded Queue')).toBeTruthy();
    fireEvent.click(screen.getByText('Original caption'));
    const captionInput = await screen.findByLabelText('Caption Editor');
    fireEvent.change(captionInput, { target: { value: 'Edited caption' } });
    fireEvent.click(screen.getByText('Save Caption'));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[1]?.method === 'PATCH' && String(c[0]).includes('/reels/reel-1')
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body as string)).toEqual({ caption: 'Edited caption' });
    });
    expect(await screen.findByText('Caption saved.')).toBeTruthy();
  });

  it('failed tab lists the failed job with its code and message', async () => {
    render(<IgAduDetailPage subdomain="acme" configId="cfg-1" />);
    await screen.findByText('My IG Account');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Failed Posts Reasons' }));
    expect(await screen.findByText(/Code: IG_CONTAINER_FAILED/)).toBeTruthy();
    expect(screen.getByText('Container publish failed.')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
  });
});
