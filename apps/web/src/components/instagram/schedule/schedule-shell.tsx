'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { ListInstagramAccountsResponseSchema } from '@fbuploadpro/contracts';
import {
  ListInstagramScheduleResponseSchema,
  type InstagramScheduleItem,
} from '@/lib/api/schemas/instagram-schedule';
import { queryKeys } from '@/lib/data/query-keys';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast } from '@/components/shared/ui/toast';
import { ScheduleCard } from './schedule-card';
import { AddScheduleModal } from './add-schedule-modal';

/**
 * Instagram Schedule list shell — the Pages shell's structure for
 * Instagram: URL pagination (?page=), search, status filter, account
 * filter, attention-first order from the API, card grid, Add flow
 * with toast + gold highlight on success. Accounts here are the
 * already-connected Instagram accounts (fetched page by page, like
 * the Pages shell's complete accounts read); only accounts the user
 * adds in this section appear as cards.
 */

const SCHEDULE_TOASTER_ID = 'instagram-schedule-toaster';

type ScheduleStatusFilter = 'all' | 'active' | 'paused' | 'expired' | 'disconnected';

const STATUS_OPTIONS: Array<{ value: ScheduleStatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'active', label: 'Connected' },
  { value: 'paused', label: 'Paused' },
  { value: 'expired', label: 'Session expired' },
  { value: 'disconnected', label: 'Disconnected' },
];

export function ScheduleShell({ subdomain }: Readonly<{ subdomain: string }>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const initialPage = React.useMemo(() => {
    const raw = Number.parseInt(searchParams.get('page') ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
  }, []);
  const [page, setPage] = React.useState(initialPage);
  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery);
  const [statusFilter, setStatusFilter] =
    React.useState<ScheduleStatusFilter>('all');
  const [accountFilter, setAccountFilter] = React.useState('all');
  const [isAddModalOpen, setIsAddModalOpen] = React.useState(false);
  const [highlightedIds, setHighlightedIds] = React.useState<string[]>([]);

  const listQuery = useQuery({
    queryKey: tenant.instagramSchedule.listPage({
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: debouncedSearchQuery.trim(),
      status: statusFilter,
      account: accountFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, '/instagram/schedule'), {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(debouncedSearchQuery.trim()
            ? { search: debouncedSearchQuery.trim() }
            : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          ...(accountFilter !== 'all' ? { account: accountFilter } : {}),
        }),
        { schema: ListInstagramScheduleResponseSchema, signal }
      ),
  });

  const accountsQuery = useQuery({
    queryKey: [...tenant.all, 'instagram', 'accounts', 'list', 'all'] as const,
    queryFn: async ({ signal }) => {
      const all: Array<{ id: string; displayName: string }> = [];
      const seenIds = new Set<string>();
      let currentPage = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const data = await api.get(
          buildUrl(buildTenantApiPath(subdomain, '/instagram/accounts'), {
            page: currentPage,
            limit: 50,
          }),
          { schema: ListInstagramAccountsResponseSchema, signal }
        );
        const batch = data.accounts ?? [];
        if (batch.length === 0) break;
        let added = false;
        for (const account of batch) {
          if (account.id && !seenIds.has(account.id)) {
            seenIds.add(account.id);
            all.push({ id: account.id, displayName: account.displayName });
            added = true;
          }
        }
        if (!added) break;
        total = data.total;
        currentPage += 1;
      }
      return all;
    },
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = listQuery.data?.totalPages ?? 0;
  const isFiltered =
    debouncedSearchQuery.trim().length > 0 ||
    statusFilter !== 'all' ||
    accountFilter !== 'all';

  const handleSelect = React.useCallback(
    (item: InstagramScheduleItem) => {
      router.push(`/tenant/${subdomain}/instagram/schedule/${item.id}`);
    },
    [router, subdomain]
  );

  const handleAdded = React.useCallback(
    (destinationId: string) => {
      toast.success('Instagram account added to Schedule', {
        toasterId: SCHEDULE_TOASTER_ID,
      });
      setHighlightedIds([destinationId]);
      setSearchQuery('');
      setStatusFilter('all');
      setAccountFilter('all');
      setPage(1);
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.list,
      });
    },
    [queryClient, tenant.instagramSchedule.list]
  );

  let contentNode: React.ReactNode;
  if (listQuery.isPending) {
    contentNode = (
      <div
        data-testid="instagram-schedule-loading-skeleton"
        aria-busy="true"
        aria-label="Loading scheduled accounts"
        className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
      >
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-50 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (listQuery.isError && items.length === 0) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="instagram-schedule-load-error"
        title="Couldn't load your scheduled accounts"
        description="Please try again."
        action={
          <Button type="button" onClick={() => void listQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  } else if (items.length === 0 && !isFiltered) {
    contentNode = (
      <EmptyState
        type="no-results"
        data-testid="instagram-schedule-empty"
        title="No Instagram accounts in Schedule yet"
        description="Add an Instagram account you have already connected, choose its timezone and posting times, and posts you create here will go out on that schedule."
        action={
          <Button type="button" onClick={() => setIsAddModalOpen(true)}>
            <PlusIcon aria-hidden />
            <span>Add account</span>
          </Button>
        }
      />
    );
  } else if (items.length === 0 && isFiltered) {
    contentNode = (
      <div className="rounded-md border border-line bg-panel">
        <EmptyState
          type="no-results"
          title="No scheduled accounts match your search or filter."
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
                setAccountFilter('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      </div>
    );
  } else {
    contentNode = (
      <>
        <div
          data-testid="instagram-schedule-grid"
          className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
        >
          {items.map((item) => (
            <ScheduleCard
              key={item.id}
              item={item}
              subdomain={subdomain}
              highlighted={highlightedIds.includes(item.id)}
              onSelect={handleSelect}
            />
          ))}
        </div>
        <ListPagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={DEFAULT_PAGE_SIZE}
          onPageChange={setPage}
        />
      </>
    );
  }

  return (
    <div
      data-testid="instagram-schedule-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="instagram-schedule-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Instagram Schedule
          </h1>
          <p
            data-testid="instagram-schedule-page-subtitle"
            className="m-0 text-body text-ink-sub"
          >
            {total === 0 && !isFiltered
              ? 'Accounts you add here post on the schedule you set.'
              : `${total} scheduled ${total === 1 ? 'account' : 'accounts'}`}
          </p>
        </div>
        <Button
          type="button"
          data-testid="header-add-schedule-btn"
          onClick={() => setIsAddModalOpen(true)}
        >
          <PlusIcon aria-hidden />
          <span>Add account</span>
        </Button>
      </div>

      <Toast id={SCHEDULE_TOASTER_ID} position="top-right" />

      {!listQuery.isPending && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Input
            data-testid="instagram-schedule-search-input"
            type="search"
            placeholder="Search accounts"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setPage(1);
            }}
            className="max-w-80"
          />
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value as ScheduleStatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger
              data-testid="instagram-schedule-status-filter"
              aria-label="Filter by status"
              className="w-45"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={accountFilter}
            onValueChange={(value) => {
              setAccountFilter(value);
              setPage(1);
            }}
          >
            <SelectTrigger
              data-testid="instagram-schedule-account-filter"
              aria-label="Filter by account"
              className="w-60"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {(accountsQuery.data ?? []).map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {contentNode}

      <AddScheduleModal
        subdomain={subdomain}
        open={isAddModalOpen}
        onOpenChange={setIsAddModalOpen}
        onSuccess={handleAdded}
      />
    </div>
  );
}
