import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SellerSidebar } from './seller-sidebar';
import { SidebarProvider } from '@/components/shared/ui/sidebar';

const apiPost = vi.fn();
const reportError = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
  },
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
  isApiError: (err: unknown) => err instanceof Error,
}));

vi.mock('@/lib/report-error', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/seller',
}));

function renderSidebar() {
  return render(
    <SidebarProvider>
      <SellerSidebar user={{ name: 'Ali', email: 'ali@example.com' }} />
    </SidebarProvider>
  );
}

describe('SellerSidebar', () => {
  beforeEach(() => {
    apiPost.mockReset();
    reportError.mockReset();
    apiPost.mockResolvedValue({ redirectUrl: '/login?logout=success' });
  });

  it('shows the seller header, the Dashboard leaf, and the user footer', () => {
    renderSidebar();
    expect(screen.getByText('FBUploadPro')).toBeTruthy();
    expect(screen.getByText('Seller')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByText('Ali')).toBeTruthy();
    expect(screen.getByText('ali@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('signs out through the logout endpoint', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/auth/logout', undefined, expect.anything())
    );
  });

  it('still leaves on sign-out failure, but reports it loudly', async () => {
    const user = userEvent.setup();
    apiPost.mockRejectedValue(new Error('logout failed'));
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(reportError).toHaveBeenCalled());
  });
});
