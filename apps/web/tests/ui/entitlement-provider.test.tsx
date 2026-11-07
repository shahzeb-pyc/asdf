/**
 * @vitest-environment jsdom
 * @file entitlement-provider.test.tsx
 * @description One shared entitlement query (entitlement rebuild):
 * gate + word fed by the same provider can never disagree; a failed
 * refetch after a proven Free clears it to the Studio placeholder
 * instead of sticking Free; sequential refetches converge to the
 * latest completed fetch; genuine Free still renders Free.
 *
 * New design (owner decision 2026-11-07): the provider starts from
 * the tenant layout's server seed and never refetches on its own —
 * no navigation re-check, no window-focus refetch, no polling. The
 * only later re-check is an explicit refetch (purchase success,
 * manual retry). These tests pin exactly that: a seeded session
 * makes zero API calls across focus and navigation, and an explicit
 * refetch is the one path that fetches again.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EntitlementProvider,
  entitlementQueryKey,
  provenEntitlementFromQuery,
  useSharedEntitlement,
} from '@/components/billing/entitlement-provider';
import { FreePlanGate } from '@/components/billing/free-plan-gate';
import { usePlanWord } from '@/components/workspace/plan-word';
import type { EntitlementResponse } from '@/lib/api/schemas/billing';

const apiGet = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiGet: (...args: unknown[]) => apiGet(...args) };
});

const navState = { pathname: '/tenant/acme/accounts' };
vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/report-error', () => ({
  reportError: vi.fn(),
}));

function paidEntitlement(): EntitlementResponse {
  return {
    plan: 'paid',
    active: true,
    counts: { facebook: 10, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    periodEndsAt: '2027-01-01T00:00:00.000Z',
    periodStartsAt: '2026-01-01T00:00:00.000Z',
    canPost: true,
    readOnly: false,
    reason: 'active',
    hasPriorPeriod: true,
  };
}

function freeEntitlement(): EntitlementResponse {
  return {
    plan: 'free',
    active: false,
    counts: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: false,
    readOnly: true,
    reason: 'no_period',
    hasPriorPeriod: false,
  };
}

function expiredEntitlement(): EntitlementResponse {
  return {
    plan: 'expired',
    active: false,
    counts: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: false,
    readOnly: true,
    reason: 'expired',
    hasPriorPeriod: true,
  };
}

function WordProbe(): React.JSX.Element {
  const word = usePlanWord(false);
  return <span data-testid="word-probe">{word ?? 'Studio'}</span>;
}

function GateProbe(): React.JSX.Element {
  return (
    <FreePlanGate subdomain="acme" useCleanPaths={false} isAdmin={false}>
      <span data-testid="gate-child">Gate child</span>
    </FreePlanGate>
  );
}

function RefetchProbe(): React.JSX.Element {
  const shared = useSharedEntitlement();
  return (
    <button type="button" data-testid="refetch-probe" onClick={() => void shared.refetch()}>
      Refetch
    </button>
  );
}

function renderShared(
  client: QueryClient,
  initialEntitlement?: EntitlementResponse | null
): ReturnType<typeof render> {
  return render(
    <QueryClientProvider client={client}>
      <EntitlementProvider
        subdomain="acme"
        adminOnly={false}
        initialEntitlement={initialEntitlement}
      >
        <WordProbe />
        <GateProbe />
        <RefetchProbe />
      </EntitlementProvider>
    </QueryClientProvider>
  );
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        retryDelay: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
    },
  });
}

beforeEach(() => {
  // mockReset, not clearAllMocks: a previous test's mockResolvedValue
  // must not leak in as the retry attempt's implementation.
  apiGet.mockReset();
  navState.pathname = '/tenant/acme/accounts';
});

describe('provenEntitlementFromQuery (pure derivation)', () => {
  const data = paidEntitlement();
  it('returns data when there is no newer error', () => {
    expect(
      provenEntitlementFromQuery({ data, dataUpdatedAt: 100, errorUpdatedAt: 0 })
    ).toEqual(data);
  });

  it('returns null when a failed refetch is newer than the last success', () => {
    expect(
      provenEntitlementFromQuery({ data, dataUpdatedAt: 100, errorUpdatedAt: 200 })
    ).toBeNull();
  });

  it('keeps data when the error predates the success', () => {
    expect(
      provenEntitlementFromQuery({ data, dataUpdatedAt: 200, errorUpdatedAt: 100 })
    ).toEqual(data);
  });

  it('returns null with no data', () => {
    expect(
      provenEntitlementFromQuery({ data: undefined, dataUpdatedAt: 0, errorUpdatedAt: 0 })
    ).toBeNull();
  });
});

describe('shared entitlement query (gate + word agreement)', () => {
  it('paid data: no dialog and Paid word from the same fetch', async () => {
    apiGet.mockResolvedValue(paidEntitlement());
    renderShared(makeClient());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('genuine Free data: dialog and Free word from the same fetch', async () => {
    apiGet.mockResolvedValue(freeEntitlement());
    renderShared(makeClient());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Free'));
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('expired data: Expired word, no dialog, section renders', async () => {
    apiGet.mockResolvedValue(expiredEntitlement());
    renderShared(makeClient());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Expired'));
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('Free success followed by a failed refetch clears to Studio and opens the gate', async () => {
    apiGet.mockResolvedValueOnce(freeEntitlement());
    const client = makeClient();
    renderShared(client);
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Free'));
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();

    apiGet.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Studio'));
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
  });

  it('sequential refetches converge to the latest completed fetch', async () => {
    apiGet.mockResolvedValueOnce(paidEntitlement());
    const client = makeClient();
    renderShared(client);
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.queryByText("You're on the Free plan")).toBeNull();

    apiGet.mockResolvedValueOnce(freeEntitlement());
    await act(async () => {
      await client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Free'));
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();

    apiGet.mockResolvedValueOnce(paidEntitlement());
    await act(async () => {
      await client.invalidateQueries({ queryKey: entitlementQueryKey('acme') });
    });
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
  });

  it('fetch error on first load fails open: children, no dialog, Studio word', async () => {
    apiGet.mockRejectedValue(new Error('network down'));
    renderShared(makeClient());
    // The word reads Studio while loading too, so wait for the
    // loading skeleton to clear (the query has settled into error)
    // before asserting the fail-open state.
    await waitFor(() =>
      expect(screen.queryByTestId('free-plan-gate-loading')).toBeNull()
    );
    expect(screen.getByTestId('word-probe')).toHaveTextContent('Studio');
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
  });
});

describe('once-per-session seed (no automatic refetch)', () => {
  it('seeded paid: zero API calls, Paid word, no dialog', async () => {
    renderShared(makeClient(), paidEntitlement());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('seeded paid: window focus and section navigation never refetch', async () => {
    const client = makeClient();
    const seed = paidEntitlement();
    const makeTree = () => (
      <QueryClientProvider client={client}>
        <EntitlementProvider subdomain="acme" adminOnly={false} initialEntitlement={seed}>
          <WordProbe />
          <GateProbe />
          <RefetchProbe />
        </EntitlementProvider>
      </QueryClientProvider>
    );
    const result = render(makeTree());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    // A tab-switch back (visibilitychange is what React Query v5
    // listens to) and a plain focus event: neither may refetch.
    window.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    // A section navigation: the provider used to invalidate on every
    // pathname change, which refetched and unmounted the section
    // while the new answer pended — the reload paid users reported.
    // The same client and tree, only the pathname changed.
    navState.pathname = '/tenant/acme/pages';
    result.rerender(makeTree());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('unseeded: one fetch on mount, window focus does not refetch', async () => {
    apiGet.mockResolvedValue(paidEntitlement());
    renderShared(makeClient());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(apiGet).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('seeded free then an explicit refetch returns paid: dialog clears (the purchase-refresh path)', async () => {
    renderShared(makeClient(), freeEntitlement());
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Free'));
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalled();

    apiGet.mockResolvedValueOnce(paidEntitlement());
    fireEvent.click(screen.getByTestId('refetch-probe'));
    await waitFor(() => expect(screen.getByTestId('word-probe')).toHaveTextContent('Paid'));
    expect(screen.getByTestId('gate-child')).toBeInTheDocument();
    expect(screen.queryByText("You're on the Free plan")).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe('useSharedEntitlement outside the provider fails loud', () => {
  it('throws instead of fetching a second, disagreeing copy', () => {
    const client = makeClient();
    const Probe = (): React.JSX.Element => {
      const shared = useSharedEntitlement();
      return <span>{shared.entitlement?.plan ?? 'none'}</span>;
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      )
    ).toThrow(/EntitlementProvider/);
    errorSpy.mockRestore();
  });
});
