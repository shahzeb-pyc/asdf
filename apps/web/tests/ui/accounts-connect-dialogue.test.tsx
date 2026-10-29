/**
 * @file accounts-connect-dialogue.test.tsx
 * @description Option B connected-dialogue redesign: named toasts with
 * no pages text, persistent mismatch banner copy, magic success page
 * param cases, no waiting-view pulse dot, and the gold card highlight.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  AccountCard,
  type FacebookAccountItem,
} from '@/components/accounts/account-card';
import { MagicLinkView } from '@/components/accounts/connect-account-modal';
import {
  getConnectSuccessCopy,
  ConnectSuccessView,
} from '@/app/connect/facebook/success/page';
import { resolveOAuthRedirectNotice } from '@/components/accounts/accounts-helpers';
import { ACCOUNTS_CONNECT_TOAST_OPTIONS } from '@/app/tenant/[subdomain]/accounts/accounts-shell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => new URLSearchParams(),
}));

const activeAccount: FacebookAccountItem = {
  id: 'acc-123',
  fbAccountId: 'fb-123',
  displayName: 'Shahzeb Malik',
  profilePictureUrl: null,
  status: 'active',
  connectedPagesCount: 2,
  createdAt: '2026-10-01T12:00:00Z',
};

describe('Option B connected dialogue', () => {
  it('waiting view shows countdown text and no pulse dot', () => {
    render(
      <MagicLinkView
        magicUrl="https://example.com/connect/facebook?token=abc"
        remainingSeconds={840}
        copySuccess={false}
        isGeneratingMagic={false}
        onCopyLink={vi.fn()}
        onRegenerateLink={vi.fn()}
      />
    );
    expect(screen.getByText('Waiting for Facebook approval...')).toBeTruthy();
    expect(screen.getByText('Link expires in 14:00')).toBeTruthy();
    expect(screen.queryByTestId('magic-pulse-indicator')).toBeNull();
  });

  it('highlighted card carries the link highlight marker, plain card does not', () => {
    const { rerender } = render(<AccountCard account={activeAccount} />);
    expect(screen.getByTestId('account-card-acc-123').getAttribute('data-highlighted')).toBeNull();
    rerender(<AccountCard account={activeAccount} highlighted />);
    const card = screen.getByTestId('account-card-acc-123');
    expect(card.getAttribute('data-highlighted')).toBe('true');
    expect(card.className).toContain('border-link');
  });

  it('magic success copy: fresh, already-connected, mismatch, and legacy no-param cases', () => {
    expect(getConnectSuccessCopy({ accountName: 'Shahzeb Malik' })).toEqual({
      variant: 'success',
      title: 'Shahzeb Malik connected',
      description:
        "You're all set! You can close this tab and return to your FBUploadPro dashboard.",
    });
    expect(
      getConnectSuccessCopy({ alreadyConnected: true, accountName: 'Shahzeb Malik' }).title
    ).toBe('Shahzeb Malik already connected — session refreshed');
    const mismatch = getConnectSuccessCopy({
      reconnectedMismatch: true,
      newAccountName: 'Daily Grind',
      expectedAccountName: 'Shahzeb Malik',
    });
    expect(mismatch.variant).toBe('error');
    // BL2 fix: the mismatched account IS connected as a separate account.
    expect(`${mismatch.title} ${mismatch.description}`).toBe(
      'Daily Grind is now connected as a separate account. Shahzeb Malik still needs to be reconnected. Open your FBUploadPro dashboard, go to Facebook Accounts, and use Reconnect on Shahzeb Malik.'
    );
    expect(getConnectSuccessCopy({}).title).toBe('Facebook account connected');
    // No confirmation copy anywhere mentions pages.
    for (const copy of [
      getConnectSuccessCopy({ accountName: 'Shahzeb Malik' }),
      getConnectSuccessCopy({ alreadyConnected: true, accountName: 'Shahzeb Malik' }),
      mismatch,
    ]) {
      expect(`${copy.title} ${copy.description}`).not.toMatch(/pages? linked/i);
    }
  });

  it('magic success view renders the mismatch case with a cross variant, not success', () => {
    render(
      <ConnectSuccessView
        params={{
          reconnectedMismatch: true,
          newAccountName: 'Daily Grind',
          expectedAccountName: 'Shahzeb Malik',
        }}
      />
    );
    expect(screen.getByTestId('magic-connect-success').getAttribute('data-variant')).toBe(
      'error'
    );
    expect(
      screen.getByText('Daily Grind is now connected as a separate account.')
    ).toBeTruthy();
    expect(screen.getByTestId('magic-mismatch-dashboard-link')).toBeTruthy();
  });

  it('direct-flow resolver: fresh and already-connected use name + connected only', () => {
    const fresh = resolveOAuthRedirectNotice(
      new URLSearchParams({ connected: '1', accountName: 'Shahzeb Malik' })
    );
    expect(fresh?.notice).toEqual({ type: 'success', message: 'Shahzeb Malik connected' });
    expect(fresh?.accountName).toBe('Shahzeb Malik');
    expect(fresh?.keysToRemove).toContain('accountName');
    const already = resolveOAuthRedirectNotice(
      new URLSearchParams({ connected: 'already', accountName: 'Shahzeb Malik' })
    );
    expect(already?.notice).toEqual({
      type: 'success',
      message: 'Shahzeb Malik already connected — session refreshed',
    });
    const mismatch = resolveOAuthRedirectNotice(
      new URLSearchParams({
        reconnected_mismatch: '1',
        newAccountName: 'Daily Grind',
        expectedAccountName: 'Shahzeb Malik',
      })
    );
    // Persistent banner copy (shell renders it dismissible, never auto-dismissed).
    // BL2 fix: connected-as-separate copy plus a Reconnect action for
    // the expected account — never a plain failure with no action.
    expect(mismatch?.notice).toEqual({
      type: 'error',
      message:
        'Daily Grind is now connected as a separate account. Shahzeb Malik still needs to be reconnected.',
      reconnectExpected: true,
      expectedAccountName: 'Shahzeb Malik',
    });
  });

  it('connect success toast is visibly green: green tint + green border, green tick text', () => {
    const classNames = ACCOUNTS_CONNECT_TOAST_OPTIONS.classNames;
    expect(classNames).toBeDefined();
    const success = classNames?.success ?? '';
    const toast = classNames?.toast ?? '';
    expect(success).toContain('bg-brand-emerald');
    expect(success).toContain('border-brand-emerald');
    expect(success).toContain('text-brand-emerald');
    // Sonner joins classes without deduping, so the base toast slot must
    // not carry a conflicting panel bg / line border.
    expect(toast).toContain('bg-brand-emerald');
    expect(toast).toContain('border-brand-emerald');
    expect(toast).not.toContain('bg-panel');
    expect(toast).not.toContain('border-line');
  });
});
