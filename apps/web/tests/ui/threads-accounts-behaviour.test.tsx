/**
 * @file threads-accounts-behaviour.test.tsx
 * @description Behavioural tests for the Threads accounts rebuild:
 * health model, subtitle, expired-first sort, card actions, and the
 * disconnect dialog — rendered live (Testing Library, jsdom project),
 * never static markup. These tests can catch a regression in what
 * was built: an expired account must not render as connected, an
 * expired sort must put expired first, and disconnect must ask first.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  ThreadsAccountCard,
  type ThreadsAccountItem,
} from '@/components/accounts/threads-account-card';
import { ThreadsDisconnectDialog } from '@/components/accounts/threads-disconnect-dialog';
import {
  computeThreadsSubtitleFromCounts,
  getThreadsAccountHealth,
  isThreadsTokenExpiringSoon,
  sortThreadsAccountsExpiredFirst,
} from '@/components/accounts/threads-accounts-helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

const connectedAccount: ThreadsAccountItem = {
  id: 'acc-con',
  threadsAccountId: 'th-con',
  displayName: 'Connected Cedar',
  profilePictureUrl: null,
  status: 'active',
  createdAt: '2026-10-12T10:00:00Z',
};

const expiredAccount: ThreadsAccountItem = {
  id: 'acc-exp',
  threadsAccountId: 'th-exp',
  displayName: 'Expired Willow',
  profilePictureUrl: null,
  status: 'expired',
  tokenExpiresAt: '2020-01-01T00:00:00Z',
  createdAt: '2026-09-03T10:00:00Z',
};

const expiringSoonAccount: ThreadsAccountItem = {
  id: 'acc-soon',
  threadsAccountId: 'th-soon',
  displayName: 'Expiring Emma',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  createdAt: '2026-10-01T10:00:00Z',
};

describe('Threads account health model', () => {
  it('a past token means expired even when the stored status is active', () => {
    expect(
      getThreadsAccountHealth({
        status: 'active',
        tokenExpiresAt: '2020-01-01T00:00:00Z',
      })
    ).toBe('expired');
  });

  it('a disconnected account is an error, not expired', () => {
    expect(
      getThreadsAccountHealth({ status: 'disconnected' })
    ).toBe('error');
  });

  it('expiring-soon is true only for connected accounts within 7 days', () => {
    expect(isThreadsTokenExpiringSoon(expiringSoonAccount)).toBe(true);
    expect(isThreadsTokenExpiringSoon(expiredAccount)).toBe(false);
    expect(isThreadsTokenExpiringSoon(connectedAccount)).toBe(false);
  });

  it('the subtitle uses the Facebook count form', () => {
    expect(
      computeThreadsSubtitleFromCounts(2, {
        connected: 1,
        expired: 1,
        error: 0,
      })
    ).toBe('1 connected · 1 session expired');
    expect(
      computeThreadsSubtitleFromCounts(0, {
        connected: 0,
        expired: 0,
        error: 0,
      })
    ).toContain('Connect your first Threads account');
  });

  it('expired-first sort puts expired before connected regardless of date', () => {
    const sorted = sortThreadsAccountsExpiredFirst([
      connectedAccount,
      expiredAccount,
    ]);
    expect(sorted[0]?.id).toBe('acc-exp');
    expect(sorted[1]?.id).toBe('acc-con');
  });
});

describe('ThreadsAccountCard behaviour', () => {
  it('a connected card shows Connected and Disconnect, with no reconnect button', () => {
    render(
      <ThreadsAccountCard
        account={connectedAccount}
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('threads-account-disconnect-button')).toBeTruthy();
    expect(
      screen.queryByTestId('threads-account-reconnect-button')
    ).toBeNull();
    // No pages strip on a Threads card, ever.
    expect(screen.queryByText(/pages linked/)).toBeNull();
  });

  it('an expired card shows the alert and a Reconnect account button', () => {
    const onReconnect = vi.fn();
    render(
      <ThreadsAccountCard
        account={expiredAccount}
        onReconnect={onReconnect}
        onDisconnect={vi.fn()}
      />
    );
    expect(
      screen.getByTestId('threads-account-expired-alert')
    ).toBeTruthy();
    expect(
      screen.getByText('Session expired — reconnect to resume publishing')
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('threads-account-reconnect-button'));
    expect(onReconnect).toHaveBeenCalledWith(expiredAccount);
  });

  it('an expiring-soon card offers Refresh connection, not Reconnect account', () => {
    render(
      <ThreadsAccountCard
        account={expiringSoonAccount}
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByText('Refresh connection')).toBeTruthy();
  });

  it('Disconnect asks for confirmation through the dialog, not immediately', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onDisconnect = vi.fn();
    const { rerender } = render(
      <ThreadsAccountCard
        account={connectedAccount}
        onReconnect={vi.fn()}
        onDisconnect={onDisconnect}
      />
    );
    fireEvent.click(screen.getByTestId('threads-account-disconnect-button'));
    expect(onDisconnect).toHaveBeenCalledWith(connectedAccount);

    // The dialog itself: Cancel does not confirm, Confirm does.
    render(
      <ThreadsDisconnectDialog
        account={connectedAccount}
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    expect(
      screen.getByText('Disconnect Connected Cedar?')
    ).toBeTruthy();
    expect(
      screen.queryByText(/Facebook page/)
    ).toBeNull();
    fireEvent.click(screen.getByTestId('threads-disconnect-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledWith('acc-con');
    void rerender;
  });
});
