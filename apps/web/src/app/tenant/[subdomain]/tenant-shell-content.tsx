import * as React from 'react';
import type { AuthenticatedUserContext } from '@/lib/auth';
import { UserShell } from '@/components/shell/user-shell';
import { getCachedEntitlement } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapEntitlementToResponse,
} from '@/lib/billing/route-helpers';
import { logServerError } from '@/lib/server-analytics';
import { getWorkspaceDisplayName } from './workspace-display-name';

interface TenantShellContentProps {
  subdomain: string;
  useCleanPaths: boolean;
  session: AuthenticatedUserContext;
  user: {
    name: string;
    email: string;
  };
  children: React.ReactNode;
}

/**
 * Tenant shell content (spec 152 O2) — the async half of the tenant
 * layout, rendered inside the layout's Suspense boundary.
 *
 * The layout itself only awaits the session (JWT verify, local
 * crypto — cheap) for the role redirects, then streams the static
 * shell skeleton immediately. This component resolves the two
 * Supabase reads the shell needs — workspace display name and the
 * entitlement seed — in PARALLEL (they are independent; the old
 * layout awaited them one after another) and only then renders
 * `UserShell`.
 *
 * The entitlement seed keeps its exact contract (owner decision
 * 2026-11-07: once at login, cached for the session; a failed seed
 * is UNKNOWN, never Free — the provider falls back to one
 * client-side fetch on mount, and every consumer renders its
 * neutral state until a proven answer arrives). This must never
 * throw the layout — a billing outage must not take the shell down.
 * With plan-check C2 merged in, the seed is a single RPC round
 * trip (O1), so the streamed wait is one query, not ~10.
 */
export async function TenantShellContent({
  subdomain,
  useCleanPaths,
  session,
  user,
  children,
}: Readonly<TenantShellContentProps>) {
  // H5/M9: resolve the display name server-side so the sidebar and
  // switcher never flash (or stick on) the internal slug before the
  // client fetch lands.
  const [workspaceName, initialEntitlement] = await Promise.all([
    getWorkspaceDisplayName(subdomain),
    (async () => {
      try {
        const adminClient = getBillingAdminClient();
        if (adminClient) {
          return mapEntitlementToResponse(
            await getCachedEntitlement(adminClient, session.userId)
          );
        }
        logServerError('[billing] entitlement seed unavailable: admin client null', null, {
          source: 'billing',
        });
        return null;
      } catch (err) {
        logServerError('[billing] entitlement seed failed', err, { source: 'billing' });
        return null;
      }
    })(),
  ]);

  return (
    <UserShell
      subdomain={subdomain}
      useCleanPaths={useCleanPaths}
      user={user}
      workspaceName={workspaceName ?? undefined}
      sessionUserId={session.userId}
      sessionEmail={session.email}
      initialEntitlement={initialEntitlement}
    >
      {children}
    </UserShell>
  );
}
