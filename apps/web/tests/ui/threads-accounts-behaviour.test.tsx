/**
 * @file threads-accounts-behaviour.test.tsx
 * @description Behavioural tests for the Threads accounts rebuild:
 * health model, subtitle, expired-first sort, card actions, and the
 * disconnect dialog — rendered live (Testing Library, jsdom project),
 * never static markup. These tests can catch a regression in what
 * was built: an expired account must not render as connected, an
 * expired sort must put expired first, and disconnect must ask first.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  ThreadsAccountCard,
  type ThreadsAccountItem,
} from '@/components/accounts/threads-account-card';
import { ThreadsDisconnectDialog } from '@/components/accounts/threads-disconnect-dialog';
import {
  computeThreadsSubtitle,
  computeThreadsSubtitleFromCounts,
  getThreadsAccountHealth,
  isThreadsTokenExpiringSoon,
  resolveThreadsOAuthRedirectNotice,
  sortThreadsAccountsExpiredFirst,
} from '@/components/accounts/threads-accounts-helpers';
import {
  buildThreadsDirectConnectUrl,
  evaluateThreadsConnectionPoll,
  ThreadsConnectModal,
} from '@/components/accounts/threads-connect-modal';
import { ThreadsAccountsShell } from '@/components/accounts/threads-accounts-shell';

const { apiGet, apiPost, apiDelete, toastSuccess, currentSearch } = vi.hoisted(
  () => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    toastSuccess: vi.fn(),
    currentSearch: { params: new URLSearchParams() },
  })
);

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  buildUrl: (path: string, query?: Record<string, unknown>) => {
    if (!query) return path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  },
  isApiError: (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in (err as Record<string, unknown>)),
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
    info: vi.fn(),
  },
  Toast: () => null,
  Toaster: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
  useSearchParams: () => currentSearch.params,
}));

const connectedAccount: ThreadsAccountItem = {
  id: 'acc-con',
  threadsAccountId: 'th-con',
  displayName: 'Connected Cedar',
  profilePictureUrl: null,
  status: 'active',
  createdAt: '2026-10-12T10:00:00Z',
};

const expiredAccount: ThreadsAccountItem = {
  id: 'acc-exp',
  threadsAccountId: 'th-exp',
  displayName: 'Expired Willow',
  profilePictureUrl: null,
  status: 'expired',
  tokenExpiresAt: '2020-01-01T00:00:00Z',
  createdAt: '2026-09-03T10:00:00Z',
};

const expiringSoonAccount: ThreadsAccountItem = {
  id: 'acc-soon',
  threadsAccountId: 'th-soon',
  displayName: 'Expiring Emma',
  profilePictureUrl: null,
  status: 'active',
  tokenExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
  createdAt: '2026-10-01T10:00:00Z',
};

describe('Threads account health model', () => {
  it('a past token means expired even when the stored status is active', () => {
    expect(
      getThreadsAccountHealth({
        status: 'active',
        tokenExpiresAt: '2020-01-01T00:00:00Z',
      })
    ).toBe('expired');
  });

  it('a disconnected account is an error, not expired', () => {
    expect(
      getThreadsAccountHealth({ status: 'disconnected' })
    ).toBe('error');
  });

  it('expiring-soon is true only for connected accounts within 7 days', () => {
    expect(isThreadsTokenExpiringSoon(expiringSoonAccount)).toBe(true);
    expect(isThreadsTokenExpiringSoon(expiredAccount)).toBe(false);
    expect(isThreadsTokenExpiringSoon(connectedAccount)).toBe(false);
  });

  it('the subtitle uses the Facebook count form', () => {
    expect(
      computeThreadsSubtitleFromCounts(2, {
        connected: 1,
        expired: 1,
        error: 0,
      })
    ).toBe('1 connected · 1 session expired');
    expect(
      computeThreadsSubtitleFromCounts(0, {
        connected: 0,
        expired: 0,
        error: 0,
      })
    ).toContain('Connect your first Threads account');
  });

  it('expired-first sort puts expired before connected regardless of date', () => {
    const sorted = sortThreadsAccountsExpiredFirst([
      connectedAccount,
      expiredAccount,
    ]);
    expect(sorted[0]?.id).toBe('acc-exp');
    expect(sorted[1]?.id).toBe('acc-con');
  });
});

describe('ThreadsAccountCard behaviour', () => {
  it('a connected card shows Connected and Disconnect, with no reconnect button', () => {
    render(
      <ThreadsAccountCard
        account={connectedAccount}
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('threads-account-disconnect-button')).toBeTruthy();
    expect(
      screen.queryByTestId('threads-account-reconnect-button')
    ).toBeNull();
    // No pages strip on a Threads card, ever.
    expect(screen.queryByText(/pages linked/)).toBeNull();
  });

  it('an expired card shows the alert and a Reconnect account button', () => {
    const onReconnect = vi.fn();
    render(
      <ThreadsAccountCard
        account={expiredAccount}
        onReconnect={onReconnect}
        onDisconnect={vi.fn()}
      />
    );
    expect(
      screen.getByTestId('threads-account-expired-alert')
    ).toBeTruthy();
    expect(
      screen.getByText('Session expired — reconnect to resume publishing')
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('threads-account-reconnect-button'));
    expect(onReconnect).toHaveBeenCalledWith(expiredAccount);
  });

  it('an expiring-soon card offers Refresh connection, not Reconnect account', () => {
    render(
      <ThreadsAccountCard
        account={expiringSoonAccount}
        onReconnect={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    expect(screen.getByText('Refresh connection')).toBeTruthy();
  });

  it('Disconnect asks for confirmation through the dialog, not immediately', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onDisconnect = vi.fn();
    const { rerender } = render(
      <ThreadsAccountCard
        account={connectedAccount}
        onReconnect={vi.fn()}
        onDisconnect={onDisconnect}
      />
    );
    fireEvent.click(screen.getByTestId('threads-account-disconnect-button'));
    expect(onDisconnect).toHaveBeenCalledWith(connectedAccount);

    // The dialog itself: Cancel does not confirm, Confirm does.
    render(
      <ThreadsDisconnectDialog
        account={connectedAccount}
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    expect(
      screen.getByText('Disconnect Connected Cedar?')
    ).toBeTruthy();
    expect(
      screen.queryByText(/Facebook page/)
    ).toBeNull();
    fireEvent.click(screen.getByTestId('threads-disconnect-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledWith('acc-con');
    void rerender;
  });
});

describe('OAuth-return notices (Facebook copy, Threads name)', () => {
  it('toasts "<name> connected" for connected=1 and strips the param', () => {
    const resolved = resolveThreadsOAuthRedirectNotice(
      new URLSearchParams('connected=1&accountName=Connected Cedar')
    );
    expect(resolved?.notice).toEqual({
      type: 'success',
      message: 'Connected Cedar connected',
    });
    expect(resolved?.accountName).toBe('Connected Cedar');
    expect(resolved?.keysToRemove).toContain('connected');
  });

  it('toasts the already-connected refresh variant', () => {
    const resolved = resolveThreadsOAuthRedirectNotice(
      new URLSearchParams('connected=already&accountName=Connected Cedar')
    );
    expect(resolved?.notice.message).toBe(
      'Connected Cedar already connected — session refreshed'
    );
  });

  it('warns (never silently succeeds) on a reconnect mismatch', () => {
    const resolved = resolveThreadsOAuthRedirectNotice(
      new URLSearchParams(
        'reconnected_mismatch=1&newAccountName=Wrong Wanda&expectedAccountName=Expired Willow'
      )
    );
    expect(resolved?.notice.type).toBe('error');
    expect(resolved?.notice.message).toContain(
      'You signed into Wrong Wanda instead of Expired Willow'
    );
    expect(resolved?.notice.message).toContain('still needs to be reconnected');
  });

  it('maps credentials_required to the Threads settings message', () => {
    const resolved = resolveThreadsOAuthRedirectNotice(
      new URLSearchParams('error=credentials_required')
    );
    expect(resolved?.notice.message).toContain('Threads App credentials');
  });

  it('maps access_denied / user_cancelled to the cancel message', () => {
    for (const code of ['access_denied', 'user_cancelled']) {
      const resolved = resolveThreadsOAuthRedirectNotice(
        new URLSearchParams(`error=${code}`)
      );
      expect(resolved?.notice.message).toBe(
        'Connection canceled. No changes were made.'
      );
    }
  });

  it('returns null when there is no notice param', () => {
    expect(
      resolveThreadsOAuthRedirectNotice(new URLSearchParams('page=2'))
    ).toBeNull();
  });
});

describe('subtitle fallback without healthCounts', () => {
  it('never subtitles "0 connected" on a non-zero page slice', () => {
    const subtitle = computeThreadsSubtitle(
      [
        { status: 'active', tokenExpiresAt: '2027-01-01T00:00:00Z' },
        { status: 'expired' },
      ],
      2,
      false
    );
    expect(subtitle).toContain('1 connected');
    expect(subtitle).toContain('1 session expired');
  });
});

describe('connect modal helpers', () => {
  it('builds the direct URL with the expected account on reconnect', () => {
    const url = buildThreadsDirectConnectUrl('acme', {
      id: 'acc-exp',
      threadsAccountId: 'th-exp',
      displayName: 'Expired Willow',
    });
    expect(url).toContain('/api/connect/threads?');
    expect(url).toContain('subdomain=acme');
    expect(url).toContain('expectedExternalAccountId=th-exp');
    expect(url).toContain('expectedDisplayName=Expired+Willow');
  });

  it('builds the plain direct URL for a fresh connect', () => {
    expect(buildThreadsDirectConnectUrl('acme')).toBe(
      '/api/connect/threads?subdomain=acme'
    );
  });

  it('detects a brand-new account in the poll', () => {
    const outcome = evaluateThreadsConnectionPoll(
      [{ id: 'acc-new', displayName: 'New Nora', status: 'active' }],
      new Set(['acc-old']),
      new Map()
    );
    expect(outcome).toEqual({
      matched: true,
      kind: 'connected',
      accountId: 'acc-new',
      accountName: 'New Nora',
    });
  });

  it('detects an already-connected refresh (expired → active)', () => {
    const outcome = evaluateThreadsConnectionPoll(
      [{ id: 'acc-exp', displayName: 'Expired Willow', status: 'active' }],
      new Set(['acc-exp']),
      new Map([['acc-exp', { status: 'expired' }]])
    );
    expect(outcome).toEqual({
      matched: true,
      kind: 'already_connected',
      accountId: 'acc-exp',
      accountName: 'Expired Willow',
    });
  });

  it('detects a reconnect mismatch instead of a silent success', () => {
    const outcome = evaluateThreadsConnectionPoll(
      [
        { id: 'acc-exp', displayName: 'Expired Willow', status: 'expired' },
        { id: 'acc-new', displayName: 'Wrong Wanda', status: 'active' },
      ],
      new Set(['acc-exp']),
      new Map([['acc-exp', { status: 'expired' }]]),
      { id: 'acc-exp', threadsAccountId: 'th-exp', displayName: 'Expired Willow' }
    );
    expect(outcome).toEqual({
      matched: true,
      kind: 'reconnected_mismatch',
      accountId: 'acc-new',
      newAccountName: 'Wrong Wanda',
      expectedAccountName: 'Expired Willow',
    });
  });
});

describe('card profile link', () => {
  it('links the name to the stored Threads profile', () => {
    render(
      <ThreadsAccountCard
        account={{
          ...connectedAccount,
          handle: 'cedar',
          accountLink: 'https://threads.com/@cedar',
        }}
      />
    );
    const link = screen.getByTestId('threads-account-profile-link');
    expect(link.getAttribute('href')).toBe('https://threads.com/@cedar');
  });

  it('shows no profile link when no handle is stored', () => {
    render(<ThreadsAccountCard account={connectedAccount} />);
    expect(
      screen.queryByTestId('threads-account-profile-link')
    ).toBeNull();
  });
});

describe('disconnect dialog destination count', () => {
  it('warns with the count and the scheduled-content consequence', () => {
    render(
      <ThreadsDisconnectDialog
        account={{ ...connectedAccount, connectedDestinationsCount: 2 }}
        open
        onOpenChange={() => undefined}
        onConfirm={async () => undefined}
      />
    );
    expect(
      screen.getByTestId('threads-disconnect-linked-destinations-warning')
    ).toBeTruthy();
    expect(screen.getByText(/2 linked Threads destinations/)).toBeTruthy();
    expect(
      screen.getByText(/scheduled content on them will be removed/)
    ).toBeTruthy();
  });

  it('shows the safe-to-remove notice when nothing is linked', () => {
    render(
      <ThreadsDisconnectDialog
        account={{ ...connectedAccount, connectedDestinationsCount: 0 }}
        open
        onOpenChange={() => undefined}
        onConfirm={async () => undefined}
      />
    );
    expect(
      screen.getByTestId('threads-disconnect-zero-destinations-notice')
    ).toBeTruthy();
    expect(
      screen.queryByText(/its destination will be removed/)
    ).toBeNull();
  });
});

describe('Threads accounts shell (React Query)', () => {
  const credentialsPayload = {
    workspaceId: '11111111-1111-4111-a111-111111111111',
    subdomain: 'acme',
    platform: 'threads',
    appId: 'threads-app-id',
    secretHint: '••••secret',
    hasSecret: true,
    status: 'configured',
    lastTestedAt: null,
    connectedAt: null,
  };

  function listPayload(accounts: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      accounts,
      total: accounts.length,
      page: 1,
      limit: 30,
      totalPages: 1,
      healthCounts: { connected: 1, expired: 1, error: 0 },
      ...overrides,
    };
  }

  function apiAccount(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      threadsAccountId: 'th-con',
      displayName: 'Connected Cedar',
      profilePictureUrl: null,
      handle: 'cedar',
      accountLink: 'https://threads.com/@cedar',
      connectedDestinationsCount: 1,
      status: 'active',
      tokenExpiresAt: '2027-01-01T00:00:00Z',
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:00Z',
      ...overrides,
    };
  }

  function renderShell(initialPage = 1) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <ThreadsAccountsShell subdomain="acme" initialPage={initialPage} />
      </QueryClientProvider>
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    currentSearch.params = new URLSearchParams();
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      return Promise.resolve(
        listPayload([
          apiAccount(),
          apiAccount({
            id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
            threadsAccountId: 'th-exp',
            displayName: 'Expired Willow',
            handle: null,
            accountLink: null,
            connectedDestinationsCount: 0,
            status: 'expired',
            tokenExpiresAt: '2020-01-01T00:00:00Z',
          }),
        ])
      );
    });
    apiPost.mockResolvedValue({
      magicUrl: 'https://example.test/connect/threads?token=magic-token',
      expiresInSeconds: 900,
    });
  });

  it('renders the prefetched list with the full-set subtitle, no skeleton flash', async () => {
    renderShell();
    await screen.findByText('Connected Cedar');
    await screen.findByText('Expired Willow');
    expect(screen.queryByTestId('threads-accounts-loading-skeleton')).toBeNull();
    expect(screen.getByTestId('threads-accounts-page-subtitle').textContent).toContain(
      '1 connected'
    );
  });

  it('toasts on OAuth return only after the list has loaded (mount-race fix)', async () => {
    currentSearch.params = new URLSearchParams(
      'connected=1&accountName=Connected Cedar'
    );
    renderShell();
    await screen.findByText('Connected Cedar');
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('Connected Cedar connected', {
        toasterId: 'threads-accounts-connect-toaster',
      });
    });
  });

  it('shows the mismatch banner on an OAuth-return mismatch', async () => {
    currentSearch.params = new URLSearchParams(
      'reconnected_mismatch=1&newAccountName=Wrong Wanda&expectedAccountName=Expired Willow'
    );
    renderShell();
    await screen.findByText('Connected Cedar');
    await waitFor(() => {
      expect(screen.getByTestId('threads-oauth-feedback-banner')).toBeTruthy();
    });
    expect(screen.getByText(/You signed into Wrong Wanda/)).toBeTruthy();
  });

  it('clamps a stale ?page=999 to the API page instead of a broken range', async () => {
    // A 90-account list: page 999 would render "Showing 29941–90
    // of 90" before the clamp; the API clamps to page 1.
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      return Promise.resolve(
        listPayload(
          [
            apiAccount(),
            apiAccount({
              id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
              threadsAccountId: 'th-exp',
              displayName: 'Expired Willow',
              handle: null,
              accountLink: null,
              connectedDestinationsCount: 0,
              status: 'expired',
              tokenExpiresAt: '2020-01-01T00:00:00Z',
            }),
          ],
          { total: 90, totalPages: 3, page: 1 }
        )
      );
    });
    renderShell(999);
    await screen.findByText('Connected Cedar');
    await waitFor(() => {
      expect(screen.getByText('Showing 1–30 of 90')).toBeTruthy();
    });
    expect(screen.queryByText(/29941/)).toBeNull();
  });

  it('opens the connect modal and generates a magic link with a 15-minute countdown', async () => {
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      return Promise.resolve(listPayload([]));
    });
    renderShell();
    await screen.findByTestId('threads-accounts-empty-state');
    fireEvent.click(screen.getByTestId('threads-empty-connect-button'));
    await screen.findByTestId('threads-connect-account-modal');
    fireEvent.click(screen.getByTestId('threads-connect-option-magic'));
    await screen.findByTestId('threads-magic-url-input');
    expect(
      (screen.getByTestId('threads-magic-url-input') as HTMLInputElement).value
    ).toBe('https://example.test/connect/threads?token=magic-token');
    expect(screen.getByTestId('threads-magic-countdown').textContent).toContain(
      '15:00'
    );
    expect(apiPost).toHaveBeenCalledWith(
      expect.stringContaining('/threads/accounts/magic-link'),
      undefined,
      expect.anything()
    );
  });

  it('polls the magic link and toasts when the account appears', async () => {
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      return Promise.resolve(listPayload([]));
    });
    renderShell();
    await screen.findByTestId('threads-accounts-empty-state');
    fireEvent.click(screen.getByTestId('threads-empty-connect-button'));
    await screen.findByTestId('threads-connect-account-modal');
    fireEvent.click(screen.getByTestId('threads-connect-option-magic'));
    await screen.findByTestId('threads-magic-url-input');
    // The account appears on the next poll (3s cycle).
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      return Promise.resolve(listPayload([apiAccount({ displayName: 'New Nora' })]));
    });
    await waitFor(
      () => {
        expect(toastSuccess).toHaveBeenCalledWith('New Nora connected', {
          toasterId: 'threads-accounts-connect-toaster',
        });
      },
      { timeout: 8000 }
    );
  });

  it('stays on page 2 after clicking it (placeholder data must not snap it back)', async () => {
    // Perf regression: with keepPreviousData, the page-1 payload is
    // served as placeholder while page 2 loads. The out-of-range
    // clamp effect must ignore placeholder data, or it reads
    // data.page (1) !== page (2) and drags the user back to page 1.
    const pageOne = [
      apiAccount(),
      apiAccount({
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        threadsAccountId: 'th-exp',
        displayName: 'Expired Willow',
        handle: null,
        accountLink: null,
        connectedDestinationsCount: 0,
        status: 'expired',
        tokenExpiresAt: '2020-01-01T00:00:00Z',
      }),
    ];
    const pageTwo = [
      apiAccount({
        id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        threadsAccountId: 'th-two',
        displayName: 'Page Two Pat',
        handle: 'pat',
        connectedDestinationsCount: 0,
        status: 'active',
      }),
    ];
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/settings/platform-credentials/')) {
        return Promise.resolve(credentialsPayload);
      }
      const params = new URL(String(url), 'http://test.invalid').searchParams;
      if (params.get('page') === '2') {
        return Promise.resolve(
          listPayload(pageTwo, { total: 90, totalPages: 3, page: 2 })
        );
      }
      return Promise.resolve(
        listPayload(pageOne, { total: 90, totalPages: 3, page: 1 })
      );
    });
    renderShell();
    await screen.findByText('Connected Cedar');
    fireEvent.click(screen.getByTestId('pagination-page-2'));
    await screen.findByText('Page Two Pat');
    // Must STAY on page 2 once loaded — no snap-back to page 1.
    await waitFor(() => {
      expect(screen.getByText('Page Two Pat')).toBeTruthy();
    });
    expect(screen.queryByText('Connected Cedar')).toBeNull();
    expect(apiGet).toHaveBeenCalledWith(
      expect.stringContaining('page=2'),
      expect.anything()
    );
  });

  it('debounces search: typing does not fire a request per keystroke', async () => {
    renderShell();
    await screen.findByText('Connected Cedar');
    apiGet.mockClear();
    const input = screen.getByTestId(
      'accounts-search-input'
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.change(input, { target: { value: 'ce' } });
    // The final term's request arrives after the 250ms debounce.
    await waitFor(
      () => {
        expect(apiGet).toHaveBeenCalledWith(
          expect.stringContaining('search=ce'),
          expect.anything()
        );
      },
      { timeout: 3000 }
    );
    const searches = apiGet.mock.calls.map(
      ([url]) =>
        new URL(String(url), 'http://test.invalid').searchParams.get('search')
    );
    expect(searches).not.toContain('c');
    expect(searches).toContain('ce');
  });
});
