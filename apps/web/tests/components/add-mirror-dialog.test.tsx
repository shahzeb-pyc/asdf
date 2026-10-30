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
});
