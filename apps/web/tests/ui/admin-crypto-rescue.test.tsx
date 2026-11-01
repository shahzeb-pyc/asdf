import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AdminApprovalsView } from '@/components/billing/admin-approvals-view';

/**
 * Crypto rescue buttons (audit fix 2026-11-01, fix 15): a pending
 * crypto payment offers Approve crypto / Expire crypto instead of
 * the bank Approve / Reject, and failed/expired crypto payments
 * appear in a Stuck crypto payments section with the same buttons.
 * Deciding posts the rescue decision and shows the matching notice.
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

function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'payment-1',
    userId: 'user-1',
    userEmail: 'buyer@example.com',
    method: 'nowpayments',
    bankMethod: null,
    status: 'pending',
    counts: { facebook: 1, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    amountPkr: 70,
    isUpgrade: false,
    screenshotStorageKey: null,
    nowpaymentsPaymentId: 'np-1',
    nowpaymentsPayAddress: 'TTestAddress',
    nowpaymentsPayAmount: 10,
    nowpaymentsNetwork: 'trc20',
    couponCode: null,
    discountPkr: 0,
    periodId: null,
    approvedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockPayments(payments: Record<string, unknown>[]): void {
  mockedApiGet.mockImplementation(async (path: string) => {
    if (path.includes('webhook-issues')) return { issues: [] };
    return { payments, page: 1, pendingTotal: payments.filter((p) => p['status'] === 'pending').length };
  });
}

describe('AdminApprovalsView crypto rescue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows rescue buttons, not bank buttons, on a pending crypto payment', async () => {
    mockPayments([payment()]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    expect(await screen.findByText('Approve crypto')).toBeInTheDocument();
    expect(screen.getByText('Expire crypto')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve payment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('approving crypto posts approve-crypto and shows the approval notice', async () => {
    mockPayments([payment()]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Approve crypto'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-1',
        { decision: 'approve-crypto' }
      )
    );
    expect(await screen.findByText('Crypto payment approved. The plan starts now and runs for 30 days.')).toBeInTheDocument();
  });

  it('expiring crypto posts expire-crypto and shows the expiry notice', async () => {
    mockPayments([payment()]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Expire crypto'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-1',
        { decision: 'expire-crypto' }
      )
    );
    expect(await screen.findByText('Crypto payment expired. No plan started; any held coupon was released.')).toBeInTheDocument();
  });

  it('bank pending payments show Approve and Reject buttons that post the decision', async () => {
    mockPayments([
      payment({ id: 'payment-bank', method: 'bank', bankMethod: 'easypaisa', status: 'pending' }),
    ]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Approve payment'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-bank',
        { decision: 'approve' }
      )
    );
    fireEvent.click(screen.getByText('Reject payment'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-bank',
        { decision: 'reject' }
      )
    );
  });

  it('lists failed crypto payments in the stuck section with rescue buttons', async () => {
    mockPayments([payment({ id: 'payment-2', status: 'failed' })]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    expect(await screen.findByText('Stuck crypto payments')).toBeInTheDocument();
    expect(screen.getAllByText('Approve crypto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Expire crypto').length).toBeGreaterThan(0);
  });

  it('stuck-section rescue buttons post the rescue decision for the failed payment', async () => {
    mockPayments([payment({ id: 'payment-2', status: 'failed' })]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView subdomain="acme" />);
    await screen.findByText('Stuck crypto payments');
    fireEvent.click(screen.getAllByText('Approve crypto')[0]);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-2',
        { decision: 'approve-crypto' }
      )
    );
    fireEvent.click(screen.getAllByText('Expire crypto')[0]);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/payments/payment-2',
        { decision: 'expire-crypto' }
      )
    );
  });
});
