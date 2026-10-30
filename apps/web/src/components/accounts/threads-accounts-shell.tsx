'use client';

/**
 * Threads accounts shell — the Threads accounts list, modelled on the
 * Facebook Accounts shell (same architecture, same UI and features),
 * Threads data only.
 *
 * Architecture (Facebook parity): the server page prefetches the list
 * page + the Threads platform credentials into DataHydration; this
 * shell reads them with React Query (`keepPreviousData` — no skeleton
 * flash on search/page/disconnect refetches; skeleton only while the
 * first page is pending). The BYOC read shares the Settings surface's
 * platform-credentials cache entry, so the Settings page and this
 * page never disagree about whether Threads app details are saved.
 *
 * Connect is an in-page modal (ThreadsConnectModal) with the same two
 * options as Facebook's: "This Browser" direct OAuth and "Different
 * Browser or Phone" magic link. A gated click (known-missing Threads
 * App ID/Secret) opens the Threads BYOC prompt modal instead of
 * leaving a disabled button with nowhere to go. Gating semantics
 * match Facebook: gated only when app details are known to be
 * missing — never while the check runs, and never when the check
 * itself fails (a retry banner covers that case instead).
 *
 * Connect completion lands HERE (never generic /accounts): the
 * complete route and the callback's Threads denial redirect both
 * carry Facebook's notice params, resolved by
 * `resolveThreadsOAuthRedirectNotice` — success toasts
 * "`<name> connected`" (green flow-scoped toast) + a 5-second gold
 * highlight of that card; already-connected and mismatch stay as a
 * persistent banner. The once-only notice effect runs only after
 * the accounts query has data, so the name match can actually find
 * the card (server prefetch means data is there on first render).
 */
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import {
  DisconnectThreadsAccountResponseSchema,
  ListThreadsAccountsResponseSchema,
} from '@fbuploadpro/contracts';
import { PlatformCredentialsResponseSchema } from '@/lib/api/schemas/settings';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { queryKeys } from '@/lib/data';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast, type ToasterProps } from '@/components/shared/ui/toast';
import { Banner } from '@/components/shared/ui/banner';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import type { AccountStatusFilter } from '@/components/accounts/accounts-helpers';
import { isConnectGatedByMissingCredentials } from '@/components/accounts/accounts-helpers';
import {
  ByocGatePrompt,
} from '@/components/connect/byoc-gate';
import {
  ThreadsAccountCard,
  type ThreadsAccountItem,
} from './threads-account-card';
import { ThreadsDisconnectDialog } from './threads-disconnect-dialog';
import { ThreadsConnectModal } from './threads-connect-modal';
import { ThreadsByocConfigPromptModal } from './threads-byoc-config-prompt-modal';
import {
  computeThreadsSubtitle,
  computeThreadsSubtitleFromCounts,
  resolveThreadsOAuthRedirectNotice,
  sortThreadsAccountsExpiredFirst,
} from './threads-accounts-helpers';

const THREADS_CONNECT_TOASTER_ID = 'threads-accounts-connect-toaster';

/** Green flow-scoped toast styling, copied from Facebook's ACCOUNTS_CONNECT_TOAST_OPTIONS. */
const THREADS_CONNECT_TOAST_OPTIONS: NonNullable<ToasterProps['toastOptions']> = {
  classNames: {
    toast:
      'group toast group flex items-start gap-2 rounded-md border border-brand-emerald bg-brand-emerald/15 p-4 text-body text-ink shadow-elevated',
    title: 'font-medium',
    description: 'text-ink-sub',
    actionButton: 'bg-primary text-on-primary rounded-sm px-3 h-9 font-medium',
    cancelButton: 'bg-subtle text-ink rounded-sm px-3 h-9 font-medium',
    closeButton: 'text-ink-sub hover:text-ink',
    success: 'text-brand-emerald border-brand-emerald bg-brand-emerald/15',
    error: 'text-signal-critical',
    warning: 'text-link',
    info: 'text-ink',
  },
};

const THREADS_DESCRIPTION =
  'Connect your Threads account to schedule and publish posts from one place. Your workspace uses its own Threads app details, so your accounts stay yours.';

export interface ThreadsAccountsShellProps {
  subdomain: string;
  /** Page from the URL at server render time (?page=, ≥1, default 1). */
  initialPage?: number;
}

function ThreadsLoadingSkeleton() {
  return (
    <div
      data-testid="threads-accounts-loading-skeleton"
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

export function ThreadsAccountsShell({
  subdomain,
  initialPage = 1,
}: Readonly<ThreadsAccountsShellProps>) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const accountsPath = buildTenantApiPath(subdomain, '/threads/accounts');
  const settingsThreadsHref = `/tenant/${subdomain}/settings?tab=threads`;

  const [page, setPage] = React.useState(initialPage);
  const [searchQuery, setSearchQuery] = React.useState('');
  // Perf: the list query runs on the debounced search, not on
  // every keystroke — the toolbar input itself stays immediate.
  // (Pages already did this; the account shells did not, so each
  // keystroke fired its own API request.)
  const debouncedSearchQuery = useDebouncedValue(searchQuery);
  const [statusFilter, setStatusFilter] =
    React.useState<AccountStatusFilter>('all');

  const accountsQuery = useQuery({
    queryKey: tenant.threadsAccounts.listPage({
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: debouncedSearchQuery.trim(),
      status: statusFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(accountsPath, {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(debouncedSearchQuery.trim()
            ? { search: debouncedSearchQuery.trim() }
            : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        }),
        { schema: ListThreadsAccountsResponseSchema, signal }
      ),
    placeholderData: keepPreviousData,
  });

  // BYOC: the Settings surface's platform-credentials entry for
  // Threads — one cache entry, shared with Settings.
  const byocQuery = useQuery({
    queryKey: tenant.settings.platformCredentials('threads'),
    queryFn: ({ signal }) =>
      api.get(
        buildTenantApiPath(subdomain, '/settings/platform-credentials/threads'),
        { schema: PlatformCredentialsResponseSchema, signal }
      ),
  });

  const accounts = React.useMemo<ThreadsAccountItem[]>(
    () =>
      sortThreadsAccountsExpiredFirst(
        (accountsQuery.data?.accounts ?? []).map((account) => ({
          id: account.id,
          threadsAccountId: account.threadsAccountId,
          displayName: account.displayName,
          profilePictureUrl: account.profilePictureUrl ?? null,
          handle: account.handle ?? null,
          accountLink: account.accountLink ?? null,
          connectedDestinationsCount: account.connectedDestinationsCount ?? 0,
          status: account.status,
          tokenExpiresAt: account.tokenExpiresAt
            ? new Date(account.tokenExpiresAt).toISOString()
            : null,
          createdAt: new Date(account.createdAt).toISOString(),
          updatedAt: account.updatedAt
            ? new Date(account.updatedAt).toISOString()
            : undefined,
        }))
      ),
    [accountsQuery.data]
  );
  const isLoading = accountsQuery.isPending;
  const total = accountsQuery.data?.total ?? 0;
  const totalPages = accountsQuery.data?.totalPages ?? 0;

  const byocStatus = React.useMemo<{
    isConfigured: boolean;
    isLoading: boolean;
    error: string | null;
  }>(() => {
    const isConfigured = byocQuery.data
      ? Boolean(byocQuery.data.appId && byocQuery.data.hasSecret)
      : false;
    if (byocQuery.isError && !byocQuery.isFetching) {
      return {
        isConfigured,
        isLoading: false,
        error:
          isApiError(byocQuery.error) && byocQuery.error.kind === 'network'
            ? "Couldn't verify your Threads App credentials. Please check your connection."
            : "Couldn't verify your Threads App credentials. Please try again.",
      };
    }
    return {
      isConfigured,
      isLoading: byocQuery.isPending || (byocQuery.isFetching && byocQuery.isError),
      error: null,
    };
  }, [byocQuery.data, byocQuery.error, byocQuery.isError, byocQuery.isFetching, byocQuery.isPending]);
  const [isByocPromptOpen, setIsByocPromptOpen] = React.useState(false);

  const [isConnectOpen, setIsConnectOpen] = React.useState(false);
  const [reconnectingAccount, setReconnectingAccount] =
    React.useState<ThreadsAccountItem | null>(null);
  const [disconnectingAccount, setDisconnectingAccount] =
    React.useState<ThreadsAccountItem | null>(null);

  const [bannerNotice, setBannerNotice] = React.useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [highlightedAccountId, setHighlightedAccountId] = React.useState<
    string | null
  >(null);
  const highlightTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const flashHighlight = React.useCallback((accountId: string | null) => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    setHighlightedAccountId(accountId);
    if (accountId) {
      highlightTimeoutRef.current = setTimeout(() => {
        setHighlightedAccountId(null);
      }, 5000);
    }
  }, []);
  React.useEffect(
    () => () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    },
    []
  );

  // An out-of-range ?page= is clamped by the API; sync state (and the
  // URL, via the effect below) to the page that actually came back —
  // a stale ?page=999 can never render "Showing 29941–90 of 90".
  // Placeholder data is excluded on purpose: while page 2 loads,
  // keepPreviousData serves the page-1 payload, and syncing to its
  // page (1) would drag the user back to page 1 (a real snap-back
  // bug). Only a settled, non-placeholder response may clamp.
  React.useEffect(() => {
    if (
      !accountsQuery.isPlaceholderData &&
      accountsQuery.data &&
      accountsQuery.data.page !== undefined &&
      accountsQuery.data.page !== page
    ) {
      setPage(accountsQuery.data.page);
    }
  }, [accountsQuery.data, accountsQuery.isPlaceholderData, page]);

  // Keep ?page= in the URL in step with state (page 1 omits the param).
  React.useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) params.delete('page');
    else params.set('page', String(page));
    const next = params.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `?${next}` : '?', { scroll: false });
    }
  }, [page, router, searchParams]);

  // OAuth-return notices (direct flow): success confirmations become
  // the same top-right toast as the modal flow; only errors (including
  // mismatch) become a banner. Guarded to run once per return, and —
  // the mount-race fix — only after the accounts query has data, so
  // the name match can actually find the card. The keys are stripped
  // via replaceState (no re-render), so without this guard a later
  // accounts refetch would re-fire the toast.
  const oauthNoticeHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (oauthNoticeHandledRef.current) return;
    if (!accountsQuery.data) return;
    const resolved = resolveThreadsOAuthRedirectNotice(searchParams);
    if (!resolved) return;
    oauthNoticeHandledRef.current = true;

    if (resolved.notice.type === 'success') {
      toast.success(resolved.notice.message, {
        toasterId: THREADS_CONNECT_TOASTER_ID,
      });
      const match = resolved.accountName
        ? accounts.find((a) => a.displayName === resolved.accountName)
        : undefined;
      flashHighlight(match?.id ?? null);
    } else {
      setBannerNotice(resolved.notice);
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      for (const key of resolved.keysToRemove) {
        url.searchParams.delete(key);
      }
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  }, [searchParams, accounts, accountsQuery.data, flashHighlight]);

  const handleConnectionNotice = React.useCallback(
    (notice: {
      type: 'success' | 'error';
      message: string;
      accountId?: string | undefined;
    }) => {
      if (notice.type === 'success') {
        toast.success(notice.message, { toasterId: THREADS_CONNECT_TOASTER_ID });
        flashHighlight(notice.accountId ?? null);
      } else {
        setBannerNotice({ type: 'error', message: notice.message });
        flashHighlight(notice.accountId ?? null);
      }
    },
    [flashHighlight]
  );

  const refetchAccounts = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: tenant.threadsAccounts.list,
    });
  }, [queryClient, tenant.threadsAccounts.list]);

  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/threads/accounts/${accountId}`), {
        schema: DisconnectThreadsAccountResponseSchema,
      }),
    onSuccess: (_data, accountId) => {
      queryClient.setQueryData<{ accounts: unknown[]; total: number }>(
        tenant.threadsAccounts.list,
        (prev) =>
          prev
            ? {
                ...prev,
                accounts: prev.accounts.filter(
                  (a) => (a as { id: string }).id !== accountId
                ),
                total: Math.max(0, prev.total - 1),
              }
            : prev
      );
      void queryClient.invalidateQueries({
        queryKey: tenant.threadsAccounts.list,
      });
      setDisconnectingAccount(null);
      setBannerNotice({
        type: 'success',
        message: 'Account disconnected.',
      });
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

  const handleOpenNewConnect = () => {
    if (byocStatus.isLoading) return;
    if (!byocStatus.isConfigured) {
      setIsByocPromptOpen(true);
      return;
    }
    setReconnectingAccount(null);
    setIsConnectOpen(true);
  };

  // Targeted reconnect: the clicked account rides into the connect
  // flow (expected id + display name); a sign-in to a different
  // account produces the mismatch warning, never a silent success.
  const handleReconnect = (account: ThreadsAccountItem) => {
    if (byocStatus.isLoading) return;
    if (!byocStatus.isConfigured) {
      setIsByocPromptOpen(true);
      return;
    }
    setReconnectingAccount(account);
    setIsConnectOpen(true);
  };

  const handleConnectOpenChange = (open: boolean) => {
    setIsConnectOpen(open);
    if (!open) {
      setReconnectingAccount(null);
    }
  };

  const handleConfirmDisconnect = async (accountId: string) => {
    try {
      await disconnectMutation.mutateAsync(accountId);
    } catch (error) {
      // The failure is surfaced to the user by the mutation's onError
      // banner; report it here so the rejection is never unhandled.
      reportError(error, { source: 'threads-accounts-disconnect' });
    }
  };

  const handleSearchChange = React.useCallback((value: string) => {
    setSearchQuery(value);
    setPage(1);
  }, []);
  const handleStatusFilterChange = React.useCallback(
    (value: AccountStatusFilter) => {
      setStatusFilter(value);
      setPage(1);
    },
    []
  );
  const handleClearFilters = React.useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    setPage(1);
  }, []);

  const isConnectGated = isConnectGatedByMissingCredentials(byocStatus);
  const isConnectDisabled = byocStatus.isLoading || isConnectGated;

  // Page-slice expired count: only a fallback for payloads that
  // predate the healthCounts field. The subtitle and the filter-bar
  // badge count the FULL filtered set — counting the slice made page
  // 1 of 65 accounts read "30 connected" while the pagination line
  // below read "Showing 1–30 of 65".
  const attentionCount = React.useMemo(
    () => accounts.filter((a) => a.status === 'expired').length,
    [accounts]
  );
  const healthCounts = accountsQuery.data?.healthCounts;
  const expiredTotal = healthCounts?.expired ?? attentionCount;
  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all';
  const situationalSubtitle = React.useMemo(() => {
    if (total === 0 && !isFiltered) {
      return computeThreadsSubtitle([], 0, false);
    }
    if (isFiltered) {
      return `${total} matching ${total === 1 ? 'account' : 'accounts'}`;
    }
    if (healthCounts) {
      return computeThreadsSubtitleFromCounts(total, healthCounts);
    }
    return computeThreadsSubtitle(accounts, accounts.length, false);
  }, [total, accounts, healthCounts, isFiltered]);

  const existingAccountIds = React.useMemo(() => accounts.map((a) => a.id), [accounts]);
  const initialAccounts = React.useMemo(
    () =>
      accounts.map((a) => ({
        id: a.id,
        threadsAccountId: a.threadsAccountId,
        displayName: a.displayName,
        status: a.status,
        updatedAt: a.updatedAt,
      })),
    [accounts]
  );

  let contentNode: React.ReactNode;
  if (isLoading) {
    contentNode = <ThreadsLoadingSkeleton />;
  } else if (accountsQuery.isError && accounts.length === 0) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="threads-accounts-load-error"
        title="Couldn't load your accounts"
        description="Please try again."
        action={
          <Button
            type="button"
            data-testid="threads-accounts-load-retry-btn"
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
          data-testid="threads-accounts-empty-state"
          icon={
            <div
              aria-hidden
              className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-xl font-bold text-on-primary select-none"
            >
              TH
            </div>
          }
          title="Connect your first Threads account"
          description={THREADS_DESCRIPTION}
          action={
            <Button
              type="button"
              size="lg"
              data-testid="threads-empty-connect-button"
              disabled={isConnectDisabled}
              aria-describedby={
                isConnectGated
                  ? 'threads-empty-connect-disabled-reason'
                  : undefined
              }
              onClick={handleOpenNewConnect}
            >
              <PlusIcon aria-hidden />
              <span>Connect Threads</span>
            </Button>
          }
        />
        {isConnectGated && (
          <div className="flex flex-col items-center px-6 pb-12 text-center">
            <p
              id="threads-empty-connect-disabled-reason"
              data-testid="threads-empty-connect-disabled-reason"
              className="-mt-8 max-w-105 text-body leading-body text-ink-sub"
            >
              Add your Threads App ID and App Secret first — connecting is
              paused until they are saved.{' '}
              <Link
                href={settingsThreadsHref}
                data-testid="threads-empty-connect-settings-link"
                className="font-semibold text-link underline"
              >
                Add them in Settings
              </Link>
            </p>
          </div>
        )}
      </div>
    );
  } else if (accounts.length === 0 && isFiltered) {
    contentNode = (
      <div
        data-testid="threads-accounts-filter-empty"
        className="rounded-md border border-line bg-panel p-6 text-center"
      >
        <p className="mb-4 text-body text-ink-sub">
          No accounts match your search or filter.
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="threads-accounts-clear-filters-btn"
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
          data-testid="threads-accounts-grid"
          className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
        >
          {accounts.map((account) => (
            <ThreadsAccountCard
              key={account.id}
              account={account}
              highlighted={account.id === highlightedAccountId}
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
      data-testid="threads-accounts-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <Toast
        id={THREADS_CONNECT_TOASTER_ID}
        position="top-right"
        toastOptions={THREADS_CONNECT_TOAST_OPTIONS}
      />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="threads-accounts-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Threads Accounts
          </h1>
          <p
            data-testid="threads-accounts-page-subtitle"
            className="m-0 text-body text-ink-sub"
          >
            {situationalSubtitle}
          </p>
        </div>

        {total > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              data-testid="threads-header-connect-button"
              disabled={isConnectDisabled}
              aria-describedby={
                isConnectGated
                  ? 'threads-header-connect-gated-reason'
                  : undefined
              }
              onClick={handleOpenNewConnect}
            >
              <PlusIcon aria-hidden />
              <span>Connect Threads</span>
            </Button>
            {isConnectGated && (
              <span
                id="threads-header-connect-gated-reason"
                data-testid="threads-header-connect-gated-reason"
                className="text-metadata leading-body text-ink-sub"
              >
                Add your App ID and Secret first.{' '}
                <Link
                  href={settingsThreadsHref}
                  data-testid="threads-header-connect-settings-link"
                  className="font-semibold text-link underline"
                >
                  Add them in Settings
                </Link>
              </span>
            )}
          </div>
        )}
      </div>

      {bannerNotice && (
        <Banner
          data-testid="threads-oauth-feedback-banner"
          variant={bannerNotice.type === 'success' ? 'success' : 'critical'}
          title={bannerNotice.message}
          onDismiss={() => setBannerNotice(null)}
          className="mb-6 border border-line"
        />
      )}

      {byocStatus.error && (
        <Banner
          data-testid="threads-byoc-retry-banner"
          variant="warning"
          title={byocStatus.error}
          className="mb-6 border border-line"
          action={
            <Button
              type="button"
              variant="link"
              data-testid="threads-byoc-retry-btn"
              onClick={() => {
                void byocQuery.refetch();
              }}
              className="font-semibold"
            >
              Retry Check
            </Button>
          }
        />
      )}

      {isConnectGated && (
        <div className="mb-6">
          <ByocGatePrompt
            platform="threads"
            platformName="Threads"
            subdomain={subdomain}
          />
        </div>
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

      <ThreadsDisconnectDialog
        account={disconnectingAccount}
        open={Boolean(disconnectingAccount)}
        onOpenChange={(open) => !open && setDisconnectingAccount(null)}
        onConfirm={handleConfirmDisconnect}
        isDisconnecting={disconnectMutation.isPending}
      />

      <ThreadsConnectModal
        subdomain={subdomain}
        open={isConnectOpen}
        onOpenChange={handleConnectOpenChange}
        onAccountConnected={refetchAccounts}
        onConnectionNotice={handleConnectionNotice}
        existingAccountIds={existingAccountIds}
        reconnectingAccount={reconnectingAccount}
        initialAccounts={initialAccounts}
      />

      <ThreadsByocConfigPromptModal
        subdomain={subdomain}
        open={isByocPromptOpen}
        onClose={() => setIsByocPromptOpen(false)}
      />
    </div>
  );
}
