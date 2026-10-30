/**
 * @file accounts-behaviour.test.tsx
 * @description Behavioural tests for the spec 131 PR-131-1 rebuilt
 * Accounts components (spec §8.7): filter bar interactions, banner
 * states + actions, empty-state gating, and card actions — rendered
 * live (Testing Library, jsdom project), never static markup.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import {
  ByocRequiredBanner,
  ByocRetryBanner,
  FeedbackBanner,
} from '@/components/accounts/accounts-banners';
import { AccountsEmptyState } from '@/components/accounts/accounts-empty-state';
import {
  AccountCard,
  type FacebookAccountItem,
} from '@/components/accounts/account-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

const expiredAccount: FacebookAccountItem = {
  id: 'acc-exp',
  fbAccountId: 'fb-exp',
  displayName: 'Expired Erin',
  profilePictureUrl: null,
  status: 'expired',
  connectedPagesCount: 2,
  createdAt: '2026-09-15T10:00:00Z',
};

const connectedAccount: FacebookAccountItem = {
  id: 'acc-con',
  fbAccountId: 'fb-con',
  displayName: 'Connected Carl',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  createdAt: '2026-09-15T10:00:00Z',
};

const expiringSoonAccount: FacebookAccountItem = {
  id: 'acc-soon',
  fbAccountId: 'fb-soon',
  displayName: 'Expiring Emma',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  connectedPagesCount: 1,
  createdAt: '2026-09-15T10:00:00Z',
};

const errorAccount: FacebookAccountItem = {
  id: 'acc-err',
  fbAccountId: 'fb-err',
  displayName: 'Error Eddie',
  profilePictureUrl: null,
  status: 'disconnected',
  connectedPagesCount: 1,
  createdAt: '2026-09-15T10:00:00Z',
};

describe('AccountsFilterBar behaviour', () => {
  it('typing updates the search, Escape clears it, and the clear button clears it', () => {
    const onSearchChange = vi.fn();
    render(
      <AccountsFilterBar
        searchQuery="erin"
        onSearchChange={onSearchChange}
        statusFilter="all"
        onStatusFilterChange={vi.fn()}
      />
    );

    const input = screen.getByTestId('accounts-search-input');
    fireEvent.change(input, { target: { value: 'erin b' } });
    expect(onSearchChange).toHaveBeenCalledWith('erin b');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSearchChange).toHaveBeenCalledWith('');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search query' }));
    expect(onSearchChange).toHaveBeenCalledWith('');
  });

  it('status tabs report selection and show the expired attention count', () => {
    const onStatusFilterChange = vi.fn();
    render(
      <AccountsFilterBar
        searchQuery=""
        onSearchChange={vi.fn()}
        statusFilter="all"
        onStatusFilterChange={onStatusFilterChange}
        attentionCount={3}
      />
    );

    expect(screen.getByTestId('accounts-filter-all').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('(3)')).toBeTruthy();

    fireEvent.click(screen.getByTestId('accounts-filter-expired'));
    expect(onStatusFilterChange).toHaveBeenCalledWith('expired');
  });
});

describe('Accounts banners behaviour', () => {
  it('feedback banner dismisses through its dismiss control', () => {
    const onDismiss = vi.fn();
    render(
      <FeedbackBanner
        notice={{ type: 'success', message: 'Jane Smith connected' }}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByTestId('oauth-feedback-banner')).toBeTruthy();
    expect(screen.getByText('Jane Smith connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss banner' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('BL2: mismatch banner states the new account is connected and offers Reconnect for the expected account', () => {
    const onReconnectExpected = vi.fn();
    render(
      <FeedbackBanner
        notice={{
          type: 'error',
          message:
            'Jane Smith is now connected as a separate account. John Doe still needs to be reconnected.',
        }}
        onDismiss={vi.fn()}
        onReconnectExpected={onReconnectExpected}
        expectedAccountName="John Doe"
      />
    );

    // Must not render as a plain failure: the connected-as-separate
    // message and a Reconnect action for the expected account are both
    // required.
    expect(
      screen.getByText(
        'Jane Smith is now connected as a separate account. John Doe still needs to be reconnected.'
      )
    ).toBeTruthy();
    const reconnectBtn = screen.getByTestId('oauth-reconnect-expected-btn');
    expect(reconnectBtn.textContent).toBe('Reconnect John Doe');
    fireEvent.click(reconnectBtn);
    expect(onReconnectExpected).toHaveBeenCalledTimes(1);
  });

  it('BL2: mismatch banner without a reconnect handler renders no reconnect action', () => {
    render(
      <FeedbackBanner
        notice={{ type: 'error', message: 'Something went wrong.' }}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.queryByTestId('oauth-reconnect-expected-btn')).toBeNull();
  });

  it('BYOC retry banner fires its retry action', () => {
    const onRetry = vi.fn();
    render(
      <ByocRetryBanner
        message="Couldn't verify your Facebook App credentials. Please try again."
        onRetry={onRetry}
      />
    );

    expect(screen.getByTestId('byoc-retry-banner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('byoc-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('BYOC required banner links to the workspace settings BYOC tab', () => {
    render(<ByocRequiredBanner subdomain="acme" />);
    const link = screen.getByTestId('byoc-configure-link');
    expect(link.getAttribute('href')).toBe('/tenant/acme/settings?tab=byoc');
    expect(screen.getByText(/Facebook App credentials are required/)).toBeTruthy();
  });
});

describe('AccountsEmptyState behaviour', () => {
  it('connect button fires onConnect when enabled', () => {
    const onConnect = vi.fn();
    render(<AccountsEmptyState onConnect={onConnect} />);
    fireEvent.click(screen.getByTestId('empty-connect-button'));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('connect button is disabled with a reason when credentials are missing', () => {
    const onConnect = vi.fn();
    render(
      <AccountsEmptyState
        onConnect={onConnect}
        isConnectDisabled={true}
        credentialsMissing={true}
        settingsHref="/tenant/acme/settings?tab=byoc"
      />
    );
    const button = screen.getByTestId('empty-connect-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('empty-connect-disabled-reason')).toBeTruthy();
    expect(screen.getByTestId('empty-connect-settings-link').getAttribute('href')).toBe(
      '/tenant/acme/settings?tab=byoc'
    );
  });
});

describe('AccountCard behaviour', () => {
  it('connected card shows a tick and no status dot', () => {
    render(<AccountCard account={connectedAccount} />);

    const mark = screen.getByTestId('account-health-mark');
    expect(mark.textContent).toContain('Connected');
    expect(mark.querySelector('[data-icon="check"]')).toBeTruthy();
    expect(mark.querySelector('.rounded-full')).toBeNull();
  });

  it('expiring-soon card keeps the clock icon and no status dot', () => {
    render(<AccountCard account={expiringSoonAccount} />);

    const mark = screen.getByTestId('account-health-mark');
    // Audit UX: an expiring-soon account says so outright instead of
    // showing a clock next to "Connected".
    expect(mark.textContent).toContain('Expires soon');
    expect(mark.querySelector('[data-icon="clock"]')).toBeTruthy();
    expect(mark.querySelector('.rounded-full')).toBeNull();
  });

  it('expired card shows a cross and no status dot, and fires reconnect/disconnect', () => {
    const onReconnect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <AccountCard
        account={expiredAccount}
        onReconnect={onReconnect}
        onDisconnect={onDisconnect}
      />
    );

    const status = screen.getByTestId('account-health-label');
    expect(status.textContent).toContain('Session expired');
    const mark = screen.getByTestId('account-health-mark');
    expect(mark.querySelector('[data-icon="cross"]')).toBeTruthy();
    expect(mark.querySelector('.rounded-full')).toBeNull();
    expect(screen.getByTestId('account-expired-alert')).toBeTruthy();

    fireEvent.click(screen.getByTestId('account-reconnect-button'));
    expect(onReconnect).toHaveBeenCalledWith(expiredAccount);

    fireEvent.click(screen.getByTestId('account-disconnect-button'));
    expect(onDisconnect).toHaveBeenCalledWith(expiredAccount);
  });

  it('error-health card shows a cross and "Connection error", and fires reconnect/disconnect (BL4)', () => {
    const onReconnect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <AccountCard
        account={errorAccount}
        onReconnect={onReconnect}
        onDisconnect={onDisconnect}
      />
    );

    const status = screen.getByTestId('account-health-label');
    expect(status.textContent).toContain('Connection error');
    const mark = screen.getByTestId('account-health-mark');
    expect(mark.querySelector('[data-icon="cross"]')).toBeTruthy();
    expect(mark.querySelector('.rounded-full')).toBeNull();

    fireEvent.click(screen.getByTestId('account-reconnect-button'));
    expect(onReconnect).toHaveBeenCalledWith(errorAccount);

    fireEvent.click(screen.getByTestId('account-disconnect-button'));
    expect(onDisconnect).toHaveBeenCalledWith(errorAccount);
  });
});
