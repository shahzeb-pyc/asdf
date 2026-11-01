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
