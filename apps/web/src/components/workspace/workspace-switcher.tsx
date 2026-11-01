'use client';

/**
 * Workspace switcher + studio footer — composition (spec 130 §5.3,
 * PR-130-2b). OD130-4 = FOOTER (DECIDED 2026-10-23): the workspace
 * switcher stays in the sidebar footer's user popover. This module
 * replaces the deleted 856-line `workspace-studio-footer.tsx`:
 *
 * Module map (all under `components/workspace/`):
 * - `workspace-switcher.tsx` (this file) — the footer composition:
 *   the switcher trigger, the Popover mount, the data layer
 *   (React Query + typed client), and the switch / sign-out /
 *   theme behaviours.
 * - `workspace-switcher-list.tsx` — popover user header + workspace
 *   list (+ list/switch failure presentation with Retry).
 * - `workspace-switcher-actions.tsx` — Settings / theme / sign-out.
 * - `workspace-switcher-utils.ts` — `getMonogram`, `broadcastLogout`,
 *   `resolveActiveWorkspace`, session-cookie + logout-redirect
 *   helpers (moved here with their consumers updated; the old file
 *   is deleted with no re-export shim).
 * - `create-workspace-modal.tsx` — the Dialog-based create flow.
 *
 * Data (spec §6 duty 1): the workspace list is a React Query query
 * over the typed client (`GET /api/workspaces`,
 * `ListWorkspacesResponseSchema`, keyed via the queryKeys factory,
 * reference-data 60s staleTime class); the `workspace-updated`
 * window event invalidates that key (and renames the cached entry
 * in place, so the trigger updates in the same tick). Switch and
 * logout are mutations: switch navigates by full-page load on
 * success (tenant context changes wholesale — cache invalidation is
 * moot, stated per spec §5.3); logout clears the query cache via
 * the mutation's own `queryClient.clear()` before the redirect.
 * Zero raw `fetch(` remains.
 *
 * Failures surface (spec §6 duty 2 — these were silent before):
 * list failure keeps the current workspace visible + message +
 * Retry in the popover; switch failure shows a plain-language
 * message in the popover and clears the switching state; sign-out
 * continues even if its request fails (degraded-network sign-out
 * must not trap the user — §4.1 preserved).
 *
 * Theme: the toggle reads its initial state from the root init
 * script's resolved `documentElement.dataset.theme` and writes only
 * through the typed preferences helper plus the existing
 * `fbup_theme` cookie the init script reads (§3.3). No direct
 * web-storage access remains in the footer.
 *
 * Identity: the fabricated `displayEmail` fallback
 * (`${subdomain}@fbuploadpro.com`) is DELETED (spec 137 §4.4) —
 * the user prop is required and always comes from a real session
 * (PR-130-1 made a null session redirect in the layout).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  ListWorkspacesResponseSchema,
  SwitchWorkspaceResponseSchema,
  type WorkspaceItem,
} from '@/lib/api/schemas/workspaces';
import { queryKeys } from '@/lib/data/query-keys';
import { getPreference, preferences, setPreference } from '@/lib/storage/preferences';
import { buildTenantHref, hasSwappableSubdomain, normalizeTenantPath } from '@/lib/tenant-href';
import { getUserInitials } from '@/lib/user-initials';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/shared/ui/popover';
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from '@/components/shared/ui/sidebar';
import { CreateWorkspaceModal } from './create-workspace-modal';
import { SwitcherUserHeader, SwitcherWorkspaceList } from './workspace-switcher-list';
import { SwitcherActionsList } from './workspace-switcher-actions';
import {
  broadcastLogout,
  clearClientSessionCookies,
  redirectToLogout,
  resolveActiveWorkspace,
} from './workspace-switcher-utils';

export interface WorkspaceStudioFooterProps {
  subdomain: string;
  /** True when on the tenant's own subdomain: use clean paths (/accounts). */
  useCleanPaths?: boolean | undefined;
  /** Server-resolved display name — used until the workspace list loads. */
  workspaceName?: string | undefined;
  user: {
    name: string;
    email: string;
    avatarUrl?: string | undefined;
  };
  onNavigate?: ((href: string) => void) | undefined;
}

const LogoutResponseSchema = z.object({
  redirectUrl: z.string().optional(),
});

const SWITCH_FAILURE_MESSAGE = "Couldn't switch workspace. Please try again.";
const LIST_FAILURE_MESSAGE = "Couldn't load your workspaces.";

export function WorkspaceStudioFooter({
  subdomain,
  useCleanPaths = false,
  workspaceName,
  user,
  onNavigate,
}: Readonly<WorkspaceStudioFooterProps>) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = !isMobile && state === 'collapsed';

  const [isOpen, setIsOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isThemeDark, setIsThemeDark] = useState(true);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const displayName = user.name;
  const displayEmail = user.email;
  const isSettingsActive = pathname
    ? normalizeTenantPath(pathname, subdomain).startsWith('/settings')
    : false;

  const listKey = queryKeys.tenant(subdomain).workspaces.list;
  const workspacesQuery = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) =>
      api.get('/api/workspaces', { schema: ListWorkspacesResponseSchema, signal }),
  });

  const fallbackWorkspace: WorkspaceItem = {
    id: 'current',
    ownerId: 'current',
    name: workspaceName || subdomain,
    subdomain,
  };
  const workspaces: WorkspaceItem[] =
    workspacesQuery.data?.workspaces && workspacesQuery.data.workspaces.length > 0
      ? workspacesQuery.data.workspaces
      : [fallbackWorkspace];
  const activeWorkspace = resolveActiveWorkspace(workspaces, subdomain, workspaceName);

  // The `workspace-updated` event (dispatched by Settings on rename):
  // rename the cached entry in place, then invalidate so the list
  // refetches — the shell-visible name updates in the same tick.
  useEffect(() => {
    const handleWorkspaceUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ subdomain?: string; name?: string }>).detail;
      if (detail?.name && detail?.subdomain) {
        const targetSubdomain = detail.subdomain;
        const newName = detail.name;
        queryClient.setQueryData<{ workspaces: WorkspaceItem[] }>(listKey, (prev) =>
          prev
            ? {
                workspaces: prev.workspaces.map((w) =>
                  w.subdomain.toLowerCase() === targetSubdomain.toLowerCase()
                    ? { ...w, name: newName }
                    : w
                ),
              }
            : prev
        );
      }
      void queryClient.invalidateQueries({ queryKey: listKey });
    };

    window.addEventListener('workspace-updated', handleWorkspaceUpdated);
    return () => {
      window.removeEventListener('workspace-updated', handleWorkspaceUpdated);
    };
    // listKey is a fresh array identity per render; the subdomain is
    // the stable dependency.
  }, [subdomain, queryClient]);

  // Initial theme: the root init script has already resolved the
  // stored preference onto the document element; the typed helper is
  // the fallback read. No direct web-storage access.
  useEffect(() => {
    const docTheme = document.documentElement.dataset.theme;
    const activeTheme =
      docTheme === 'light' || docTheme === 'dark'
        ? docTheme
        : getPreference(preferences.theme);
    setIsThemeDark(activeTheme !== 'light');
  }, []);

  const switchMutation = useMutation({
    mutationFn: (targetSubdomain: string) =>
      api.post('/api/workspaces/switch', { subdomain: targetSubdomain }, {
        schema: SwitchWorkspaceResponseSchema,
      }),
    onSuccess: (data, targetSubdomain) => {
      if (isMobile) setOpenMobile(false);
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else if (useCleanPaths) {
        // On the tenant's own subdomain: switch to the target workspace's host.
        const parts = window.location.hostname.split('.');
        parts[0] = targetSubdomain;
        window.location.href = `${window.location.protocol}//${parts.join('.')}/`;
      } else if (hasSwappableSubdomain(window.location.hostname)) {
        // No clean-path flag and no server redirect: the current host
        // carries a subdomain label, so swap it for the target's and
        // land on the target workspace's own clean home (port
        // preserved, unlike the hostname-based branch above).
        const parts = window.location.host.split('.');
        parts[0] = targetSubdomain;
        window.location.href = `${window.location.protocol}//${parts.join('.')}/`;
      } else {
        window.location.href = `/tenant/${targetSubdomain}`;
      }
    },
    onError: (error) => {
      // Mechanics unchanged (§4.1); the failure now surfaces in the
      // popover instead of failing silently (spec §9 item 3).
      setSwitchError(
        isApiError(error) && error.kind === 'http'
          ? getErrorMessage(error, SWITCH_FAILURE_MESSAGE)
          : SWITCH_FAILURE_MESSAGE
      );
      setIsOpen(true);
    },
  });

  const handleSelectWorkspace = (targetSubdomain: string) => {
    if (targetSubdomain.toLowerCase() === subdomain.toLowerCase()) {
      setIsOpen(false);
      return;
    }
    setSwitchError(null);
    setIsOpen(false);
    switchMutation.mutate(targetSubdomain);
  };

  const handleOpenSettings = () => {
    setIsOpen(false);
    if (isMobile) setOpenMobile(false);
    const settingsHref = buildTenantHref(subdomain, '/settings', useCleanPaths);
    if (onNavigate) {
      onNavigate(settingsHref);
    } else {
      router.push(settingsHref);
    }
  };

  const handleToggleTheme = () => {
    const newTheme = isThemeDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = newTheme;
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(newTheme);
    setPreference(preferences.theme, newTheme);
    document.cookie = `fbup_theme=${newTheme}; path=/; max-age=31536000; SameSite=Lax`;
    setIsThemeDark(!isThemeDark);
  };

  const logoutMutation = useMutation({
    mutationFn: () =>
      api.post('/api/auth/logout', undefined, { schema: LogoutResponseSchema }),
  });

  const handleSignOut = useCallback(async () => {
    clearClientSessionCookies();
    broadcastLogout();
    let targetRedirectUrl: string | null = null;
    try {
      const data = await logoutMutation.mutateAsync();
      if (data.redirectUrl) {
        targetRedirectUrl = data.redirectUrl;
      }
    } catch {
      // Continue even if the network is degraded or offline —
      // sign-out must not trap the user (§4.1 preserved): fall
      // through to the central-login redirect below.
      targetRedirectUrl = null;
    }
    queryClient.clear();
    if (targetRedirectUrl) {
      window.location.href = targetRedirectUrl;
    } else {
      redirectToLogout();
    }
  }, [queryClient]);

  const isSigningOut = logoutMutation.isPending;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
              <SidebarMenuButton
                size="lg"
                data-testid="workspace-switcher-trigger"
                data-collapsed={isCollapsed ? 'true' : undefined}
                aria-label="Workspace and profile menu"
                aria-haspopup="true"
                aria-expanded={isOpen}
                {...(isCollapsed
                  ? { tooltip: `${activeWorkspace.name} (${displayEmail})` }
                  : {})}
                className={
                  isCollapsed ? 'h-12 w-full justify-center p-0' : 'h-12 w-full px-2 py-1'
                }
              >
                <div
                  data-testid="workspace-user-avatar"
                  className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary text-body font-bold text-on-primary"
                >
                  {getUserInitials(activeWorkspace.name || subdomain)}
                </div>

                {!isCollapsed && (
                  <div className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="truncate text-body font-semibold text-ink">
                      {activeWorkspace.name || subdomain}
                    </span>
                    <span className="truncate text-metadata text-ink-dim">{displayEmail}</span>
                  </div>
                )}

                {!isCollapsed && (
                  <svg
                    data-testid="workspace-user-caret"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="ml-auto shrink-0 text-ink-dim"
                  >
                    <path d="m7 15 5 5 5-5" />
                    <path d="m7 9 5-5 5 5" />
                  </svg>
                )}
              </SidebarMenuButton>
            </PopoverTrigger>

            <PopoverContent
              side="top"
              align="start"
              sideOffset={6}
              layer={isMobile ? 'overlayTop' : 'popover'}
              data-testid="workspace-switcher-dropdown"
              aria-label="Workspace and profile"
              className="flex w-60 flex-col gap-1 p-1"
            >
              <SwitcherUserHeader
                displayName={displayName}
                displayEmail={displayEmail}
                userInitials={getUserInitials(displayName)}
              />

              <div aria-hidden="true" className="my-0.5 h-px bg-line" />

              <SwitcherWorkspaceList
                workspaces={workspaces}
                currentSubdomain={subdomain}
                isSwitching={switchMutation.isPending}
                isLoadingList={workspacesQuery.isPending}
                listError={workspacesQuery.isError ? LIST_FAILURE_MESSAGE : null}
                switchError={switchError}
                onSelectWorkspace={handleSelectWorkspace}
                onRetryList={() => {
                  void workspacesQuery.refetch();
                }}
                onOpenCreate={() => {
                  setIsOpen(false);
                  setIsCreateOpen(true);
                }}
              />

              <div aria-hidden="true" className="my-0.5 h-px bg-line" />

              <SwitcherActionsList
                currentSubdomain={subdomain}
                isThemeDark={isThemeDark}
                isSettingsActive={isSettingsActive}
                isSigningOut={isSigningOut}
                onOpenSettings={handleOpenSettings}
                onToggleTheme={handleToggleTheme}
                onSignOut={handleSignOut}
              />
            </PopoverContent>
          </Popover>
        </SidebarMenuItem>
      </SidebarMenu>

      <CreateWorkspaceModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(newWs) => {
          setIsCreateOpen(false);
          void handleSelectWorkspace(newWs.subdomain);
        }}
      />
    </>
  );
}
