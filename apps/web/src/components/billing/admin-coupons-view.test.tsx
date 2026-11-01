import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminCouponsView } from './admin-coupons-view';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

describe('AdminCouponsView coupon code input', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiPatch.mockReset();
    apiGet.mockResolvedValue({ coupons: [], page: 1 });
    apiPost.mockResolvedValue({});
  });

  it('uppercases a lowercase code as it is typed and submits it uppercase', async () => {
    const user = userEvent.setup();
    render(<AdminCouponsView subdomain="test" />);
    await waitFor(() =>
      expect(screen.getByText('Create a coupon')).toBeInTheDocument()
    );
    const input = screen.getByLabelText('Code');
    await user.type(input, 'save20');
    // Typed lowercase becomes uppercase in the input value itself.
    expect(input).toHaveValue('SAVE20');
    await user.click(screen.getByRole('button', { name: 'Create coupon' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(
      '/tenant/test/billing/admin/coupons',
      expect.objectContaining({ code: 'SAVE20' })
    );
    await waitFor(() =>
      expect(screen.getByText('Coupon SAVE20 created.')).toBeInTheDocument()
    );
  });

  it('uppercases a pasted lowercase code', async () => {
    const user = userEvent.setup();
    render(<AdminCouponsView subdomain="test" />);
    await waitFor(() =>
      expect(screen.getByText('Create a coupon')).toBeInTheDocument()
    );
    const input = screen.getByLabelText('Code');
    await user.click(input);
    await user.paste('save20');
    expect(input).toHaveValue('SAVE20');
  });
});
