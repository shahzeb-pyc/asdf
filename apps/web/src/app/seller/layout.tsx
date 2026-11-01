import type { Metadata } from 'next';
import React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionSecret, verifySessionToken } from '@fbuploadpro/contracts';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/components/shared/ui/sidebar';
import { Toaster } from '@/components/shared/ui/toast';
import { AppSidebar } from '@/components/shell/app-sidebar';
import { SELLER_SECTIONS } from '@/components/shell/sidebar-sections';
import { AccountFooter } from '@/components/shell/account-footer';
import { DataProvider } from '@/lib/data/provider';

export const metadata: Metadata = {
  title: 'Seller Dashboard',
};

/**
 * Seller frame — the same sidebar + topbar chrome as the tenant
 * frame, with seller content only. Guarded server-side with the
 * full session token (the shared getServerSessionContext drops
 * status, which this guard needs): only a seller session renders
 * it. Anything else goes to login, suspended sellers to the
 * suspended page. Middleware redirects seller sessions here
 * first; this is the backstop. Active-session enforcement (user
 * still exists, not suspended after login, password not rotated)
 * lives where it does for tenant pages: the API routes, via
 * validateSessionActive — a stale session renders the shell
 * with a load error, never seller data.
 */
export default async function SellerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let token: string | undefined;
  try {
    token = (await cookies()).get('fbup_session')?.value;
  } catch {
    token = undefined;
  }

  if (!token) {
    redirect('/login?returnUrl=%2Fseller');
  }

  let session;
  try {
    session = await verifySessionToken(token, getSessionSecret());
  } catch {
    redirect('/login?returnUrl=%2Fseller');
  }

  if (session.status === 'suspended') {
    redirect('/account-suspended');
  }
  if (session.role !== 'seller') {
    redirect('/login?returnUrl=%2Fseller');
  }

  const user = {
    name: session.name ?? session.email.split('@')[0],
    email: session.email,
  };

  return (
    <DataProvider>
      <SidebarProvider>
        <a
          href="#seller-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-sm focus:bg-panel focus:px-4 focus:py-2 focus:text-body focus:font-medium focus:text-ink focus:outline-2 focus:outline-offset-2 focus:outline-link"
        >
          Skip to content
        </a>
        <AppSidebar
          sections={SELLER_SECTIONS}
          headerWord="Seller"
          brandingHref="/seller"
          showBrandMark={false}
          brandingClassName="flex min-w-0 items-center gap-2 px-2 py-2"
          footer={<AccountFooter user={user} signOutErrorSource="seller-sign-out" />}
        />
        <SidebarInset id="seller-content" tabIndex={-1} className="scroll-mt-11">
          <header
            data-slot="seller-topbar"
            data-testid="seller-topbar"
            className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-canvas px-3"
          >
            <SidebarTrigger className="size-11" />
            <div aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
            <span className="truncate text-body font-semibold text-ink">Seller Dashboard</span>
          </header>
          <main className="flex-1 px-3 py-4 sm:px-4">{children}</main>
          <Toaster />
        </SidebarInset>
      </SidebarProvider>
    </DataProvider>
  );
}
