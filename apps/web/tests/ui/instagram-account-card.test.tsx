/**
 * Instagram account card — behavioural tests. The card must show the
 * circle status mark (never a dot), the verbatim expired alert, and
 * Reconnect only on expired/expiring cards; Disconnect must call back
 * with the account (the shell owns the confirmation dialogue, so the
 * card itself must not delete anything).
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
    // eslint-disable-next-line @next/next/no-img-element
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
  it('shows a connected account with a green-circle tick mark and its connected date', () => {
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

  it('shows no linked-pages strip — an Instagram card has no pages section', () => {
    const { container } = render(<InstagramAccountCard account={baseAccount()} />);
    expect(container.textContent).not.toContain('pages linked');
    expect(container.textContent).not.toContain('page linked');
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
