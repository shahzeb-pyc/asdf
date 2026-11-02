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
    render(<AdminApprovalsView />);
    expect(await screen.findByText('Approve crypto')).toBeInTheDocument();
    expect(screen.getByText('Expire crypto')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve payment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('approving crypto posts approve-crypto and shows the approval notice', async () => {
    mockPayments([payment()]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView />);
    fireEvent.click(await screen.findByText('Approve crypto'));
    // Decisions now confirm through a dialog first.
    fireEvent.click(await screen.findByRole('button', { name: 'Approve payment' }));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-1',
        { decision: 'approve-crypto' }
      )
    );
    // The view shows the notice both at the top and on the card.
    expect(
      await screen.findAllByText('Crypto payment approved. The plan starts now and runs for 30 days.')
    ).toHaveLength(2);
  });

  it('expiring crypto posts expire-crypto and shows the expiry notice', async () => {
    mockPayments([payment()]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView />);
    fireEvent.click(await screen.findByText('Expire crypto'));
    fireEvent.click(await screen.findByRole('button', { name: 'Expire crypto payment' }));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-1',
        { decision: 'expire-crypto' }
      )
    );
    expect(
      await screen.findAllByText('Crypto payment expired. No plan started; any held coupon was released.')
    ).toHaveLength(2);
  });

  it('bank pending payments show Approve and Reject buttons that post the decision', async () => {
    mockPayments([
      payment({ id: 'payment-bank', method: 'bank', bankMethod: 'easypaisa', status: 'pending' }),
    ]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView />);
    fireEvent.click(await screen.findByText('Approve payment'));
    // This bank payment has no screenshot, so approving through
    // the dialog requires a recorded override reason first.
    fireEvent.change(screen.getByLabelText('Override reason (required)'), {
      target: { value: 'Screenshot verified on file' },
    });
    // The card button and the dialog confirm share a label; the
    // dialog renders after the card, so its button is the last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve payment' }).at(-1)!);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-bank',
        { decision: 'approve', overrideReason: 'Screenshot verified on file' }
      )
    );
    fireEvent.click(screen.getByText('Reject payment'));
    // Reject now requires a reason, chosen in the dialog.
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'Wrong amount' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject payment' }).at(-1)!);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-bank',
        { decision: 'reject', rejectionReason: 'Wrong amount' }
      )
    );
  });

  it('lists failed crypto payments in the stuck section with rescue buttons', async () => {
    mockPayments([payment({ id: 'payment-2', status: 'failed' })]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView />);
    expect(await screen.findByText('Stuck crypto payments')).toBeInTheDocument();
    expect(screen.getAllByText('Approve crypto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Expire crypto').length).toBeGreaterThan(0);
  });

  it('stuck-section rescue buttons post the rescue decision for the failed payment', async () => {
    mockPayments([payment({ id: 'payment-2', status: 'failed' })]);
    mockedApiPost.mockResolvedValue({});
    render(<AdminApprovalsView />);
    await screen.findByText('Stuck crypto payments');
    fireEvent.click(screen.getAllByText('Approve crypto')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve payment' }));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-2',
        { decision: 'approve-crypto' }
      )
    );
    fireEvent.click(screen.getAllByText('Expire crypto')[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Expire crypto payment' }));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-2',
        { decision: 'expire-crypto' }
      )
    );
  });
});

/**
 * Split-build admin coverage: override approval, load-more, screenshot
 * states, refresh, and the decided section — the branches the rescue
 * tests above do not reach.
 */
describe('AdminApprovalsView split-build paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approving a screenshot-less payment requires and posts the override reason', async () => {
    mockPayments([
      payment({
        method: 'bank',
        bankMethod: 'easypaisa',
        screenshotStorageKey: null,
        nowpaymentsPaymentId: null,
        nowpaymentsPayAddress: null,
        nowpaymentsPayAmount: null,
        nowpaymentsNetwork: null,
      }),
    ]);
    render(<AdminApprovalsView />);
    expect(await screen.findByText(/No screenshot attached to this payment/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve payment' }));
    // The dialog confirm stays disabled until the override reason is filled.
    expect(screen.getAllByRole('button', { name: 'Approve payment' }).at(-1)).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Override reason (required)'), {
      target: { value: 'Screenshot verified on file' },
    });
    // The card button and the dialog confirm share a label; the
    // dialog renders after the card, so its button is the last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve payment' }).at(-1)!);
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/admin/payments/payment-1',
        { decision: 'approve', overrideReason: 'Screenshot verified on file' },
      ),
    );
  });

  it('loads more payments and appends page 2', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      payment({ id: `payment-${i + 1}`, userEmail: `buyer${i + 1}@example.com` }),
    );
    mockedApiGet.mockImplementation(async (path: string) => {
      if (path.includes('webhook-issues')) return { issues: [] };
      if (path.includes('page=2')) {
        return { payments: [payment({ id: 'payment-101', userEmail: 'buyer101@example.com' })], page: 2, pendingTotal: 150 };
      }
      return { payments: page1, page: 1, pendingTotal: 150 };
    });
    render(<AdminApprovalsView />);
    expect(await screen.findByText(/Showing 100 of 150/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more payments' }));
    expect(await screen.findByText(/Showing 101 of 150/)).toBeTruthy();
    expect(await screen.findByText('buyer101@example.com')).toBeTruthy();
  });

  it('shows a loaded screenshot preview with an open-full-size link', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => 'blob:mock-screenshot';
    vi.stubGlobal(
      'fetch',
      async () => ({ ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'image/png' }) }),
    );
    mockPayments([
      payment({
        method: 'bank',
        bankMethod: 'easypaisa',
        screenshotStorageKey: 'screenshots/payment-1.png',
        nowpaymentsPaymentId: null,
        nowpaymentsPayAddress: null,
        nowpaymentsPayAmount: null,
        nowpaymentsNetwork: null,
      }),
    ]);
    render(<AdminApprovalsView />);
    expect(await screen.findByText('Open full size')).toBeTruthy();
    URL.createObjectURL = origCreateObjectURL;
    vi.unstubAllGlobals();
  });

  it('refresh reloads the payments list', async () => {
    mockPayments([payment({ userEmail: 'buyer@example.com' })]);
    render(<AdminApprovalsView />);
    expect(await screen.findByText('buyer@example.com')).toBeTruthy();
    const callsBefore = mockedApiGet.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mockedApiGet.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('lists decided payments in the Recently decided section', async () => {
    mockPayments([
      payment({
        id: 'payment-decided',
        status: 'approved',
        method: 'bank',
        bankMethod: 'easypaisa',
        screenshotStorageKey: null,
        nowpaymentsPaymentId: null,
        nowpaymentsPayAddress: null,
        nowpaymentsPayAmount: null,
        nowpaymentsNetwork: null,
        approvedAt: '2026-06-02T00:00:00.000Z',
        decidedAt: '2026-06-02T00:00:00.000Z',
        userEmail: 'decided@example.com',
      }),
    ]);
    render(<AdminApprovalsView />);
    expect(await screen.findByText('Recently decided')).toBeTruthy();
    expect(await screen.findByText('decided@example.com')).toBeTruthy();
    expect(screen.queryByText('No decided payments yet')).toBeNull();
  });
});
