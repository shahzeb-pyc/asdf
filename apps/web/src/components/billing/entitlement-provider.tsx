'use client';

/**
 * Shared entitlement query — the ONE plan check for the tenant shell.
 *
 * One fetch per document, cached for the whole session (owner
 * decision 2026-11-07): the tenant layout reads entitlement once on
 * the server and passes it in as `initialEntitlement`; the query
 * starts from that seed and never refetches on its own — no
 * navigation re-check, no window-focus refetch, no polling, no
 * re-check loop. The gate, the sidebar plan word, the topbar pill,
 * the feature-cap text, and the billing view all read the same
 * query data through `useSharedEntitlement`. One fetch, one
 * decision — nothing else in the shell fetches entitlement.
 *
 * If the server seed failed, `initialEntitlement` is null and the
 * query fetches once from the entitlement API route on mount, then
 * likewise never refetches automatically. The only later re-checks
 * are explicit: `refetch` is called by billing after a purchase /
 * upgrade succeeds, and by the manual retry buttons on My Plan and
 * Purchase. A full page reload re-runs the layout and re-seeds —
 * that is the manual refresh path.
 *
 * Free-only-when-proven: the provider exposes ONLY proven data.
 * `entitlement` is non-null exactly when the latest completed fetch
 * succeeded; a failed first fetch, or a failed refetch newer than
 * the last success, yields null (never a stale success). Consumers
 * render neutral states from null — the gate renders children with
 * no dialog, the word renders the Studio placeholder, billing
 * renders its loading/error state — never a Free rendering from
 * unproven data. While a refetch is in flight, the previous proven
 * value is kept (no flash); only a settled failure clears it.
 *
 * States: paid / free / expired / admin / UNKNOWN (null). The plan
 * value is explicit in the contract — expired is a real plan, not a
 * derivation — so the gate, the word, and Home can never disagree
 * about it.
 *
 * Billing status (smooth-steps spec, 2026-11-08): this file also
 * owns the shared /billing query (`useBillingStatus`) — builder,
 * checkout and confirmation read one cache instead of each fetching
 * on mount, with a 15s timeout scoped to that query only.
 */

import * as React from 'react';
import {
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  EntitlementResponseSchema,
  type EntitlementResponse,
} from '@fbuploadpro/contracts';
import {
  BillingStatusResponseSchema,
  type BillingStatusResponse,
} from '@/lib/api/schemas/billing';
import { apiGet, buildTenantApiPath } from '@/lib/api';
import { reportError } from '@/lib/report-error';

/** The one entitlement query key, shared by gate, word, and billing. */
export function entitlementQueryKey(subdomain: string): readonly string[] {
  return ['tenant', subdomain, 'billing', 'entitlement'];
}

/** The one billing-status query key, shared by builder, checkout and confirmation. */
export function billingStatusQueryKey(subdomain: string, page = 1): readonly (string | number)[] {
  return ['tenant', subdomain, 'billing', 'status', page];
}

/**
 * Billing-status load timeout (owner order 2026-11-08): a hung
 * /billing request must fail into the retry error UI within ~15s,
 * never an endless skeleton. Scoped to this query only — no other
 * caller gets a timeout from it, and apiGet itself is untouched.
 */
export const BILLING_STATUS_TIMEOUT_MS = 15_000;

/**
 * Abort when either the query is cancelled or the timeout elapses.
 * AbortSignal.any is not used (no call site in the codebase relies
 * on it); the two signals are combined by hand instead.
 */
function combineSignals(querySignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  if (!querySignal) return timeoutSignal ?? new AbortController().signal;
  if (!timeoutSignal) return querySignal;
  if (querySignal.aborted) return querySignal;
  if (timeoutSignal.aborted) return timeoutSignal;
  const controller = new AbortController();
  const onQueryAbort = () => {
    timeoutSignal.removeEventListener('abort', onTimeout);
    controller.abort(querySignal.reason);
  };
  const onTimeout = () => {
    querySignal.removeEventListener('abort', onQueryAbort);
    controller.abort(timeoutSignal.reason);
  };
  querySignal.addEventListener('abort', onQueryAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  return controller.signal;
}

/**
 * Shared billing-status query options (smooth-steps spec). Builder,
 * checkout and confirmation all read this one cache, so moving
 * between steps never re-fetches and never shows the skeleton —
 * the data is fetched once, on first entry into Purchase. Page 1 is
 * the bare `/billing` path (the route defaults `?page=` to 1), so
 * the confirmation's page-1 read hits the exact cache entry the
 * builder filled.
 */
export function billingStatusQueryOptions(
  subdomain: string,
  page = 1
): UseQueryOptions<BillingStatusResponse, Error> {
  return {
    queryKey: billingStatusQueryKey(subdomain, page),
    queryFn: ({ signal }) =>
      apiGet(
        buildTenantApiPath(subdomain, page === 1 ? '/billing' : `/billing?page=${page}`),
        {
          schema: BillingStatusResponseSchema,
          signal: combineSignals(signal, BILLING_STATUS_TIMEOUT_MS),
        }
      ),
    // Fetched once per session, never again on its own — the same
    // shape as the entitlement query. Explicit refetch (after a
    // purchase, a 409, or Try again) is the only re-check.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // The old mount-only load() never retried: a failed load showed
    // the retry UI at once. Keep that — a hung request must surface
    // within ~15s, not after a retry doubles it to ~30s.
    retry: 0,
  };
}

/** Read the shared billing status for a Purchase step. */
export function useBillingStatus(
  subdomain: string,
  page = 1
): UseQueryResult<BillingStatusResponse, Error> {
  return useQuery(billingStatusQueryOptions(subdomain, page));
}

export interface SharedEntitlementState {
  /** Proven entitlement, or null while loading / unproven. */
  entitlement: EntitlementResponse | null;
  /** True exactly when `entitlement` is a successful fetch result. */
  isProven: boolean;
  /** True before the first fetch settles (never fetched yet). */
  isLoading: boolean;
  /**
   * True when there is no proven value because a fetch failed —
   * either the first fetch, or a refetch newer than the last
   * success. Consumers render neutral states from this, never Free.
   */
  isUnproven: boolean;
  /**
   * Re-run the shared query. The ONLY re-check path: called by
   * billing after a purchase/upgrade succeeds and by the manual
   * retry buttons. Nothing automatic ever calls this.
   */
  refetch: () => Promise<unknown>;
}

/**
 * Pure derivation of the proven value from a query result. A success
 * counts only if no failure is newer than it: React Query retains
 * the last successful `data` across a failed refetch, and that stale
 * success must never masquerade as a fresh plan answer.
 */
export function provenEntitlementFromQuery(query: {
  data: EntitlementResponse | undefined;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): EntitlementResponse | null {
  const data = query.data ?? null;
  if (!data) return null;
  if (query.errorUpdatedAt > query.dataUpdatedAt) return null;
  return data;
}

const EntitlementContext = React.createContext<SharedEntitlementState | null>(null);

export interface EntitlementProviderProps {
  subdomain: string;
  adminOnly: boolean;
  /**
   * The entitlement the tenant layout read on the server for this
   * document. Null when the server read failed — the query then
   * fetches once from the API route on mount instead.
   */
  initialEntitlement?: EntitlementResponse | null | undefined;
  children: React.ReactNode;
}

export function EntitlementProvider({
  subdomain,
  adminOnly,
  initialEntitlement,
  children,
}: Readonly<EntitlementProviderProps>) {
  const query: UseQueryResult<EntitlementResponse, Error> = useQuery({
    queryKey: entitlementQueryKey(subdomain),
    queryFn: ({ signal }) =>
      apiGet(buildTenantApiPath(subdomain, '/billing/entitlement'), {
        schema: EntitlementResponseSchema,
        signal,
      }),
    enabled: !adminOnly,
    // Fetched once per session, never again on its own: the seed
    // (or the one mount fetch) is the answer until an explicit
    // refetch after a purchase/upgrade or a manual retry. No
    // navigation invalidation, no focus refetch, no polling.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    initialData: initialEntitlement ?? undefined,
  });

  // Observability parity with the old gate's fetch-error report:
  // a failed entitlement check is logged loudly (console transport
  // today) instead of failing silently into a neutral UI.
  const queryError = query.error;
  React.useEffect(() => {
    if (queryError) {
      reportError(queryError, { source: 'shared-entitlement' });
    }
  }, [queryError]);

  const value = React.useMemo<SharedEntitlementState>(() => {
    const entitlement = adminOnly ? null : provenEntitlementFromQuery(query);
    return {
      entitlement,
      isProven: entitlement !== null,
      isLoading: !adminOnly && query.isPending,
      isUnproven: !adminOnly && entitlement === null && !query.isPending,
      refetch: () => query.refetch(),
    };
  }, [adminOnly, query]);

  return (
    <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>
  );
}

/**
 * Read the shared entitlement state. Must be used under
 * EntitlementProvider (mounted by the tenant layout); anything else
 * is a wiring bug and fails loud rather than fetching a second,
 * disagreeing copy.
 */
export function useSharedEntitlement(): SharedEntitlementState {
  const context = React.useContext(EntitlementContext);
  if (!context) {
    throw new Error('useSharedEntitlement must be used within EntitlementProvider');
  }
  return context;
}
