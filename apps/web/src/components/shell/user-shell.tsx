'use client';

import React from 'react';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/shared/ui/sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { WorkspaceBreadcrumb } from '@/components/workspace/workspace-breadcrumb';
import { CommandPaletteHost } from '@/components/shell/command-palette-host';
import { DownloadTray } from '@/components/shell/download-tray';
import { WorkspaceLifecycleGuard } from '@/components/workspace/workspace-lifecycle-guard';
import { FreePlanGate } from '@/components/billing/free-plan-gate';
import { EntitlementProvider } from '@/components/billing/entitlement-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { DataProvider } from '@/lib/data/provider';
import { normalizeTenantPath, buildTenantHref } from '@/lib/tenant-href';
import { WorkspaceStudioFooter } from '@/components/workspace/workspace-switcher';
import { usePlanWord } from '@/components/workspace/plan-word';
import { AppSidebar } from './app-sidebar';
import { getUserSections } from './sidebar-sections';

export interface UserShellProps {
  subdomain: string;
  useCleanPaths: boolean;
  user: {
    name: string;
    email: string;
    avatarUrl?: string | undefined;
  };
  workspaceName?: string | undefined;
  sessionUserId: string;
  sessionEmail: string;
  children: React.ReactNode;
}

/**
 * Sidebar header word for the user shell. Reads the shared
 * entitlement query owned by the tenant layout (via the provider
 * this shell mounts) — never a separate plan API and never a second
 * fetch. Kept as its own component because it must render INSIDE
 * the provider; UserShell itself renders the provider.
 */
function UserHeaderWord() {
  const planWord = usePlanWord(false);
  return <>{planWord ?? 'Studio'}</>;
}

/**
 * UserShell — the tenant frame for regular users only (shell
 * isolation): the current tenant layout body, extracted verbatim
 * apart from the admin branch removal. Admins never render here:
 * the tenant layout redirects them to /admin/subscriptions first,
 * so the gate's isAdmin is always false and the sidebar's plan word
 * never resolves to Admin in this shell.
 */
export function UserShell({
  subdomain,
  useCleanPaths,
  user,
  workspaceName,
  sessionUserId,
  sessionEmail,
  children,
}: Readonly<UserShellProps>) {
  return (
    <DataProvider subdomain={subdomain}>
      {/* The one entitlement query for the whole shell: the gate,
          the sidebar plan word, and the billing view all read this
          provider's data, so they can never disagree. */}
      <EntitlementProvider subdomain={subdomain} adminOnly={false}>
      <SidebarProvider>
        {/* Skip link: the frame's first focusable element (spec 130 §5.1). */}
        <a
          href="#tenant-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-sm focus:bg-panel focus:px-4 focus:py-2 focus:text-body focus:font-medium focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-link"
        >
          Skip to content
        </a>
        <WorkspaceLifecycleGuard userId={sessionUserId} userEmail={sessionEmail} />
        {/* PostHog identify: tenant shell already holds the session. */}
        <PostHogIdentify userId={sessionUserId} tenantId={subdomain} />
        <AppSidebar
          sections={getUserSections(subdomain, useCleanPaths)}
          headerWord={<UserHeaderWord />}
          brandingHref={buildTenantHref(subdomain, '/', useCleanPaths)}
          collapsible="icon"
          normalizePath={(path: string) => normalizeTenantPath(path, subdomain)}
          footer={(navigate) => (
            <WorkspaceStudioFooter
              subdomain={subdomain}
              useCleanPaths={useCleanPaths}
              user={user}
              workspaceName={workspaceName}
              onNavigate={navigate}
            />
          )}
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
            <FreePlanGate
              subdomain={subdomain}
              useCleanPaths={useCleanPaths}
              isAdmin={false}
            >
              {children}
            </FreePlanGate>
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
        {/*
          Download tray (spec 149): shell-level, mounted on every
          tenant page so progress survives section navigation. It
          reads only the jobs endpoint — no page props needed.
        */}
        <DownloadTray subdomain={subdomain} useCleanPaths={useCleanPaths} />
        <Toaster
          position="top-right"
          offset={{ top: 'max(24px, env(safe-area-inset-top))' }}
          mobileOffset={{ top: 'max(16px, env(safe-area-inset-top))' }}
        />
      </SidebarProvider>
      </EntitlementProvider>
    </DataProvider>
  );
}
