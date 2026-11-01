/**
 * @file account-footer.test.tsx
 * @description Sign-out tests for the shared AccountFooter (shell
 * isolation, spec §9.1) — carried over from the deleted
 * seller-sidebar test, rendering the footer directly.
 *
 * Sign-out must not trap the user: even when the logout API fails,
 * the browser still leaves for the logged-out login page, but the
 * failure is reported loudly (reportError) rather than swallowed.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountFooter } from '@/components/shell/account-footer';
import { api } from '@/lib/api';
import { reportError } from '@/lib/report-error';

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn() },
}));
vi.mock('@/lib/report-error', () => ({
  reportError: vi.fn(),
}));

const mockedPost = vi.mocked(api.post);
const mockedReportError = vi.mocked(reportError);

const USER = { name: 'Ali Khan', email: 'ali@example.com' };

describe('AccountFooter', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    // window.location.href is read-only in jsdom; stub it so the
    // fall-through navigation is observable instead of throwing.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'http://localhost/seller' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('renders the account name, email, and a Sign out control', () => {
    render(<AccountFooter user={USER} signOutErrorSource="seller-sign-out" />);
    expect(screen.getByText('Ali Khan')).toBeTruthy();
    expect(screen.getByText('ali@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('calls the logout endpoint and follows the server redirect', async () => {
    mockedPost.mockResolvedValue({ redirectUrl: '/login?logout=success' });
    render(<AccountFooter user={USER} signOutErrorSource="seller-sign-out" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/auth/logout', undefined, expect.anything()));
    expect(window.location.href).toBe('/login?logout=success');
    expect(mockedReportError).not.toHaveBeenCalled();
  });

  it('still leaves for login on logout failure and reports loudly', async () => {
    mockedPost.mockRejectedValue(new Error('network down'));
    render(<AccountFooter user={USER} signOutErrorSource="admin-sign-out" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(mockedReportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'admin-sign-out',
      })
    );
    expect(window.location.href).toBe('/login?logout=success');
  });
});
