/**
 * Audit BG17 — a disconnect failure must be visible INSIDE the
 * dialog, which stays open on failure, not only in the
 * page-level banner behind the overlay.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DisconnectAccountDialog } from '@/components/accounts/disconnect-account-dialog';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

const account: FacebookAccountItem = {
  id: 'acc-123',
  fbAccountId: 'fb-123',
  displayName: 'Shahzeb Malik',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 1,
  connectedPages: [{ id: 'page-1', pageName: 'Test Page' }],
  createdAt: '2026-10-01T12:00:00Z',
};

describe('DisconnectAccountDialog failure visibility (BG17)', () => {
  it('renders the failure message inside the dialog when error is set', () => {
    render(
      <DisconnectAccountDialog
        account={account}
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        error="Couldn't disconnect account. Please refresh and try again."
      />
    );
    const banner = screen.getByTestId('disconnect-error');
    expect(banner.textContent).toContain("Couldn't disconnect account");
    expect(banner.getAttribute('role')).toBe('alert');
    // The confirm action is still available for a retry.
    expect(screen.getByTestId('disconnect-confirm-btn')).toBeTruthy();
  });

  it('renders no error region when there is no failure', () => {
    render(
      <DisconnectAccountDialog
        account={account}
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.queryByTestId('disconnect-error')).toBeNull();
  });
});
