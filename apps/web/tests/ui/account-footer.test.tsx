import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountFooter } from '@/components/shell/account-footer';

/**
 * Seller/admin account footer sign-out (session-global-check
 * spec §7.2): the footer must run the FULL sign-out sequence —
 * clear client cookies, broadcast logout, POST the server clear,
 * clear the query cache — and fall back to the same-host GET
 * clear endpoint (not straight to /login) when the POST fails.
 * Other tabs' logout broadcasts must redirect here via the
 * storage signal.
 */

let navigatedTo: string | null = null;
const originalLocation = window.location;

function stubLocation(): void {
  navigatedTo = null;
  let currentHref = 'http://localhost:3000/seller';
  const locationStub: Record<string, unknown> = { hostname: 'localhost' };
  Object.defineProperty(locationStub, 'href', {
    get: () => currentHref,
    set: (value: string) => {
      currentHref = value;
      navigatedTo = value;
    },
    configurable: true,
  });
  Object.defineProperty(window, 'location', {
    value: locationStub,
    writable: true,
    configurable: true,
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, 'location', {
    value: originalLocation,
    writable: true,
    configurable: true,
  });
}

let logoutShouldFail = false;
const fetchCalls: Array<{ url: string; method: string }> = [];

function installFetchStub(): void {
  fetchCalls.length = 0;
  logoutShouldFail = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/auth/logout') {
        if (logoutShouldFail) throw new Error('network down');
        return new Response(JSON.stringify({ redirectUrl: '/login?logout=success' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    })
  );
}

function renderFooter(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the cache so the clear is observable.
  queryClient.setQueryData(['probe'], { value: 1 });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountFooter
        user={{ name: 'Seller One', email: 'seller@example.com' }}
        signOutErrorSource="seller-sign-out"
      />
    </QueryClientProvider>
  );
}

describe('AccountFooter sign-out', () => {
  beforeEach(() => {
    stubLocation();
    installFetchStub();
    window.localStorage.clear();
    window.localStorage.setItem('fbup_active_user', JSON.stringify({ email: 'seller@example.com' }));
    window.localStorage.setItem('fbup_theme', 'dark');
  });

  afterEach(() => {
    restoreLocation();
    vi.unstubAllGlobals();
  });

  it('runs the full sequence and redirects to the server URL on success', async () => {
    const user = userEvent.setup();
    renderFooter();
    expect(screen.getByText('Seller One')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(
        true
      );
    });
    // Broadcast removes the stored identity (other tabs read the
    // logout signal); theme is untouched.
    expect(window.localStorage.getItem('fbup_active_user')).toBeNull();
    expect(window.localStorage.getItem('fbup_theme')).toBe('dark');
    await waitFor(() => {
      expect(navigatedTo).toBe('/login?logout=success');
    });
  });

  it('falls back to the same-host GET clear endpoint when the POST fails', async () => {
    logoutShouldFail = true;
    const user = userEvent.setup();
    renderFooter();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(
        true
      );
    });
    // Degraded must still mean logged out afterwards: the fallback
    // lands on the server clear, not straight on /login (where a
    // surviving cookie would bounce the user back home).
    await waitFor(() => {
      expect(navigatedTo).toBe('/api/auth/logout');
    });
  });

  it('redirects when another tab broadcasts logout via storage', async () => {
    renderFooter();
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'fbup_logout_event', newValue: String(Date.now()) })
    );
    await waitFor(() => {
      expect(navigatedTo).toBe('/login?logout=success');
    });
  });

  it('ignores unrelated storage events', async () => {
    renderFooter();
    window.dispatchEvent(new StorageEvent('storage', { key: 'fbup_theme', newValue: 'light' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigatedTo).toBeNull();
  });
});
