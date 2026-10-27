import type { Metadata } from 'next';
import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { shouldUseCleanTenantPaths } from '@/lib/tenant-href';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/shared/ui/sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { WorkspaceSidebar } from '@/components/workspace/workspace-sidebar';
import { WorkspaceBreadcrumb } from '@/components/workspace/workspace-breadcrumb';
import { CommandPaletteHost } from '@/components/shell/command-palette-host';
import { WorkspaceLifecycleGuard } from '@/components/workspace/workspace-lifecycle-guard';
import { getServerSessionContext } from '@/lib/auth';
import { DataProvider } from '@/lib/data/provider';
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
 * Tenant frame (spec 130 §5.1, PR-130-1): rebuilt on the shared/ui
 * Sidebar primitive — provider, inset and header trigger come from
 * `components/shared/ui/sidebar`, styling is token-backed utilities
 * only, and the shell mounts the one Toaster system plus the Banner
 * slot every tenant surface raises into.
 *
 * Provider state (spec 130 §11, closed by PR-130-2b): PR-130-1 left a
 * legacy provider nested inside this frame as the designed transition
 * state while the sidebar and footer migrated. PR-130-2a/2b migrated
 * both, the legacy `components/ui/sidebar.tsx` is deleted, and this
 * frame is now single-provider: the shared/ui `SidebarProvider` is
 * the one sidebar state — the header trigger and Cmd/Ctrl+B drive
 * exactly it.
 *
 * Identity (spec 137 §4.4): a null server session NEVER renders a
 * shell with invented identity data. Middleware already redirects
 * unauthenticated tenant requests, so a null session here is a race
 * or test path — it resolves via redirect to login, carrying the
 * tenant return path in the `returnUrl` parameter the login flow
 * already honours for tenant redirects (the middleware convention).
 */
export default async function TenantLayout({ params, children }: Readonly<TenantLayoutProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();

  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}`)}`);
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
    <DataProvider subdomain={subdomain}>
      <SidebarProvider>
        {/* Skip link: the frame's first focusable element (spec 130 §5.1). */}
        <a
          href="#tenant-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-sm focus:bg-panel focus:px-4 focus:py-2 focus:text-body focus:font-medium focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-brand-gold"
        >
          Skip to content
        </a>
        <WorkspaceLifecycleGuard userId={session.userId} userEmail={session.email} />
        <WorkspaceSidebar
          subdomain={subdomain}
          useCleanPaths={useCleanPaths}
          user={user}
          workspaceName={workspaceName ?? undefined}
        />
        <SidebarInset id="tenant-content" tabIndex={-1} className="scroll-mt-11">
            <header
              data-slot="workspace-topbar"
              data-testid="workspace-topbar"
              className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-canvas px-3"
            >
              <SidebarTrigger className="size-11" />
              <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
              <WorkspaceBreadcrumb subdomain={subdomain} useCleanPaths={useCleanPaths} />
              {/*
                ⌘K palette trigger (spec 130 §5.6, OD130-6: YES — the
                visible search-style header button ships alongside the
                keyboard shortcut). The host is the palette's only
                frame-bundle part; the palette itself loads via
                next/dynamic on first open (PR-130-4's one mount edit
                to this layout).
              */}
              <CommandPaletteHost subdomain={subdomain} useCleanPaths={useCleanPaths} />
            </header>
            {/*
              Banner slot (spec 130 §5.1): the shell-level region directly
              under the header where a persistent page/account-level Banner
              (shared/ui) renders when a surface or the shell raises one.
              Surfaces render their Banner into `#tenant-banner-slot`; no
              banner is raised at baseline.
            */}
            <div id="tenant-banner-slot" data-slot="tenant-banner-slot" />
            {children}
        </SidebarInset>
        {/*
          Tenant toasts sit top-right (not the shared default
          bottom-right): the flow-scoped Accounts/Pages toasters already
          use top-right, and dedicated-page feedback (automation
          paused/resumed, publishing, slots, timezone) must be visible
          at once, not below the fold. Top offset mirrors the shared
          bottom offset (24px desktop / 16px mobile) against the top
          safe-area inset, so toasts never hug the very edge.
        */}
        <Toaster
          position="top-right"
          offset={{ top: 'max(24px, env(safe-area-inset-top))' }}
          mobileOffset={{ top: 'max(16px, env(safe-area-inset-top))' }}
        />
      </SidebarProvider>
    </DataProvider>
  );
}
