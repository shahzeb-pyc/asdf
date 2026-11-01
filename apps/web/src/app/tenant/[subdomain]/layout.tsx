import type { Metadata } from 'next';
import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { shouldUseCleanTenantPaths } from '@/lib/tenant-href';
import { getServerSessionContext } from '@/lib/auth';
import { UserShell } from '@/components/shell/user-shell';
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

  // H5/M9: resolve the display name server-side so the sidebar and switcher
  // never flash (or stick on) the internal slug before the client fetch lands.
  const workspaceName = await getWorkspaceDisplayName(subdomain);

  const user = {
    name: session.subdomain || session.email.split('@')[0],
    email: session.email,
  };

  return (
    <UserShell
      subdomain={subdomain}
      useCleanPaths={useCleanPaths}
      user={user}
      workspaceName={workspaceName ?? undefined}
      sessionUserId={session.userId}
      sessionEmail={session.email}
    >
      {children}
    </UserShell>
  );
}
