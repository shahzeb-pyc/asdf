/**
 * Connect outcomes + suspended — behavioural suite (spec 136 PR-136D).
 *
 * Asserts the rebuilt terminal states keep their verbatim copy
 * (spec §3.4), present status as colour + icon + text (OD-3 / UX
 * Rule 27 — the states must read correctly in greyscale, so the icon
 * shape and the text, not the tint, carry the distinction), and carry
 * no inline styles (the surface's inline-style ratchet debit is
 * discharged by this PR).
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import FacebookConnectSuccessPage from '@/app/connect/facebook/success/page';
import { ConnectErrorView, getConnectErrorCopy } from '@/app/connect/facebook/error/page';
import { InstagramConnectSuccessView } from '@/app/connect/instagram/success/page';
import { ThreadsConnectSuccessView } from '@/app/connect/threads/success/page';
import { InstagramConnectErrorView } from '@/app/connect/instagram/error/page';
import { ThreadsConnectErrorView } from '@/app/connect/threads/error/page';
import AccountSuspendedPage from '@/app/account-suspended/page';

describe('connect success page (spec 136 §3.4)', () => {
  it('renders the verbatim success copy inside the success status layout', () => {
    // No params: the param-aware success page falls back to the generic
    // named-less success copy (Option B dialogue); the param variants
    // are pinned in accounts-connect-dialogue.test.tsx.
    render(<FacebookConnectSuccessPage />);
    const region = screen.getByTestId('magic-connect-success');
    expect(region.getAttribute('data-variant')).toBe('success');
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Facebook account connected',
      })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You're all set! You can close this tab and return to your FBUploadPro dashboard."
      )
    ).toBeTruthy();
    expect(screen.getByText('Linked to FBUploadPro via Facebook.')).toBeTruthy();
    // Greyscale distinction: an icon is present alongside the text.
    expect(region.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(screen.getByText('Success')).toBeTruthy();
  });

  it('renders no inline styles', () => {
    const { container } = render(<FacebookConnectSuccessPage />);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });
});

describe('connect error page (spec 136 §3.4, OD-136-4 default map)', () => {
  it('keeps the reason-to-copy mapping verbatim', () => {
    expect(getConnectErrorCopy('cancelled')).toEqual({
      title: 'Connection Canceled',
      description: 'Connection canceled. No changes were made. You can close this tab.',
    });
    expect(getConnectErrorCopy('oauth_failed')).toEqual({
      title: "Couldn't Connect to Facebook",
      description: "Couldn't connect to Facebook. Check your permissions and try again.",
    });
    expect(getConnectErrorCopy('internal_oauth_error')).toEqual(
      getConnectErrorCopy('oauth_failed')
    );
    // BL1 fix: a failed save gets its own copy, never the permissions
    // copy and never the expired-link fallthrough.
    expect(getConnectErrorCopy('account_save_failed')).toEqual({
      title: "Couldn't Save Your Facebook Account",
      description:
        'Facebook approved the connection, but we couldn\u2019t save the account. Nothing was connected. Please try connecting again from your FBUploadPro dashboard.',
    });
    // Audit UX1: distinct failures get their own copy instead of
    // all reading as "link expired".
    expect(getConnectErrorCopy('expired_or_invalid').title).toBe(
      'Connection Link Expired or Invalid'
    );
    expect(getConnectErrorCopy('missing_token').title).toBe('Connection Link Invalid');
    expect(getConnectErrorCopy('app_not_configured').title).toBe(
      'Facebook App Not Configured'
    );
    expect(getConnectErrorCopy('credentials_required').title).toBe(
      'Facebook App Not Configured'
    );
    // Only genuinely unknown reasons fall through to the default copy.
    for (const reason of [null, undefined]) {
      expect(getConnectErrorCopy(reason).title).toBe('Connection Link Expired or Invalid');
    }
  });

  it('renders the error variant with icon + text for each reason', () => {
    const { unmount } = render(<ConnectErrorView reason="cancelled" />);
    const region = screen.getByTestId('magic-connect-error');
    expect(region.getAttribute('data-variant')).toBe('error');
    expect(screen.getByRole('heading', { level: 1, name: 'Connection Canceled' })).toBeTruthy();
    expect(region.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(screen.getByText('Error')).toBeTruthy();
    unmount();

    render(<ConnectErrorView />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Connection Link Expired or Invalid' })
    ).toBeTruthy();
  });

  it('renders no inline styles', () => {
    const { container } = render(<ConnectErrorView reason="oauth_failed" />);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });
});

describe('account suspended page (spec 136 §3.4 / §5.5)', () => {
  it('renders the verbatim copy with a colour + icon + text status line', () => {
    render(<AccountSuspendedPage />);
    const status = screen.getByRole('status', { name: 'Account Suspended' });
    expect(status.getAttribute('data-status')).toBe('critical');
    expect(status.textContent).toContain('Account Suspended');
    expect(status.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Access Restricted' })
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Your account has been suspended. Please contact support to restore access.'
      )
    ).toBeTruthy();
  });

  it('renders no inline styles and no interactive elements', () => {
    const { container } = render(<AccountSuspendedPage />);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
  });
});

/**
 * Instagram/Threads magic outcome pages (spec 208, FB parity).
 *
 * The success pages offer a dashboard link on every variant (the
 * original tab may be closed), and the error pages offer a way
 * forward on every failure except an explicit cancel. The links
 * are relative `/` — the pages are served from the brand's app
 * host, so `/` is the brand gateway host, never fbuploadpro.com
 * on the white label.
 */
describe('instagram/threads magic success pages carry a dashboard back link (spec 208)', () => {
  it('instagram success renders a relative dashboard link on the plain variant', () => {
    render(<InstagramConnectSuccessView params={{}} />);
    const link = screen.getByTestId('instagram-magic-success-dashboard-link');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro dashboard');
  });

  it('instagram success renders a relative dashboard link on the mismatch variant', () => {
    render(
      <InstagramConnectSuccessView
        params={{
          reconnectedMismatch: true,
          newAccountName: 'Sunset Bakery',
          expectedAccountName: 'Old Account',
        }}
      />
    );
    const link = screen.getByTestId('instagram-magic-mismatch-dashboard-link');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro dashboard');
    expect(screen.queryByTestId('instagram-magic-success-dashboard-link')).toBeNull();
  });

  it('threads success renders a relative dashboard link on the plain variant', () => {
    render(<ThreadsConnectSuccessView params={{}} />);
    const link = screen.getByTestId('threads-magic-success-dashboard-link');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro dashboard');
  });

  it('threads success renders a relative dashboard link on the mismatch variant', () => {
    render(
      <ThreadsConnectSuccessView
        params={{
          reconnectedMismatch: true,
          newAccountName: 'Willow',
          expectedAccountName: 'Old Account',
        }}
      />
    );
    const link = screen.getByTestId('threads-magic-mismatch-dashboard-link');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro dashboard');
    expect(screen.queryByTestId('threads-magic-success-dashboard-link')).toBeNull();
  });
});

describe('instagram/threads magic error pages carry a back link except on cancel (spec 208)', () => {
  it('instagram error renders a relative back link on a failure', () => {
    render(<InstagramConnectErrorView reason="oauth_failed" />);
    const link = screen.getByTestId('instagram-magic-connect-error-back');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro');
  });

  it('instagram error renders no back link on an explicit cancel', () => {
    render(<InstagramConnectErrorView reason="cancelled" />);
    expect(screen.queryByTestId('instagram-magic-connect-error-back')).toBeNull();
  });

  it('threads error renders a relative back link on a failure', () => {
    render(<ThreadsConnectErrorView reason="oauth_failed" />);
    const link = screen.getByTestId('threads-magic-connect-error-back');
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent).toContain('Back to FBUploadPro');
  });

  it('threads error renders no back link on an explicit cancel', () => {
    render(<ThreadsConnectErrorView reason="cancelled" />);
    expect(screen.queryByTestId('threads-magic-connect-error-back')).toBeNull();
  });
});
