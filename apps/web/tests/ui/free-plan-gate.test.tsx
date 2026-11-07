/** @vitest-environment jsdom */
/**
 * FreePlanGate behavioural tests (entitlement rebuild): the gate now
 * reads the tenant layout's shared entitlement query instead of
 * fetching on its own, so every test renders EntitlementProvider
 * around it with a fresh QueryClient. Behaviours preserved: the
 * hard-block upgrade dialog for PROVEN FREE users; exempt routes,
 * admins, and paying users see no dialog; Upgrade goes to Billing
 * Purchase and Back to Home goes home; Esc and outside pointer-down
 * do not dismiss; loading holds content; a fetch error renders
 * content (fail-open, reported).
 *
 * Changed by design (owner decision 2026-11-07):
 * - Expired users are NOT blocked: they browse like paid users and
 *   only publishing stops (server-side, at the action).
 * - The gate never refetches on its own: no navigation re-check, no
 *   window-focus refetch, no 30-second capped auto re-check, no
 *   "Check again" button. The only re-check is an explicit refetch
 *   (purchase success, manual retry), which these tests drive
 *   through the query client.
 * - Exempt routes no longer skip the fetch — the shared query loads
 *   once for the whole shell (the sidebar word reads the same data),
 *   so only admins never fetch.
 */

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  pathname: '/tenant/acme/accounts',
  push: vi.fn(),
  apiGet: vi.fn(),
  reportError: vi.fn(),
}));
const mockPush = mocks.push;
const mockApiGet = mocks.apiGet;
const mockReportError = mocks.reportError;

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, apiGet: mocks.apiGet };
});

vi.mock('@/lib/report-error', () => ({ reportError: mocks.reportError }));

import { FreePlanGate } from '@/components/billing/free-plan-gate';
import {
  EntitlementProvider,
  entitlementQueryKey,
} from '@/components/billing/entitlement-provider';

type Plan = 'free' | 'paid' | 'expired';

function entitlement(plan: Plan) {
  const paid = plan === 'paid';
  return {
    plan,
    active: paid,
    counts: {
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    },
    usage: {
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: paid,
    readOnly: !paid,
    reason: paid ? null : plan === 'expired' ? 'expired' : 'Free plan',
    hasPriorPeriod: plan !== 'free',
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        retryDelay: 0,
        staleTime: 0,
        refetchOnWindowFocus: true,
      },
    },
  });
}

function renderGate(props: { isAdmin?: boolean; useCleanPaths?: boolean } = {}) {
  const isAdmin = props.isAdmin ?? false;
  const client = makeClient();
  // Fresh element on every render: reusing one element object lets
  // React bail out of re-rendering the provider (identical props),
  // so a navigation rerender would never reach the gate.
  const makeTree = () => (
    <QueryClientProvider client={client}>
      <EntitlementProvider subdomain="acme" adminOnly={isAdmin}>
        <FreePlanGate
          subdomain="acme"
          useCleanPaths={props.useCleanPaths ?? false}
          isAdmin={isAdmin}
        >
          <div>Section content</div>
        </FreePlanGate>
      </EntitlementProvider>
    </QueryClientProvider>
  );
  const result = render(makeTree());
  return {
    ...result,
    client,
    rerenderGate: () => result.rerender(makeTree()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockReset();
  mocks.pathname = '/tenant/acme/accounts';
  mockApiGet.mockResolvedValue(entitlement('free'));
});

describe('FreePlanGate', () => {
  it('shows the hard-block dialog and hides section content for a Free user on a gated route', async () => {
    renderGate();
    expect(screen.getByTestId('free-plan-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(await screen.findByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();
    expect(
      screen.getByText('This feature needs a paid plan. Upgrade to use it.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    // Hard block: no close button at all.
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('does NOT block an expired user: they browse the section like a paid user', async () => {
    mockApiGet.mockResolvedValue(entitlement('expired'));
    renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
  });

  it('shows no dialog on exempt routes', async () => {
    for (const path of ['/tenant/acme', '/tenant/acme/', '/prompts', '/tenant/acme/prompts', '/tenant/acme/my-plan', '/tenant/acme/purchase', '/tenant/acme/purchase/checkout', '/tenant/acme/payments', '/tenant/acme/refund']) {
      mocks.pathname = path;
      const { unmount } = renderGate();
      expect(screen.getByText('Section content')).toBeInTheDocument();
      expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows no dialog for an admin on a gated route and never fetches entitlement', () => {
    renderGate({ isAdmin: true });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('shows section content and no dialog for a paying user on a gated route', async () => {
    mockApiGet.mockResolvedValue(entitlement('paid'));
    renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
  });

  it('Upgrade navigates to Billing Purchase and Back to Home navigates home', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.click(screen.getByTestId('free-plan-upgrade-btn'));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/purchase');
    fireEvent.click(screen.getByTestId('free-plan-home-btn'));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/');
  });

  it('uses clean-path hrefs when clean paths are on', async () => {
    renderGate({ useCleanPaths: true });
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.click(screen.getByTestId('free-plan-upgrade-btn'));
    expect(mockPush).toHaveBeenCalledWith('/purchase');
    fireEvent.click(screen.getByTestId('free-plan-home-btn'));
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('Esc does not dismiss the dialog', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
  });

  it('outside pointer-down does not dismiss the dialog', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
  });

  it('holds a neutral loading state until entitlement resolves', async () => {
    let resolveEntitlement!: (value: unknown) => void;
    mockApiGet.mockImplementation(
      () => new Promise((resolve) => { resolveEntitlement = resolve; }),
    );
    renderGate();
    expect(screen.getByTestId('free-plan-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    resolveEntitlement(entitlement('free'));
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
  });

  it('renders content on entitlement fetch error (fail-open, reported)', async () => {
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockReportError).toHaveBeenCalled();
  });

  it('keeps section content during an explicit refetch after a failed check (sticky fail-open, no skeleton flash)', async () => {
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    const { client } = renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
    const callsAfterError = mockApiGet.mock.calls.length;
    let rejectRefetch!: (error: unknown) => void;
    mockApiGet.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRefetch = reject;
        }),
    );
    // An explicit refetch (purchase success / manual retry) starts
    // while the section is fail-open. Without stickiness the pending
    // refetch would flash skeletons, unmounting the section.
    await act(async () => {
      void client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    await waitFor(() => {
      expect(mockApiGet.mock.calls.length).toBeGreaterThan(callsAfterError);
    });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
    rejectRefetch(new Error('entitlement down'));
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
  });

  it('fails open when an explicit refetch fails after a proven Free decision', async () => {
    const { client } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
  });

  it('renders the panel with phone-width geometry from the shared dialog', async () => {
    renderGate();
    const panel = await screen.findByTestId('free-plan-upgrade-dialog');
    expect(panel.className).toContain('inset-x-4');
    expect(panel.className).toContain('sm:max-w-lg');
  });

  it('does NOT re-check on navigation: the dialog stays until an explicit refresh', async () => {
    const { rerenderGate } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    // The plan becomes paid server-side, but navigation alone must
    // not re-read it — that re-check on every section change is the
    // reload paid users reported.
    mockApiGet.mockResolvedValue(entitlement('paid'));
    mocks.pathname = '/tenant/acme/pages';
    rerenderGate();
    await waitFor(() => expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument());
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-check on window focus: the dialog stays until an explicit refresh', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    mockApiGet.mockResolvedValue(entitlement('paid'));
    // React Query v5 refetches on window focus via the
    // visibilitychange event (not the focus event): dispatching it
    // is what a tab-switch back looks like to the query client.
    window.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument());
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });

  it('an explicit refetch DOES clear the dialog once the plan becomes paid (the purchase-refresh path)', async () => {
    const { client } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    mockApiGet.mockResolvedValue(entitlement('paid'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the dialog during an explicit refetch (no skeleton flash)', async () => {
    let resolveSecond!: (value: unknown) => void;
    mockApiGet.mockResolvedValueOnce(entitlement('free'));
    mockApiGet.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSecond = resolve; }),
    );
    const { client } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    await act(async () => {
      void client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
    resolveSecond(entitlement('paid'));
    expect(await screen.findByText('Section content')).toBeInTheDocument();
  });

  it('does not fetch on window focus for admins', async () => {
    renderGate({ isAdmin: true });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    window.dispatchEvent(new Event('visibilitychange'));
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  // The capped auto re-check is deleted: while the dialog shows,
  // the gate must never fetch on its own, however much time passes.
  // Fake timers drive the clock; visibility is mocked because jsdom
  // defaults to 'prerender'.
  it('never auto re-checks while the dialog shows — no loop, no Check again button', async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      renderGate();
      const dialog = screen.findByTestId('free-plan-upgrade-dialog');
      await vi.advanceTimersByTimeAsync(100);
      await dialog;
      expect(mockApiGet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(mockApiGet).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('free-plan-recheck-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
