/**
 * Muse page — behavioural tests (Media Library only, option B).
 *
 * Counts today by type, day-grouped rows with Folder / No folder
 * and per-row Open links, the empty state, and the loud error +
 * Retry path. The approved user-explanation paragraph is asserted
 * present; "Open Media Library" must not appear as a header action.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MusePage } from '@/components/muse/muse-page';

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();
const mockedApiDelete = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  apiDelete: (...args: unknown[]) => mockedApiDelete(...args),
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

const ACTIVITY = {
  today: { videos: 2, images: 1, total: 3 },
  days: [
    {
      label: 'Today',
      date: '2026-11-03',
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1',
          mediaId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb1',
          mediaType: 'video',
          folderId: null,
          name: 'reel-01.mp4',
          createdAt: '2026-11-03T10:42:00.000Z',
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2',
          mediaId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2',
          mediaType: 'image',
          folderId: 'cccccccc-cccc-4ccc-cccc-ccccccccccc1',
          name: 'cover-01.jpg',
          createdAt: '2026-11-03T11:10:00.000Z',
        },
      ],
    },
    {
      label: 'Yesterday',
      date: '2026-11-02',
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3',
          mediaId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb3',
          mediaType: 'video',
          folderId: null,
          name: 'reel-old.mp4',
          createdAt: '2026-11-02T18:31:00.000Z',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApiGet.mockImplementation((path: string) => {
    if (path.includes('/muse/keys')) return Promise.resolve({ keys: [] });
    return Promise.resolve(ACTIVITY);
  });
});

describe('MusePage', () => {
  it('shows the user explanation, today counts, and day-grouped rows', async () => {
    render(<MusePage subdomain="creatorstack" />);
    expect(
      await screen.findByText(/You tell Muse what you want/)
    ).toBeTruthy();
    expect(screen.getByText(/Today, Muse added 2 videos and 1 images/)).toBeTruthy();
    expect(screen.getByText('reel-01.mp4')).toBeTruthy();
    expect(screen.getByText('cover-01.jpg')).toBeTruthy();
    expect(screen.getByText('reel-old.mp4')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();
    // Folder column: a row with no folder says "No folder", a row
    // with a folder says "Folder" — and the Open link for the
    // foldered row carries the folder query.
    expect(screen.getAllByText('No folder')).toHaveLength(2);
    // The foldered row's own cells say "Folder" (the two table
    // headers also say "Folder", so check the row, not the page).
    expect(
      screen.getByText('cover-01.jpg').closest('tr')?.textContent
    ).toContain('Folder');
    // Link role only: the table headers also read "Open", so a
    // plain text query would count them as well.
    const openLinks = screen.getAllByRole('link', { name: 'Open' });
    expect(openLinks[1].getAttribute('href')).toContain(
      'folder=cccccccc-cccc-4ccc-cccc-ccccccccccc1'
    );
    expect(openLinks[0].getAttribute('href')).toBe('/tenant/creatorstack/media');
    expect(screen.queryByText('Open Media Library')).toBeNull();
  });

  it('shows the empty state when Muse has added nothing', async () => {
    mockedApiGet.mockImplementation((path: string) => {
      if (path.includes('/muse/keys')) return Promise.resolve({ keys: [] });
      return Promise.resolve({
        today: { videos: 0, images: 0, total: 0 },
        days: [],
      });
    });
    render(<MusePage subdomain="creatorstack" />);
    expect(await screen.findByText('No uploads by Muse yet')).toBeTruthy();
    expect(screen.getByText(/Today, Muse added 0 videos and 0 images/)).toBeTruthy();
  });

  it('shows the error and recovers on Retry', async () => {
    mockedApiGet
      .mockRejectedValueOnce(new Error('Activity failed'))
      .mockImplementation((path: string) => {
        if (path.includes('/muse/keys')) return Promise.resolve({ keys: [] });
        return Promise.resolve(ACTIVITY);
      });
    const user = userEvent.setup();
    render(<MusePage subdomain="creatorstack" />);
    expect(await screen.findByText(/Couldn't load today's work/)).toBeTruthy();
    await user.click(screen.getByText('Retry'));
    await waitFor(() =>
      expect(screen.getByText(/Today, Muse added 2 videos and 1 images/)).toBeTruthy()
    );
  });

  it('opens the Connect Muse dialogue from the header button', async () => {
    const user = userEvent.setup();
    render(<MusePage subdomain="creatorstack" />);
    await screen.findByText(/You tell Muse what you want/);
    await user.click(screen.getByText('Connect Muse'));
    expect(await screen.findByText('Create a key for Muse to use your Media Library.')).toBeTruthy();
  });
});
