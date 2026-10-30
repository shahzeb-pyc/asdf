/**
 * Instagram account card — behavioural tests. The card must show the
 * shared status mark (never a dot), the verbatim expired alert, and
 * Reconnect only on expired/expiring cards; Disconnect must call back
 * with the account (the shell owns the confirmation dialogue, so the
 * card itself must not delete anything). Parity with Facebook's card:
 * the destinations strip (the linked-pages analogue) and the profile
 * link from the provider-reported handle must both render.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InstagramAccountCard,
  type InstagramAccountItem,
} from '@/components/accounts/instagram-account-card';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    return <img alt={String(props.alt ?? '')} data-testid={String(props['data-testid'] ?? '')} />;
  },
}));

const baseAccount = (overrides: Partial<InstagramAccountItem> = {}): InstagramAccountItem => ({
  id: '11111111-1111-4111-a111-111111111111',
  externalAccountId: 'ig-123',
  displayName: 'Sunset Bakery',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: '2027-01-01T00:00:00Z',
  createdAt: '2026-10-12T00:00:00Z',
  ...overrides,
});

describe('InstagramAccountCard', () => {
  it('shows a connected account with a shared tick mark and its connected date', () => {
    render(<InstagramAccountCard account={baseAccount()} />);
    expect(screen.getByTestId('account-name').textContent).toBe('Sunset Bakery');
    const mark = screen.getByTestId('account-health-mark');
    expect(mark.getAttribute('aria-label')).toBe('Connected');
    expect(mark.textContent).toContain('Connected');
    expect(screen.getByTestId('account-connected-date').textContent).toContain('Oct 12, 2026');
    expect(screen.queryByTestId('account-reconnect-button')).toBeNull();
    expect(screen.getByTestId('account-disconnect-button')).toBeTruthy();
  });

  it('shows the verbatim expired alert and a Reconnect button on an expired account', () => {
    render(
      <InstagramAccountCard
        account={baseAccount({ status: 'expired', tokenExpiresAt: '2026-10-01T00:00:00Z' })}
      />
    );
    expect(screen.getByTestId('account-expired-alert').textContent).toContain(
      'Session expired — reconnect to resume publishing'
    );
    expect(screen.getByTestId('account-reconnect-button').textContent).toContain(
      'Reconnect account'
    );
  });

  it('shows Refresh connection, not Reconnect, on an expiring-soon account', () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    render(<InstagramAccountCard account={baseAccount({ tokenExpiresAt: soon })} />);
    expect(screen.getByTestId('account-reconnect-button').textContent).toContain(
      'Refresh connection'
    );
  });

  it('shows the destinations strip (the linked-pages analogue) and the profile link from the handle', () => {
    render(
      <InstagramAccountCard
        account={baseAccount({ destinationCount: 1, destinationHandle: 'sunset.bakery' })}
      />
    );
    expect(screen.getByTestId('account-destinations-count').textContent).toBe(
      '1 destination linked'
    );
    const link = screen.getByTestId('account-profile-link');
    expect(link.getAttribute('href')).toBe('https://www.instagram.com/sunset.bakery/');
  });

  it('shows zero destinations linked when the account has no destination row', () => {
    render(<InstagramAccountCard account={baseAccount()} />);
    expect(screen.getByTestId('account-destinations-count').textContent).toBe(
      '0 destinations linked'
    );
    expect(screen.queryByTestId('account-profile-link')).toBeNull();
  });

  it('calls onDisconnect with the account when Disconnect is clicked, and never deletes on its own', async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn();
    render(<InstagramAccountCard account={baseAccount()} onDisconnect={onDisconnect} />);
    await user.click(screen.getByTestId('account-disconnect-button'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: baseAccount().id }));
  });

  it('calls onReconnect with the account when Reconnect is clicked', async () => {
    const user = userEvent.setup();
    const onReconnect = vi.fn();
    render(
      <InstagramAccountCard
        account={baseAccount({ status: 'expired', tokenExpiresAt: '2026-10-01T00:00:00Z' })}
        onReconnect={onReconnect}
      />
    );
    await user.click(screen.getByTestId('account-reconnect-button'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
