'use client';

/**
 * Command palette — the ⌘K surface (spec 130 §5.6, PR-130-4).
 *
 * Home: `components/shell/` (named here per plan.md PR-130-4 — the
 * palette is shell chrome, not workspace-switcher machinery).
 *
 * Pool (OD130-3, DECIDED: the §5.6 minimum only — no media/queue
 * search, no backend search endpoint):
 * - "Go to" — every sidebar destination (incl. each platform's
 *   Accounts page and Settings).
 * - "Accounts & Pages" — the current workspace's Facebook accounts,
 *   Facebook pages, and cross-platform accounts,
 *   read from the React Query cache and refreshed through it (the
 *   queries below are keyed via the queryKeys factory and enabled
 *   only while the palette is open — never a per-keystroke server
 *   round-trip, UI Rule 20).
 * - "Workspaces" — the user's workspaces; a switch row restates its
 *   target workspace name (UX Rule 2).
 * - "Actions" — Create Workspace, Settings, the theme toggle,
 *   Toggle Sidebar (hint ⌘B), Sign Out.
 * Every one of these also exists visibly elsewhere in the UI
 * (sidebar, footer popover, switcher) — the palette supplements the
 * visible UI, never replaces it (UI Rules 19–20; the inventory is in
 * the PR description).
 *
 * Behaviour: opens from the host's ⌘K/Ctrl+K listener or the header
 * button (OD130-6); Esc closes and focus returns to the invoker via
 * the Dialog primitive; recents (last five chosen items, a device
 * preference written through the typed preferences helper) show
 * first while the query is empty; shortcut hints ride on rows that
 * have them. Open is instant — destinations/actions render from local
 * data immediately; a cold accounts/pages cache shows skeleton rows
 * at final geometry, and a failed refresh keeps any cached rows
 * usable under a non-blocking note (spec §8.5 palette row).
 */

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, getErrorMessage, isApiError } from '@/lib/api';
import {
  ListFacebookAccountsResponseSchema,
  ListSocialAccountsResponseSchema,
} from '@/lib/api/schemas/accounts';
import { ListFacebookPagesResponseSchema } from '@/lib/api/schemas/pages';
import {
  ListWorkspacesResponseSchema,
  SwitchWorkspaceResponseSchema,
} from '@/lib/api/schemas/workspaces';
import { queryKeys } from '@/lib/data/query-keys';
import { buildTenantHref } from '@/lib/tenant-href';
import { definePreference, getPreference, preferences, setPreference } from '@/lib/storage/preferences';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/shared/ui/command';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { useSidebar } from '@/components/shared/ui/sidebar';
import { toast } from '@/components/shared/ui/toast';
import { UPCOMING_PLATFORMS } from '@/components/workspace/platform-nav-config';
import { CreateWorkspaceModal } from '@/components/workspace/create-workspace-modal';
import {
  broadcastLogout,
  clearClientSessionCookies,
  redirectToLogout,
} from '@/components/workspace/workspace-switcher-utils';

export interface CommandPaletteProps {
  subdomain: string;
  useCleanPaths?: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Recents are a device preference — written only through the typed
 * preferences helper (spec 137 §3.9), never direct storage access. */
const recentsPreference = definePreference(
  'command-palette-recents',
  z.array(z.string()),
  [] as string[]
);

const MAX_RECENTS = 5;
const SWITCH_FAILURE_MESSAGE = "Couldn't switch workspace. Please try again.";
const REFRESH_FAILURE_NOTE = "Some lists couldn't be refreshed — showing what's already loaded.";
const LogoutResponseSchema = z.object({ redirectUrl: z.string().optional() });

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  /** Secondary context shown after the label (platform, kind, target). */
  detail?: string | undefined;
  shortcut?: string | undefined;
  keywords: string;
  run: () => void;
}

export function CommandPalette({
  subdomain,
  useCleanPaths = false,
  open,
  onOpenChange,
}: Readonly<CommandPaletteProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const tenant = queryKeys.tenant(subdomain);
  const href = (path: string) => buildTenantHref(subdomain, path, useCleanPaths);

  // Pool queries — React Query cache reads, refreshed via the data
  // layer while the palette is open (reference-data staleTime class).
  const workspacesQuery = useQuery({
    queryKey: tenant.workspaces.list,
    queryFn: ({ signal }) =>
      api.get('/api/workspaces', { schema: ListWorkspacesResponseSchema, signal }),
    enabled: open,
  });
  const fbAccountsQuery = useQuery({
    queryKey: tenant.accounts.list,
    queryFn: ({ signal }) =>
      api.get(`/api/tenant/${subdomain}/accounts`, {
        schema: ListFacebookAccountsResponseSchema,
        signal,
      }),
    enabled: open,
  });
  const fbPagesQuery = useQuery({
    queryKey: tenant.pages.list,
    queryFn: ({ signal }) =>
      api.get(`/api/tenant/${subdomain}/pages`, {
        schema: ListFacebookPagesResponseSchema,
        signal,
      }),
    enabled: open,
  });
  const socialQuery = useQuery({
    queryKey: tenant.accounts.socialList,
    queryFn: ({ signal }) =>
      api.get(`/api/tenant/${subdomain}/accounts/social`, {
        schema: ListSocialAccountsResponseSchema,
        signal,
      }),
    enabled: open,
  });

  const switchMutation = useMutation({
    mutationFn: (targetSubdomain: string) =>
      api.post('/api/workspaces/switch', { subdomain: targetSubdomain }, {
        schema: SwitchWorkspaceResponseSchema,
      }),
    onSuccess: (data, targetSubdomain) => {
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else if (useCleanPaths) {
        const parts = window.location.hostname.split('.');
        parts[0] = targetSubdomain;
        window.location.href = `${window.location.protocol}//${parts.join('.')}/`;
      } else {
        window.location.href = `/tenant/${targetSubdomain}`;
      }
    },
    onError: (error) => {
      toast.error(
        isApiError(error) && error.kind === 'http'
          ? getErrorMessage(error, SWITCH_FAILURE_MESSAGE)
          : SWITCH_FAILURE_MESSAGE
      );
    },
  });

  const close = () => onOpenChange(false);

  const handleToggleTheme = () => {
    const current =
      document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark'
        ? document.documentElement.dataset.theme
        : getPreference(preferences.theme);
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(next);
    setPreference(preferences.theme, next);
    document.cookie = `fbup_theme=${next}; path=/; max-age=31536000; SameSite=Lax`;
  };

  const handleSignOut = async () => {
    clearClientSessionCookies();
    broadcastLogout();
    let targetRedirectUrl: string | null = null;
    try {
      const data = await api.post('/api/auth/logout', undefined, {
        schema: LogoutResponseSchema,
      });
      if (data.redirectUrl) targetRedirectUrl = data.redirectUrl;
    } catch {
      // Degraded-network sign-out must not trap the user (§4.1).
      targetRedirectUrl = null;
    }
    queryClient.clear();
    if (targetRedirectUrl) {
      window.location.href = targetRedirectUrl;
    } else {
      redirectToLogout();
    }
  };

  const items = useMemo<PaletteItem[]>(() => {
    const navigate = (path: string) => () => {
      close();
      router.push(href(path));
    };
    const pool: PaletteItem[] = [
      { id: 'go-home', group: 'Go to', label: 'Home', keywords: 'home dashboard workspace', run: navigate('/') },
      { id: 'go-media', group: 'Go to', label: 'Media Library', keywords: 'media library files uploads downloads', run: navigate('/media') },
      { id: 'go-fdola', group: 'Go to', label: 'Fdola Studio', keywords: 'fdola studio', run: navigate('/fdola-studio') },
      { id: 'go-accounts', group: 'Go to', label: 'Accounts', detail: 'Facebook', keywords: 'facebook accounts connect', run: navigate('/accounts') },
      { id: 'go-pages', group: 'Go to', label: 'Pages', detail: 'Facebook', keywords: 'facebook pages', run: navigate('/pages') },
      { id: 'go-settings', group: 'Go to', label: 'Settings', keywords: 'settings workspace profile', run: navigate('/settings') },
      ...UPCOMING_PLATFORMS.map((platform) => ({
        id: `go-${platform.key}-accounts`,
        group: 'Go to',
        label: 'Accounts',
        detail: platform.label,
        keywords: `${platform.label.toLowerCase()} accounts`,
        run: navigate(`/${platform.routeSlug}/accounts`),
      })),
    ];

    for (const account of fbAccountsQuery.data?.accounts ?? []) {
      pool.push({
        id: `fb-account-${account.id}`,
        group: 'Accounts & Pages',
        label: account.displayName,
        detail: 'Facebook account',
        keywords: `facebook account ${account.displayName}`,
        run: navigate('/accounts'),
      });
    }
    for (const page of fbPagesQuery.data?.pages ?? []) {
      pool.push({
        id: `fb-page-${page.id}`,
        group: 'Accounts & Pages',
        label: page.pageName,
        detail: 'Facebook Page',
        keywords: `facebook page ${page.pageName}`,
        run: navigate(`/pages/${page.id}`),
      });
    }
    for (const account of socialQuery.data?.accounts ?? []) {
      pool.push({
        id: `social-account-${account.id}`,
        group: 'Accounts & Pages',
        label: account.displayName,
        detail: `${account.platform} account`,
        keywords: `${account.platform} account ${account.displayName}`,
        run: navigate('/accounts'),
      });
      // Destinations pages were removed: no palette entry points at a
      // destination view anymore. Facebook Pages stay reachable through
      // their own entries above; other platforms' destinations are
      // managed from their Accounts pages.
    }

    for (const workspace of workspacesQuery.data?.workspaces ?? []) {
      const isCurrent = workspace.subdomain.toLowerCase() === subdomain.toLowerCase();
      pool.push({
        id: `workspace-${workspace.subdomain}`,
        group: 'Workspaces',
        label: isCurrent ? `${workspace.name} (current workspace)` : `Switch to ${workspace.name}`,
        detail: 'Workspace',
        keywords: `workspace switch ${workspace.name} ${workspace.subdomain}`,
        run: () => {
          close();
          if (!isCurrent) switchMutation.mutate(workspace.subdomain);
        },
      });
    }

    pool.push(
      {
        id: 'action-create-workspace',
        group: 'Actions',
        label: 'Create Workspace',
        keywords: 'create new workspace',
        run: () => {
          close();
          setIsCreateOpen(true);
        },
      },
      {
        id: 'action-settings',
        group: 'Actions',
        label: 'Settings',
        keywords: 'settings preferences',
        run: navigate('/settings'),
      },
      {
        id: 'action-theme',
        group: 'Actions',
        label: 'Toggle Light / Dark Mode',
        keywords: 'theme light mode dark mode',
        run: () => {
          close();
          handleToggleTheme();
        },
      },
      {
        id: 'action-toggle-sidebar',
        group: 'Actions',
        label: 'Toggle Sidebar',
        shortcut: '⌘B',
        keywords: 'sidebar toggle collapse expand navigation',
        run: () => {
          close();
          toggleSidebar();
        },
      },
      {
        id: 'action-sign-out',
        group: 'Actions',
        label: 'Sign Out',
        keywords: 'sign out log out logout',
        run: () => {
          close();
          void handleSignOut();
        },
      }
    );
    return pool;
    // The pool rebuilds when its data inputs change; the run
    // closures read router/state setters that are stable across
    // renders, so they are deliberately not dependencies.
  }, [
    fbAccountsQuery.data,
    fbPagesQuery.data,
    socialQuery.data,
    workspacesQuery.data,
    subdomain,
    useCleanPaths,
  ]);

  const isPoolLoading =
    (fbAccountsQuery.isPending || fbPagesQuery.isPending || socialQuery.isPending || workspacesQuery.isPending) &&
    !fbAccountsQuery.data &&
    !fbPagesQuery.data &&
    !socialQuery.data &&
    !workspacesQuery.data;
  const hasRefreshFailure =
    fbAccountsQuery.isError || fbPagesQuery.isError || socialQuery.isError || workspacesQuery.isError;

  const recentItems = recents
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is PaletteItem => Boolean(item));

  const groups = useMemo(() => {
    const order = ['Go to', 'Accounts & Pages', 'Workspaces', 'Actions'];
    return order
      .map((group) => ({ group, rows: items.filter((item) => item.group === group) }))
      .filter((entry) => entry.rows.length > 0);
  }, [items]);

  // Every open starts from a clean query with recents re-read from
  // the device preference (the host opens via prop, Radix events
  // only cover closes — so this lives in an open-transition effect,
  // not in onOpenChange).
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setRecents(getPreference(recentsPreference));
      setQuery('');
    }
    wasOpenRef.current = open;
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
  };

  const runItem = (item: PaletteItem) => {
    const nextRecents = [item.id, ...recents.filter((id) => id !== item.id)].slice(0, MAX_RECENTS);
    setRecents(nextRecents);
    setPreference(recentsPreference, nextRecents);
    item.run();
  };

  const renderItem = (item: PaletteItem) => (
    <CommandItem
      key={item.id}
      value={`${item.id} ${item.label} ${item.keywords}`}
      onSelect={() => runItem(item)}
      data-testid={`palette-item-${item.id}`}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.detail ? <span className="shrink-0 text-metadata text-ink-dim">{item.detail}</span> : null}
      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
    </CommandItem>
  );

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Search and commands"
        description="Search destinations, accounts, pages, workspaces and actions in this workspace."
      >
        <Command label="Search and commands" shouldFilter>
          <CommandInput
            placeholder="Search destinations, accounts, pages, actions…"
            value={query}
            onValueChange={setQuery}
            data-testid="command-palette-input"
          />
          <CommandList data-testid="command-palette-list">
            {!isPoolLoading && (
              <CommandEmpty>
                <EmptyState
                  type="no-results"
                  title={`No results for "${query}"`}
                  description="Try a destination, an account or page name, or an action."
                  activeFilters={[query]}
                  action={
                    <Button type="button" variant="outline" onClick={() => setQuery('')}>
                      Clear search
                    </Button>
                  }
                />
              </CommandEmpty>
            )}
            {isPoolLoading ? (
              <div className="flex flex-col gap-1 p-1" aria-busy="true" aria-label="Loading results">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : (
              <>
                {query === '' && recentItems.length > 0 && (
                  <CommandGroup heading="Recents">{recentItems.map(renderItem)}</CommandGroup>
                )}
                {groups.map((entry) => (
                  <CommandGroup key={entry.group} heading={entry.group}>
                    {entry.rows.map(renderItem)}
                  </CommandGroup>
                ))}
              </>
            )}
            {hasRefreshFailure && (
              <p role="status" className="border-t border-line px-3 py-2 text-metadata text-ink-dim">
                {REFRESH_FAILURE_NOTE}
              </p>
            )}
          </CommandList>
        </Command>
      </CommandDialog>

      <CreateWorkspaceModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(newWorkspace) => {
          setIsCreateOpen(false);
          // §4.1: creation ends by arriving in the new workspace's home.
          window.location.href = `/tenant/${newWorkspace.subdomain}`;
        }}
      />
    </>
  );
}
