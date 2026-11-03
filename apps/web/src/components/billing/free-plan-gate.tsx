'use client';

/**
 * FreePlanGate — the route-level plan gate for the tenant shell.
 *
 * Mounted in the tenant layout around `{children}`. On every section
 * and sub-section route EXCEPT Home, Prompt Library, and Billing, a
 * user whose proven entitlement says they cannot post sees a
 * hard-block upgrade dialog instead of the section content. Admins
 * never see it; exempt routes render their content immediately.
 *
 * Source of truth is the tenant layout's shared entitlement query
 * (`EntitlementProvider`): the gate reads the same query data as the
 * sidebar plan word and the billing view, so the dialog and the word
 * can never disagree within one page state. This component performs
 * NO fetch of its own — the independent apiGet effect it used to
 * own is deleted.
 *
 * Free-only-when-proven: the dialog renders ONLY from a successful,
 * privilege-proven entitlement response. While the check has never
 * resolved, gated routes hold a neutral loading state; when the
 * check fails — first fetch or a refetch newer than the last
 * success — the children render with no dialog (fail-open, exactly
 * as before: wrongly locking a paying user out of whole sections is
 * worse than showing content the server gates still protect).
 * While a refetch is in flight the previous proven decision is kept
 * (no skeleton flash). The fail-open decision is sticky the same
 * way: once a fetch has settled unproven, later refetches keep the
 * children instead of pulling the skeletons back. Without stickiness
 * a gated page whose content itself reads this query (the pages
 * shell's feature-cap query refetches on mount) oscillates forever:
 * fail-open mounts the shell, the mount refetches, the pending
 * refetch shows skeletons, the skeletons unmount the shell and abort
 * its queries, the failed refetch fail-opens again — and the page
 * never renders. A sticky fail-open breaks the cycle: the shell
 * mounts once and stays, so its queries complete.
 *
 * Blocked means proven `canPost: false`. That covers Free users and
 * expired users exactly as before — same dialog, same copy, same
 * buttons — because expiry keeps the renewal funnel behind Upgrade.
 * What changed is what can never block: loading, error, unverified,
 * or stale data. A proven Paid response never blocks.
 *
 * Hard block: shared Dialog, controlled open, no close button, Esc
 * and outside-pointer dismissal explicitly prevented, onOpenChange
 * ignored. The only exits are Upgrade (Billing Purchase view) and
 * Back to Home.
 *
 * Capped self-healing re-check: while the dialog is shown for a
 * proven Free decision, the dialog itself covers the sidebar, so
 * the sidebar navigation that would normally trigger a pathname
 * re-check cannot happen — a blocked same-tab session previously
 * only recovered by a full reload. To fix that without polling
 * genuine Free users forever, the gate re-checks the shared query
 * every 30 seconds, at most 10 times, and only while the tab is
 * visible (ticks while hidden are skipped and never counted).
 * When a re-check returns Paid the dialog clears on its own; when
 * the 10th check still returns Free, auto re-checking stops and a
 * "Check again" button appears for manual re-checks. Manual taps
 * never restart auto polling, and the counter resets whenever the
 * dialog clears, the user leaves to an exempt route, or the gate
 * unmounts. A fetch error still fail-opens through the proven-only
 * path and never loops.
 */

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { buildTenantHref, normalizeTenantPath } from '@/lib/tenant-href';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { useSharedEntitlement } from './entitlement-provider';

export interface FreePlanGateProps {
  subdomain: string;
  useCleanPaths: boolean;
  isAdmin: boolean;
  children: React.ReactNode;
}

/** First path segments that never show the dialog. '' is the tenant home. */
// Separate billing sections (2026-11-02): My Plan, Purchase,
// Payments and Refund are all exempt, or a Free user clicking
// Purchase would be hard-blocked on the very page they were
// sent to buy from, with Upgrade pointing back at itself.
const EXEMPT_FIRST_SEGMENTS = new Set(['', 'prompts', 'my-plan', 'purchase', 'payments', 'refund']);

/** Capped auto re-check while the Free dialog is shown. */
const AUTO_RECHECK_INTERVAL_MS = 30_000;
const MAX_AUTO_RECHECKS = 10;

export function isFreePlanExemptRoute(pathname: string | null, subdomain: string): boolean {
  const normalized = normalizeTenantPath(pathname ?? '', subdomain);
  const first = normalized.split('/').filter(Boolean)[0] ?? '';
  return EXEMPT_FIRST_SEGMENTS.has(first);
}

export function FreePlanGate({
  subdomain,
  useCleanPaths,
  isAdmin,
  children,
}: Readonly<FreePlanGateProps>) {
  const pathname = usePathname();
  const router = useRouter();
  const exempt = isFreePlanExemptRoute(pathname, subdomain);
  const { entitlement, isProven, isLoading, isUnproven, refetch } = useSharedEntitlement();
  // Client timeout on gated loading (billing audit fix): a hung
  // entitlement fetch must not leave a section on skeletons
  // indefinitely. After 15s, offer a retry; fail-open still applies
  // once a fetch settles unproven.
  const [loadingTimedOut, setLoadingTimedOut] = React.useState(false);
  React.useEffect(() => {
    if (!isLoading) {
      setLoadingTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), 15_000);
    return () => clearTimeout(timer);
  }, [isLoading]);

  // Sticky fail-open (see the header note): once a fetch has settled
  // unproven, later refetches keep the children instead of flashing
  // the skeletons and unmounting the section. The flag is set in an
  // effect so it is already true by the time any refetch renders as
  // pending; it never resets within one shell mount, and a proven
  // decision always takes precedence over it below.
  const hasFailOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (isUnproven) hasFailOpenedRef.current = true;
  }, [isUnproven]);

  // Capped self-healing re-check (see the header note). These hooks
  // run unconditionally, before the early returns below, so the
  // interval is owned by the gate regardless of which branch renders.
  // `blocked` is true exactly while the dialog renders.
  const blocked = !exempt && !isAdmin && isProven && !!entitlement && !entitlement.canPost;
  const [autoRecheckCount, setAutoRecheckCount] = React.useState(0);
  const autoRecheckCountRef = React.useRef(0);
  // The shared query's refetch identity can change between renders;
  // the interval reads it through a ref so a new identity never
  // restarts (and thereby postpones) the 30-second cadence.
  const refetchRef = React.useRef(refetch);
  React.useEffect(() => {
    refetchRef.current = refetch;
  });
  // A new blocked episode starts from zero, and clearing to Paid,
  // leaving to an exempt route, or unmounting (cleanup below) all
  // end the current episode, so the next one is capped afresh.
  React.useEffect(() => {
    if (!blocked) {
      autoRecheckCountRef.current = 0;
      setAutoRecheckCount((previous) => (previous === 0 ? previous : 0));
    }
  }, [blocked]);
  React.useEffect(() => {
    if (!blocked) return undefined;
    if (autoRecheckCountRef.current >= MAX_AUTO_RECHECKS) return undefined;
    const timer = setInterval(() => {
      // Pause while hidden: a hidden tab must never burn checks.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      autoRecheckCountRef.current += 1;
      const performed = autoRecheckCountRef.current;
      setAutoRecheckCount(performed);
      if (performed >= MAX_AUTO_RECHECKS) clearInterval(timer);
      void refetchRef.current();
    }, AUTO_RECHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [blocked]);

  const capped = blocked && autoRecheckCount >= MAX_AUTO_RECHECKS;

  if (exempt || isAdmin) return <>{children}</>;
  if (!isProven || !entitlement) {
    if (isLoading && !hasFailOpenedRef.current) {
      return (
        <div data-testid="free-plan-gate-loading" aria-busy="true" className="space-y-3 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          {loadingTimedOut ? (
            <div className="flex flex-col gap-2 pt-2">
              <p className="text-body text-ink-sub">
                Checking your plan is taking longer than usual.
              </p>
              <div>
                <Button variant="outline" onClick={() => void refetch()}>
                  Try checking again
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    // Unproven (fetch error or failed refetch): fail open.
    return <>{children}</>;
  }
  if (entitlement.canPost) return <>{children}</>;

  const homeHref = buildTenantHref(subdomain, '/', useCleanPaths);
  const upgradeHref = buildTenantHref(subdomain, '/purchase', useCleanPaths);

  return (
    <Dialog
      open
      onOpenChange={() => {
        // Hard block: Radix must never close this dialog on its own.
      }}
    >
      <DialogContent
        data-testid="free-plan-upgrade-dialog"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>You're on the Free plan</DialogTitle>
        <DialogDescription>
          This feature needs a paid plan. Upgrade to use it.
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            data-testid="free-plan-home-btn"
            onClick={() => router.push(homeHref)}
          >
            Back to Home
          </Button>
          {capped ? (
            <Button
              variant="outline"
              data-testid="free-plan-recheck-btn"
              onClick={() => {
                // Manual re-check only: this never restarts auto polling.
                void refetch();
              }}
            >
              Check again
            </Button>
          ) : null}
          <Button data-testid="free-plan-upgrade-btn" onClick={() => router.push(upgradeHref)}>
            Upgrade
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
