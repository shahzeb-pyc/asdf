'use client';

/**
 * FreePlanGate — the route-level Free-plan upgrade gate for the tenant shell.
 *
 * Mounted in the tenant layout around `{children}`. On every section and
 * sub-section route EXCEPT Home, Prompt Library, and Billing, a user whose
 * entitlement says they cannot post (Free plan, or an expired paid period)
 * sees a hard-block upgrade dialog instead of the section content. Admins
 * never see it and never trigger an entitlement fetch; exempt routes render
 * their content immediately with no fetch at all.
 *
 * Source of truth is the existing entitlement endpoint, validated with
 * EntitlementResponseSchema. No backend change: the server-side subscription
 * gates stay as the silent backstop for actions.
 *
 * Loading: gated non-admin routes hold a neutral loading state until the
 * entitlement resolves, so section content is never flashed to a Free user.
 * Fetch error: reported via reportError and the children render (fail-open
 * with a loud log — wrongly locking a paying user out of whole sections is
 * worse than showing content the server gates still protect).
 *
 * Hard block: shared Dialog, controlled open, no close button, Esc and
 * outside-pointer dismissal explicitly prevented, onOpenChange ignored.
 * The only exits are Upgrade (Billing Purchase view) and Back to Home.
 */

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { EntitlementResponseSchema } from '@fbuploadpro/contracts';
import { apiGet, buildTenantApiPath } from '@/lib/api';
import { reportError } from '@/lib/report-error';
import { buildTenantHref, normalizeTenantPath } from '@/lib/tenant-href';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Skeleton } from '@/components/shared/ui/skeleton';

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

type GateStatus = 'loading' | 'allowed' | 'blocked' | 'error-open';

export function FreePlanGate({
  subdomain,
  useCleanPaths,
  isAdmin,
  children,
}: Readonly<FreePlanGateProps>) {
  const pathname = usePathname();
  const router = useRouter();
  const exempt = isFreePlanExemptRoute(pathname, subdomain);
  const [status, setStatus] = React.useState<GateStatus>('loading');
  const liveRef = React.useRef(true);

  React.useEffect(() => {
    if (exempt || isAdmin) return;
    liveRef.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const entitlement = await apiGet(
          buildTenantApiPath(subdomain, '/billing/entitlement'),
          { schema: EntitlementResponseSchema, signal: controller.signal },
        );
        if (liveRef.current) setStatus(entitlement.canPost ? 'allowed' : 'blocked');
      } catch (err) {
        if (!liveRef.current || controller.signal.aborted) return;
        reportError(err, { source: 'free-plan-gate' });
        setStatus('error-open');
      }
    })();
    return () => {
      liveRef.current = false;
      controller.abort();
    };
  }, [exempt, isAdmin, subdomain]);

  if (exempt || isAdmin) return <>{children}</>;
  if (status === 'allowed' || status === 'error-open') return <>{children}</>;
  if (status === 'loading') {
    return (
      <div data-testid="free-plan-gate-loading" aria-busy="true" className="space-y-3 p-4">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

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
