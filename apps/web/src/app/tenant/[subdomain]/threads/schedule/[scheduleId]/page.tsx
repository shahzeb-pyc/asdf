/**
 * Threads In-app Schedule detail route — server component (server-first
 * entry, interactive surface in the detail shell, same pattern as the
 * schedule list page). Detail, queue, slots and insights are prefetched
 * in parallel into the React Query cache; a failed prefetch simply
 * leaves the key out and the shell fetches on mount, where its error
 * state is the ladder rung (never silent).
 */
import * as React from 'react';

import { buildTenantApiPath } from '@/lib/api/client';
import {
  ListThreadsScheduleQueueResponseSchema,
  ListThreadsScheduleSlotsResponseSchema,
  ThreadsScheduleDetailResponseSchema,
  ThreadsScheduleInsightsResponseSchema,
} from '@fbuploadpro/contracts';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';

import ThreadsScheduleDetailLoading from './loading';
import { ThreadsScheduleDetailShell } from '@/components/threads-schedule/schedule-detail-shell';

interface ThreadsScheduleDetailPageProps {
  params: Promise<{ subdomain: string; scheduleId: string }>;
}

export default async function ThreadsScheduleDetailPage({
  params,
}: Readonly<ThreadsScheduleDetailPageProps>) {
  const { subdomain, scheduleId } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const basePath = buildTenantApiPath(subdomain, `/threads/schedule/${scheduleId}`);

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.threadsSchedule.detail(scheduleId),
      queryFn: () =>
        serverApiFetch(basePath, {
          schema: ThreadsScheduleDetailResponseSchema,
        }),
    },
    {
      queryKey: [...tenant.threadsSchedule.queue(scheduleId), 'all', 1],
      queryFn: () =>
        serverApiFetch(`${basePath}/queue?page=1&limit=${DEFAULT_PAGE_SIZE}`, {
          schema: ListThreadsScheduleQueueResponseSchema,
        }),
    },
    {
      queryKey: tenant.threadsSchedule.slots(scheduleId),
      queryFn: () =>
        serverApiFetch(`${basePath}/slots`, {
          schema: ListThreadsScheduleSlotsResponseSchema,
        }),
    },
    {
      queryKey: tenant.threadsSchedule.insights(scheduleId),
      queryFn: () =>
        serverApiFetch(`${basePath}/insights`, {
          schema: ThreadsScheduleInsightsResponseSchema,
        }),
    },
  ]);

  return (
    <DataHydration state={state}>
      <React.Suspense fallback={<ThreadsScheduleDetailLoading />}>
        <ThreadsScheduleDetailShell subdomain={subdomain} scheduleId={scheduleId} />
      </React.Suspense>
    </DataHydration>
  );
}
