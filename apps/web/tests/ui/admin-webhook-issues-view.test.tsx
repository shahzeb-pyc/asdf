import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AdminWebhookIssuesView } from '@/components/billing/admin-webhook-issues-view';

/**
 * Admin webhook issues view (audit fix 2026-11-01, fix 22): unknown,
 * mismatched, underpaid, and refunded crypto payments surface here
 * for an admin decision. Empty list renders nothing; dismiss posts
 * and reloads; a load error before data renders nothing.
 */

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'issue-1',
    provider: 'nowpayments',
    providerPaymentId: 'np-1',
    paymentId: 'payment-1',
    reason: 'unknown_payment',
    detail: 'No subscription payment matched.',
    dismissedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AdminWebhookIssuesView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the list is empty', async () => {
    mockedApiGet.mockResolvedValue({ issues: [] });
    const { container } = render(<AdminWebhookIssuesView subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    expect(container.querySelector('section[aria-label="Webhook issues"]')).toBeNull();
  });

  it('lists issues with reason labels and dismisses one', async () => {
    mockedApiGet
      .mockResolvedValueOnce({
        issues: [
          issue(),
          issue({ id: 'issue-2', reason: 'underpaid', providerPaymentId: 'np-2' }),
        ],
      })
      .mockResolvedValueOnce({ issues: [] });
    mockedApiPost.mockResolvedValue({});
    render(<AdminWebhookIssuesView subdomain="acme" />);
    expect(await screen.findByText('Webhook issues (2)')).toBeInTheDocument();
    expect(screen.getByText('Unknown payment')).toBeInTheDocument();
    expect(screen.getByText('Underpaid — held for admin decision')).toBeInTheDocument();
    expect(screen.getByText(/nowpayments payment np-1/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/webhook-issues',
        { issueId: 'issue-1' }
      )
    );
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalledTimes(2));
  });

  it('labels every issue reason, including the refunded fallback', async () => {
    mockedApiGet.mockResolvedValue({
      issues: [
        issue({ id: 'i-1', reason: 'amount_mismatch', providerPaymentId: 'np-a' }),
        issue({ id: 'i-2', reason: 'currency_mismatch', providerPaymentId: 'np-b' }),
        issue({ id: 'i-3', reason: 'coupon_released_before_finish', providerPaymentId: 'np-c' }),
        issue({ id: 'i-4', reason: 'refunded', providerPaymentId: 'np-d' }),
      ],
    });
    render(<AdminWebhookIssuesView subdomain="acme" />);
    expect(await screen.findByText('Webhook issues (4)')).toBeInTheDocument();
    expect(screen.getByText('Amount does not match the payment')).toBeInTheDocument();
    expect(screen.getByText('Currency does not match the payment')).toBeInTheDocument();
    expect(screen.getByText('Coupon released before payment finished')).toBeInTheDocument();
    expect(screen.getByText('Refunded after activation — period revoked')).toBeInTheDocument();
  });

  it('shows an error when dismiss fails', async () => {
    mockedApiGet.mockResolvedValue({ issues: [issue()] });
    mockedApiPost.mockRejectedValue(new Error('dismiss down'));
    render(<AdminWebhookIssuesView subdomain="acme" />);
    await screen.findByText('Webhook issues (1)');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(mockedApiPost).toHaveBeenCalled());
    expect(await screen.findByText('dismiss down')).toBeInTheDocument();
  });

  it('renders nothing when the load fails before any data', async () => {
    mockedApiGet.mockRejectedValue(new Error('boom'));
    const { container } = render(<AdminWebhookIssuesView subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    // The error alert only shows once data exists; with no data the
    // section hides entirely rather than crashing the admin page.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('section[aria-label="Webhook issues"]')).toBeNull();
  });
});
