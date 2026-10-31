/**
 * @file refund-section.test.tsx
 * @description Behavioural tests for the My Plan refund section:
 * the button appears only when the server says eligible, a pending
 * request shows its status instead, and the form carries the
 * manual-check copy and submits the same-method destination.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { RefundSection } from '@/components/billing/refund-section';

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

const eligibleData = {
  requests: [],
  eligibility: {
    eligible: true,
    reason: null,
    paymentId: 'payment-1',
    periodId: 'period-1',
    amountPaid: 4200,
    currency: 'PKR',
    estimatedRefund: 3780,
    daysUsed: 3,
    destinationType: 'mobile',
    windowEndsAt: '2026-10-08T00:00:00.000Z',
  },
};

const pendingData = {
  requests: [
    {
      id: 'refund-1',
      userId: 'user-1',
      paymentId: 'payment-1',
      periodId: 'period-1',
      periodStartsAt: '2026-10-01T00:00:00.000Z',
      status: 'requested',
      amountPaid: 4200,
      currency: 'PKR',
      refundAmount: null,
      daysUsed: null,
      destinationType: 'mobile',
      destinationValue: '03001234567',
      destinationNetwork: null,
      reason: null,
      requestedAt: '2026-10-04T00:00:00.000Z',
      decidedAt: null,
      sentAt: null,
    },
  ],
  eligibility: {
    eligible: false,
    reason: 'A refund request for this payment is already waiting for a decision.',
    paymentId: null,
    periodId: null,
    amountPaid: null,
    currency: null,
    estimatedRefund: null,
    daysUsed: null,
    destinationType: null,
    windowEndsAt: null,
  },
};

const ineligibleData = {
  requests: [],
  eligibility: {
    eligible: false,
    reason: 'Upgrades cannot be refunded. Only a first purchase can be refunded.',
    paymentId: null,
    periodId: null,
    amountPaid: null,
    currency: null,
    estimatedRefund: null,
    daysUsed: null,
    destinationType: null,
    windowEndsAt: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RefundSection', () => {
  it('shows the request button and estimate only when eligible', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Request refund')).toBeTruthy();
    expect(screen.getByText(/Estimated refund: 3780 PKR/)).toBeTruthy();
  });

  it('renders nothing when not eligible and no requests exist', async () => {
    mockedApiGet.mockResolvedValue(ineligibleData);
    const { container } = render(<RefundSection subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    // The loading skeleton is replaced by nothing.
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('shows a pending request status instead of the button', async () => {
    mockedApiGet.mockResolvedValue(pendingData);
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Waiting for a decision')).toBeTruthy();
    expect(
      screen.getByText(/Your plan stays active while this request is waiting/)
    ).toBeTruthy();
    expect(screen.queryByText('Request refund')).toBeNull();
  });

  it('submits the same-method destination with the manual-check copy', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-new' } });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    expect(
      await screen.findByText(
        'Refunds go to the same account you paid from. We check it manually against your payment screenshot before sending.'
      )
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Mobile number you paid from'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByText('Submit refund request'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/refunds',
        expect.objectContaining({
          paymentId: 'payment-1',
          destination: { type: 'mobile', value: '03001234567', network: null },
        })
      )
    );
  });
});
