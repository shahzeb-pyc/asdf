'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import {
  ListThreadsScheduleCandidatesResponseSchema,
  ListThreadsScheduleResponseSchema,
  type ThreadsScheduleItem,
} from '@fbuploadpro/contracts';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { queryKeys } from '@/lib/data';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast } from '@/components/shared/ui/toast';
import { Banner } from '@/components/shared/ui/banner';
import { Input } from '@/components/shared/ui/input';
import { ThreadsScheduleCard } from './schedule-card';
import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';
import { AddThreadsScheduleDialog } from './add-schedule-dialog';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'expired', label: 'Expired' },
  { value: 'disconnected', label: 'Disconnected' },
  { value: 'rate_limited', label: 'Rate limited' },
] as const;

function LoadingSkeleton() {
  return (
    <div
      data-testid="threads-schedule-loading-skeleton"
      aria-busy="true"
      aria-label="Loading scheduled accounts"
      className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[1, 2].map((i) => (
        <Skeleton key={i} className="h-45 w-full rounded-md" />
      ))}
    </div>
  );
}

export function ThreadsScheduleShell({
  subdomain,
  initialPage = 1,
}: Readonly<{ subdomain: string; initialPage?: number }>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenant = queryKeys.tenant(subdomain);
  const [page, setPage] = React.useState(initialPage);
  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearch = useDebouncedValue(searchQuery);
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [accountFilter, setAccountFilter] = React.useState<string>('all');
  const [addOpen, setAddOpen] = React.useState(false);
  // Plan cap: the Add account button disables at the cap, and the
  // schedule add route enforces the same cap server-side.
  const { cap: threadsCap } = useFeatureCap(subdomain, 'threads');

  const candidatesQuery = useQuery({
    queryKey: tenant.threadsSchedule.candidates,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/threads/schedule/candidates'), {
        schema: ListThreadsScheduleCandidatesResponseSchema,
        signal,
      }),
    staleTime: 60_000,
  });
  const accountOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const candidate of candidatesQuery.data?.candidates ?? []) {
      if (candidate.scheduleAdded && !seen.has(candidate.accountId)) {
        seen.set(candidate.accountId, candidate.displayName);
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [candidatesQuery.data]);

  const listPath = buildTenantApiPath(subdomain, '/threads/schedule');
  const listQuery = useQuery({
    queryKey: tenant.threadsSchedule.listPage({
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: debouncedSearch.trim(),
      status: statusFilter,
      account: accountFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(listPath, {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          ...(accountFilter !== 'all' ? { account: accountFilter } : {}),
        }),
        { schema: ListThreadsScheduleResponseSchema, signal }
      ),
    placeholderData: keepPreviousData,
  });

  const items: ThreadsScheduleItem[] = React.useMemo(
    () =>
      (listQuery.data?.items ?? []).map((item) => ({
        ...item,
        addedAt: new Date(item.addedAt),
        createdAt: new Date(item.createdAt),
        updatedAt: new Date(item.updatedAt),
      })),
    [listQuery.data]
  );
  const total = listQuery.data?.total ?? 0;
  const totalPages = listQuery.data?.totalPages ?? 0;

  React.useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, accountFilter]);

  const onAdded = React.useCallback(
    (name: string) => {
      setAddOpen(false);
      toast.success(`${name} added to In-app Schedule`);
    },
    []
  );

  return (
    <div className="flex flex-col gap-6">
      <Toast />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title font-bold text-ink">In-app Schedule</h1>
          <p className="mt-1 text-body text-ink-dim">
            Schedule and publish Threads posts from the accounts you add here.
            Only accounts you add appear here — connect more accounts in
            Threads Accounts first.
          </p>
          {threadsCap ? (
            <FeatureCapText cap={threadsCap} platform="threads" />
          ) : null}
        </div>
        <Button type="button" onClick={() => setAddOpen(true)} disabled={threadsCap?.atCap ?? false}>
          <PlusIcon aria-hidden className="size-4" />
          Add account
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Search scheduled accounts"
          placeholder="Search by name or handle"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="max-w-80"
        />
        <label className="flex items-center gap-2 text-body text-ink-dim">
          Status
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-sm border border-line bg-panel px-2 py-2 text-body text-ink"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-body text-ink-dim">
          Account
          <select
            aria-label="Filter by account"
            value={accountFilter}
            onChange={(event) => setAccountFilter(event.target.value)}
            className="rounded-sm border border-line bg-panel px-2 py-2 text-body text-ink"
          >
            <option value="all">All accounts</option>
            {accountOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {listQuery.isError ? (
        <Banner variant="critical" title="Could not load scheduled accounts">
          Something went wrong loading this list. Try again, and if it keeps
          happening, reconnect the account in Threads Accounts.
        </Banner>
      ) : listQuery.isPending ? (
        <LoadingSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          type="first-use"
          title="No accounts in In-app Schedule yet"
          description="Add a connected Threads account here to give it posting times and a queue. Accounts themselves are connected in Threads Accounts."
          action={
            <div className="flex flex-col items-center gap-3">
              {threadsCap ? (
                <FeatureCapText cap={threadsCap} platform="threads" />
              ) : null}
              <div className="flex flex-wrap justify-center gap-3">
                <Button type="button" onClick={() => setAddOpen(true)} disabled={threadsCap?.atCap ?? false}>
                  Add account
                </Button>
                <Button type="button" variant="outline" asChild>
                  <Link href={`/tenant/${subdomain}/threads/accounts`}>
                    Go to Threads Accounts
                  </Link>
                </Button>
              </div>
            </div>
          }
        />
      ) : (
        <>
          <p className="text-metadata text-ink-dim" aria-live="polite">
            {total} {total === 1 ? 'account' : 'accounts'} in In-app Schedule
          </p>
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <ThreadsScheduleCard key={item.id} item={item} subdomain={subdomain} />
            ))}
          </div>
          {totalPages > 1 ? (
            <ListPagination
              page={page}
              total={total}
              limit={DEFAULT_PAGE_SIZE}
              totalPages={totalPages}
              onPageChange={(next) => {
                setPage(next);
                router.replace(
                  `/tenant/${subdomain}/threads/schedule?${new URLSearchParams({
                    ...Object.fromEntries(searchParams.entries()),
                    page: String(next),
                  }).toString()}`,
                  { scroll: false }
                );
              }}
            />
          ) : null}
        </>
      )}

      <AddThreadsScheduleDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        subdomain={subdomain}
        onAdded={onAdded}
      />
    </div>
  );
}
