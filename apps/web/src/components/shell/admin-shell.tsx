'use client';

import React from 'react';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/shared/ui/sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { DataProvider } from '@/lib/data/provider';
import { AppSidebar } from './app-sidebar';
import { ADMIN_SECTIONS } from './sidebar-sections';
import { AccountFooter } from './account-footer';

export interface AdminShellProps {
  user: { name: string; email: string };
  children: React.ReactNode;
}

/**
 * AdminShell — the frame for the global admin section (shell
 * isolation): admin sections only, no workspace, no subdomain.
 * Deliberately ABSENT (admin sections do not need them, and their
 * presence would re-import user-shell concerns): FreePlanGate
 * (admins bypass plan gates), WorkspaceLifecycleGuard
 * (workspace-scoped), command palette (workspace-scoped items),
 * download tray (user download jobs), tenant banner slot (no admin
 * surface raises into it), PostHog identify with a tenant id (no
 * workspace context), workspace switcher, and tenant breadcrumb.
 * Toast position stays top-right, as in the tenant frame today.
 */
export function AdminShell({ user, children }: Readonly<AdminShellProps>) {
  return (
    <DataProvider>
      <SidebarProvider>
        <a
          href="#admin-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-sm focus:bg-panel focus:px-4 focus:py-2 focus:text-body focus:font-medium focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-link"
        >
          Skip to content
        </a>
        <AppSidebar
          sections={ADMIN_SECTIONS}
          headerWord="Admin"
          brandingHref="/admin/subscriptions"
          collapsible="icon"
          footer={<AccountFooter user={user} signOutErrorSource="admin-sign-out" />}
        />
        <SidebarInset id="admin-content" tabIndex={-1} className="scroll-mt-11">
          <header
            data-slot="admin-topbar"
            data-testid="admin-topbar"
            className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-canvas px-3"
          >
            <SidebarTrigger className="size-11" />
            <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
            <span className="truncate text-body font-semibold text-ink">Admin</span>
          </header>
          <main className="flex-1 px-3 py-4 sm:px-4">{children}</main>
        </SidebarInset>
        <Toaster
          position="top-right"
          offset={{ top: 'max(24px, env(safe-area-inset-top))' }}
          mobileOffset={{ top: 'max(16px, env(safe-area-inset-top))' }}
        />
      </SidebarProvider>
    </DataProvider>
  );
}
