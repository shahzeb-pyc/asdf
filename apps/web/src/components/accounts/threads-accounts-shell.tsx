'use client';

/**
 * Threads accounts shell — the Threads accounts list, modelled on the
 * Facebook Accounts shell but Threads-specific and Threads-only.
 *
 * Data: the Threads accounts list API (social_accounts rows with
 * platform='threads'), fetched with the typed API client and validated
 * by the Threads list schema. Server pagination: page lives in the
 * URL (?page=), filter/search reset to page 1.
 *
 * Connect is NOT a modal here: Threads keeps its existing direct
 * connect flow (/api/connect/threads) behind the Threads app-details
 * check. Gating semantics match Facebook: connect is gated only when
 * Threads app details are known to be missing — never while the check
 * runs, and never when the check itself fails (a retry banner covers
 * that case instead). The settings link points at the real Threads
 * credentials tab (?tab=threads).
 *
 * Success path, and its honest limit: the shared connect-complete
 * route lands a finished connect on the generic /accounts page, not
 * here, so no current flow sends an OAuth-return notice to this page.
 * This shell still handles a `connected` / `connect_error` param the
 * same way Facebook's shell handles its OAuth returns (top-right
 * toast + briefly gold-highlighted card, once, params stripped) so
 * the hook exists if that landing ever changes — it is not claimed
 * as a live end-to-end path today.
 */
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import {
  DisconnectThreadsAccountResponseSchema,
  ListThreadsAccountsResponseSchema,
} from '@fbuploadpro/contracts';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast } from '@/components/shared/ui/toast';
import { Banner } from '@/components/shared/ui/banner';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import type { AccountStatusFilter } from '@/components/accounts/accounts-helpers';
import {
  ByocGatePrompt,
  checkByocCredentials,
  type ByocGateStatus,
} from '@/components/connect/byoc-gate';
import {
  ThreadsAccountCard,
  type ThreadsAccountItem,
} from './threads-account-card';
import { ThreadsDisconnectDialog } from './threads-disconnect-dialog';
import {
  computeThreadsSubtitleFromCounts,
  sortThreadsAccountsExpiredFirst,
} from './threads-accounts-helpers';

const THREADS_CONNECT_TOASTER_ID = 'threads-accounts-connect-toaster';

const THREADS_DESCRIPTION =
  'Connect your Threads account to schedule and publish posts from one place. Your workspace uses its own Threads app details, so your accounts stay yours.';

export interface ThreadsAccountsShellProps {
  subdomain: string;
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
}: Readonly<ThreadsAccountsShellProps>) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const accountsPath = buildTenantApiPath(subdomain, '/threads/accounts');
  const connectHref = `/api/connect/threads?subdomain=${encodeURIComponent(subdomain)}`;
  const settingsThreadsHref = `/tenant/${subdomain}/settings?tab=threads`;

  const initialPage = React.useMemo(() => {
    const raw = Number.parseInt(searchParams.get('page') ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
    // Deliberately read once at mount: later URL changes flow
    // through the sync effect, not through this initializer.
  }, []);
  const [page, setPage] = React.useState(initialPage);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] =
    React.useState<AccountStatusFilter>('all');

  const [accounts, setAccounts] = React.useState<ThreadsAccountItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(0);
  const [healthCounts, setHealthCounts] = React.useState({
    connected: 0,
    expired: 0,
    error: 0,
  });
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadToken, setReloadToken] = React.useState(0);

  const [byocStatus, setByocStatus] = React.useState<ByocGateStatus>({
    isLoading: true,
    hasCredentials: false,
    error: null,
  });
  const [byocReloadToken, setByocReloadToken] = React.useState(0);

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

  const [disconnectingAccount, setDisconnectingAccount] =
    React.useState<ThreadsAccountItem | null>(null);
  const [isDisconnecting, setIsDisconnecting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(false);
    const apiStatus =
      statusFilter === 'active' || statusFilter === 'expired'
        ? statusFilter
        : undefined;
    api
      .get(
        buildUrl(accountsPath, {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
          ...(apiStatus ? { status: apiStatus } : {}),
        }),
        { schema: ListThreadsAccountsResponseSchema }
      )
      .then((data) => {
        if (cancelled) return;
        setAccounts(
          sortThreadsAccountsExpiredFirst(
            data.accounts.map((account) => ({
              id: account.id,
              threadsAccountId: account.threadsAccountId,
              displayName: account.displayName,
              profilePictureUrl: account.profilePictureUrl ?? null,
              status: account.status,
              tokenExpiresAt: account.tokenExpiresAt
                ? new Date(account.tokenExpiresAt).toISOString()
                : null,
              createdAt: new Date(account.createdAt).toISOString(),
              updatedAt: account.updatedAt
                ? new Date(account.updatedAt).toISOString()
                : undefined,
            }))
          )
        );
        setTotal(data.total);
        setTotalPages(data.totalPages ?? 0);
        if (data.healthCounts) setHealthCounts(data.healthCounts);
        setIsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportError(error, { source: 'threads-accounts-list' });
        setLoadError(true);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountsPath, page, searchQuery, statusFilter, reloadToken]);

  React.useEffect(() => {
    let cancelled = false;
    setByocStatus((prev) => ({ ...prev, isLoading: true }));
    void checkByocCredentials(subdomain, 'threads').then((result) => {
      if (!cancelled) setByocStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [subdomain, byocReloadToken]);

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

  // OAuth-return hook (see the file header for its honest limit):
  // a `connected` name toasts + highlights that card once; a
  // `connect_error` becomes a banner. Params are stripped afterwards
  // so a later refetch cannot re-fire the toast.
  const connectedNoticeHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (connectedNoticeHandledRef.current) return;
    const connectedName = searchParams.get('connected');
    const connectError = searchParams.get('connect_error');
    if (!connectedName && !connectError) return;
    connectedNoticeHandledRef.current = true;
    if (connectedName) {
      toast.success(`${connectedName} connected`, {
        toasterId: THREADS_CONNECT_TOASTER_ID,
      });
      const match = accounts.find((a) => a.displayName === connectedName);
      flashHighlight(match?.id ?? null);
    } else {
      setBannerNotice({
        type: 'error',
        message: "Couldn't connect your Threads account. Please try again.",
      });
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('connected');
      url.searchParams.delete('connect_error');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  }, [searchParams, accounts, flashHighlight]);

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

  const isConnectGated =
    !byocStatus.isLoading && !byocStatus.hasCredentials && !byocStatus.error;
  const isConnectDisabled = byocStatus.isLoading || isConnectGated;

  const handleReconnect = React.useCallback(() => {
    window.location.assign(connectHref);
  }, [connectHref]);

  const handleConfirmDisconnect = async (accountId: string) => {
    setIsDisconnecting(true);
    try {
      await api.delete(
        buildTenantApiPath(subdomain, `/threads/accounts/${accountId}`),
        { schema: DisconnectThreadsAccountResponseSchema }
      );
      setDisconnectingAccount(null);
      setBannerNotice({ type: 'success', message: 'Account disconnected.' });
      setReloadToken((t) => t + 1);
    } catch (error) {
      reportError(error, { source: 'threads-accounts-disconnect' });
      setBannerNotice({
        type: 'error',
        message: isApiError(error) && error.kind === 'http'
          ? "Couldn't disconnect account. Please refresh and try again."
          : "Couldn't disconnect the account. Please try again.",
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all';
  const situationalSubtitle = React.useMemo(() => {
    if (total === 0 && !isFiltered) {
      return computeThreadsSubtitleFromCounts(0, {
        connected: 0,
        expired: 0,
        error: 0,
      });
    }
    if (isFiltered) {
      return `${total} matching ${total === 1 ? 'account' : 'accounts'}`;
    }
    return computeThreadsSubtitleFromCounts(total, healthCounts);
  }, [total, isFiltered, healthCounts]);

  let contentNode: React.ReactNode;
  if (isLoading) {
    contentNode = <ThreadsLoadingSkeleton />;
  } else if (loadError && accounts.length === 0) {
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
            onClick={() => setReloadToken((t) => t + 1)}
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
            isConnectDisabled ? (
              <Button
                type="button"
                size="lg"
                data-testid="threads-empty-connect-button"
                disabled
                aria-describedby={
                  isConnectGated
                    ? 'threads-empty-connect-disabled-reason'
                    : undefined
                }
              >
                <PlusIcon aria-hidden />
                <span>Connect Threads</span>
              </Button>
            ) : (
              <Button asChild size="lg">
                <a
                  href={connectHref}
                  data-testid="threads-connect-link"
                >
                  <PlusIcon aria-hidden />
                  <span>Connect Threads</span>
                </a>
              </Button>
            )
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
      <Toast id={THREADS_CONNECT_TOASTER_ID} position="top-right" />

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
            {isConnectDisabled ? (
              <Button
                type="button"
                data-testid="threads-header-connect-button"
                disabled
                aria-describedby={
                  isConnectGated
                    ? 'threads-header-connect-gated-reason'
                    : undefined
                }
              >
                <PlusIcon aria-hidden />
                <span>Connect Threads</span>
              </Button>
            ) : (
              <Button asChild>
                <a
                  href={connectHref}
                  data-testid="threads-connect-link"
                >
                  <PlusIcon aria-hidden />
                  <span>Connect Threads</span>
                </a>
              </Button>
            )}
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
              onClick={() => setByocReloadToken((t) => t + 1)}
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
          attentionCount={healthCounts.expired}
        />
      )}

      {contentNode}

      <ThreadsDisconnectDialog
        account={disconnectingAccount}
        open={Boolean(disconnectingAccount)}
        onOpenChange={(open) => !open && setDisconnectingAccount(null)}
        onConfirm={handleConfirmDisconnect}
        isDisconnecting={isDisconnecting}
      />
    </div>
  );
}
