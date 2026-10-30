/**
 * Instagram Accounts page — behavioural render test. Replaces the stale
 * legacy static-render assertion in tests/components/connect-pages.test.tsx,
 * which still asserted the deleted placeholder page (ByocGate +
 * `instagram-connect-link` to `/api/connect/instagram?subdomain=acme`).
 * The page is now the real list shell: header, empty state when no
 * accounts, header Connect button once accounts exist.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  buildUrl: (path: string, query?: Record<string, string | number | null | undefined>) => {
    if (!query) return path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const queryString = params.toString();
    return queryString ? `${path}?${queryString}` : path;
  },
  isApiError: () => false,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ subdomain: 'acme' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}));

import InstagramAccountsPage from '@/app/tenant/[subdomain]/instagram/accounts/page';

const EMPTY_LIST = {
  accounts: [],
  total: 0,
  totalPages: 0,
  page: 1,
  limit: 10,
  healthCounts: { connected: 0, expired: 0, error: 0, expiringSoon: 0 },
};

const CREDENTIALS_CONFIGURED = { appId: 'ig_app_123', hasSecret: true };

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InstagramAccountsPage />
    </QueryClientProvider>
  );
}

describe('InstagramAccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/instagram/accounts')) return Promise.resolve(EMPTY_LIST);
      if (url.includes('/settings/platform-credentials/instagram'))
        return Promise.resolve(CREDENTIALS_CONFIGURED);
      return Promise.reject(new Error(`unexpected api.get: ${url}`));
    });
  });

  it('renders the real list page: header, subtitle, and empty state', async () => {
    renderPage();

    expect(await screen.findByTestId('instagram-accounts-page-title')).toHaveTextContent(
      'Instagram Accounts'
    );
    expect(await screen.findByTestId('instagram-accounts-empty-state')).toBeTruthy();
    expect(await screen.findByText('Connect your first Instagram account')).toBeTruthy();
    expect(screen.getByTestId('instagram-empty-connect-button')).toBeTruthy();
    // The old placeholder is gone: no testing notice, no ByocGate
    // connect link to the framework initiate route.
    expect(document.body.textContent).not.toContain('instagram-connect-link');
    expect(document.body.textContent).not.toContain('Being tested');
  });

  it('shows the header Connect Instagram button once accounts exist', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/instagram/accounts'))
        return Promise.resolve({
          ...EMPTY_LIST,
          accounts: [
            {
              id: 'acct-1',
              externalAccountId: 'ig_user_123',
              displayName: 'Sunset Bakery',
              username: 'sunset.bakery',
              profilePictureUrl: null,
              status: 'active',
              createdAt: '2026-10-30T00:00:00.000Z',
              expiresAt: null,
              lastError: null,
              accountType: 'business',
              destinationsLinked: 1,
            },
          ],
          total: 1,
          totalPages: 1,
          healthCounts: { connected: 1, expired: 0, error: 0, expiringSoon: 0 },
        });
      if (url.includes('/settings/platform-credentials/instagram'))
        return Promise.resolve(CREDENTIALS_CONFIGURED);
      return Promise.reject(new Error(`unexpected api.get: ${url}`));
    });

    renderPage();

    expect(await screen.findByTestId('instagram-header-connect-button')).toHaveTextContent(
      'Connect Instagram'
    );
    expect(await screen.findByText('Sunset Bakery')).toBeTruthy();
  });
});
