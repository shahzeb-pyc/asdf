/**
 * Threads accounts route — server component (Facebook Accounts
 * parity: server-first entry, interactive surface in the shell).
 *
 * The list page and the Threads platform credentials are fetched in
 * parallel here and dehydrated into the React Query cache the shell
 * reads from — zero fetch-on-mount for initial data, so the
 * OAuth-return notice effect runs with the list already loaded and
 * its name match can find the card. Both reads go through the
 * cookie-forwarding server variant of the typed API client; the BYOC
 * read shares the Settings surface's platform-credentials cache
 * entry for Threads.
 *
 * Failure handling: `prefetchQuery` never throws — a failed prefetch
 * simply leaves the key out of the dehydrated state and the shell's
 * query fetches on mount instead, where its error state is the
 * ladder rung (retry banner / load-error state, never silent).
 *
 * The shell reads search params (OAuth-return notices), so it is
 * mounted inside a Suspense boundary below — the bailout is
 * contained to the island and the route streams the aligned
 * `loading.tsx` geometry meanwhile.
 */
import * as React from 'react';

import { buildTenantApiPath, buildUrl } from '@/lib/api/client';
import { ListThreadsAccountsResponseSchema } from '@fbuploadpro/contracts';
import { PlatformCredentialsResponseSchema } from '@/lib/api/schemas/settings';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';

import ThreadsAccountsLoading from './loading';
import { ThreadsAccountsShell } from '@/components/accounts/threads-accounts-shell';

interface ThreadsAccountsPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ page?: string }>;
}

export default async function ThreadsAccountsPage({
  params,
  searchParams,
}: Readonly<ThreadsAccountsPageProps>) {
  const { subdomain } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const rawPage = Number.parseInt((await searchParams)?.page ?? '', 10);
  const initialPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.threadsAccounts.listPage({
        page: initialPage,
        limit: DEFAULT_PAGE_SIZE,
        search: '',
        status: 'all',
      }),
      queryFn: () =>
        serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/threads/accounts'), {
            page: initialPage,
            limit: DEFAULT_PAGE_SIZE,
          }),
          {
            schema: ListThreadsAccountsResponseSchema,
          }
        ),
    },
    {
      queryKey: tenant.settings.platformCredentials('threads'),
      queryFn: () =>
        serverApiFetch(
          buildTenantApiPath(subdomain, '/settings/platform-credentials/threads'),
          {
            schema: PlatformCredentialsResponseSchema,
          }
        ),
    },
  ]);

  return (
    <DataHydration state={state}>
      <React.Suspense fallback={<ThreadsAccountsLoading />}>
        <ThreadsAccountsShell subdomain={subdomain} initialPage={initialPage} />
      </React.Suspense>
    </DataHydration>
  );
}
