/**
 * @file destination-redirect.test.tsx
 * @description The Destinations pages were removed: the old
 * /tenant/<sub>/destinations/<id> route is now a redirector only.
 * A Facebook destination whose external id matches a page's Facebook
 * page id redirects to that page's dedicated view; anything else
 * (non-Facebook destination, no matching page, lookup failure) redirects
 * to the Pages list — never a 404 for a previously reachable link.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const REDIRECT = Symbol('redirect');
const redirectMock = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { [REDIRECT]: true, url });
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

const serverApiFetchMock = vi.fn();
vi.mock('@/lib/data/server', () => ({
  serverApiFetch: (...args: unknown[]) => serverApiFetchMock(...args),
}));

import DestinationRedirectPage from '@/app/tenant/[subdomain]/destinations/[destinationId]/page';

const FB_DESTINATION = {
  destination: {
    id: 'dest-row-1',
    externalDestinationId: 'fb-page-100',
    name: 'My Brand',
    handle: 'mybrand',
    avatarUrl: null,
    timezone: 'UTC',
    status: 'active',
    accountType: null,
    platform: 'facebook',
    account: { id: 'acct-1', displayName: 'Fixture Creator', platform: 'facebook', status: 'active' },
  },
};

const PAGES = {
  pages: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      facebookAccountId: '22222222-2222-4222-8222-222222222222',
      fbPageId: 'fb-page-100',
      pageName: 'My Brand',
      profilePictureUrl: null,
      category: null,
      timezone: 'UTC',
      startingFollowers: 0,
      currentFollowers: 0,
      followersGained: 0,
      followersCount: 0,
      status: 'active',
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      rateLimitedAt: null,
    },
  ],
  total: 1,
};

async function runRedirect() {
  try {
    await DestinationRedirectPage({
      params: Promise.resolve({ subdomain: 'acme', destinationId: 'dest-row-1' }),
    });
  } catch (error) {
    return (error as { url?: string }).url;
  }
  return undefined;
}

describe('destination redirect', () => {
  beforeEach(() => {
    serverApiFetchMock.mockReset();
    redirectMock.mockClear();
  });

  it('redirects a Facebook destination to its page dedicated view', async () => {
    serverApiFetchMock.mockImplementation((path: string) =>
      path.includes('/accounts/social/')
        ? Promise.resolve(FB_DESTINATION)
        : Promise.resolve(PAGES)
    );
    expect(await runRedirect()).toBe(
      '/tenant/acme/pages/11111111-1111-4111-8111-111111111111'
    );
  });

  it('redirects a non-Facebook destination to the Pages list', async () => {
    serverApiFetchMock.mockImplementation((path: string) =>
      path.includes('/accounts/social/')
        ? Promise.resolve({
            destination: { ...FB_DESTINATION.destination, platform: 'instagram' },
          })
        : Promise.resolve(PAGES)
    );
    expect(await runRedirect()).toBe('/tenant/acme/pages');
  });

  it('finds a page beyond page 1 instead of falling back to the list', async () => {
    // Page 1 is full (50 non-matching rows, 2 pages total); the match
    // sits on page 2. A redirector that only fetched page 1 would
    // wrongly land on the list.
    const page1 = {
      pages: Array.from({ length: 50 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        fbPageId: `fb-other-${i}`,
      })),
      total: 51,
      page: 1,
      limit: 50,
      totalPages: 2,
    };
    const page2 = {
      pages: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          fbPageId: 'fb-page-100',
        },
      ],
      total: 51,
      page: 2,
      limit: 50,
      totalPages: 2,
    };
    serverApiFetchMock.mockImplementation((path: string) => {
      if (path.includes('/accounts/social/')) {
        return Promise.resolve(FB_DESTINATION);
      }
      const pageParam = new URLSearchParams(path.split('?')[1] ?? '').get('page');
      return Promise.resolve(pageParam === '2' ? page2 : page1);
    });
    expect(await runRedirect()).toBe(
      '/tenant/acme/pages/11111111-1111-4111-8111-111111111111'
    );
    expect(
      serverApiFetchMock.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('/pages') &&
          call[0].includes('page=2')
      )
    ).toBe(true);
  });

  it('redirects to the Pages list when no page matches the destination', async () => {
    serverApiFetchMock.mockImplementation((path: string) =>
      path.includes('/accounts/social/')
        ? Promise.resolve(FB_DESTINATION)
        : Promise.resolve({ pages: [], total: 0 })
    );
    expect(await runRedirect()).toBe('/tenant/acme/pages');
  });

  it('redirects to the Pages list when the destination lookup fails', async () => {
    serverApiFetchMock.mockRejectedValue(new Error('not found'));
    expect(await runRedirect()).toBe('/tenant/acme/pages');
  });
});
