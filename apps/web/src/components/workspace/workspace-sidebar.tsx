'use client';

/**
 * WorkspaceSidebar — rebuilt on the shared/ui Sidebar primitive
 * (spec 130 §5.2, PR-130-2a). The primitive is the F3 rebuild of the
 * same upstream shadcn sidebar the legacy file consumed, so the
 * variant, collapsible icon mode, tooltips, and cookie persistence
 * carry over; the construction (legacy `components/ui/sidebar`
 * imports, inline styles, theme presets) is replaced wholesale.
 *
 * Behaviour preserved verbatim (spec §4.1):
 * - Structure and order: branding header (logo + wordmark, a Link to
 *   Home) → primary group (Home, Media Library, Fdola
 *   Studio) → Facebook collapsible group (default open; Accounts,
 *   Pages, Publish Now) → one collapsible group per upcoming platform, each with a
 *   single Accounts item and the testing-placeholder note → footer.
 * - Spec 110 single-click model: every leaf is a Next.js <Link> that
 *   navigates on the FIRST click; the leaf click handler only paints
 *   the active state optimistically and closes the mobile drawer — it
 *   never preventDefaults and never substitutes a router.push.
 *   Collapsible parent toggles in icon-collapsed mode navigate via
 *   router.push and warm the router cache on hover prefetch.
 * - Active state derives from the current path (Home exact-match, the
 *   rest prefix-match) with the optimistic-pathname paint on click.
 */

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarSeparator,
  SidebarRail,
  useSidebar,
} from '@/components/shared/ui/sidebar';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/brand';
import { buildTenantHref, normalizeTenantPath } from '@/lib/tenant-href';
import { WorkspaceStudioFooter } from './workspace-switcher';
import { UPCOMING_PLATFORMS, TESTING_PLACEHOLDER_TEXT } from './platform-nav-config';

export interface WorkspaceSidebarProps {
  subdomain: string;
  /** True when on the tenant's own subdomain: use clean paths (/accounts). */
  useCleanPaths?: boolean | undefined;
  /** Server-resolved display name — avoids flashing the internal slug. */
  workspaceName?: string | undefined;
  /** Always present in the tenant frame: the layout redirects to
   * login without a session, so the footer never renders anonymous. */
  user: {
    name: string;
    email: string;
    avatarUrl?: string | undefined;
  };
}

function ChevronIcon({ open }: Readonly<{ open: boolean }>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(
        'ml-auto shrink-0 text-ink-dim transition-transform duration-base ease-standard',
        open && 'rotate-90'
      )}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

interface NavLeaf {
  label: string;
  href: string;
  isActive: boolean;
  onLeafClick: (href: string) => void;
}

function NavSubLeaf({ label, href, isActive, onLeafClick }: Readonly<NavLeaf>) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={isActive}>
        <Link href={href} onClick={() => onLeafClick(href)}>
          {label}
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

export function WorkspaceSidebar({
  subdomain,
  useCleanPaths = false,
  workspaceName,
  user,
}: Readonly<WorkspaceSidebarProps>) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = !isMobile && state === 'collapsed';
  const [isFacebookOpen, setIsFacebookOpen] = useState(true);
  const [openPlatforms, setOpenPlatforms] = useState<Record<string, boolean>>({});
  const [optimisticPathname, setOptimisticPathname] = useState<string | null>(null);

  useEffect(() => {
    setOptimisticPathname(null);
  }, [pathname]);

  const effectivePath = normalizeTenantPath(optimisticPathname ?? (pathname || ''), subdomain);

  const href = (path: string) => buildTenantHref(subdomain, path, useCleanPaths);
  const homeHref = href('/');
  const mediaHref = href('/media');
  const fdolaStudioHref = href('/fdola-studio');
  const promptsHref = href('/prompts');
  const accountsHref = href('/accounts');
  const pagesHref = href('/pages');
  const publishNowHref = href('/publish-now');
  const tiktokMirrorsHref = href('/tiktok-mirrors');

  const isHomeActive = effectivePath === normalizeTenantPath(homeHref, subdomain);
  const isMediaActive = effectivePath.startsWith(normalizeTenantPath(mediaHref, subdomain));
  const isFdolaStudioActive = effectivePath.startsWith(
    normalizeTenantPath(fdolaStudioHref, subdomain)
  );
  const isPromptsActive = effectivePath.startsWith(
    normalizeTenantPath(promptsHref, subdomain)
  );
  const isAccountsActive = effectivePath.startsWith(normalizeTenantPath(accountsHref, subdomain));
  const isPagesActive = effectivePath.startsWith(normalizeTenantPath(pagesHref, subdomain));
  const isPublishNowActive = effectivePath.startsWith(
    normalizeTenantPath(publishNowHref, subdomain)
  );
  const isTiktokMirrorsActive = effectivePath.startsWith(
    normalizeTenantPath(tiktokMirrorsHref, subdomain)
  );

  const handleNavigate = (targetHref: string) => {
    setOptimisticPathname(targetHref);
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push(targetHref);
  };

  /**
   * Click observer for leaf items, which render as Next.js <Link>s
   * (spec 110). The Link performs the (client-side) navigation itself,
   * so this handler must never preventDefault or substitute its own
   * router.push — it only paints the active state immediately and
   * closes the mobile drawer.
   */
  const handleLeafClick = (targetHref: string) => {
    setOptimisticPathname(targetHref);
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  /**
   * Hover prefetch for the collapsible parent toggles only: in
   * icon-collapsed mode they still navigate via handleNavigate
   * (router.push), so warming the router cache on hover is genuinely
   * used there. Leaf items are Next.js <Link>s and prefetch natively.
   */
  const handlePrefetch = (targetHref: string) => {
    router.prefetch(targetHref);
  };

  const primaryLeaves = [
    {
      label: 'Home',
      href: homeHref,
      isActive: isHomeActive,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      ),
    },
    {
      label: 'Media Library',
      href: mediaHref,
      isActive: isMediaActive,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <polygon points="10 11 16 14 10 17 10 11" />
        </svg>
      ),
    },
    {
      label: 'Fdola Studio',
      href: fdolaStudioHref,
      isActive: isFdolaStudioActive,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" x2="16" y1="21" y2="21" />
          <line x1="12" x2="12" y1="17" y2="21" />
        </svg>
      ),
    },
    {
      label: 'Prompt Library',
      href: promptsHref,
      isActive: isPromptsActive,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12c.7.6 1 1.4 1 2h6c0-.6.3-1.4 1-2a7 7 0 0 0-4-12z" />
        </svg>
      ),
    },
  ];

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <Link
          href={homeHref}
          onClick={() => handleLeafClick(homeHref)}
          data-slot="sidebar-header-branding"
          data-testid="sidebar-branding-link"
          aria-label="FBUploadPro Studio"
          className={cn(
            'flex items-center gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link',
            isCollapsed && 'justify-center px-0'
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-line bg-canvas">
            <BrandMark size={20} />
          </div>
          {!isCollapsed && (
            <div className="flex min-w-0 flex-col">
              <span className="text-body font-bold tracking-caption text-ink">FBUploadPro</span>
              <span className="text-metadata text-ink-dim">Studio</span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryLeaves.map((leaf) => (
                <SidebarMenuItem key={leaf.label}>
                  <SidebarMenuButton asChild isActive={leaf.isActive} tooltip={leaf.label}>
                    <Link href={leaf.href} onClick={() => handleLeafClick(leaf.href)}>
                      {leaf.icon}
                      <span>{leaf.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Facebook — Accounts, Pages, Publish Now & TikTok"
                  isActive={isCollapsed && (isAccountsActive || isPagesActive || isPublishNowActive || isTiktokMirrorsActive)}
                  aria-expanded={isCollapsed ? undefined : isFacebookOpen}
                  onClick={() => {
                    if (isCollapsed) {
                      handleNavigate(accountsHref);
                    } else {
                      setIsFacebookOpen((prev) => !prev);
                    }
                  }}
                  onMouseEnter={() => handlePrefetch(accountsHref)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                  </svg>
                  <span className="flex-1 truncate">Facebook</span>
                  <ChevronIcon open={isFacebookOpen} />
                </SidebarMenuButton>

                {isFacebookOpen && (
                  <SidebarMenuSub>
                    <NavSubLeaf label="Accounts" href={accountsHref} isActive={isAccountsActive} onLeafClick={handleLeafClick} />
                    <NavSubLeaf label="Pages" href={pagesHref} isActive={isPagesActive} onLeafClick={handleLeafClick} />
                    <NavSubLeaf label="Publish Now" href={publishNowHref} isActive={isPublishNowActive} onLeafClick={handleLeafClick} />
                    <NavSubLeaf label="Auto Repost" href={tiktokMirrorsHref} isActive={isTiktokMirrorsActive} onLeafClick={handleLeafClick} />
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>

              {UPCOMING_PLATFORMS.map((platform) => {
                const platformAccountsHref = href(`/${platform.routeSlug}/accounts`);
                const isPlatformActive = effectivePath.startsWith(`/${platform.routeSlug}`);
                const isAccountsSubActive = effectivePath.startsWith(
                  normalizeTenantPath(platformAccountsHref, subdomain)
                );
                const isOpen = openPlatforms[platform.key] ?? isPlatformActive;

                return (
                  <SidebarMenuItem key={platform.key}>
                    <SidebarMenuButton
                      tooltip={platform.tooltip}
                      isActive={isCollapsed && isPlatformActive}
                      aria-expanded={isCollapsed ? undefined : isOpen}
                      onClick={() => {
                        if (isCollapsed) {
                          handleNavigate(platformAccountsHref);
                        } else {
                          setOpenPlatforms((prev) => ({ ...prev, [platform.key]: !isOpen }));
                        }
                      }}
                      onMouseEnter={() => handlePrefetch(platformAccountsHref)}
                    >
                      <span className="inline-flex shrink-0 items-center justify-center">
                        {platform.icon}
                      </span>
                      <span className="flex-1 truncate">{platform.label}</span>
                      <ChevronIcon open={isOpen} />
                    </SidebarMenuButton>

                    {isOpen && (
                      <SidebarMenuSub>
                        <NavSubLeaf label="Accounts" href={platformAccountsHref} isActive={isAccountsSubActive} onLeafClick={handleLeafClick} />
                        {platform.isTesting && (
                          <SidebarMenuSubItem>
                            <div
                              data-testid={`sidebar-testing-note-${platform.key}`}
                              className="px-2 py-1 text-metadata leading-normal tracking-body text-ink-dim select-none"
                            >
                              {TESTING_PLACEHOLDER_TEXT}
                            </div>
                          </SidebarMenuSubItem>
                        )}
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <WorkspaceStudioFooter
          subdomain={subdomain}
          useCleanPaths={useCleanPaths}
          user={user}
          workspaceName={workspaceName}
          onNavigate={handleNavigate}
        />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
