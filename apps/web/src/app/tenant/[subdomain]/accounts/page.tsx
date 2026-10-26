/**
 * Accounts route — server component (spec 131 PR-131-1, spec §8.1/§8.4).
 *
 * The former 1,208-line client route is decomposed: this file is the
 * server-first entry only; the interactive surface lives in
 * `accounts-shell.tsx`, the filter bar / banners / BYOC prompt modal
 * in `components/accounts/`, and the pure helpers (sorting, filtering,
 * subtitle, gating, OAuth-notice resolution) in
 * `components/accounts/accounts-helpers.ts` with their names and
 * behaviour preserved for the parity suites.
 *
 * Server-first pattern (spec 137 §3.2.4): the accounts list and the
 * BYOC status are fetched in parallel here and dehydrated into the
 * React Query cache the shell reads from — zero fetch-on-mount for
 * initial data. Both reads go through the cookie-forwarding server
 * variant of the typed API client, validated by the already-shipped
 * zod schemas; the BYOC read shares the Settings surface's single
 * cache entry (`queryKeys.settings.byoc`, one shape per key,
 * spec §8.3).
 *
 * Failure handling: `prefetchQuery` never throws — a failed prefetch
 * simply leaves the key out of the dehydrated state and the shell's
 * query fetches on mount instead, where its error state is the
 * ladder rung (retry banner / load-error state, never silent).
 *
 * The shell reads search params (OAuth-return notices), so it is
 * mounted inside a Suspense boundary below — under Next 16 the
 * bailout is contained to the island and the route streams the
 * aligned `loading.tsx` geometry meanwhile.
 */

import * as React from 'react';

import { buildTenantApiPath, buildUrl } from '@/lib/api/client';
import {
  ListFacebookAccountsResponseSchema,
} from '@/lib/api/schemas/accounts';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';

import AccountsLoading from './loading';
import { AccountsShell } from './accounts-shell';

interface TenantAccountsPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ page?: string }>;
}

export default async function TenantAccountsPage({
  params,
  searchParams,
}: Readonly<TenantAccountsPageProps>) {
  const { subdomain } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const rawPage = Number.parseInt((await searchParams)?.page ?? '', 10);
  const initialPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.accounts.listPage({
        page: initialPage,
        limit: 30,
        search: '',
        status: 'all',
      }),
      queryFn: () =>
        serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/accounts'), {
            page: initialPage,
            limit: 30,
          }),
          {
            schema: ListFacebookAccountsResponseSchema,
          }
        ),
    },
    {
      queryKey: tenant.settings.byoc,
      queryFn: () =>
        serverApiFetch(buildTenantApiPath(subdomain, '/settings/byoc'), {
          schema: ByocSettingsResponseSchema,
        }),
    },
  ]);

  return (
    <DataHydration state={state}>
      <React.Suspense fallback={<AccountsLoading />}>
        <AccountsShell subdomain={subdomain} />
      </React.Suspense>
    </DataHydration>
  );
}
