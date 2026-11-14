'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/shared/ui/sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { WorkspaceBreadcrumb } from '@/components/workspace/workspace-breadcrumb';
import { CommandPaletteHost } from '@/components/shell/command-palette-host';
import { TopbarPlanPill } from '@/components/shell/topbar-plan-pill';
import { WorkspaceLifecycleGuard } from '@/components/workspace/workspace-lifecycle-guard';
import type { EntitlementResponse } from '@fbuploadpro/contracts';
import { FreePlanGate } from '@/components/billing/free-plan-gate';
import { EntitlementProvider } from '@/components/billing/entitlement-provider';
import { PostHogIdentify } from '@/components/posthog-identify';
import { DataProvider } from '@/lib/data/provider';
import { normalizeTenantPath, buildTenantHref } from '@/lib/tenant-href';
import { WorkspaceStudioFooter } from '@/components/workspace/workspace-switcher';
import { usePlanWord } from '@/components/workspace/plan-word';
import { AppSidebar } from './app-sidebar';
import { getUserSections } from './sidebar-sections';

/**
 * Spec 152 O3 — the download tray loads after first paint. It is a
 * fixed-position overlay that renders nothing when no downloads
 * exist, so deferring its chunk costs no layout shift: it appears
 * exactly when a download does, via the jobs query it mounts with.
 * `ssr: false` keeps it out of the server HTML entirely.
 */
const DownloadTray = dynamic(
  () => import('@/components/shell/download-tray').then((module) => module.DownloadTray),
  { ssr: false }
);

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
  /**
   * The entitlement the tenant layout read on the server for this
   * document. Null when the server read failed — the provider then
   * fetches once from the API route on mount instead.
   */
  initialEntitlement?: EntitlementResponse | null | undefined;
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
  initialEntitlement,
  children,
}: Readonly<UserShellProps>) {
  return (
    <DataProvider subdomain={subdomain}>
      {/* The one entitlement query for the whole shell: the gate,
          the sidebar plan word, and the billing view all read this
          provider's data, so they can never disagree. It starts
          from the layout's server seed and never refetches on its
          own — once per session, refreshed only after a purchase
          or a manual refresh. */}
      <EntitlementProvider subdomain={subdomain} adminOnly={false} initialEntitlement={initialEntitlement}>
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
          showGoldActiveBar
          // Spec 187 header (57px + hairline, user shell only): the
          // default branding class with py-1.5 → py-1 — the brand
          // text column is ~40px, so 8px header padding + 41px link
          // (40px text + 1px border) lands the header at ~57px.
          // border-b is the hairline; -mx-2 bleeds it edge to edge
          // past the header's p-2, and -mb-2 drops it onto the
          // header's bottom edge (the negative bottom margin shrinks
          // the header by the same 8px the border fills).
          // Radius (spec 190 — back to Squared): the branding link is a
          // nav element, so it takes rounded-sm (6px) under the
          // 4/6/8 ladder — the nav step.
          brandingClassName="flex items-center gap-2 rounded-sm border-b border-line -mx-2 -mb-2 px-2 py-1 outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
          footer={(navigate) => (
            // Spec 187 footer hairline + 12px padding, user shell
            // only: the wrapper bleeds edge to edge (-mx-2) and
            // pulls up over the footer's p-2 (-mt-2) so the border-t
            // sits on the footer's top edge; pt-3 + pb-1 then put
            // 12px above and below the 56px card, as in the mockup.
            <div className="-mx-2 -mt-2 border-t border-line px-2 pt-3 pb-1">
              <WorkspaceStudioFooter
                subdomain={subdomain}
                useCleanPaths={useCleanPaths}
                user={user}
                workspaceName={workspaceName}
                onNavigate={navigate}
              />
            </div>
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
                Right cluster: plan pill immediately left of the ⌘K
                search, gap-2 only. The cluster carries the header
                row's SINGLE auto margin: exactly one ml-auto, on
                this wrapper. The pill itself carries no auto margin
                and the search button's own ml-auto has no free
                space inside this shrink-0 cluster, so the two can
                never split the free space again and float the pill
                into the middle of the header (the merged pill bug:
                two auto margins distribute free space equally).
                ⌘K palette trigger (spec 130 §5.6, OD130-6: YES — the
                visible search-style header button ships alongside the
                keyboard shortcut). The host is the palette's only
                frame-bundle part; the palette itself loads via
                next/dynamic on first open (PR-130-4's one mount edit
                to this layout).
              */}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <TopbarPlanPill subdomain={subdomain} useCleanPaths={useCleanPaths} />
                <CommandPaletteHost subdomain={subdomain} useCleanPaths={useCleanPaths} />
              </div>
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
