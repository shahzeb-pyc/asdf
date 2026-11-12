/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { CreatorFinderPage } from './creator-finder-page';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string; className?: string }) =>
    React.createElement('img', {
      src: props.src,
      alt: props.alt,
      className: props.className,
    }),
}));

const postMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => getMock(...args),
      post: (...args: unknown[]) => postMock(...args),
      delete: vi.fn(),
    },
  };
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CreatorFinderPage subdomain="creatorstack" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((path: string) => {
    if (path.includes('/creator-finder/saved')) {
      return Promise.resolve({
        creators: [],
        total: 0,
        page: 1,
        pageSize: 30,
        totalPages: 0,
      });
    }
    if (path.includes('/creator-finder/regions')) {
      return Promise.resolve({
        regions: [{ code: 'PK', name: 'Pakistan' }],
        defaultRegion: 'PK',
      });
    }
    if (path.includes('/creator-finder/usage')) {
      return Promise.resolve({ used: 0, limit: 100, date: '2026-11-03' });
    }
    return Promise.resolve({});
  });
});

describe('CreatorFinderPage video and hashtag tabs', () => {
  it('renders tabs in order: Trending, Niche, Similar, Saved, Video, Hashtag', async () => {
    renderPage();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Trending by country',
      'By niche / words',
      'Similar creators',
      'Saved',
      'Video',
      'Hashtag',
    ]);
  });

  it('video check renders a working Download button using download_link', async () => {
    postMock.mockResolvedValue({
      url: 'https://www.tiktok.com/@alice/video/123',
      video: {
        videoId: 'VID1',
        coverUrl: 'https://example.com/cover.jpg',
        creatorHandle: 'alice',
        creatorName: 'Alice Fit',
        description: 'Morning routine',
        postedAt: '2023-11-14T22:13:20.000Z',
        plays: 2700000,
        likes: 190000,
        comments: 6100,
        shares: 2000,
        saves: 7800,
        musicTitle: 'Song Title',
        musicArtist: 'Artist',
        downloadUrl: 'https://example.com/video.mp4',
      },
    });
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Video' }));
    fireEvent.change(screen.getByPlaceholderText('Paste a TikTok video link here'), {
      target: { value: 'https://www.tiktok.com/@alice/video/123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check video' }));
    const download = await screen.findByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe('https://example.com/video.mp4');
    expect(screen.getByText('Morning routine')).toBeTruthy();
    expect(screen.getByText('2,700,000')).toBeTruthy();
    expect(screen.getByText('7,800')).toBeTruthy();
  });

  it('video failure shows a loud error, not an empty result', async () => {
    postMock.mockRejectedValue(
      new ApiError('http', 'That video could not be found. Try a different TikTok video link.', {
        status: 502,
      }),
    );
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Video' }));
    fireEvent.change(screen.getByPlaceholderText('Paste a TikTok video link here'), {
      target: { value: 'https://www.tiktok.com/@alice/video/999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check video' }));
    expect(
      await screen.findByText(
        'That video could not be found. Try a different TikTok video link.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
  });

  it('hashtag generation renders chips and Copy all copies one space-separated line', async () => {
    postMock.mockResolvedValue({
      keyword: 'viral',
      hashtags: ['viral', 'fitness', 'morning'],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Hashtag' }));
    fireEvent.change(screen.getByPlaceholderText('Keyword, for example: viral'), {
      target: { value: 'viral' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate hashtags' }));
    expect(await screen.findByText('#viral')).toBeTruthy();
    expect(screen.getByText('#fitness')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('#viral #fitness #morning'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('hashtag failure shows a loud error, not empty chips', async () => {
    postMock.mockRejectedValue(
      new ApiError('http', 'Hashtags could not be generated. Please try again.', {
        status: 502,
      }),
    );
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Hashtag' }));
    fireEvent.change(screen.getByPlaceholderText('Keyword, for example: viral'), {
      target: { value: 'viral' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate hashtags' }));
    expect(
      await screen.findByText('Hashtags could not be generated. Please try again.'),
    ).toBeTruthy();
  });
});

describe('CreatorFinderPage lazy loading and return-first enrichment (spec 169)', () => {
  function savedCallCount() {
    return getMock.mock.calls.filter((call) =>
      String(call[0]).includes('/creator-finder/saved'),
    ).length;
  }

  it('does not fetch Saved on mount', async () => {
    renderPage();
    await screen.findByText('0 of 100 used today');
    expect(savedCallCount()).toBe(0);
    // The visible Trending tab still loads its own data.
    expect(
      getMock.mock.calls.some((call) =>
        String(call[0]).includes('/creator-finder/regions'),
      ),
    ).toBe(true);
  });

  it('fetches Saved when the Saved tab opens', async () => {
    renderPage();
    await screen.findByText('0 of 100 used today');
    expect(savedCallCount()).toBe(0);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Saved' }));
    await screen.findByText(
      'No saved creators yet. Search trending, niche, or similar creators and they will be saved automatically.',
    );
    expect(savedCallCount()).toBeGreaterThan(0);
  });

  it('shows basic cards first, then fills in details after enrich', async () => {
    const basicCreator = {
      handle: 'alice',
      displayName: 'Alice Fit',
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: 'https://www.tiktok.com/@alice',
    };
    const enrichedCreator = {
      ...basicCreator,
      enrichment: {
        bio: 'Fitness creator',
        followerCount: 12400,
        verified: true,
        hashtags: [],
        mentions: [],
      },
    };
    getMock.mockImplementation((path: string) => {
      if (path.includes('/creator-finder/trending')) {
        return Promise.resolve({ region: 'PK', creators: [basicCreator] });
      }
      if (path.includes('/creator-finder/regions')) {
        return Promise.resolve({
          regions: [{ code: 'PK', name: 'Pakistan' }],
          defaultRegion: 'PK',
        });
      }
      if (path.includes('/creator-finder/usage')) {
        return Promise.resolve({ used: 0, limit: 100, date: '2026-11-03' });
      }
      if (path.includes('/creator-finder/saved')) {
        return Promise.resolve({
          creators: [],
          total: 0,
          page: 1,
          pageSize: 30,
          totalPages: 0,
        });
      }
      return Promise.resolve({});
    });
    let resolveEnrich: (value: {
      creators: unknown[];
      saveFailed: boolean;
    }) => void = () => {};
    postMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnrich = resolve;
        }),
    );
    renderPage();
    await screen.findByText('0 of 100 used today');
    await screen.findByDisplayValue('Pakistan');
    fireEvent.click(
      screen.getByRole('button', { name: 'Find trending creators' }),
    );
    await screen.findByText('@alice');
    expect(
      screen.getByText('Details unavailable for this creator.'),
    ).toBeTruthy();
    resolveEnrich({ creators: [enrichedCreator], saveFailed: false });
    await screen.findByText('Fitness creator');
    expect(screen.getByText('12.4K followers')).toBeTruthy();
    expect(
      screen.queryByText('Details unavailable for this creator.'),
    ).toBeNull();
    expect(
      postMock.mock.calls.some((call) =>
        String(call[0]).includes('/creator-finder/enrich'),
      ),
    ).toBe(true);
  });

  it('a niche keyword over 200 chars still enriches without the save-failed banner (spec 169 verification B2)', async () => {
    const keyword = 'a'.repeat(201);
    const basicCreator = {
      handle: 'alice',
      displayName: 'Alice Fit',
      avatarUrl: null,
      latestVideoTitle: null,
      latestVideoCover: null,
      profileUrl: 'https://www.tiktok.com/@alice',
    };
    const enrichedCreator = {
      ...basicCreator,
      enrichment: {
        bio: 'Fitness creator',
        followerCount: 12400,
        verified: true,
        hashtags: [],
        mentions: [],
      },
    };
    getMock.mockImplementation((path: string) => {
      if (path.includes('/creator-finder/niche')) {
        return Promise.resolve({ keyword, creators: [basicCreator] });
      }
      if (path.includes('/creator-finder/regions')) {
        return Promise.resolve({
          regions: [{ code: 'PK', name: 'Pakistan' }],
          defaultRegion: 'PK',
        });
      }
      if (path.includes('/creator-finder/usage')) {
        return Promise.resolve({ used: 0, limit: 100, date: '2026-11-03' });
      }
      if (path.includes('/creator-finder/saved')) {
        return Promise.resolve({
          creators: [],
          total: 0,
          page: 1,
          pageSize: 30,
          totalPages: 0,
        });
      }
      return Promise.resolve({});
    });
    postMock.mockResolvedValue({
      creators: [enrichedCreator],
      saveFailed: false,
    });
    renderPage();
    await screen.findByText('0 of 100 used today');
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'By niche / words' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. fitness'), {
      target: { value: keyword },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find creators' }));
    await screen.findByText('Fitness creator');
    expect(screen.queryByText("Couldn't save creators")).toBeNull();
    const enrichCall = postMock.mock.calls.find((call) =>
      String(call[0]).includes('/creator-finder/enrich'),
    );
    expect(enrichCall).toBeDefined();
    expect(
      (enrichCall?.[1] as { searchTerm: string }).searchTerm,
    ).toHaveLength(200);
  });
});
