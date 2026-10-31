import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminSellerDetail } from './admin-seller-detail';

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const apiPost = vi.fn();
const push = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
  isApiError: (err: unknown) => err instanceof Error,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

function detail(overrides: Record<string, unknown> = {}) {
  return {
    seller: {
      id: 'seller-1',
      name: 'Ali',
      email: 'ali@example.com',
      currentCode: 'ALI20',
      rate: 20,
      scope: 'every',
      status: 'active',
      signups: 2,
      purchasers: 1,
      payablePkr: 1500,
      paidPkr: 2000,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    codes: [{ code: 'ALI20', current: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    balances: { pending: 0, payable: 1500, requested: 0, paid: 2000 },
    commissions: [
      {
        id: 'c-1',
        buyerName: 'Bilal',
        buyerEmail: 'bilal@example.com',
        paymentId: 'pay-1',
        periodStartsAt: '2026-01-01T00:00:00.000Z',
        rate: 20,
        scope: 'every',
        amountPkr: 1400,
        status: 'payable',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    payoutRequests: [],
    referredUsers: [
      {
        id: 'buyer-1',
        name: 'Bilal',
        email: 'bilal@example.com',
        referralCode: 'ALI20',
        purchased: true,
        signedUpAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    referredTotal: 1,
    ...overrides,
  };
}

function renderDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminSellerDetail subdomain="acme" sellerId="seller-1" />
    </QueryClientProvider>
  );
}

describe('AdminSellerDetail', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPatch.mockReset();
    apiDelete.mockReset();
    apiPost.mockReset();
    push.mockReset();
    apiGet.mockResolvedValue(detail());
  });

  it('shows profile, balances, commissions, and referrals', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('Ali')).toBeTruthy());
    expect(screen.getByText(/ali@example.com/)).toBeTruthy();
    expect(screen.getByText('PKR 1,500')).toBeTruthy();
    // Bilal appears twice: once as a commission buyer, once as a referral.
    expect(screen.getAllByText('Bilal').length).toBe(2);
    // "Payable" appears as a balance label and as a commission status.
    expect(screen.getAllByText('Payable').length).toBeGreaterThanOrEqual(2);
  });

  it('blocks delete while commissions are unpaid and explains why', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete seller' })).toBeTruthy());
    const button = screen.getByRole('button', { name: 'Delete seller' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Delete is blocked until every commission is paid out/)).toBeTruthy();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('saves a rate change through the patch endpoint', async () => {
    apiPatch.mockResolvedValue({ ok: true });
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('Commission %')).toBeTruthy());
    const input = screen.getByLabelText('Commission %') as HTMLInputElement;
    // fireEvent, not user.clear: user-event's clear reverts on this
    // values-controlled number input in jsdom (the component itself
    // submits correctly, as this change + submit proves).
    fireEvent.change(input, { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/tenant/acme/sellers/seller-1',
        expect.objectContaining({ rate: 15 }),
        expect.anything()
      )
    );
  });

  it('deletes a fully paid-out seller after confirmation and navigates back', async () => {
    const paidOut = detail({
      seller: { ...detail().seller, payablePkr: 0 },
      balances: { pending: 0, payable: 0, requested: 0, paid: 3500 },
    });
    apiGet.mockResolvedValue(paidOut);
    apiDelete.mockResolvedValue({ ok: true });
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete seller' })).toBeTruthy());
    const button = screen.getByRole('button', { name: 'Delete seller' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Delete this seller?')).toBeTruthy());
    // Once the dialog opens, Radix aria-hides the trigger, so the
    // only 'Delete seller' button in the role query is the confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Delete seller' }));
    await waitFor(() =>
      expect(apiDelete).toHaveBeenCalledWith(
        '/api/tenant/acme/sellers/seller-1',
        expect.anything()
      )
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith('/tenant/acme/sellers'));
  });

  it('rejects a payout request from the payout history', async () => {
    const withRequest = detail({
      payoutRequests: [
        {
          id: 'req-1',
          sellerId: 'seller-1',
          sellerName: 'Ali',
          sellerEmail: 'ali@example.com',
          totalPkr: 1400,
          commissionCount: 2,
          status: 'pending',
          payoutMethod: 'easypaisa',
          payoutAccount: '03270000000',
          requestedAt: '2026-01-05T00:00:00.000Z',
          decidedAt: null,
        },
      ],
    });
    apiGet.mockResolvedValue(withRequest);
    apiPost.mockResolvedValue({ ok: true });
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/sellers/payout-requests/req-1',
        { action: 'reject' },
        expect.anything()
      )
    );
  });
});
