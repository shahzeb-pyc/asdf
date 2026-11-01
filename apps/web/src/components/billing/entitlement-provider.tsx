'use client';

/**
 * Shared entitlement query — the ONE plan check for the tenant shell.
 *
 * Before this rebuild, the free-plan gate ran its own apiGet effect
 * and the sidebar plan word ran its own React Query, so the dialog
 * and the word could disagree within one page state (each fetch could
 * answer differently). Now the tenant layout mounts this provider
 * once, and the gate, the plan word, and the billing view all read
 * the same query data through `useSharedEntitlement`. One fetch, one
 * decision — nothing else in the shell fetches entitlement.
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
 * Freshness (preserved from the old gate): staleTime 0 plus the
 * app's refetch-on-focus default, and an invalidation on every SPA
 * navigation (pathname change) so a plan that becomes paid while
 * the tab is open unblocks sections without a full reload. All
 * refetches go through this one query — no duplicate in-flight
 * checks from separate fetchers. Out-of-order responses cannot
 * overwrite newer data: React Query serializes fetches for one key
 * (an invalidation during a fetch queues a follow-up fetch that
 * runs after it), so the last completed fetch is always the latest
 * initiated one.
 */

import * as React from 'react';
import { usePathname } from 'next/navigation';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  EntitlementResponseSchema,
  type EntitlementResponse,
} from '@fbuploadpro/contracts';
import { apiGet, buildTenantApiPath } from '@/lib/api';
import { reportError } from '@/lib/report-error';

/** The one entitlement query key, shared by gate, word, and billing. */
export function entitlementQueryKey(subdomain: string): readonly string[] {
  return ['tenant', subdomain, 'billing', 'entitlement'];
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
  /** Re-run the shared query (used by billing's retry). */
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
  children: React.ReactNode;
}

export function EntitlementProvider({
  subdomain,
  adminOnly,
  children,
}: Readonly<EntitlementProviderProps>) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const query: UseQueryResult<EntitlementResponse, Error> = useQuery({
    queryKey: entitlementQueryKey(subdomain),
    queryFn: ({ signal }) =>
      apiGet(buildTenantApiPath(subdomain, '/billing/entitlement'), {
        schema: EntitlementResponseSchema,
        signal,
      }),
    enabled: !adminOnly,
    staleTime: 0,
  });

  // Re-check on SPA navigation, through the one query. The first
  // run is skipped: mount already fetches once via useQuery, and
  // invalidating immediately would double-fetch.
  const firstPathnameRef = React.useRef(true);
  React.useEffect(() => {
    if (firstPathnameRef.current) {
      firstPathnameRef.current = false;
      return;
    }
    if (adminOnly) return;
    void queryClient.invalidateQueries({ queryKey: entitlementQueryKey(subdomain) });
  }, [pathname, adminOnly, queryClient, subdomain]);

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
