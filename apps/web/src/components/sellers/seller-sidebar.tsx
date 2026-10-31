'use client';

/**
 * Seller sidebar — the same sidebar chrome users see, with seller
 * content only: one Dashboard leaf and a sign-out footer. Sellers
 * have no workspace, so there is no workspace switcher, no plan
 * word, and no tenant navigation here.
 */

import React, { useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { z } from 'zod';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/shared/ui/sidebar';
import { Button } from '@/components/shared/ui/button';
import { api } from '@/lib/api';

const LogoutResponseSchema = z.object({
  redirectUrl: z.string().optional(),
});

export interface SellerSidebarProps {
  user: { name: string; email: string };
}

export function SellerSidebar({ user }: Readonly<SellerSidebarProps>) {
  const pathname = usePathname() ?? '';
  const isDashboardActive = pathname === '/seller' || pathname === '/seller/';

  const handleSignOut = useCallback(async () => {
    // Sign-out must not trap the seller: even if the API call
    // fails, the browser still leaves for the logged-out login.
    let target = '/login?logout=success';
    try {
      const data = await api.post('/api/auth/logout', undefined, {
        schema: LogoutResponseSchema,
      });
      if (data.redirectUrl) target = data.redirectUrl;
    } catch {
      // Fall through to the logged-out login page.
    }
    window.location.href = target;
  }, []);

  return (
    <Sidebar>
      <SidebarHeader>
        <Link href="/seller" className="flex min-w-0 items-center gap-2 px-2 py-2">
          <span className="text-body font-bold tracking-caption text-ink">FBUploadPro</span>
          <span className="text-metadata text-ink-dim">Seller</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isDashboardActive} tooltip="Dashboard">
                  <Link href="/seller">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="7" height="9" x="3" y="3" rx="1" />
                      <rect width="7" height="5" x="14" y="3" rx="1" />
                      <rect width="7" height="9" x="14" y="12" rx="1" />
                      <rect width="7" height="5" x="3" y="16" rx="1" />
                    </svg>
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
          <span className="truncate text-body font-medium text-ink">{user.name}</span>
          <span className="truncate text-metadata text-ink-dim">{user.email}</span>
          <Button variant="ghost" size="sm" className="mt-1 justify-start" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
