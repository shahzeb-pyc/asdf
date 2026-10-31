import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZERO_PLATFORM_COUNTS, type PlatformCounts } from '@fbuploadpro/contracts';
import { CouponSection } from './coupon-section';

const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiPost: (...args: unknown[]) => apiPost(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

function counts(partial: Partial<PlatformCounts>): PlatformCounts {
  return { ...ZERO_PLATFORM_COUNTS, ...partial };
}

const preview = {
  code: 'SAVE20',
  kind: 'percent_multi' as const,
  percent: 20,
  discountPkr: 140,
  amountDuePkr: 700,
  amountAfterDiscountPkr: 560,
  fullyCovered: false,
};

const fullyCoveredPreview = {
  code: 'POOL1000',
  kind: 'balance' as const,
  percent: null,
  discountPkr: 700,
  amountDuePkr: 700,
  amountAfterDiscountPkr: 0,
  fullyCovered: true,
};

describe('CouponSection', () => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it('applies a code and shows the server-validated discount', async () => {
    const user = userEvent.setup();
    const onAppliedChange = vi.fn();
    apiPost.mockResolvedValue(preview);
    render(
      <CouponSection
        subdomain="test"
        counts={counts({ facebook: 10 })}
        applied={null}
        onAppliedChange={onAppliedChange}
        onActivateZeroDue={() => {}}
        activating={false}
        disabled={false}
      />
    );
    await user.type(screen.getByLabelText('Coupon code'), 'save20');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(
      '/tenant/test/billing/coupons/validate',
      { code: 'save20', counts: counts({ facebook: 10 }) },
      expect.anything()
    );
    await waitFor(() => expect(onAppliedChange).toHaveBeenCalledWith(preview));
  });

  it('shows the server message on a failed apply and keeps the old coupon', async () => {
    const user = userEvent.setup();
    const onAppliedChange = vi.fn();
    apiPost.mockRejectedValue(new Error('This coupon has already been used.'));
    render(
      <CouponSection
        subdomain="test"
        counts={counts({ facebook: 10 })}
        applied={preview}
        onAppliedChange={onAppliedChange}
        onActivateZeroDue={() => {}}
        activating={false}
        disabled={false}
      />
    );
    // The applied coupon is still shown while a different code fails.
    expect(screen.getByText(/SAVE20/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Use a different code'), 'ONCE20');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByText('This coupon has already been used.')).toBeInTheDocument()
    );
    expect(onAppliedChange).not.toHaveBeenCalled();
  });

  it('removes the applied coupon', async () => {
    const user = userEvent.setup();
    const onAppliedChange = vi.fn();
    render(
      <CouponSection
        subdomain="test"
        counts={counts({ facebook: 10 })}
        applied={preview}
        onAppliedChange={onAppliedChange}
        onActivateZeroDue={() => {}}
        activating={false}
        disabled={false}
      />
    );
    expect(screen.getByText(/New amount due: 560 PKR/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove coupon' }));
    expect(onAppliedChange).toHaveBeenCalledWith(null);
  });

  it('offers activation instead of payment when the coupon covers everything', async () => {
    const user = userEvent.setup();
    const onActivateZeroDue = vi.fn();
    render(
      <CouponSection
        subdomain="test"
        counts={counts({ facebook: 10 })}
        applied={fullyCoveredPreview}
        onAppliedChange={() => {}}
        onActivateZeroDue={onActivateZeroDue}
        activating={false}
        disabled={false}
      />
    );
    expect(screen.getByText(/covers the full amount/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Activate plan now' }));
    expect(onActivateZeroDue).toHaveBeenCalledTimes(1);
  });
});
