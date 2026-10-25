/**
 * Settings route — server component (spec 135 PR-135-1, spec §6.2).
 *
 * Server-first pattern (spec 137 §3.2.4): the active tab is resolved
 * from `searchParams` here on the server (the 4 ids + the legacy
 * `byoc` → `facebook` alias + default `general`, spec §5.6 as amended
 * 2026-10-25 — youtube/x/tiktok now resolve to `general`), the
 * active tab's initial data plus the workspace list are fetched in
 * parallel, and the result is dehydrated into the React Query cache
 * the client island (`SettingsShell`) reads from — zero fetch-on-mount
 * for initial data, zero raw fetch in the subtree.
 *
 * The per-tab server-data contract is wired generically for all 4
 * tabs, keyed by the existing `queryKeys` factory:
 *   general          → workspace list only
 *   facebook / `byoc` → workspace list + `queryKeys.settings.byoc`
 *   instagram/threads → workspace list + `queryKeys.settings.platformCredentials(platform)`
 *
 * Data source: preference (2) of spec 137 §3.2.4 — the cookie-forwarding
 * server variant of the typed API client (`serverApiFetch`) against the
 * route's own API handlers, validated by the already-shipped zod
 * schemas. Preference (1) does not apply: `lib/server/` exposes no
 * function returning the settings responses (its resolvers return
 * decrypted credentials / workspace ids for server-internal use, not
 * the settings payload shape), and assembling that shape here would
 * duplicate the API routes' response construction.
 *
 * Failure handling: `prefetchQuery` never throws — a failed prefetch
 * simply leaves the key out of the dehydrated state and the client
 * island's query fetches on mount instead. Nothing fails silently at
 * the surface: the client query's error state is the ladder rung.
 *
 * `useSearchParams` discipline (spec §6.2 re-verification): the shell
 * island still reads search params (the credential panels read
 * `?notice=` themselves), so it is mounted inside a Suspense boundary
 * below — under Next 16 the bailout is contained to the island and
 * the route streams the aligned `loading.tsx` geometry meanwhile.
 * Outcome recorded in PR-135-1.
 */

import * as React from 'react';

import { ListWorkspacesResponseSchema } from '@/lib/api/schemas/workspaces';
import {
  ByocSettingsResponseSchema,
  PlatformCredentialsResponseSchema,
} from '@/lib/api/schemas/settings';
import { buildTenantApiPath } from '@/lib/api/client';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
  type ServerPrefetchEntry,
} from '@/lib/data/server';

import SettingsLoading from './loading';
import { SettingsShell } from './settings-shell';
import { resolveSettingsTab, type SettingsTab } from './settings-tabs';

interface WorkspaceSettingsPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams: Promise<{ tab?: string | string[] | undefined }>;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The server-prefetch entries for one tab (see the contract above). */
function settingsPrefetchEntries(subdomain: string, tab: SettingsTab): ServerPrefetchEntry[] {
  const tenant = queryKeys.tenant(subdomain);
  const entries: ServerPrefetchEntry[] = [
    {
      queryKey: tenant.workspaces.list,
      queryFn: () =>
        serverApiFetch('/api/workspaces', { schema: ListWorkspacesResponseSchema }),
    },
  ];

  if (tab === 'facebook') {
    entries.push({
      queryKey: tenant.settings.byoc,
      queryFn: () =>
        serverApiFetch(buildTenantApiPath(subdomain, '/settings/byoc'), {
          schema: ByocSettingsResponseSchema,
        }),
    });
  }

  if (tab === 'instagram' || tab === 'threads') {
    entries.push({
      queryKey: tenant.settings.platformCredentials(tab),
      queryFn: () =>
        serverApiFetch(
          buildTenantApiPath(subdomain, `/settings/platform-credentials/${tab}`),
          { schema: PlatformCredentialsResponseSchema }
        ),
    });
  }

  return entries;
}

export default async function WorkspaceSettingsPage({
  params,
  searchParams,
}: Readonly<WorkspaceSettingsPageProps>) {
  const { subdomain } = await params;
  const { tab: tabParam } = await searchParams;
  const activeTab = resolveSettingsTab(firstParam(tabParam));

  const queryClient = createServerQueryClient(subdomain);
  const dehydratedState = await prefetchServerQueries(
    queryClient,
    settingsPrefetchEntries(subdomain, activeTab)
  );

  return (
    <DataHydration state={dehydratedState}>
      <React.Suspense fallback={<SettingsLoading />}>
        <SettingsShell subdomain={subdomain} initialTab={activeTab} />
      </React.Suspense>
    </DataHydration>
  );
}
