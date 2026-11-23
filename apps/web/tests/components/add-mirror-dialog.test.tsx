/** @vitest-environment jsdom */
/**
 * Add Auto Repost dialog: rebuilt on the Add Page flow's pieces.
 * Pins the parity: shared account picker rows (avatar fallback,
 * "N pages linked", expired dimmed with Reconnect), rich
 * single-select page rows with search, the header back arrow, the
 * rose error banner, and the selected-page row on the username step.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: (...args: unknown[]) => apiGetMock(...args),
      post: (...args: unknown[]) => apiPostMock(...args),
    },
  };
});

import { AddMirrorDialog } from '@/components/tiktok/add-mirror-dialog';
import { httpError } from '@/lib/api/errors';

const activeAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  fbAccountId: 'fb_user_1',
  displayName: 'Sarah Connor',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: null,
  connectedPagesCount: 2,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const expiredAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  fbAccountId: 'fb_user_2',
  displayName: 'John Doe',
  profilePictureUrl: null,
  status: 'expired',
  tokenExpiresAt: null,
  connectedPagesCount: 1,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

const alphaPage = {
  fbPageId: '749557154917108',
  pageName: 'Alpha Page',
  profilePictureUrl: null,
  category: 'Tech',
  followersCount: 12000,
  isImported: false,
};

const betaPage = {
  fbPageId: '123456789012345',
  pageName: 'Beta Bakery',
  profilePictureUrl: null,
  category: 'Food',
  followersCount: 350,
  isImported: false,
};

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AddMirrorDialog subdomain="acme" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange };
}

/** How many times the dialog called discover. */
function discoverCallCount() {
  return apiGetMock.mock.calls.filter(
    ([path]) => typeof path === 'string' && path.includes('/pages/discover'),
  ).length;
}

/**
 * Spec 227: script the discover call to fail the first `times` calls
 * with `status` (and, for a 429, `retryAfterSeconds`), then succeed.
 * Lets a test prove a transient failure recovers by retry instead
 * of erroring, and that a failure that never clears is tried exactly
 * DISCOVER_MAX_ATTEMPTS (3) times.
 */
function mockDiscoverTransient(status: number, times: number, retryAfterSeconds = 1) {
  let discoverCalls = 0;
  apiGetMock.mockImplementation((path: string) => {
    if (path.includes('/pages/discover')) {
      discoverCalls += 1;
      if (discoverCalls <= times) {
        return Promise.reject(
          httpError(status, 'Too many requests. Please wait 1 seconds before trying again.', {
            cause: { error: 'Too many requests.', retryAfterSeconds },
          })
        );
      }
      return Promise.resolve({ pages: [alphaPage, betaPage] });
    }
    return Promise.resolve({ accounts: [activeAccount, expiredAccount] });
  });
}

describe('AddMirrorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes('/pages/discover')) {
        return Promise.resolve({ pages: [alphaPage, betaPage] });
      }
      return Promise.resolve({ accounts: [activeAccount, expiredAccount] });
    });
    apiPostMock.mockResolvedValue({
      mirror: { id: '44444444-4444-4444-a444-444444444444' },
      immediatePost: { attempted: false },
    });
  });

  it('shows rich account rows and keeps expired accounts unpickable', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByTestId('select-account-list')).toBeTruthy();
    expect(screen.getByText('Sarah Connor')).toBeTruthy();
    expect(screen.getByText('2 pages linked')).toBeTruthy();
    // Expired: dimmed row with a Reconnect action, not a pickable row.
    expect(screen.getByTestId(`expired-account-${expiredAccount.id}`)).toBeTruthy();
    expect(screen.getByText('1 page linked · Session expired')).toBeTruthy();
    expect(
      screen.getByTestId(`reconnect-account-${expiredAccount.id}`)
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`select-account-${expiredAccount.id}`)
    ).toBeNull();

    await user.click(screen.getByTestId(`select-account-${activeAccount.id}`));
    expect(await screen.findByTestId('add-mirror-pages-list')).toBeTruthy();
    expect(screen.getByText('Select Facebook Page')).toBeTruthy();
  });

  it('shows rich page rows, filters by search, and advances on click', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    expect(await screen.findByTestId('add-mirror-pages-list')).toBeTruthy();
    expect(screen.getByText('Alpha Page')).toBeTruthy();
    expect(screen.getByText('Tech • 12,000 followers · Page ID …917108')).toBeTruthy();
    expect(screen.getByText('Beta Bakery')).toBeTruthy();

    await user.type(
      screen.getByTestId('add-mirror-page-search-input'),
      'bakery'
    );
    await waitFor(() => {
      expect(screen.queryByText('Alpha Page')).toBeNull();
    });
    expect(screen.getByText('Beta Bakery')).toBeTruthy();

    await user.clear(screen.getByTestId('add-mirror-page-search-input'));
    await user.click(
      await screen.findByTestId(`add-mirror-page-${alphaPage.fbPageId}`)
    );
    expect(await screen.findByTestId('add-mirror-username-input')).toBeTruthy();
    // The username step confirms with the same avatar row, not a text line.
    expect(screen.getByText('Tech • 12,000 followers · Page ID …917108')).toBeTruthy();
    expect(screen.getByTestId('add-mirror-connect-btn')).toBeDisabled();

    await user.type(screen.getByTestId('add-mirror-username-input'), 'alice');
    expect(screen.getByTestId('add-mirror-connect-btn')).toBeEnabled();
  });

  it('goes back via the header arrow, not a body button', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    expect(await screen.findByTestId('add-mirror-pages-list')).toBeTruthy();
    expect(screen.queryByText('Back to accounts')).toBeNull();
    await user.click(screen.getByTestId('add-mirror-back-to-accounts'));
    expect(await screen.findByTestId('select-account-list')).toBeTruthy();
  });

  it('shows a duplicate error in the banner, not as bare text', async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValue(
      httpError(409, 'Mirror already exists', { code: 'DUPLICATE_MIRROR' })
    );
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    await user.click(
      await screen.findByTestId(`add-mirror-page-${alphaPage.fbPageId}`)
    );
    await user.type(screen.getByTestId('add-mirror-username-input'), 'alice');
    await user.click(screen.getByTestId('add-mirror-connect-btn'));
    const banner = await screen.findByTestId('add-mirror-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toMatch(/already reposted/);
  });

  it('a 429 once then success resolves with pages instead of erroring (spec 227)', async () => {
    const user = userEvent.setup();
    mockDiscoverTransient(429, 1, 1);
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    // The 429'd discover recovers on retry: its pages join the list
    // and no error renders — one transient failure never blocks the
    // dialog, with no manual Retry clicked.
    expect(await screen.findByTestId('add-mirror-pages-list', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Alpha Page')).toBeTruthy();
    expect(screen.getByText('Beta Bakery')).toBeTruthy();
    expect(screen.queryByTestId('add-mirror-error')).toBeNull();
    // Exactly two discover calls: the failed first attempt + the retry.
    expect(discoverCallCount()).toBe(2);
  });

  it('a transient 500 once then success resolves with pages (spec 227)', async () => {
    const user = userEvent.setup();
    mockDiscoverTransient(500, 1);
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    expect(await screen.findByTestId('add-mirror-pages-list', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Alpha Page')).toBeTruthy();
    expect(screen.queryByTestId('add-mirror-error')).toBeNull();
    expect(discoverCallCount()).toBe(2);
  });

  it('an auth-dead 403 is not retried and keeps the connection message (spec 227)', async () => {
    const user = userEvent.setup();
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes('/pages/discover')) {
        return Promise.reject(httpError(403, 'Forbidden'));
      }
      return Promise.resolve({ accounts: [activeAccount, expiredAccount] });
    });
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    const banner = await screen.findByTestId('add-mirror-error');
    expect(banner.textContent).toMatch(/check the account connection/);
    // A dead token is tried exactly once — retrying it cannot help.
    expect(discoverCallCount()).toBe(1);
  });

  it('a 429 that never clears ends in the busy message, not the connection message (spec 227)', async () => {
    const user = userEvent.setup();
    mockDiscoverTransient(429, 5, 1);
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    const banner = await screen.findByTestId('add-mirror-error', {}, { timeout: 5000 });
    expect(banner.textContent).toMatch(/Facebook was busy/);
    expect(banner.textContent).not.toMatch(/check the account connection/);
    expect(screen.queryByText(/check the account connection/)).toBeNull();
    // Exactly three attempts: initial + two retries, then it stops.
    expect(discoverCallCount()).toBe(3);
  });

  it('the dialog stays in "Finding Facebook Pages..." through a retry (spec 227)', async () => {
    const user = userEvent.setup();
    mockDiscoverTransient(429, 1, 2);
    renderDialog();
    await user.click(
      await screen.findByTestId(`select-account-${activeAccount.id}`)
    );
    // The wait covers the retry: still discovering, no pages list
    // yet, and no error — the step must not error or render while
    // the retry is still in flight.
    expect(screen.getByTestId('add-mirror-discovering-state')).toBeTruthy();
    expect(screen.queryByTestId('add-mirror-pages-list')).toBeNull();
    expect(screen.queryByTestId('add-mirror-error')).toBeNull();
    // Once the retry lands, the pages render.
    expect(await screen.findByTestId('add-mirror-pages-list', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Alpha Page')).toBeTruthy();
  });
});
