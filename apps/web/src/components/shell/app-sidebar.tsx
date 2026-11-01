'use client';

/**
 * AppSidebar — THE sidebar component (shell isolation). It owns ONLY
 * generic behavior, carried over verbatim from the two sidebars it
 * replaces (WorkspaceSidebar, SellerSidebar):
 *
 * - Structure: branding header → sections → footer, on the shared/ui
 *   Sidebar primitive, collapsible icon mode for user/admin and the
 *   primitive's offcanvas default for the seller frame.
 * - Spec 110 single-click model: every leaf is a Next.js <Link> that
 *   navigates on the FIRST click; the leaf click handler only paints
 *   the active state optimistically and closes the mobile drawer —
 *   it never preventDefaults and never substitutes a router.push.
 *   Collapsible parent toggles in icon-collapsed mode navigate via
 *   router.push and warm the router cache on hover prefetch.
 * - Active state derives from the current path (exact-match for
 *   home/dashboard leaves, prefix-match otherwise, ?view= matching
 *   for view leaves) with the optimistic-pathname paint on click.
 *
 * The engine must NOT know roles, must NOT call usePlanWord, and
 * must NOT contain per-role branches. Role differences live ONLY in
 * the section configs (sidebar-sections.ts) and the shells' header /
 * footer composition: sections, headerWord, brandingHref,
 * showBrandMark, footer, collapsible, and normalizePath are all
 * props.
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
import type {
  SidebarSections,
  SidebarLeaf,
  SidebarCollapsibleGroup,
} from './sidebar-sections';

export interface AppSidebarProps {
  sections: SidebarSections;
  /** Rendered node under the wordmark — plan word, or static Admin/Seller. */
  headerWord: React.ReactNode;
  /** Home link target per role. */
  brandingHref: string;
  /** User/admin show the BrandMark box; the seller header is text-only. */
  showBrandMark?: boolean | undefined;
  brandingClassName?: string | undefined;
  /** Footer node, or a render function receiving the sidebar navigate. */
  footer: React.ReactNode | ((navigate: (href: string) => void) => React.ReactNode);
  collapsible?: 'offcanvas' | 'icon' | 'none' | undefined;
  /** Path normalizer for active-state comparison (tenant paths). */
  normalizePath?: ((path: string) => string) | undefined;
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

/** Read a ?view= value out of a full href (optimistic pathname included). */
function viewFromHref(href: string | null): string | null {
  if (!href) return null;
  const match = href.match(/[?&]view=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function pathOf(href: string): string {
  return href.split('?')[0]?.split('#')[0] ?? href;
}

function AppSidebarContent({
  sections,
  headerWord,
  brandingHref,
  showBrandMark = true,
  brandingClassName,
  footer,
  collapsible = 'offcanvas',
  normalizePath = (path: string) => path,
}: Readonly<AppSidebarProps>) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = !isMobile && state === 'collapsed';
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [optimisticPathname, setOptimisticPathname] = useState<string | null>(null);

  useEffect(() => {
    setOptimisticPathname(null);
  }, [pathname]);

  const effectivePath = normalizePath(optimisticPathname ?? (pathname || ''));
  const currentView = viewFromHref(optimisticPathname) ?? searchParams.get('view');

  const leafActive = (leaf: Omit<SidebarLeaf, 'kind'>, group?: SidebarCollapsibleGroup): boolean => {
    if (leaf.match === 'view') {
      if (!group?.matchPath) return false;
      const inGroup = effectivePath.startsWith(normalizePath(pathOf(group.matchPath)));
      if (!inGroup) return false;
      // No view means the default section (My Plan).
      if (leaf.view === 'my-plan') return currentView === null || currentView === 'my-plan';
      return currentView === leaf.view;
    }
    const leafPath = normalizePath(pathOf(leaf.href));
    if (leaf.match === 'exact') {
      return effectivePath === leafPath || effectivePath === `${leafPath}/`;
    }
    return effectivePath.startsWith(leafPath);
  };

  const groupActive = (group: SidebarCollapsibleGroup): boolean => {
    if (group.activePrefix && effectivePath.startsWith(normalizePath(group.activePrefix))) {
      return true;
    }
    return group.leaves.some((leaf) => leafActive(leaf, group));
  };

  const isGroupOpen = (group: SidebarCollapsibleGroup): boolean =>
    openGroups[group.key] ?? group.defaultOpen ?? groupActive(group);

  const handleNavigate = (targetHref: string) => {
    setOptimisticPathname(targetHref);
    if (isMobile) {
      setOpenMobile(false);
    }
    router.push(targetHref);
  };

  const handleLeafClick = (targetHref: string) => {
    setOptimisticPathname(targetHref);
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const handlePrefetch = (targetHref: string) => {
    router.prefetch(targetHref);
  };

  const renderLeaf = (leaf: Omit<SidebarLeaf, 'kind'>, group?: SidebarCollapsibleGroup) => {
    if (group) {
      return (
        <SidebarMenuSubItem key={leaf.label}>
          <SidebarMenuSubButton asChild isActive={leafActive(leaf, group)}>
            <Link href={leaf.href} onClick={() => handleLeafClick(leaf.href)}>
              {leaf.label}
            </Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    }
    return (
      <SidebarMenuItem key={leaf.label}>
        <SidebarMenuButton asChild isActive={leafActive(leaf)} tooltip={leaf.label}>
          <Link href={leaf.href} onClick={() => handleLeafClick(leaf.href)}>
            {leaf.icon}
            <span>{leaf.label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  const renderGroup = (group: SidebarCollapsibleGroup) => {
    const active = groupActive(group);
    const open = isGroupOpen(group);
    return (
      <SidebarMenuItem key={group.key}>
        <SidebarMenuButton
          tooltip={group.tooltip ?? group.label}
          isActive={isCollapsed && active}
          aria-expanded={isCollapsed ? undefined : open}
          onClick={() => {
            if (isCollapsed && group.parentHref) {
              handleNavigate(group.parentHref);
            } else {
              setOpenGroups((prev) => ({ ...prev, [group.key]: !open }));
            }
          }}
          onMouseEnter={() => {
            if (group.parentHref) handlePrefetch(group.parentHref);
          }}
        >
          {group.icon}
          <span className="flex-1 truncate">{group.label}</span>
          <ChevronIcon open={open} />
        </SidebarMenuButton>

        {open && (
          <SidebarMenuSub>
            {group.leaves.map((leaf) => renderLeaf(leaf, group))}
            {group.testingNote && (
              <SidebarMenuSubItem>
                <div
                  data-testid={`sidebar-testing-note-${group.key}`}
                  className="px-2 py-1 text-metadata leading-normal tracking-body text-ink-dim select-none"
                >
                  {group.testingNote}
                </div>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible={collapsible} variant="sidebar">
      <SidebarHeader>
        <Link
          href={brandingHref}
          onClick={() => handleLeafClick(brandingHref)}
          data-slot="sidebar-header-branding"
          data-testid="sidebar-branding-link"
          aria-label="FBUploadPro Studio"
          className={cn(
            brandingClassName ??
              'flex items-center gap-2 rounded-sm px-2 py-1.5 outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-link',
            isCollapsed && 'justify-center px-0'
          )}
        >
          {showBrandMark && (
            <div className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-line bg-canvas">
              <BrandMark size={20} />
            </div>
          )}
          {!isCollapsed && (
            <div className="flex min-w-0 flex-col">
              <span className="text-body font-bold tracking-caption text-ink">FBUploadPro</span>
              <span className="text-metadata text-ink-dim">{headerWord}</span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section, sectionIndex) => (
          <React.Fragment key={section.key}>
            {sectionIndex > 0 && <SidebarSeparator />}
            <SidebarGroup>
              {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) =>
                    item.kind === 'leaf' ? renderLeaf(item) : renderGroup(item)
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </React.Fragment>
        ))}
      </SidebarContent>

      <SidebarFooter>
        {typeof footer === 'function' ? footer(handleNavigate) : footer}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Public sidebar export. The content reads ?view= (useSearchParams),
 * which Next requires inside a Suspense boundary, so the wrapper
 * provides one here and the shells need no change.
 */
export function AppSidebar(props: Readonly<AppSidebarProps>) {
  return (
    <React.Suspense fallback={null}>
      <AppSidebarContent {...props} />
    </React.Suspense>
  );
}
