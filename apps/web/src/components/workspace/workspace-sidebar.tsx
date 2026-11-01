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
 *   Pages, Publish Now, Auto Repost, Auto Download/Upload) → one collapsible
 *   group per upcoming platform, each with a single Accounts item and the
 *   testing-placeholder note (Threads also has an In-app Schedule item
 *   below Accounts) → Billing collapsible group (default open;
 *   My Plan, Purchase, Payments), last → footer.
 * - Testing platforms (platform.isTesting, currently X, TikTok, YouTube)
 *   are the exception: their group shows ONLY the testing-placeholder
 *   note — no Accounts leaf — and the group header never navigates to
 *   an accounts route; clicking it only expands/collapses the group.
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
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import { usePlanWord } from './plan-word';

export interface WorkspaceSidebarProps {
  subdomain: string;
  /** True when on the tenant's own subdomain: use clean paths (/accounts). */
  useCleanPaths?: boolean | undefined;
  /**
   * Admin-only shell: when an admin logs in, the sidebar contains
   * ONLY the Subscriptions approval section, not the user sections.
   * The approval view lives on the Billing route for admins.
   */
  adminOnly?: boolean | undefined;
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

/** Read a ?view= value out of a full href (optimistic pathname included). */
function viewFromHref(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/[?&]view=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
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

function WorkspaceSidebarContent({
  subdomain,
  useCleanPaths = false,
  workspaceName,
  user,
  adminOnly = false,
}: Readonly<WorkspaceSidebarProps>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = !isMobile && state === 'collapsed';
  // Sidebar header plan word: replaces the "Studio" word under the
  // FBUploadPro wordmark with the user's plan (Paid / Expired /
  // Free / Admin). Null while the entitlement is unresolved or the
  // check failed, so the "Studio" placeholder stays until the real
  // word is known — never a flashed or failed-as-Free plan.
  const planWord = usePlanWord(subdomain, adminOnly);
  const [isFacebookOpen, setIsFacebookOpen] = useState(true);
  const [isBillingOpen, setIsBillingOpen] = useState(true);
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
  const creatorFinderHref = href('/creator-finder');
  const accountsHref = href('/accounts');
  const pagesHref = href('/pages');
  const publishNowHref = href('/publish-now');
  const tiktokMirrorsHref = href('/tiktok-mirrors');
  const threadsAutoRepostHref = href('/threads/auto-repost');
  const billingHref = href('/billing');
  const billingMyPlanHref = href('/billing?view=my-plan');
  const billingPurchaseHref = href('/billing?view=purchase');
  const billingPaymentsHref = href('/billing?view=payments');
  const sellersHref = href('/sellers');
  const autoDownloadUploadHref = href('/auto-download-upload');

  const isHomeActive = effectivePath === normalizeTenantPath(homeHref, subdomain);
  const isMediaActive = effectivePath.startsWith(normalizeTenantPath(mediaHref, subdomain));
  const isFdolaStudioActive = effectivePath.startsWith(
    normalizeTenantPath(fdolaStudioHref, subdomain)
  );
  const isPromptsActive = effectivePath.startsWith(
    normalizeTenantPath(promptsHref, subdomain)
  );
  const isCreatorFinderActive = effectivePath.startsWith(
    normalizeTenantPath(creatorFinderHref, subdomain)
  );
  const isAccountsActive = effectivePath.startsWith(normalizeTenantPath(accountsHref, subdomain));
  const isPagesActive = effectivePath.startsWith(normalizeTenantPath(pagesHref, subdomain));
  const isPublishNowActive = effectivePath.startsWith(
    normalizeTenantPath(publishNowHref, subdomain)
  );
  const isTiktokMirrorsActive = effectivePath.startsWith(
    normalizeTenantPath(tiktokMirrorsHref, subdomain)
  );
  const isThreadsAutoRepostActive = effectivePath.startsWith(
    normalizeTenantPath(threadsAutoRepostHref, subdomain)
  );
  const isBillingActive = effectivePath.startsWith(
    normalizeTenantPath(billingHref, subdomain)
  );
  const isSellersActive = effectivePath.startsWith(
    normalizeTenantPath(sellersHref, subdomain)
  );

  /**
   * Billing sub-leaf active state. The Billing sections live behind
   * one route, selected by ?view=, so the view comes from the
   * optimistic leaf href on click (for the immediate paint) or the
   * live search params otherwise. No view means My Plan (the
   * Billing default). Purchase-internal steps are not ?view=
   * values, so a user inside Purchase always highlights Purchase.
   */
  const billingView = viewFromHref(optimisticPathname) ?? searchParams.get('view');
  const isMyPlanActive =
    isBillingActive && (billingView === null || billingView === 'my-plan');
  const isPurchaseActive = isBillingActive && billingView === 'purchase';
  const isPaymentsActive = isBillingActive && billingView === 'payments';
  const isAutoDownloadUploadActive = effectivePath.startsWith(
    normalizeTenantPath(autoDownloadUploadHref, subdomain)
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
    {
      label: 'Creator Finder',
      href: creatorFinderHref,
      isActive: isCreatorFinderActive,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
          <path d="M11 8.5a2.5 2.5 0 0 1 2.5 2.5" />
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
              <span className="text-metadata text-ink-dim">{planWord ?? 'Studio'}</span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      {adminOnly ? (
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isBillingActive} tooltip="Subscriptions approval">
                    <Link href={billingHref} onClick={() => handleLeafClick(billingHref)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      <span>Subscriptions approval</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isSellersActive} tooltip="Sellers">
                    <Link href={sellersHref} onClick={() => handleLeafClick(sellersHref)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                      <span>Sellers</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      ) : (
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
                  tooltip="Facebook — Accounts, Pages, Publish Now, Auto Repost & Auto Download/Upload"
                  isActive={
                    isCollapsed &&
                    (isAccountsActive ||
                      isPagesActive ||
                      isPublishNowActive ||
                      isTiktokMirrorsActive ||
                      isAutoDownloadUploadActive)
                  }
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
                    <NavSubLeaf label="Auto Download/Upload" href={autoDownloadUploadHref} isActive={isAutoDownloadUploadActive} onLeafClick={handleLeafClick} />
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>

              {UPCOMING_PLATFORMS.map((platform) => {
                const platformAccountsHref = href(`/${platform.routeSlug}/accounts`);
                const platformScheduleHref = href(`/${platform.routeSlug}/schedule`);
                // Threads Publish Now (feat/threads-publish-now):
                // Threads accounts are the destinations, so the
                // section lives directly under Threads. The
                // In-app Schedule leaf sits above it when the
                // Schedule branch merges; this leaf is the only
                // Threads Publish Now change in this file.
                const platformPublishNowHref = href(`/${platform.routeSlug}/publish-now`);
                const isPlatformActive = effectivePath.startsWith(`/${platform.routeSlug}`);
                const isAccountsSubActive = effectivePath.startsWith(
                  normalizeTenantPath(platformAccountsHref, subdomain)
                );
                // Instagram Schedule leaf (other Instagram leaves are
                // added by their own builders, in order, after this one).
                const instagramScheduleHref =
                  platform.key === 'instagram'
                    ? href('/instagram/schedule')
                    : null;
                const isInstagramScheduleActive =
                  instagramScheduleHref !== null &&
                  effectivePath.startsWith(
                    normalizeTenantPath(instagramScheduleHref, subdomain)
                  );
                // Instagram Publish Now leaf, after the Schedule leaf.
                const instagramPublishNowHref = href('/instagram/publish-now');
                const isInstagramPublishNowActive =
                  platform.key === 'instagram' &&
                  effectivePath.startsWith(
                    normalizeTenantPath(instagramPublishNowHref, subdomain)
                  );
                const isScheduleSubActive = effectivePath.startsWith(
                  normalizeTenantPath(platformScheduleHref, subdomain)
                );
                const isPublishNowSubActive =
                  platform.key === 'threads' &&
                  effectivePath.startsWith(
                    normalizeTenantPath(platformPublishNowHref, subdomain)
                  );
                const isOpen = openPlatforms[platform.key] ?? isPlatformActive;
                // Instagram ADU leaf only (other Instagram leaves are
                // owned by their own parallel branches, not this one).
                const igAduHref = href('/instagram/auto-download-upload');
                const isIgAduActive = effectivePath.startsWith(
                  normalizeTenantPath(igAduHref, subdomain)
                );

                return (
                  <SidebarMenuItem key={platform.key}>
                    <SidebarMenuButton
                      tooltip={platform.tooltip}
                      isActive={isCollapsed && isPlatformActive}
                      aria-expanded={isCollapsed ? undefined : isOpen}
                      onClick={() => {
                        // Testing platforms have no Accounts leaf, so
                        // their header must never navigate to an
                        // accounts route — it only expands/collapses
                        // the group to reveal the testing note.
                        if (isCollapsed && !platform.isTesting) {
                          handleNavigate(platformAccountsHref);
                        } else {
                          setOpenPlatforms((prev) => ({ ...prev, [platform.key]: !isOpen }));
                        }
                      }}
                      onMouseEnter={() => {
                        if (!platform.isTesting) handlePrefetch(platformAccountsHref);
                      }}
                    >
                      <span className="inline-flex shrink-0 items-center justify-center">
                        {platform.icon}
                      </span>
                      <span className="flex-1 truncate">{platform.label}</span>
                      <ChevronIcon open={isOpen} />
                    </SidebarMenuButton>

                    {isOpen && (
                      <SidebarMenuSub>
                        {!platform.isTesting && (
                          <NavSubLeaf label="Accounts" href={platformAccountsHref} isActive={isAccountsSubActive} onLeafClick={handleLeafClick} />
                        )}
                        {platform.key === 'threads' ? (
                          <NavSubLeaf label="In-app Schedule" href={platformScheduleHref} isActive={isScheduleSubActive} onLeafClick={handleLeafClick} />
                        ) : null}
                        {platform.key === 'threads' && (
                          <NavSubLeaf label="Publish Now" href={platformPublishNowHref} isActive={isPublishNowSubActive} onLeafClick={handleLeafClick} />
                        )}
                        {platform.key === 'threads' && (
                          <NavSubLeaf label="Auto Repost" href={threadsAutoRepostHref} isActive={isThreadsAutoRepostActive} onLeafClick={handleLeafClick} />
                        )}
                        {platform.key === 'threads' && (
                          <NavSubLeaf
                            label="Auto Download/Upload"
                            href={href('/threads/auto-download-upload')}
                            isActive={effectivePath.startsWith(
                              normalizeTenantPath(href('/threads/auto-download-upload'), subdomain)
                            )}
                            onLeafClick={handleLeafClick}
                          />
                        )}
                        {instagramScheduleHref && (
                          <NavSubLeaf label="Schedule" href={instagramScheduleHref} isActive={isInstagramScheduleActive} onLeafClick={handleLeafClick} />
                        )}
                        {platform.key === 'instagram' && (
                          <NavSubLeaf label="Publish Now" href={instagramPublishNowHref} isActive={isInstagramPublishNowActive} onLeafClick={handleLeafClick} />
                        )}
                        {/*
                          Instagram Auto Repost only. The Publish Now
                          leaf (parallel PR, merging before this one)
                          sits between Accounts and Auto Repost after
                          the merge-time rebase; this leaf is placed
                          here so it never touches another platform.
                        */}
                        {platform.key === 'instagram' && (
                          <NavSubLeaf
                            label="Auto Repost"
                            href={href('/instagram/auto-repost')}
                            isActive={effectivePath.startsWith(
                              normalizeTenantPath(href('/instagram/auto-repost'), subdomain)
                            )}
                            onLeafClick={handleLeafClick}
                          />
                        )}
                        {platform.key === 'instagram' ? (
                          <NavSubLeaf label="Auto Download/Upload" href={igAduHref} isActive={isIgAduActive} onLeafClick={handleLeafClick} />
                        ) : null}
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

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Billing — My Plan, Purchase & Payments"
                  isActive={isCollapsed && isBillingActive}
                  aria-expanded={isCollapsed ? undefined : isBillingOpen}
                  onClick={() => {
                    if (isCollapsed) {
                      handleNavigate(billingMyPlanHref);
                    } else {
                      setIsBillingOpen((prev) => !prev);
                    }
                  }}
                  onMouseEnter={() => handlePrefetch(billingMyPlanHref)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                    <rect width="20" height="14" x="2" y="5" rx="2" />
                    <line x1="2" x2="22" y1="10" y2="10" />
                  </svg>
                  <span className="flex-1 truncate">Billing</span>
                  <ChevronIcon open={isBillingOpen} />
                </SidebarMenuButton>

                {isBillingOpen && (
                  <SidebarMenuSub>
                    <NavSubLeaf label="My Plan" href={billingMyPlanHref} isActive={isMyPlanActive} onLeafClick={handleLeafClick} />
                    <NavSubLeaf label="Purchase" href={billingPurchaseHref} isActive={isPurchaseActive} onLeafClick={handleLeafClick} />
                    <NavSubLeaf label="Payments" href={billingPaymentsHref} isActive={isPaymentsActive} onLeafClick={handleLeafClick} />
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      )}

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

/**
 * Public sidebar export. The content reads ?view= (useSearchParams),
 * which Next requires inside a Suspense boundary, so the wrapper
 * provides one here and the tenant layout needs no change. The admin
 * shell is unaffected: adminOnly still renders only the
 * "Subscriptions approval" leaf inside the content component.
 */
export function WorkspaceSidebar(props: Readonly<WorkspaceSidebarProps>) {
  return (
    <React.Suspense fallback={null}>
      <WorkspaceSidebarContent {...props} />
    </React.Suspense>
  );
}
