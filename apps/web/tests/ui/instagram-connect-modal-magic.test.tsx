/**
 * Instagram connect modal — magic-link view. The "Different Browser or
 * Phone" option must be ENABLED (an Instagram magic-link route now
 * exists) and clicking it must generate the link and show Facebook's
 * magic view: the link in a read-only input, a copy button, and the
 * 15:00 countdown. The direct view must point at the dedicated
 * Instagram initiate route, not the framework initiate.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiPost = vi.fn();
const apiGet = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  isApiError: (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in (err as Record<string, unknown>)),
}));

import {
  InstagramConnectAccountModal,
  buildInstagramDirectConnectUrl,
} from '@/components/accounts/instagram-connect-account-modal';

describe('InstagramConnectAccountModal magic link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ accounts: [] });
    apiPost.mockResolvedValue({
      success: true,
      magicUrl: 'http://localhost:3000/connect/instagram?token=magic-token-123',
      expiresAt: '2026-10-30T07:00:00.000Z',
      expiresInSeconds: 900,
    });
  });

  function renderModal(props: Record<string, unknown> = {}) {
    return render(
      <InstagramConnectAccountModal
        subdomain="acme"
        open
        onOpenChange={() => undefined}
        onAccountConnected={() => undefined}
        {...props}
      />
    );
  }

  it('shows the magic option enabled (not disabled with a not-available reason)', async () => {
    renderModal();
    const magicButton = screen.getByTestId('instagram-connect-option-magic');
    expect(magicButton).not.toBeDisabled();
    expect(magicButton.textContent).not.toContain("isn't available for Instagram yet");
    expect(magicButton.textContent).toContain('Different Browser or Phone');
  });

  it('generates the magic link and shows the magic view with copy + countdown', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByTestId('instagram-connect-option-magic'));

    expect(apiPost).toHaveBeenCalledWith(
      '/api/tenant/acme/instagram/accounts/magic-link',
      undefined,
      expect.objectContaining({ schema: expect.anything() })
    );
    expect(screen.getByTestId('instagram-magic-url-input')).toHaveValue(
      'http://localhost:3000/connect/instagram?token=magic-token-123'
    );
    expect(screen.getByTestId('instagram-magic-copy-button').textContent).toBe('Copy Link');
    expect(screen.getByTestId('instagram-magic-countdown').textContent).toContain(
      'Link expires in 15:00'
    );
    expect(screen.getByText('Waiting for Instagram approval...')).toBeTruthy();
  });

  it('sends the expected account hint when generating a reconnect magic link', async () => {
    const user = userEvent.setup();
    renderModal({
      reconnectingAccount: {
        id: 'acct-1',
        externalAccountId: 'ig_user_123',
        displayName: 'Sunset Bakery',
        status: 'expired',
      },
    });

    await user.click(screen.getByTestId('instagram-connect-option-magic'));

    expect(apiPost).toHaveBeenCalledWith(
      '/api/tenant/acme/instagram/accounts/magic-link',
      {
        expectedInstagramAccountId: 'ig_user_123',
        expectedDisplayName: 'Sunset Bakery',
      },
      expect.objectContaining({ schema: expect.anything() })
    );
  });

  it('builds the direct connect URL at the dedicated Instagram initiate route', () => {
    expect(buildInstagramDirectConnectUrl()).toBe('/api/auth/instagram');
    expect(
      buildInstagramDirectConnectUrl({
        id: 'acct-1',
        externalAccountId: 'ig_user_123',
        displayName: 'Sunset Bakery',
      })
    ).toBe(
      '/api/auth/instagram?expectedInstagramAccountId=ig_user_123&expectedDisplayName=Sunset+Bakery'
    );
  });
});
