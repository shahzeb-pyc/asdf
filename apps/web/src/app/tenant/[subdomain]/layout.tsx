import type { Metadata } from 'next';
import React, { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { shouldUseCleanTenantPaths } from '@/lib/tenant-href';
import { getServerSessionContext } from '@/lib/auth';
import { TenantShellContent } from './tenant-shell-content';
import { TenantShellSkeleton } from './tenant-shell-skeleton';
import { getWorkspaceDisplayName } from './workspace-display-name';

interface TenantLayoutProps {
  params: Promise<{ subdomain: string }>;
  children: React.ReactNode;
}

/**
 * Metadata standard (spec 137 §3.3.4 / PR-A2): tenant route titles follow
 * `<Section> · <Workspace name>`; segments export a plain section title
 * and this template appends the workspace name, resolved from the same
 * server context the layout body uses. The default is the workspace name
 * itself for segments that export no title.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}): Promise<Metadata> {
  const { subdomain } = await params;
  const workspaceName = (await getWorkspaceDisplayName(subdomain)) ?? subdomain;
  return {
    title: {
      template: `%s · ${workspaceName}`,
      default: workspaceName,
    },
  };
}

/**
 * Tenant layout — a thin role router (shell isolation). It resolves
 * the session and hands rendering to UserShell for regular users
 * only. Sellers and admins never render the tenant frame:
 *
 * - No session → login (unchanged; a null session here is a race or
 *   test path — middleware already redirects unauthenticated tenant
 *   requests, and the tenant return path rides in `returnUrl`).
 * - Seller → /seller backstop (unchanged; sellers have no workspace).
 * - Admin → /admin/subscriptions backstop (NEW — replaces the old
 *   `adminOnly` rendering; admins live in the global admin section).
 * - User → <UserShell> (the tenant frame, user sections only).
 */
export default async function TenantLayout({ params, children }: Readonly<TenantLayoutProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();

  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}`)}`);
  }

  // Sellers have no workspace and must never render the tenant
  // frame (sidebar, plan gate, lifecycle guard all assume a
  // workspace). Middleware redirects them first; this is the
  // backstop for any path that reaches the layout directly.
  if (session.role === 'seller') {
    redirect('/seller');
  }

  // Admins live in the global admin section, not the tenant frame.
  // Middleware redirects them first; this is the backstop.
  if (session.role === 'admin') {
    redirect('/admin/subscriptions');
  }

  let hostHeader: string | null = null;
  try {
    hostHeader = (await headers()).get('host');
  } catch {
    // Outside a request scope (tests, static generation): fall back to prefixed URLs.
    hostHeader = null;
  }
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'fbuploadpro.com';
  const useCleanPaths = shouldUseCleanTenantPaths(hostHeader, subdomain, rootDomain);

  const user = {
    name: session.subdomain || session.email.split('@')[0],
    email: session.email,
  };

  // Spec 152 O2 — stream the shell: this layout awaits ONLY the
  // session (JWT verify, local crypto — cheap) for the role
  // redirects above, then renders at once. The static shell
  // skeleton paints immediately; TenantShellContent resolves the
  // workspace name + entitlement seed (in parallel, O1's single
  // RPC) behind the Suspense boundary and swaps in the real shell.
  // The skeleton is plan-blind — no plan word, no pill, no gate —
  // so no plan state can flash. On client navigation the router
  // transition keeps the mounted shell visible while the new
  // segment resolves, so a stale switch does not flash the
  // skeleton either.
  return (
    <Suspense fallback={<TenantShellSkeleton />}>
      <TenantShellContent
        subdomain={subdomain}
        useCleanPaths={useCleanPaths}
        session={session}
        user={user}
      >
        {children}
      </TenantShellContent>
    </Suspense>
  );
}
