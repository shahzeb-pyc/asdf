/**
 * Facebook ADU detail page rebuild tests.
 *
 * The rebuilt detail page matches the Pages dedicated section: a capped
 * centred container, a 56px avatar header with a coloured status mark,
 * URL-driven sticky tabs, grouped Overview tiles with formatted values,
 * a per-status alert banner, and a single Discover button. Behavioural
 * coverage only: every test asserts something a regression would break.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const pushMock = vi.fn();
const replaceMock = vi.fn();
let mockTab: string | null = null;

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('next/image', () => ({
  default: ({ src, alt, ...props }: { src: string; alt: string }) => (
    <img src={src} alt={alt} {...props} />
  ),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === 'tab' ? mockTab : null),
    toString: () => (mockTab ? `tab=${mockTab}` : ''),
  }),
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

import { AduDetailPage } from '@/components/auto-download-upload/adu-detail-page';
import { resolveAduDetailTab } from '@/components/auto-download-upload/adu-detail-page';

const fetchMock = vi.fn();

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    destinationId: 'dest-1',
    destinationName: 'Ellie Blossom',
    destinationExternalId: '432724216597352',
    destinationAvatarUrl: null,
    accountName: 'Shahzeb Malik',
    accountAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'sdf',
    sourceLink: 'https://www.tiktok.com/@sdf',
    sourceIdentity: '@sdf',
    timezone: 'Asia/Karachi',
    postsPerDay: 2,
    scheduleType: 'dailyrandom',
    postingTimes: [],
    status: 'active',
    syncStatus: 'synced',
    displayStatus: 'Active posting',
    alert: null,
    followersCount: 23000,
    followersGained: 23108,
    createdAt: '2026-02-11T00:00:00.000Z',
    postedCount: 12,
    pendingCount: 5,
    failedCount: 3,
    postedToday: 1,
    pendingToday: 1,
    failedToday: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function installFetch(configOverrides: Record<string, unknown> = {}) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method) return jsonResponse({});
    if (url.includes('/reels')) return jsonResponse({ reels: [] });
    if (url.includes('/failed')) return jsonResponse({ jobs: [] });
    return jsonResponse({ config: makeConfig(configOverrides) });
  });
}

function renderDetail() {
  return render(<AduDetailPage subdomain="acme" configId="cfg-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTab = null;
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('resolveAduDetailTab', () => {
  it('returns the tab for a known value', () => {
    expect(resolveAduDetailTab('reels')).toBe('reels');
  });
  it('falls back to overview for a missing value', () => {
    expect(resolveAduDetailTab(null)).toBe('overview');
  });
  it('falls back to overview for an unknown value', () => {
    expect(resolveAduDetailTab('bogus')).toBe('overview');
  });
});

describe('header', () => {
  it('shows initials when there is no avatar photo', async () => {
    installFetch();
    renderDetail();
    expect(await screen.findByTestId('adu-detail-avatar-initials')).toHaveTextContent('EB');
  });

  it('shows the photo when an avatar URL exists, and falls back to initials on error', async () => {
    installFetch({ destinationAvatarUrl: 'https://example.com/avatar.jpg' });
    renderDetail();
    const img = await screen.findByTestId('adu-detail-avatar-img');
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
    fireEvent.error(img);
    expect(await screen.findByTestId('adu-detail-avatar-initials')).toHaveTextContent('EB');
  });

  it('shows the account photo beside Connected via when an account avatar URL exists', async () => {
    installFetch({ accountAvatarUrl: 'https://example.com/account.jpg' });
    renderDetail();
    const img = await screen.findByTestId('adu-detail-account-avatar-img');
    expect(img).toHaveAttribute('src', 'https://example.com/account.jpg');
    expect(screen.getByText('Connected via Shahzeb Malik')).toBeInTheDocument();
  });

  it('shows account initials beside Connected via when there is no account avatar photo', async () => {
    installFetch();
    renderDetail();
    expect(await screen.findByTestId('adu-detail-account-avatar')).toHaveTextContent('SM');
  });

  it('falls back to account initials when the account photo fails to load', async () => {
    installFetch({ accountAvatarUrl: 'https://example.com/account.jpg' });
    renderDetail();
    const img = await screen.findByTestId('adu-detail-account-avatar-img');
    fireEvent.error(img);
    expect(await screen.findByTestId('adu-detail-account-avatar')).toHaveTextContent('SM');
  });

  it('formats followers with separators and shows +N gained only when nonzero', async () => {
    installFetch();
    renderDetail();
    expect(await screen.findByText('23,108')).toBeInTheDocument();
    expect(screen.getByText('+108 gained')).toBeInTheDocument();
  });

  it('hides the gained line when net gained is zero', async () => {
    installFetch({ followersGained: 23000 });
    renderDetail();
    await screen.findByText('23,000');
    expect(screen.queryByText(/gained$/)).toBeNull();
  });

  it('never renders the Internal ID line', async () => {
    installFetch();
    renderDetail();
    await screen.findByRole('heading', { name: 'Ellie Blossom' });
    expect(screen.queryByText(/Internal ID/)).toBeNull();
    expect(screen.queryByText('432724216597352')).toBeNull();
  });

  it('links the breadcrumb to the hub', async () => {
    installFetch();
    renderDetail();
    const link = await screen.findByRole('link', { name: 'Auto Download/Upload' });
    expect(link).toHaveAttribute('href', '/tenant/acme/auto-download-upload');
  });
});

describe('status alert banner', () => {
  it('shows the rate-limit banner with its recovery copy', async () => {
    installFetch({ status: 'fb_rate_limited', displayStatus: 'Rate limited' });
    renderDetail();
    expect(await screen.findByText('Facebook Rate Limited')).toBeInTheDocument();
    expect(screen.getByText(/about 3 days/)).toBeInTheDocument();
  });

  it('shows the scrape-pending banner while the page status itself is active', async () => {
    installFetch({ syncStatus: 'pending', displayStatus: 'Scrape pending' });
    renderDetail();
    expect(await screen.findByText('Scraping Pending')).toBeInTheDocument();
    expect(screen.getByText(/will be scraped soon/)).toBeInTheDocument();
  });

  it('shows no banner when active and synced', async () => {
    installFetch();
    renderDetail();
    await screen.findByRole('heading', { name: 'Total Statistics' });
    expect(screen.queryByText('Facebook Rate Limited')).toBeNull();
    expect(screen.queryByText('Scraping Pending')).toBeNull();
  });
});

describe('overview groups', () => {
  it('groups tiles under Total and Today headings with formatted values', async () => {
    installFetch();
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Total Statistics' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Today's Statistics" })).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('108')).toBeInTheDocument();
  });
});

describe('tabs', () => {
  it('defaults to overview with no ?tab=', async () => {
    installFetch();
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Total Statistics' })).toBeInTheDocument();
  });

  it('opens the tab named by ?tab=', async () => {
    mockTab = 'reels';
    installFetch();
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Downloaded Queue' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Total Statistics' })).toBeNull();
  });

  it('falls back to overview and normalises an unknown ?tab=', async () => {
    mockTab = 'bogus';
    installFetch();
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Total Statistics' })).toBeInTheDocument();
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        expect.stringContaining('tab=overview'),
        expect.objectContaining({ scroll: false })
      );
    });
  });

  it('pushes the new tab into the URL on click', async () => {
    const user = userEvent.setup();
    installFetch();
    renderDetail();
    await screen.findByRole('heading', { name: 'Total Statistics' });
    await user.click(screen.getByRole('tab', { name: 'Reels' }));
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        expect.stringContaining('tab=reels'),
        expect.objectContaining({ scroll: false })
      );
    });
  });
});

describe('reels tab', () => {
  it('has exactly one Discover button and it POSTs discover', async () => {
    const user = userEvent.setup();
    mockTab = 'reels';
    installFetch();
    renderDetail();
    const discover = await screen.findByRole('button', { name: 'Discover reels' });
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    await user.click(discover);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/reels'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'discover' }),
        })
      );
    });
  });
});

describe('loading state', () => {
  it('renders the skeleton while loading', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderDetail();
    expect(screen.getByTestId('adu-detail-loading')).toBeInTheDocument();
  });
});

describe('automation toggle (ADU statuses)', () => {
  async function patchBody(): Promise<Record<string, unknown> | null> {
    let found: Record<string, unknown> | null = null;
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH'
      );
      expect(call).toBeTruthy();
      found = JSON.parse((call![1] as { body: string }).body);
    });
    return found;
  }

  it('turning automation off writes paused, never inactive', async () => {
    installFetch();
    renderDetail();
    await screen.findByRole('heading', { name: 'Total Statistics' });
    fireEvent.click(screen.getByRole('switch'));
    expect(await patchBody()).toEqual({ status: 'paused' });
  });

  it('turning automation on from paused writes active', async () => {
    installFetch({ status: 'paused', displayStatus: 'Paused' });
    renderDetail();
    await screen.findByText('Posting Paused');
    fireEvent.click(screen.getByRole('switch'));
    expect(await patchBody()).toEqual({ status: 'active' });
  });

  it.each(['invalid_token', 'completed', 'fb_rate_limited'])(
    'locks the toggle for %s',
    async (status) => {
      installFetch({ status, displayStatus: status });
      renderDetail();
      await screen.findByRole('heading', { name: 'Total Statistics' });
      expect(screen.getByRole('switch')).toBeDisabled();
    }
  );

  it('shows the paused banner', async () => {
    installFetch({ status: 'paused', displayStatus: 'Paused' });
    renderDetail();
    expect(await screen.findByText('Posting Paused')).toBeInTheDocument();
    expect(screen.getByText(/Turn automation on to resume/)).toBeInTheDocument();
  });

  it('shows the missing page access banner with the admin-role recovery', async () => {
    installFetch({ status: 'missing_page_access', displayStatus: 'Missing page access' });
    renderDetail();
    expect(await screen.findByText('Missing Page Access')).toBeInTheDocument();
    expect(screen.getByText(/restore your role in Business Manager/)).toBeInTheDocument();
  });

  it('shows the missing permission banner with the admin-grant recovery', async () => {
    installFetch({ status: 'missing_permission', displayStatus: 'Missing permission' });
    renderDetail();
    expect(await screen.findByText('Missing Permission')).toBeInTheDocument();
    expect(screen.getByText(/grant the permission/)).toBeInTheDocument();
  });

  it('shows the creator-suspended banner with the all-time 50 rule and no source change', async () => {
    installFetch({ status: 'creator_suspended', displayStatus: 'Creator suspended' });
    renderDetail();
    expect(await screen.findByText('Source Creator Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/more than 50 failed downloads/)).toBeInTheDocument();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
    expect(screen.queryByText(/Update Settings > Source/)).toBeNull();
    expect(screen.getByText(/Turn automation on to check/)).toBeInTheDocument();
  });

  it('shows the account-suspended banner with toggle recovery, never reconnect', async () => {
    installFetch({ status: 'account_suspended', displayStatus: 'Account suspended' });
    renderDetail();
    expect(await screen.findByText('Facebook Account Suspended')).toBeInTheDocument();
    expect(screen.getByText(/turn automation back on/)).toBeInTheDocument();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it('shows the check-developer-app banner with toggle recovery, never reconnect', async () => {
    installFetch({ status: 'check_developer_app', displayStatus: 'Check developer app' });
    renderDetail();
    expect(await screen.findByText('Developer App Access Blocked')).toBeInTheDocument();
    expect(screen.getByText(/Fix the problem in your developer app/)).toBeInTheDocument();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it('marks a new status with colour + icon + text, never a bare dot', async () => {
    installFetch({ status: 'missing_page_access', displayStatus: 'Missing page access' });
    renderDetail();
    const mark = await screen.findByTestId('adu-detail-status-mark');
    expect(mark).toHaveAttribute('data-status', 'critical');
    expect(mark).toHaveTextContent('Missing page access');
  });

  it('marks paused as queued', async () => {
    installFetch({ status: 'paused', displayStatus: 'Paused' });
    renderDetail();
    const mark = await screen.findByTestId('adu-detail-status-mark');
    expect(mark).toHaveAttribute('data-status', 'queued');
    expect(mark).toHaveTextContent('Paused');
  });
});
