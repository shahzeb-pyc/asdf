import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminSellersList } from './admin-sellers-list';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
  isApiError: (err: unknown) => err instanceof Error,
}));

function sellersList() {
  return {
    sellers: [
      {
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
    ],
    total: 1,
  };
}

function payoutQueue() {
  return {
    requests: [
      {
        id: 'req-1',
        sellerId: 'seller-1',
        sellerName: 'Ali',
        sellerEmail: 'ali@example.com',
        totalPkr: 1500,
        commissionCount: 2,
        status: 'pending',
        payoutMethod: 'easypaisa',
        payoutAccount: '03270000000',
        requestedAt: '2026-01-05T00:00:00.000Z',
        decidedAt: null,
      },
    ],
    total: 1,
  };
}

function renderList() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminSellersList subdomain="acme" />
    </QueryClientProvider>
  );
}

describe('AdminSellersList', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path.includes('/sellers/payout-requests')) return Promise.resolve(payoutQueue());
      if (path.includes('/sellers')) return Promise.resolve(sellersList());
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it('lists sellers with code, rate, scope, and payable', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Ali')).toBeTruthy());
    expect(screen.getByText(/Code ALI20/)).toBeTruthy();
    expect(screen.getByText(/20% · Every purchase/)).toBeTruthy();
    expect(screen.getByText(/Payable PKR 1,500/)).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Ali/ });
    expect(link.getAttribute('href')).toBe('/tenant/acme/sellers/seller-1');
  });

  it('shows the pending payout queue with decide buttons', async () => {
    renderList();
    await waitFor(() =>
      expect(screen.getByText(/PKR 1,500 · 2 commissions/)).toBeTruthy()
    );
    expect(screen.getByText(/Easypaisa: 03270000000/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('rejects a payout request from the queue', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ ok: true });
    renderList();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    );
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/sellers/payout-requests/req-1',
        { action: 'reject' },
        expect.anything()
      )
    );
  });

  it('asks for confirmation before marking a payout as sent', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ ok: true });
    renderList();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeTruthy()
    );
    await user.click(screen.getByRole('button', { name: 'Mark as sent' }));
    await waitFor(() =>
      expect(screen.getByText('Mark this payout as sent?')).toBeTruthy()
    );
    expect(apiPost).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, I paid it' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/sellers/payout-requests/req-1',
        { action: 'mark-sent' },
        expect.anything()
      )
    );
  });

  it('shows empty states when there are no sellers or requests', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes('/sellers/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.resolve({ sellers: [], total: 0 });
    });
    renderList();
    await waitFor(() => expect(screen.getByText(/No sellers yet/)).toBeTruthy());
    expect(screen.getByText('No pending payout requests.')).toBeTruthy();
  });
});
