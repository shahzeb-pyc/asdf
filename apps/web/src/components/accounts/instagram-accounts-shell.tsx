'use client';

/**
 * Instagram Accounts shell — Facebook's `accounts-shell.tsx` structure
 * exactly, with Instagram data and copy in every slot:
 *
 * Page order: flow-scoped Toast → header → FeedbackBanner →
 * ByocRetryBanner → ByocRequiredBanner → FilterBar → content →
 * ConnectModal → DisconnectDialog → ByocPromptModal.
 *
 * Behaviour parity: expired-first ordering, All / Active / Expired tabs
 * (plus the programmatic `expiring_soon` filter value, passed through
 * to the API — never mapped to `all`), text search, the health-derived
 * subtitle from FULL-set counts, BYOC point-of-need gating (gate only
 * on known-missing credentials, never on a failed check — the retry
 * banner covers that case), URL-synced pagination (`?page=`), the
 * connect modal with polling, flash highlight on the just-connected
 * card, and every OAuth-return notice.
 *
 * Data: the Instagram-only list route
 * (`GET /api/tenant/[subdomain]/instagram/accounts`, contracts
 * `ListInstagramAccountsResponseSchema`) over the typed API client.
 * Credentials come from the Instagram platform-credentials route
 * (`appId` + `hasSecret`); the Settings link is the Instagram App tab
 * (`?tab=instagram`, never Facebook's `?tab=byoc`).
 *
 * The query key is built inline here rather than in the shared
 * `queryKeys` factory — that factory is owned by another surface and
 * this build's file ownership does not cover it; the key is still
 * tenant-scoped and parameterised, so the cache stays correct (a
 * future cleanup may move it into the factory).
 */
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import {
  DisconnectInstagramAccountResponseSchema,
  ListInstagramAccountsResponseSchema,
} from '@fbuploadpro/contracts';

import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import { PlatformCredentialsResponseSchema } from '@/lib/api/schemas/settings';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast, type ToasterProps } from '@/components/shared/ui/toast';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import { FeedbackBanner } from '@/components/accounts/accounts-banners';
import { isConnectGatedByMissingCredentials } from '@/components/accounts/accounts-helpers';
import {
  InstagramAccountCard,
  type InstagramAccountItem,
} from './instagram-account-card';
import { InstagramDisconnectDialog } from './instagram-disconnect-dialog';
import { InstagramAccountsEmptyState } from './instagram-accounts-empty-state';
import {
  InstagramByocRequiredBanner,
  InstagramByocRetryBanner,
} from './instagram-banners';
import { InstagramByocConfigPromptModal } from './instagram-byoc-config-prompt-modal';
import { InstagramConnectAccountModal } from './instagram-connect-account-modal';
import { resolveInstagramOAuthRedirectNotice } from './instagram-oauth-helpers';
import {
  computeInstagramSubtitleFromCounts,
  getInstagramAccountHealth,
  sortInstagramAccountsExpiredFirst,
  type InstagramAccountStatusFilter,
} from './instagram-account-health';

/** Id of the Accounts-only toaster: top-right, used solely by connect confirmations. */
const INSTAGRAM_ACCOUNTS_CONNECT_TOASTER_ID = 'instagram-accounts-connect-toaster';

/**
 * Green styling for the Accounts connect success toast, scoped to this
 * flow's toaster only — the shared tenant Toaster keeps its default.
 * Identical to Facebook's `ACCOUNTS_CONNECT_TOAST_OPTIONS`.
 */
export const INSTAGRAM_ACCOUNTS_CONNECT_TOAST_OPTIONS: NonNullable<ToasterProps['toastOptions']> = {
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

export interface InstagramAccountsShellProps {
  subdomain: string;
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const accountsPath = buildTenantApiPath(subdomain, '/instagram/accounts');
  const credentialsPath = buildTenantApiPath(
    subdomain,
    '/settings/platform-credentials/instagram'
  );
  const listKey = React.useCallback(
    (params: { page: number; limit: number; search: string; status: string }) =>
      ['tenant', subdomain, 'instagram-accounts', 'list', params] as const,
    [subdomain]
  );

  // Pagination state lives in the URL (?page=) so refresh and a shared
  // link land on the same page; an unparseable value falls back to 1.
  const initialPage = React.useMemo(() => {
    const raw = Number.parseInt(searchParams.get('page') ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
    // Deliberately read once at mount: later URL changes flow
    // through the sync effect, not through this initializer.
  }, []);
  const [page, setPage] = React.useState(initialPage);

  // Filter/search state lives here; changing any of them resets to
  // page 1 (the filtered result's first page).
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
  const credentialsQuery = useQuery({
    queryKey: ['tenant', subdomain, 'instagram-credentials'] as const,
    queryFn: ({ signal }) =>
      api.get(credentialsPath, { schema: PlatformCredentialsResponseSchema, signal }),
  });

  // The API already returns the slice expired-first; the sort here
  // is a stable no-op on real data and keeps the documented order
  // for any cache seeded out of order.
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

  // A briefly gold-highlighted card for the account that was just
  // connected/refreshed, shown while its toast is up.
  const [highlightedAccountId, setHighlightedAccountId] = React.useState<string | null>(null);
  const highlightTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Success confirmations go to the TOP-RIGHT toast (flow-scoped
  // toaster below), while a mismatch stays as a persistent,
  // dismissible banner — exactly as on Facebook.
  const handleConnectionNotice = React.useCallback(
    (notice: {
      type: 'success' | 'error';
      message: string;
      accountId?: string | undefined;
    }) => {
      if (notice.type === 'success') {
        toast.success(notice.message, { toasterId: INSTAGRAM_ACCOUNTS_CONNECT_TOASTER_ID });
        flashHighlight(notice.accountId ?? null);
      } else {
        setBannerNotice({ type: 'error', message: notice.message });
        flashHighlight(notice.accountId ?? null);
      }
    },
    [flashHighlight]
  );

  // Instagram App credentials status & advisory modal. Derived with
  // Facebook's exact semantics: while the check runs (or is being
  // retried) the state is "loading"; a failed check keeps the last
  // known configuration and surfaces the retry banner instead of gating.
  const byocStatus = React.useMemo<{
    isConfigured: boolean;
    isLoading: boolean;
    error: string | null;
  }>(() => {
    const isConfigured = credentialsQuery.data
      ? Boolean(credentialsQuery.data.appId && credentialsQuery.data.hasSecret)
      : false;
    if (credentialsQuery.isError && !credentialsQuery.isFetching) {
      return {
        isConfigured,
        isLoading: false,
        error:
          isApiError(credentialsQuery.error) && credentialsQuery.error.kind === 'network'
            ? "Couldn't verify your Instagram App credentials. Please check your connection."
            : "Couldn't verify your Instagram App credentials. Please try again.",
      };
    }
    return {
      isConfigured,
      isLoading: credentialsQuery.isPending || (credentialsQuery.isFetching && credentialsQuery.isError),
      error: null,
    };
  }, [credentialsQuery.data, credentialsQuery.error, credentialsQuery.isError, credentialsQuery.isFetching, credentialsQuery.isPending]);
  const [isByocPromptOpen, setIsByocPromptOpen] = React.useState(false);

  // Modal & filter states
  const [isConnectOpen, setIsConnectOpen] = React.useState(false);
  const [reconnectingAccount, setReconnectingAccount] =
    React.useState<InstagramAccountItem | null>(null);
  const [disconnectingAccount, setDisconnectingAccount] =
    React.useState<InstagramAccountItem | null>(null);

  // An out-of-range ?page= is clamped by the API; sync state (and the
  // URL, via the effect below) to the page that actually came back.
  React.useEffect(() => {
    if (accountsQuery.data && accountsQuery.data.page !== undefined && accountsQuery.data.page !== page) {
      setPage(accountsQuery.data.page);
    }
  }, [accountsQuery.data, page]);

  // Keep ?page= in the URL in step with state (page 1 omits the param).
  // A query-only replace resolves against the current pathname. This
  // coexists with the OAuth-return effect below: that effect only
  // strips OAuth params on a return, after which this effect re-adds
  // ?page= if the state is past page 1, and settles.
  React.useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) params.delete('page');
    else params.set('page', String(page));
    const next = params.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `?${next}` : '?', { scroll: false });
    }
  }, [page, router, searchParams]);

  // Any filter/search change restarts at page 1.
  const handleSearchChange = React.useCallback((value: string) => {
    setSearchQuery(value);
    setPage(1);
  }, []);
  const handleStatusFilterChange = React.useCallback(
    (value: InstagramAccountStatusFilter) => {
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

  const refetchAccounts = React.useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['tenant', subdomain, 'instagram-accounts'],
    });
  }, [queryClient, subdomain]);

  // Handle URL query parameters from OAuth returns (direct flow):
  // success confirmations become the same top-right toast as the
  // modal flow; only errors (including mismatch) become a banner.
  // The direct redirect carries no account id, so the highlight (when
  // any) is matched by the account name it does carry. Guarded to run
  // once per return: the keys are stripped via replaceState (no
  // re-render), so without this guard a later accounts refetch would
  // re-fire the toast.
  const oauthNoticeHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (oauthNoticeHandledRef.current) return;
    const resolved = resolveInstagramOAuthRedirectNotice(searchParams);
    if (!resolved) return;
    oauthNoticeHandledRef.current = true;

    if (resolved.notice.type === 'success') {
      toast.success(resolved.notice.message, { toasterId: INSTAGRAM_ACCOUNTS_CONNECT_TOASTER_ID });
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
      window.history.replaceState({}, '', url.pathname);
    }
  }, [searchParams, accounts, flashHighlight]);

  const handleOpenNewConnect = () => {
    if (byocStatus.isLoading) return;
    if (!byocStatus.isConfigured) {
      setIsByocPromptOpen(true);
      return;
    }
    setReconnectingAccount(null);
    setIsConnectOpen(true);
  };

  // Handle Reconnect (opens the connect modal with reconnectingAccount context)
  const handleReconnect = (account: InstagramAccountItem) => {
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

  // Handle Disconnect confirmation
  const handleConfirmDisconnect = async (accountId: string) => {
    try {
      await disconnectMutation.mutateAsync(accountId);
    } catch (error) {
      // The failure is surfaced to the user by the mutation's onError
      // banner; report it here so the rejection is never unhandled.
      reportError(error, { source: 'instagram-accounts-disconnect' });
    }
  };

  // Note: with pagination this covers the current page only. The
  // connect modal uses it to flag already-connected accounts, and the
  // backend still resolves a re-connect as already-connected, so an
  // account on another page degrades to the normal reconnect flow
  // rather than a duplicate.
  const existingAccountIds = React.useMemo(() => accounts.map((a) => a.id), [accounts]);

  // Connect is gated while the App ID and Secret are known to be missing:
  // the action is disabled and the reason is shown next to it, instead of
  // letting a user start a connect flow that cannot succeed.
  const isConnectGated = isConnectGatedByMissingCredentials(byocStatus);
  const isConnectDisabled = byocStatus.isLoading || isConnectGated;
  const settingsInstagramHref = `/tenant/${subdomain}/settings?tab=instagram`;

  // Page-slice expired count: only a fallback for payloads that
  // predate the healthCounts field. The subtitle and the filter-bar
  // badge must count the FULL filtered set — counting the slice
  // made page 1 of 65 accounts read "30 connected" while the
  // pagination line below read "Showing 1–30 of 65".
  const attentionCount = React.useMemo(
    () => accounts.filter((a) => getInstagramAccountHealth(a) === 'expired').length,
    [accounts]
  );
  const healthCounts = accountsQuery.data?.healthCounts;
  const expiredTotal = healthCounts?.expired ?? attentionCount;
  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all';
  // The subtitle counts from the API total and the full-set health
  // counts; when healthCounts is absent (old payload) it falls back
  // to the previous page-slice computation.
  const situationalSubtitle = React.useMemo(() => {
    if (total === 0 && !isFiltered) {
      return computeInstagramSubtitleFromCounts(0, { connected: 0, expired: 0, error: 0 });
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
      <InstagramAccountsEmptyState
        onConnect={handleOpenNewConnect}
        isConnectDisabled={isConnectDisabled}
        credentialsMissing={isConnectGated}
        settingsHref={settingsInstagramHref}
      />
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
      data-testid="instagram-accounts-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      {/* Flow-scoped toaster for connect confirmations only: TOP-RIGHT
          (the shared tenant Toaster is top-right too, see the tenant
          layout mount).
          Toasts reach it via toasterId, never via the shared default. */}
      <Toast
        id={INSTAGRAM_ACCOUNTS_CONNECT_TOASTER_ID}
        position="top-right"
        toastOptions={INSTAGRAM_ACCOUNTS_CONNECT_TOAST_OPTIONS}
      />
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="instagram-accounts-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Instagram Accounts
          </h1>
          <p data-testid="instagram-accounts-page-subtitle" className="m-0 text-body text-ink-sub">
            {situationalSubtitle}
          </p>
        </div>

        {total > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              data-testid="instagram-header-connect-button"
              disabled={isConnectDisabled}
              aria-describedby={
                isConnectGated ? 'instagram-header-connect-gated-reason' : undefined
              }
              onClick={handleOpenNewConnect}
            >
              <PlusIcon aria-hidden />
              <span>Connect Instagram</span>
            </Button>
            {isConnectGated && (
              <span
                id="instagram-header-connect-gated-reason"
                data-testid="instagram-header-connect-gated-reason"
                className="text-metadata leading-body text-ink-sub"
              >
                Add your App ID and Secret first.{' '}
                <Link
                  href={settingsInstagramHref}
                  data-testid="instagram-header-connect-settings-link"
                  className="font-semibold text-link underline"
                >
                  Add them in Settings
                </Link>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Dismissible Feedback Banner */}
      {bannerNotice && (
        <FeedbackBanner
          notice={bannerNotice}
          onDismiss={() => setBannerNotice(null)}
        />
      )}

      {/* BYOC Network / 500 Retry Banner */}
      {byocStatus.error && (
        <InstagramByocRetryBanner
          message={byocStatus.error}
          onRetry={() => {
            void credentialsQuery.refetch();
          }}
        />
      )}

      {/* BYOC Required Warning Banner */}
      {!byocStatus.isLoading && !byocStatus.isConfigured && !byocStatus.error && (
        <InstagramByocRequiredBanner subdomain={subdomain} />
      )}

      {/* Search & Status Filter Bar */}
      {!isLoading && total > 0 && (
        <AccountsFilterBar
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          attentionCount={expiredTotal}
          // Instagram's list API has no error filter (unlike
          // Facebook's, which gained an Error tab in the audit
          // branch), so only the four tabs it can honour are shown.
          tabs={[
            { value: 'all', label: 'All', testId: 'accounts-filter-all' },
            { value: 'active', label: 'Active', testId: 'accounts-filter-active' },
            { value: 'expiring_soon', label: 'Expiring soon', testId: 'accounts-filter-expiring-soon' },
            { value: 'expired', label: 'Expired', testId: 'accounts-filter-expired' },
          ]}
        />
      )}

      {/* Main Content Area */}
      {contentNode}

      {/* Connect Account Modal */}
      <InstagramConnectAccountModal
        subdomain={subdomain}
        open={isConnectOpen}
        onOpenChange={handleConnectOpenChange}
        onAccountConnected={refetchAccounts}
        onConnectionNotice={handleConnectionNotice}
        existingAccountIds={existingAccountIds}
        reconnectingAccount={
          reconnectingAccount
            ? {
                ...reconnectingAccount,
                updatedAt: reconnectingAccount.updatedAt
                  ? new Date(reconnectingAccount.updatedAt).toISOString()
                  : undefined,
              }
            : null
        }
        initialAccounts={accounts.map((a) => ({
          ...a,
          updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : undefined,
        }))}
      />

      {/* Disconnect Safety Dialog */}
      <InstagramDisconnectDialog
        account={disconnectingAccount}
        open={Boolean(disconnectingAccount)}
        onOpenChange={(open) => !open && setDisconnectingAccount(null)}
        onConfirm={handleConfirmDisconnect}
        isDisconnecting={disconnectMutation.isPending}
      />

      {/* BYOC Configuration Advisory Modal */}
      <InstagramByocConfigPromptModal
        subdomain={subdomain}
        open={isByocPromptOpen}
        onClose={() => setIsByocPromptOpen(false)}
      />
    </div>
  );
}
