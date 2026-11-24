'use client';

import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AnalyticsAggregateResponseSchema,
  type AnalyticsAggregateResponse,
  type AnalyticsPeriod,
} from '@fbuploadpro/contracts';
import { ChevronDownIcon, LayoutGridIcon } from 'lucide-react';
import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { ListWorkspacesResponseSchema } from '@/lib/api/schemas/workspaces';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { AnalyticsAudience } from './analytics-audience';
import { AnalyticsPerformance } from './analytics-performance';

/**
 * Analytics page (spec 241) — combined Facebook performance for one
 * workspace, or all workspaces combined. No per-page view at all.
 *
 * Data comes only from the stored analytics columns (the insights
 * worker fills them once a day); the page never calls Facebook live.
 * The workspace picker defaults to the current workspace; the period
 * defaults to 28 days. Switching workspace or period refetches, and
 * the previous numbers stay visible until the new ones arrive.
 */
export function AnalyticsPage({
  subdomain,
}: Readonly<{ subdomain: string }>): React.ReactElement {
  const tenant = queryKeys.tenant(subdomain);
  const [selectedWorkspace, setSelectedWorkspace] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState<AnalyticsPeriod>('28');

  const workspacesQuery = useQuery({
    queryKey: tenant.workspaces.list,
    queryFn: ({ signal }) =>
      api.get('/api/workspaces', { schema: ListWorkspacesResponseSchema, signal }),
  });

  const currentWorkspace = workspacesQuery.data?.workspaces.find(
    (item) => item.subdomain.toLowerCase() === subdomain.toLowerCase(),
  );
  // Default = current workspace; 'all' only when the caller has no
  // workspace of their own (or picked it explicitly).
  const effectiveWorkspace = selectedWorkspace ?? currentWorkspace?.id ?? 'all';

  const aggregateQuery = useQuery({
    queryKey: tenant.analytics.aggregate({ workspace: effectiveWorkspace, period }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, '/analytics'), {
          workspace: effectiveWorkspace,
          period,
        }),
        { schema: AnalyticsAggregateResponseSchema, signal },
      ),
    enabled: workspacesQuery.isSuccess,
    placeholderData: keepPreviousData,
  });

  const data: AnalyticsAggregateResponse | undefined = aggregateQuery.data;
  const isLoading = workspacesQuery.isPending || aggregateQuery.isPending;
  const isError = workspacesQuery.isError || aggregateQuery.isError;

  return (
    <div className="mx-auto w-full max-w-300 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-5 pb-8 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-xxxl font-bold tracking-h1 text-ink">Analytics</h1>
          <p className="mt-1.5 text-body text-ink-sub">
            Your Facebook pages&apos; performance, combined in one place.
          </p>
        </div>

        <div className="w-full md:w-76 md:shrink-0">
          <label
            htmlFor="analytics-workspace-picker"
            className="mb-1.5 block text-xs font-bold uppercase tracking-caption text-ink-dim"
          >
            Workspace
          </label>
          <div className="relative">
            <span
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
              aria-hidden="true"
            >
              <LayoutGridIcon className="size-4" />
            </span>
            <select
              id="analytics-workspace-picker"
              name="workspace"
              value={effectiveWorkspace}
              disabled={workspacesQuery.isPending}
              onChange={(event) => setSelectedWorkspace(event.target.value)}
              className="h-control-lg w-full cursor-pointer appearance-none rounded-xl border border-line-strong bg-panel py-2 pr-9 pl-9 text-body font-semibold text-ink transition-colors duration-150 hover:border-ink-dim/70 hover:bg-hover focus-visible:border-link/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="all" className="bg-panel text-ink">
                All workspaces
              </option>
              {workspacesQuery.data?.workspaces.map((item) => (
                <option key={item.id} value={item.id} className="bg-panel text-ink">
                  {item.name}
                  {item.id === currentWorkspace?.id ? ' — current workspace' : ''}
                </option>
              ))}
            </select>
            <span
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-dim"
              aria-hidden="true"
            >
              <ChevronDownIcon className="size-4" />
            </span>
          </div>
        </div>
      </header>

      {isLoading && !data ? (
        <p role="status" className="text-body text-ink-sub">
          Loading analytics…
        </p>
      ) : null}

      {isError ? (
        <div className="rounded-md border border-line bg-panel px-5 py-4">
          <p className="text-body font-semibold text-ink">Couldn&apos;t load analytics.</p>
          <p className="mt-1 text-body text-ink-sub">
            The numbers are stored from the last daily run — try again and they should load.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              void workspacesQuery.refetch();
              void aggregateQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {data ? (
        <>
          {data.hasNoData ? (
            <p className="mb-6 text-body text-ink-sub">
              No analytics data yet — Facebook only shares insights once a page is big
              enough, around 6,000–9,000 followers.
            </p>
          ) : null}
          <AnalyticsAudience data={data} />
          <AnalyticsPerformance
            data={data}
            period={period}
            onPeriodChange={setPeriod}
            isFetching={aggregateQuery.isFetching}
          />
        </>
      ) : null}
    </div>
  );
}
