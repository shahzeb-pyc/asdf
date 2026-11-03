/** @vitest-environment jsdom */
/**
 * FreePlanGate behavioural tests (entitlement rebuild): the gate now
 * reads the tenant layout's shared entitlement query instead of
 * fetching on its own, so every test renders EntitlementProvider
 * around it with a fresh QueryClient. Behaviours preserved: the
 * hard-block upgrade dialog for users who cannot post; exempt routes,
 * admins, and paying users see no dialog; Upgrade goes to Billing
 * Purchase and Back to Home goes home; Esc and outside pointer-down
 * do not dismiss; loading holds content; a fetch error renders
 * content (fail-open, reported). New: expired users still see the
 * dialog (proven canPost=false, preserved); a failed refetch after a
 * proven decision fails open instead of sticking the old decision.
 * Changed by design: exempt routes no longer skip the fetch — the
 * shared query loads once for the whole shell (the sidebar word
 * reads the same data), so only admins never fetch.
 */

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
import { EntitlementProvider } from '@/components/billing/entitlement-provider';

function entitlement(canPost: boolean, hasPriorPeriod = false) {
  return {
    plan: canPost ? 'paid' : 'free',
    active: canPost,
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
    canPost,
    readOnly: !canPost,
    reason: canPost ? null : 'Free plan',
    hasPriorPeriod,
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
  // so a navigation rerender would never reach its effect.
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
    rerenderGate: () => result.rerender(makeTree()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockReset();
  mocks.pathname = '/tenant/acme/accounts';
  mockApiGet.mockResolvedValue(entitlement(false));
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

  it('shows the dialog for an expired user (proven canPost=false, prior period)', async () => {
    mockApiGet.mockResolvedValue(entitlement(false, true));
    renderGate();
    expect(await screen.findByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
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
    mockApiGet.mockResolvedValue(entitlement(true, true));
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
    resolveEntitlement(entitlement(false));
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

  it('keeps section content during a refetch after a failed check (sticky fail-open, no skeleton flash)', async () => {
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    const { rerenderGate } = renderGate();
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
    // A navigation re-check starts while the section is fail-open.
    // Without stickiness the pending refetch would flash skeletons,
    // unmounting the section — and any child that reads this query
    // and refetches on mount would loop mount/refetch/unmount
    // forever instead of rendering.
    mocks.pathname = '/tenant/acme/pages';
    rerenderGate();
    await vi.waitFor(() => {
      expect(mockApiGet.mock.calls.length).toBeGreaterThan(callsAfterError);
    });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
    rejectRefetch(new Error('entitlement down'));
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
  });

  it('fails open when a refetch fails after a proven Free decision', async () => {
    const { rerenderGate } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    mocks.pathname = '/tenant/acme/pages';
    rerenderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
  });

  it('renders the panel with phone-width geometry from the shared dialog', async () => {
    renderGate();
    const panel = await screen.findByTestId('free-plan-upgrade-dialog');
    expect(panel.className).toContain('inset-x-4');
    expect(panel.className).toContain('sm:max-w-lg');
  });

  it('re-checks on navigation: the dialog disappears without a reload once the plan becomes paid', async () => {
    const { rerenderGate } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    mockApiGet.mockResolvedValue(entitlement(true, true));
    mocks.pathname = '/tenant/acme/pages';
    rerenderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });

  it('re-checks on window focus: the dialog disappears once the plan becomes paid', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(mockApiGet).toHaveBeenCalledTimes(1);
    mockApiGet.mockResolvedValue(entitlement(true, true));
    // React Query v5 refetches on window focus via the
    // visibilitychange event (not the focus event): dispatching it
    // is what a tab-switch back looks like to the query client.
    window.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the previous status during a navigation re-check (no skeleton flash)', async () => {
    let resolveSecond!: (value: unknown) => void;
    mockApiGet.mockResolvedValueOnce(entitlement(false));
    mockApiGet.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSecond = resolve; }),
    );
    const { rerenderGate } = renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    mocks.pathname = '/tenant/acme/pages';
    rerenderGate();
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
    resolveSecond(entitlement(true, true));
    expect(await screen.findByText('Section content')).toBeInTheDocument();
  });

  it('does not fetch on window focus for admins', async () => {
    renderGate({ isAdmin: true });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    window.dispatchEvent(new Event('visibilitychange'));
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  // Capped auto re-check tests: fake timers drive the 30-second
  // interval; visibility is mocked because jsdom defaults to
  // 'prerender', which the gate correctly treats as not visible.
  const setVisibility = (value: string) => {
    Object.defineProperty(document, 'visibilityState', {
      value,
      configurable: true,
    });
  };
  const findDialogWithFakeTimers = async () => {
    const found = screen.findByTestId('free-plan-upgrade-dialog');
    await vi.advanceTimersByTimeAsync(100);
    return found;
  };

  it('clears without a reload when a capped re-check returns Paid', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      renderGate();
      await findDialogWithFakeTimers();
      expect(mockApiGet).toHaveBeenCalledTimes(1);
      mockApiGet.mockResolvedValue(entitlement(true, true));
      await vi.advanceTimersByTimeAsync(30_000);
      // findBy polls on timers, which are fake here: advance once
      // more so its polling interval can observe the new render.
      const content = screen.findByText('Section content');
      await vi.advanceTimersByTimeAsync(100);
      expect(await content).toBeInTheDocument();
      expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
      expect(mockApiGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops auto re-checking after 10 checks and shows a Check again button', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      renderGate();
      await findDialogWithFakeTimers();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(mockApiGet).toHaveBeenCalledTimes(11);
      expect(screen.getByTestId('free-plan-recheck-btn')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mockApiGet).toHaveBeenCalledTimes(11);
      expect(screen.getByTestId('free-plan-recheck-btn')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not burn auto checks while the tab is hidden', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('hidden');
      renderGate();
      await findDialogWithFakeTimers();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mockApiGet).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('free-plan-recheck-btn')).not.toBeInTheDocument();
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockApiGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual Check again clears the dialog on Paid', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      renderGate();
      await findDialogWithFakeTimers();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(screen.getByTestId('free-plan-recheck-btn')).toBeInTheDocument();
      mockApiGet.mockResolvedValue(entitlement(true, true));
      fireEvent.click(screen.getByTestId('free-plan-recheck-btn'));
      const content = screen.findByText('Section content');
      await vi.advanceTimersByTimeAsync(100);
      expect(await content).toBeInTheDocument();
      expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual Check again on still-Free keeps the button and does not restart auto polling', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      renderGate();
      await findDialogWithFakeTimers();
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(mockApiGet).toHaveBeenCalledTimes(11);
      fireEvent.click(screen.getByTestId('free-plan-recheck-btn'));
      await vi.advanceTimersByTimeAsync(100);
      expect(mockApiGet).toHaveBeenCalledTimes(12);
      expect(screen.getByTestId('free-plan-recheck-btn')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mockApiGet).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-opens when a capped re-check errors, instead of looping', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      renderGate();
      await findDialogWithFakeTimers();
      mockApiGet.mockRejectedValue(new Error('entitlement down'));
      await vi.advanceTimersByTimeAsync(30_000);
      const content = screen.findByText('Section content');
      await vi.advanceTimersByTimeAsync(100);
      expect(await content).toBeInTheDocument();
      expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto re-check on exempt routes or for admins', async () => {
    vi.useFakeTimers();
    try {
      setVisibility('visible');
      mocks.pathname = '/tenant/acme';
      const { unmount } = renderGate();
      expect(screen.getByText('Section content')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(100);
      const callsAfterExemptMount = mockApiGet.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mockApiGet.mock.calls.length).toBe(callsAfterExemptMount);
      unmount();
      mocks.pathname = '/tenant/acme/accounts';
      mockApiGet.mockClear();
      renderGate({ isAdmin: true });
      expect(screen.getByText('Section content')).toBeInTheDocument();
      expect(mockApiGet).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(mockApiGet).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      mocks.pathname = '/tenant/acme/accounts';
    }
  });
});
