/**
 * Pages route — server component (spec 131 PR-131-2, spec §8.1/§8.4).
 *
 * The former 844-line client route is decomposed: this file is the
 * server-first entry only; the interactive surface lives in
 * `pages-shell.tsx`, the toolbar in `components/pages/pages-toolbar`,
 * and the pure helpers (sorting, filtering, subtitle) in
 * `components/pages/pages-helpers.ts` with their names and behaviour
 * preserved for the parity suites.
 *
 * Server-first pattern (spec 137 §3.2.4): the pages list, the
 * accounts list, and the BYOC status are fetched in parallel here
 * and dehydrated into the React Query cache the shell reads from —
 * zero fetch-on-mount for initial data. All three reads go through
 * the cookie-forwarding server variant of the typed API client,
 * validated by the already-shipped zod schemas; the BYOC read shares
 * the Settings surface's single cache entry
 * (`queryKeys.settings.byoc`, one shape per key, spec §8.3).
 *
 * Failure handling: `prefetchServerQueries` never throws — a failed
 * prefetch simply leaves the key out of the dehydrated state and the
 * shell's query fetches on mount instead, where its error state is
 * the ladder rung (load-error state with Retry, never silent).
 */

import * as React from 'react';

import { buildTenantApiPath, buildUrl } from '@/lib/api/client';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import { ListFacebookPagesResponseSchema } from '@/lib/api/schemas/pages';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';

import PagesLoading from './loading';
import { PagesShell } from './pages-shell';

interface TenantPagesPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ page?: string }>;
}

export default async function TenantPagesPage({
  params,
  searchParams,
}: Readonly<TenantPagesPageProps>) {
  const { subdomain } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const rawPage = Number.parseInt((await searchParams)?.page ?? '', 10);
  const initialPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.pages.listPage({
        page: initialPage,
        limit: 30,
        search: '',
        status: 'all',
        account: 'all',
      }),
      queryFn: () =>
        serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/pages'), {
            page: initialPage,
            limit: 30,
          }),
          {
            schema: ListFacebookPagesResponseSchema,
          }
        ),
    },
    {
      queryKey: tenant.accounts.listPage({
        page: 1,
        limit: 50,
        search: '',
        status: 'all',
      }),
      queryFn: () =>
        serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/accounts'), {
            page: 1,
            limit: 50,
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
      <React.Suspense fallback={<PagesLoading />}>
        <PagesShell subdomain={subdomain} />
      </React.Suspense>
    </DataHydration>
  );
}
