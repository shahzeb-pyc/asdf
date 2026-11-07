'use client';

/**
 * FreePlanGate — the route-level plan gate for the tenant shell.
 *
 * Mounted in the tenant layout around `{children}`. On every section
 * and sub-section route EXCEPT Home, Prompt Library, and Billing, a
 * user whose PROVEN entitlement plan is `free` sees a hard-block
 * upgrade dialog instead of the section content. Admins never see
 * it; exempt routes render their content immediately.
 *
 * Source of truth is the tenant layout's shared entitlement query
 * (`EntitlementProvider`): the gate reads the same query data as the
 * sidebar plan word and the billing view, so the dialog and the word
 * can never disagree within one page state. This component performs
 * NO fetch of its own.
 *
 * Free-only-when-proven: the dialog renders ONLY from a successful,
 * privilege-proven entitlement response whose plan is `free`. While
 * the check has never resolved, gated routes hold a neutral loading
 * state; when the check fails — first fetch or a refetch newer than
 * the last success — the children render with no dialog (fail-open:
 * wrongly locking a paying user out of whole sections is worse than
 * showing content the server gates still protect). While a refetch
 * is in flight the previous proven decision is kept (no skeleton
 * flash). The fail-open decision is sticky the same way: once a
 * fetch has settled unproven, later refetches keep the children
 * instead of pulling the skeletons back.
 *
 * Expired users are NOT blocked (owner decision 2026-11-07): an
 * expired plan browses like a paid plan; only publishing stops, and
 * that is enforced server-side at the action, not here. What blocks
 * is exactly one state: proven `plan === 'free'`. A proven Paid
 * response never blocks.
 *
 * No re-check loop: the gate never refetches on its own. The old
 * 30-second capped auto re-check and its "Check again" button are
 * deleted — a free user who buys a plan does so on the exempt
 * Purchase route, and the purchase flow refreshes the shared query
 * itself, so returning to a section shows it unlocked. No polling,
 * no loop, no flicker.
 *
 * Hard block: shared Dialog, controlled open, no close button, Esc
 * and outside-pointer dismissal explicitly prevented, onOpenChange
 * ignored. The only exits are Upgrade (Billing Purchase view) and
 * Back to Home — both buttons the user chooses; the gate never
 * redirects on its own.
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
  // once a fetch settles unproven. The retry is a single manual
  // tap, never a loop.
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
  // Proven free only. Expired users browse like paid users; only
  // publishing stops, enforced server-side at the action.
  if (entitlement.plan !== 'free') return <>{children}</>;

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
          <Button data-testid="free-plan-upgrade-btn" onClick={() => router.push(upgradeHref)}>
            Upgrade
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
