'use client';

/**
 * Instagram Accounts shell — the real Instagram accounts list, modelled
 * on Facebook's `accounts-shell.tsx` (same header / filter bar / card
 * grid / pagination shape) but Instagram-only.
 *
 * Data: the Instagram-only list route
 * (`GET /api/tenant/[subdomain]/instagram/accounts`, contracts
 * `ListInstagramAccountsResponseSchema`) over the typed API client, with
 * the same React Query shape as Facebook (page + limit + search +
 * status in the key). The query key is built inline here rather than in
 * the shared `queryKeys` factory — that factory is owned by another
 * surface and this build's file ownership does not cover it; the key
 * is still tenant-scoped and parameterised, so the cache stays correct
 * (a future cleanup may move it into the factory).
 *
 * Connect: the EXISTING Instagram flow, unchanged — "Connect Instagram"
 * via `ByocGate` (missing app details → the gate's Settings prompt) to
 * `/api/connect/instagram`. No new connect modal.
 * Reconnect: same link, from an expired/expiring card. Disconnect: the
 * Instagram disconnect dialogue asks first; on success the list
 * invalidates and a success banner shows.
 */
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  DisconnectInstagramAccountResponseSchema,
  ListInstagramAccountsResponseSchema,
} from '@fbuploadpro/contracts';

import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { ByocGate } from '@/components/connect/byoc-gate';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import type { AccountStatusFilter } from '@/components/accounts/accounts-helpers';
import { FeedbackBanner } from '@/components/accounts/accounts-banners';
import {
  InstagramAccountCard,
  type InstagramAccountItem,
} from './instagram-account-card';
import { InstagramDisconnectDialog } from './instagram-disconnect-dialog';
import {
  computeInstagramSubtitleFromCounts,
  getInstagramAccountHealth,
  sortInstagramAccountsExpiredFirst,
  type InstagramAccountStatusFilter,
} from './instagram-account-health';

export interface InstagramAccountsShellProps {
  subdomain: string;
}

const INSTAGRAM_DESCRIPTION =
  'Connect your Instagram account to schedule and publish posts from one place. Your workspace uses its own Instagram app details, so your accounts stay yours.';

function InstagramConnectLink({
  subdomain,
  testId,
  size,
}: Readonly<{ subdomain: string; testId: string; size?: 'lg' | undefined }>) {
  return (
    <ByocGate platform="instagram" platformName="Instagram" subdomain={subdomain}>
      <Button asChild size={size}>
        <a
          href={`/api/connect/instagram?subdomain=${encodeURIComponent(subdomain)}`}
          data-testid={testId}
        >
          <PlusIcon aria-hidden />
          <span>Connect Instagram</span>
        </a>
      </Button>
    </ByocGate>
  );
}

function InstagramAccountsLoadingSkeleton() {
  return (
    <div
      data-testid="instagram-accounts-loading-skeleton"
      aria-busy="true"
      aria-label="Loading accounts"
      className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[1, 2].map((i) => (
        <Skeleton key={i} className="h-45 w-full rounded-md" />
      ))}
    </div>
  );
}

export function InstagramAccountsShell({ subdomain }: Readonly<InstagramAccountsShellProps>) {
  const queryClient = useQueryClient();
  const accountsPath = buildTenantApiPath(subdomain, '/instagram/accounts');
  const listKey = React.useCallback(
    (params: { page: number; limit: number; search: string; status: string }) =>
      ['tenant', subdomain, 'instagram-accounts', 'list', params] as const,
    [subdomain]
  );

  const [page, setPage] = React.useState(1);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] =
    React.useState<InstagramAccountStatusFilter>('all');

  const accountsQuery = useQuery({
    queryKey: listKey({
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: searchQuery.trim(),
      status: statusFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(accountsPath, {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        }),
        { schema: ListInstagramAccountsResponseSchema, signal }
      ),
  });

  const accounts = React.useMemo<InstagramAccountItem[]>(
    () =>
      sortInstagramAccountsExpiredFirst(
        (accountsQuery.data?.accounts ?? []) as InstagramAccountItem[]
      ),
    [accountsQuery.data]
  );
  const isLoading = accountsQuery.isPending;
  const total = accountsQuery.data?.total ?? 0;
  const totalPages = accountsQuery.data?.totalPages ?? 0;

  const [bannerNotice, setBannerNotice] = React.useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [disconnectingAccount, setDisconnectingAccount] =
    React.useState<InstagramAccountItem | null>(null);

  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/instagram/accounts/${accountId}`), {
        schema: DisconnectInstagramAccountResponseSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['tenant', subdomain, 'instagram-accounts'],
      });
      setDisconnectingAccount(null);
      setBannerNotice({ type: 'success', message: 'Account disconnected.' });
    },
    onError: (error) => {
      setBannerNotice({
        type: 'error',
        message:
          isApiError(error) && error.kind === 'http'
            ? "Couldn't disconnect account. Please refresh and try again."
            : "Couldn't disconnect the account. Please try again.",
      });
    },
  });

  const handleConfirmDisconnect = async (accountId: string) => {
    try {
      await disconnectMutation.mutateAsync(accountId);
    } catch (error) {
      reportError(error, { source: 'instagram-accounts-disconnect' });
    }
  };

  const handleSearchChange = React.useCallback((value: string) => {
    setSearchQuery(value);
    setPage(1);
  }, []);
  // The shared filter bar's type includes 'expiring_soon' (a Facebook-only
  // tab value it never emits from its All / Active / Expired tabs); map it
  // defensively to 'all' so it can never reach the Instagram state.
  const handleStatusFilterChange = React.useCallback(
    (value: AccountStatusFilter) => {
      setStatusFilter(value === 'expiring_soon' ? 'all' : value);
      setPage(1);
    },
    []
  );
  const handleClearFilters = React.useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    setPage(1);
  }, []);

  // Reconnect starts the existing Instagram connect flow; the framework
  // upserts the same social_accounts row, so it refreshes rather than
  // duplicating the account.
  const handleReconnect = React.useCallback(() => {
    window.location.href = `/api/connect/instagram?subdomain=${encodeURIComponent(subdomain)}`;
  }, [subdomain]);

  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all';
  const healthCounts = accountsQuery.data?.healthCounts;
  const expiredTotal = healthCounts?.expired ?? accounts.filter((a) => getInstagramAccountHealth(a) === 'expired').length;
  const situationalSubtitle = React.useMemo(() => {
    if (total === 0 && !isFiltered) {
      return '';
    }
    if (isFiltered) {
      return `${total} matching ${total === 1 ? 'account' : 'accounts'}`;
    }
    if (healthCounts) {
      return computeInstagramSubtitleFromCounts(total, healthCounts);
    }
    const counts = { connected: 0, expired: 0, error: 0 };
    for (const account of accounts) {
      counts[getInstagramAccountHealth(account)] += 1;
    }
    return computeInstagramSubtitleFromCounts(total, counts);
  }, [total, accounts, healthCounts, isFiltered]);

  let contentNode: React.ReactNode;
  if (isLoading) {
    contentNode = <InstagramAccountsLoadingSkeleton />;
  } else if (accountsQuery.isError && accounts.length === 0) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="instagram-accounts-load-error"
        title="Couldn't load your accounts"
        description="Please try again."
        action={
          <Button
            type="button"
            data-testid="instagram-accounts-load-retry-btn"
            onClick={() => {
              void accountsQuery.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (accounts.length === 0 && !isFiltered) {
    contentNode = (
      <div className="mx-auto my-10 w-full max-w-xl rounded-md border border-line bg-panel shadow-card">
        <EmptyState
          type="first-use"
          data-testid="instagram-accounts-empty-state"
          icon={
            <div
              aria-hidden
              className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-xl font-bold text-on-primary select-none"
            >
              IG
            </div>
          }
          title="Connect your first Instagram account"
          description={INSTAGRAM_DESCRIPTION}
          action={
            <InstagramConnectLink
              subdomain={subdomain}
              testId="instagram-connect-link"
              size="lg"
            />
          }
        />
      </div>
    );
  } else if (accounts.length === 0 && isFiltered) {
    contentNode = (
      <div
        data-testid="instagram-accounts-filter-empty"
        className="rounded-md border border-line bg-panel p-6 text-center"
      >
        <p className="mb-4 text-body text-ink-sub">
          No accounts match your search or filter.
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="instagram-accounts-clear-filters-btn"
          onClick={handleClearFilters}
        >
          Clear filters
        </Button>
      </div>
    );
  } else {
    contentNode = (
      <>
        <div
          data-testid="instagram-accounts-grid"
          className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
        >
          {accounts.map((account) => (
            <InstagramAccountCard
              key={account.id}
              account={account}
              onReconnect={handleReconnect}
              onDisconnect={(acc) => setDisconnectingAccount(acc)}
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
      data-testid="instagram-accounts-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="instagram-accounts-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Instagram Accounts
          </h1>
          {situationalSubtitle && (
            <p data-testid="instagram-accounts-page-subtitle" className="m-0 text-body text-ink-sub">
              {situationalSubtitle}
            </p>
          )}
        </div>

        {total > 0 && (
          <div className="flex flex-col items-end gap-1">
            <InstagramConnectLink
              subdomain={subdomain}
              testId="instagram-connect-link"
            />
          </div>
        )}
      </div>

      {bannerNotice && (
        <FeedbackBanner
          notice={bannerNotice}
          onDismiss={() => setBannerNotice(null)}
        />
      )}

      {!isLoading && total > 0 && (
        <AccountsFilterBar
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          attentionCount={expiredTotal}
        />
      )}

      {contentNode}

      <InstagramDisconnectDialog
        account={disconnectingAccount}
        open={Boolean(disconnectingAccount)}
        onOpenChange={(open) => !open && setDisconnectingAccount(null)}
        onConfirm={handleConfirmDisconnect}
        isDisconnecting={disconnectMutation.isPending}
      />
    </div>
  );
}
