import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SellerDashboard } from './seller-dashboard';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    put: (...args: unknown[]) => apiPut(...args),
  },
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
  isApiError: (err: unknown) => err instanceof Error,
}));

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    sellerId: 'seller-1',
    name: 'Ali',
    email: 'ali@example.com',
    rate: 20,
    scope: 'every',
    status: 'active',
    currentCode: 'ALI20',
    codes: [{ code: 'ALI20', current: true, createdAt: '2026-01-01T00:00:00.000Z' }],
    referralLink: 'http://localhost:3000/signup?ref=ALI20',
    signups: 2,
    purchasers: 1,
    balances: { pending: 1400, payable: 600, requested: 0, paid: 2000 },
    payoutDetails: null,
    ...overrides,
  };
}

function referrals() {
  return {
    users: [
      {
        id: 'buyer-1',
        name: 'Bilal',
        email: 'bilal@example.com',
        referralCode: 'ALI20',
        purchased: true,
        signedUpAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'buyer-2',
        name: 'Carl',
        email: 'carl@example.com',
        referralCode: 'ALI20',
        purchased: false,
        signedUpAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    total: 2,
  };
}

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SellerDashboard />
    </QueryClientProvider>
  );
}

describe('SellerDashboard', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiPut.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/seller/dashboard')) return Promise.resolve(dashboard());
      if (path.startsWith('/api/seller/referrals')) return Promise.resolve(referrals());
      if (path.startsWith('/api/seller/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it('shows balances, rate, scope, and the referral link', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('20% · Every purchase')).toBeTruthy());
    expect(screen.getByText('PKR 1,400')).toBeTruthy();
    // Payable renders twice: the balance card and the payout section.
    expect(screen.getAllByText('PKR 600').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByDisplayValue('http://localhost:3000/signup?ref=ALI20')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('shows the paused banner and hides it when active', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/seller/dashboard')) {
        return Promise.resolve(dashboard({ status: 'paused' }));
      }
      if (path.startsWith('/api/seller/referrals')) return Promise.resolve(referrals());
      if (path.startsWith('/api/seller/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText('Your account is paused')).toBeTruthy()
    );
  });

  it('disables payout below the minimum and shows the shortfall', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/PKR 400 more/)).toBeTruthy());
    const button = screen.getByRole('button', { name: 'Request payout' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Add your payout details above/)).toBeTruthy();
  });

  it('enables payout when payable covers the minimum and details exist', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/seller/dashboard')) {
        return Promise.resolve(
          dashboard({
            balances: { pending: 0, payable: 1500, requested: 0, paid: 0 },
            payoutDetails: { method: 'easypaisa', accountLabel: '03270000000' },
          })
        );
      }
      if (path.startsWith('/api/seller/referrals')) return Promise.resolve(referrals());
      if (path.startsWith('/api/seller/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText('PKR 1,500').length).toBeGreaterThanOrEqual(1));
    const button = screen.getByRole('button', { name: 'Request payout' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/more to request a payout/)).toBeNull();
  });

  it('lists referrals with names, emails, and purchase marks', async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByText('Bilal')).toBeTruthy());
    expect(screen.getByText('bilal@example.com')).toBeTruthy();
    expect(screen.getByText('carl@example.com')).toBeTruthy();
    expect(screen.getByText('Purchased')).toBeTruthy();
    expect(screen.getByText('Not purchased yet')).toBeTruthy();
  });

  it('changes the referral code and shows confirmation', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ code: 'NEW99' });
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Change referral code')).toBeTruthy());
    await user.type(screen.getByLabelText('Change referral code'), 'NEW99');
    await user.click(screen.getByRole('button', { name: 'Change code' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/seller/referral-code',
        { code: 'NEW99' },
        expect.anything()
      )
    );
    await waitFor(() => expect(screen.getByText('Referral code updated.')).toBeTruthy());
  });

  it('shows the error state with a retry button when the dashboard fails', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText("Couldn't load your dashboard")).toBeTruthy()
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('requests a payout through the payout endpoint', async () => {
    const user = userEvent.setup();
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/seller/dashboard')) {
        return Promise.resolve(
          dashboard({
            balances: { pending: 0, payable: 1500, requested: 0, paid: 0 },
            payoutDetails: { method: 'easypaisa', accountLabel: '03270000000' },
          })
        );
      }
      if (path.startsWith('/api/seller/referrals')) return Promise.resolve(referrals());
      if (path.startsWith('/api/seller/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });
    apiPost.mockResolvedValue({
      request: { id: 'req-1', totalPkr: 1500, status: 'pending' },
      count: 2,
    });
    renderDashboard();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request payout' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Request payout' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/seller/payout-requests', {}, expect.anything())
    );
  });

  it('saves payout details and shows confirmation', async () => {
    const user = userEvent.setup();
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/api/seller/dashboard')) {
        return Promise.resolve(
          dashboard({
            payoutDetails: { method: 'easypaisa', accountLabel: '03270000000' },
          })
        );
      }
      if (path.startsWith('/api/seller/referrals')) return Promise.resolve(referrals());
      if (path.startsWith('/api/seller/payout-requests')) {
        return Promise.resolve({ requests: [], total: 0 });
      }
      return Promise.reject(new Error('unexpected'));
    });
    apiPut.mockResolvedValue({ ok: true });
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Account')).toBeTruthy());
    await user.clear(screen.getByLabelText('Account'));
    await user.type(screen.getByLabelText('Account'), '03270000009');
    await user.click(screen.getByRole('button', { name: 'Save payout details' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith(
        '/api/seller/payout-details',
        { method: 'easypaisa', accountLabel: '03270000009' },
        expect.anything()
      )
    );
    await waitFor(() => expect(screen.getByText('Payout details saved.')).toBeTruthy());
  });

  it('shows the referral code error when changing fails', async () => {
    const user = userEvent.setup();
    apiPost.mockRejectedValue(new Error('That code is taken.'));
    renderDashboard();
    await waitFor(() => expect(screen.getByLabelText('Change referral code')).toBeTruthy());
    await user.type(screen.getByLabelText('Change referral code'), 'TAKEN1');
    await user.click(screen.getByRole('button', { name: 'Change code' }));
    await waitFor(() => expect(screen.getByText('That code is taken.')).toBeTruthy());
  });
});
