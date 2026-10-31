/**
 * Threads In-app Schedule list route — server component (Threads
 * Accounts parity: server-first entry, interactive surface in the
 * shell). The list is prefetched in parallel into the React Query
 * cache the shell reads from, so a failed prefetch simply leaves the
 * key out and the shell fetches on mount, where its error state is
 * the ladder rung (never silent).
 */
import * as React from 'react';

import { buildTenantApiPath, buildUrl } from '@/lib/api/client';
import { ListThreadsScheduleResponseSchema } from '@fbuploadpro/contracts';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';

import ThreadsScheduleLoading from './loading';
import { ThreadsScheduleShell } from '@/components/threads-schedule/schedule-shell';

interface ThreadsSchedulePageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ page?: string }>;
}

export default async function ThreadsSchedulePage({
  params,
  searchParams,
}: Readonly<ThreadsSchedulePageProps>) {
  const { subdomain } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const rawPage = Number.parseInt((await searchParams)?.page ?? '', 10);
  const initialPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.threadsSchedule.listPage({
        page: initialPage,
        limit: DEFAULT_PAGE_SIZE,
        search: '',
        status: 'all',
        account: 'all',
      }),
      queryFn: () =>
        serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/threads/schedule'), {
            page: initialPage,
            limit: DEFAULT_PAGE_SIZE,
          }),
          {
            schema: ListThreadsScheduleResponseSchema,
          }
        ),
    },
  ]);

  return (
    <DataHydration state={state}>
      <React.Suspense fallback={<ThreadsScheduleLoading />}>
        <ThreadsScheduleShell subdomain={subdomain} initialPage={initialPage} />
      </React.Suspense>
    </DataHydration>
  );
}
