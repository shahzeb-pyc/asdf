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
 * (no skeleton flash).
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
const EXEMPT_FIRST_SEGMENTS = new Set(['', 'prompts', 'billing']);

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
  const { entitlement, isProven, isLoading } = useSharedEntitlement();

  if (exempt || isAdmin) return <>{children}</>;
  if (!isProven || !entitlement) {
    if (isLoading) {
      return (
        <div data-testid="free-plan-gate-loading" aria-busy="true" className="space-y-3 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      );
    }
    // Unproven (fetch error or failed refetch): fail open.
    return <>{children}</>;
  }
  if (entitlement.canPost) return <>{children}</>;

  const homeHref = buildTenantHref(subdomain, '/', useCleanPaths);
  const upgradeHref = buildTenantHref(subdomain, '/billing?view=purchase', useCleanPaths);

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
