'use client';

/**
 * Data-layer provider (spec 137 §3.2.5) — mounts the one QueryClient
 * in the tenant layout and registers the global 401 handler there:
 * on `session-expired` the query cache is cleared and the browser is
 * sent to login exactly once (the handler + latch live in
 * `lib/api/session-expired`, PR-A1a; this provider is its one
 * registration site). It also runs the global session check
 * (`useGlobalSessionCheck`, session-global-check spec §2.2): the
 * one database-backed session revalidation, on mount, every 5
 * minutes, and on window focus.
 *
 * `DataHydration` is the client half of the server-first hand-off
 * (spec §3.2.4): a route's server component prefetches with
 * `lib/data/server` and renders its client islands inside
 * `<DataHydration state={dehydrated}>` so they read the server data
 * from the cache instead of refetching on mount.
 */

import * as React from 'react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  HydrationBoundary,
  QueryClientProvider,
  type DehydratedState,
} from '@tanstack/react-query';
import {
  createSessionExpiredHandler,
  handleSessionExpired,
  registerSessionExpiredHandler,
  resetSessionExpiredGuard,
} from '../api/session-expired';
import {
  checkSessionStatus,
  SESSION_CHECK_FOCUS_THROTTLE_MS,
  SESSION_CHECK_INTERVAL_MS,
} from '../api/session-check';
import { createQueryClient } from './query-client';

export interface DataProviderProps {
  subdomain?: string | undefined;
  children: ReactNode;
}

/**
 * Global session check (session-global-check spec §2.2): the ONE
 * database-backed session check, run by every shell (this provider
 * mounts in the user, seller, and admin shells alike) on mount,
 * every 5 minutes, and on window focus (throttled to once a
 * minute). It is the only thing allowed to bounce the user for a
 * dead session, besides a foreground mutation's 401 (see
 * `lib/api/client.ts`).
 *
 * Outcomes: `active` → nothing. `dead` → the existing login
 * bounce (latched exactly-once, cache cleared, `next` = current
 * page). `error` (the check itself failed: 503, 5xx, network) →
 * neutral: no bounce, no surfaced error; the next scheduled check
 * retries. A failed check must never look like an expired session.
 */
function useGlobalSessionCheck(): void {
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      lastCheckRef.current = Date.now();
      try {
        const result = await checkSessionStatus();
        if (cancelled) return;
        if (result === 'dead') {
          await handleSessionExpired();
        }
      } finally {
        inFlightRef.current = false;
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, SESSION_CHECK_INTERVAL_MS);
    const onFocus = (): void => {
      if (Date.now() - lastCheckRef.current >= SESSION_CHECK_FOCUS_THROTTLE_MS) {
        void run();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

export function DataProvider({ subdomain, children }: DataProviderProps) {
  const [queryClient] = useState(() => createQueryClient(subdomain));

  useEffect(() => {
    resetSessionExpiredGuard();
    const unregister = registerSessionExpiredHandler(
      createSessionExpiredHandler({
        clearCache: () => {
          queryClient.clear();
        },
      })
    );
    return unregister;
  }, [queryClient]);

  useGlobalSessionCheck();

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

export interface DataHydrationProps {
  state: DehydratedState;
  children: ReactNode;
}

export function DataHydration({ state, children }: DataHydrationProps) {
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}
