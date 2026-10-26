'use client';

/**
 * Accounts shell — the client island of the Accounts route
 * (spec 131 PR-131-1, spec §8.1/§8.4).
 *
 * Data: initial accounts + BYOC status arrive server-first through
 * the route's dehydration (see page.tsx) and are read/refetched here
 * with React Query over the typed API client — zero raw fetch, zero
 * fetch-on-mount for initial data. The BYOC status shares the
 * Settings surface's single cache entry (`queryKeys.settings.byoc`,
 * full `ByocSettingsResponseSchema` shape — one shape per key,
 * spec §8.3) and only the `fbAppId`/`hasSecret` fields are read here.
 *
 * Mutations (named invalidation): disconnect → DELETE via the typed
 * client, invalidates `queryKeys.accounts.list`; a completed connect
 * (the modal's `onAccountConnected`) invalidates the same key.
 *
 * Behaviour parity (spec §6): expired-first ordering, All / Active /
 * Expired filters, text search, the health-derived subtitle, BYOC
 * point-of-need gating (gate only on known-missing credentials,
 * never on a failed check — the retry banner covers that case), and
 * every OAuth-return notice are computed by the same helpers the
 * parity suites pin (`components/accounts/accounts-helpers`).
 */
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  DisconnectAccountResponseSchema,
  ListFacebookAccountsResponseSchema,
  type FacebookAccountView,
} from '@/lib/api/schemas/accounts';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { queryKeys } from '@/lib/data/query-keys';
import { reportError } from '@/lib/report-error';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Toast, toast, type ToasterProps } from '@/components/shared/ui/toast';
import { AccountCard, type FacebookAccountItem } from '@/components/accounts/account-card';
import { AccountsEmptyState } from '@/components/accounts/accounts-empty-state';
import { AccountsFilterBar } from '@/components/accounts/accounts-filter-bar';
import {
  ByocRequiredBanner,
  ByocRetryBanner,
  FeedbackBanner,
} from '@/components/accounts/accounts-banners';
import { ByocConfigPromptModal } from '@/components/accounts/byoc-config-prompt-modal';
import {
  computeAccountsSubtitle,
  filterAccountsList,
  isConnectGatedByMissingCredentials,
  resolveOAuthRedirectNotice,
  sortAccountsExpiredFirst,
  type AccountStatusFilter,
} from '@/components/accounts/accounts-helpers';
import { ConnectAccountModal } from '@/components/accounts/connect-account-modal';
import { DisconnectAccountDialog } from '@/components/accounts/disconnect-account-dialog';

/** Id of the Accounts-only toaster: top-right, used solely by connect confirmations. */
const ACCOUNTS_CONNECT_TOASTER_ID = 'accounts-connect-toaster';

/**
 * Green styling for the Accounts connect success toast, scoped to this
 * flow's toaster only — the shared tenant Toaster keeps its default.
 * Sonner joins classNames without deduping, so the base `toast` slot
 * must not carry a conflicting bg/border: this toaster only ever
 * receives success toasts (both call sites use toast.success), and
 * the green tint/border live on both the `toast` and `success` slots
 * so the green wins regardless of stylesheet order. All other slots
 * mirror the shared Toast defaults exactly.
 */
export const ACCOUNTS_CONNECT_TOAST_OPTIONS: NonNullable<ToasterProps['toastOptions']> = {
  classNames: {
    toast:
      'group toast group flex items-start gap-2 rounded-md border border-brand-emerald bg-brand-emerald/15 p-4 text-body text-ink shadow-elevated',
    title: 'font-medium',
    description: 'text-ink-sub',
    actionButton: 'bg-primary text-on-primary rounded-sm px-3 h-9 font-medium',
    cancelButton: 'bg-subtle text-ink rounded-sm px-3 h-9 font-medium',
    closeButton: 'text-ink-sub hover:text-ink',
    success: 'text-brand-emerald border-brand-emerald bg-brand-emerald/15',
    error: 'text-brand-rose',
    warning: 'text-brand-gold',
    info: 'text-ink',
  },
};

export interface AccountsShellProps {
  subdomain: string;
}

function AccountsLoadingSkeleton() {
  return (
    <div
      data-testid="accounts-loading-skeleton"
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

export function AccountsShell({ subdomain }: Readonly<AccountsShellProps>) {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const accountsPath = buildTenantApiPath(subdomain, '/accounts');
  const byocPath = buildTenantApiPath(subdomain, '/settings/byoc');

  const accountsQuery = useQuery({
    queryKey: tenant.accounts.list,
    queryFn: ({ signal }) =>
      api.get(accountsPath, { schema: ListFacebookAccountsResponseSchema, signal }),
  });
  const byocQuery = useQuery({
    queryKey: tenant.settings.byoc,
    queryFn: ({ signal }) =>
      api.get(byocPath, { schema: ByocSettingsResponseSchema, signal }),
  });

  const accounts = React.useMemo<FacebookAccountItem[]>(
    () => (accountsQuery.data?.accounts ?? []) as FacebookAccountItem[],
    [accountsQuery.data]
  );
  const isLoading = accountsQuery.isPending;

  const [bannerNotice, setBannerNotice] = React.useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Option B dialogue: a briefly gold-highlighted card for the account
  // that was just connected/refreshed, shown while its toast is up.
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

  // Option B dialogue routing: success confirmations go to the
  // TOP-RIGHT toast (flow-scoped toaster below — the shared Toaster
  // default stays bottom-right for every other surface), while a
  // mismatch stays as a persistent, dismissible banner. Sonner toasts
  // carry role="status" / aria-live, so no extra live region is needed.
  const handleConnectionNotice = React.useCallback(
    (notice: {
      type: 'success' | 'error';
      message: string;
      accountId?: string | undefined;
    }) => {
      if (notice.type === 'success') {
        toast.success(notice.message, { toasterId: ACCOUNTS_CONNECT_TOASTER_ID });
        flashHighlight(notice.accountId ?? null);
      } else {
        setBannerNotice({ type: 'error', message: notice.message });
        flashHighlight(notice.accountId ?? null);
      }
    },
    [flashHighlight]
  );

  // BYOC credentials status & advisory modal. Derived from the shared
  // BYOC query with the previous implementation's exact semantics:
  // while the check runs (or is being retried) the state is "loading";
  // a failed check keeps the last known configuration and surfaces the
  // retry banner instead of gating.
  const byocStatus = React.useMemo<{
    isConfigured: boolean;
    isLoading: boolean;
    error: string | null;
  }>(() => {
    const isConfigured = byocQuery.data
      ? Boolean(byocQuery.data.fbAppId && byocQuery.data.hasSecret)
      : false;
    if (byocQuery.isError && !byocQuery.isFetching) {
      return {
        isConfigured,
        isLoading: false,
        error:
          isApiError(byocQuery.error) && byocQuery.error.kind === 'network'
            ? "Couldn't verify your Facebook App credentials. Please check your connection."
            : "Couldn't verify your Facebook App credentials. Please try again.",
      };
    }
    return {
      isConfigured,
      isLoading: byocQuery.isPending || (byocQuery.isFetching && byocQuery.isError),
      error: null,
    };
  }, [byocQuery.data, byocQuery.error, byocQuery.isError, byocQuery.isFetching, byocQuery.isPending]);
  const [isByocPromptOpen, setIsByocPromptOpen] = React.useState(false);

  // Modal & filter states
  const [isConnectOpen, setIsConnectOpen] = React.useState(false);
  const [reconnectingAccount, setReconnectingAccount] =
    React.useState<FacebookAccountItem | null>(null);
  const [disconnectingAccount, setDisconnectingAccount] =
    React.useState<FacebookAccountItem | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<AccountStatusFilter>('all');

  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/accounts/${accountId}`), {
        schema: DisconnectAccountResponseSchema,
      }),
    onSuccess: (_data, accountId) => {
      queryClient.setQueryData<{ accounts: FacebookAccountView[]; total: number }>(
        tenant.accounts.list,
        (prev) =>
          prev
            ? {
                ...prev,
                accounts: prev.accounts.filter((a) => a.id !== accountId),
                total: Math.max(0, prev.total - 1),
              }
            : prev
      );
      void queryClient.invalidateQueries({ queryKey: tenant.accounts.list });
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

  const refetchAccounts = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.accounts.list });
  }, [queryClient, tenant.accounts.list]);

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
    const resolved = resolveOAuthRedirectNotice(searchParams);
    if (!resolved) return;
    oauthNoticeHandledRef.current = true;

    if (resolved.notice.type === 'success') {
      toast.success(resolved.notice.message, { toasterId: ACCOUNTS_CONNECT_TOASTER_ID });
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

  // Handle Reconnect (opens ConnectAccountModal with reconnectingAccount context)
  const handleReconnect = (account: FacebookAccountItem) => {
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
      reportError(error, { source: 'accounts-disconnect' });
    }
  };

  const sortedAccounts = React.useMemo(() => sortAccountsExpiredFirst(accounts), [accounts]);
  const filteredAccounts = React.useMemo(
    () => filterAccountsList(sortedAccounts, searchQuery, statusFilter),
    [sortedAccounts, searchQuery, statusFilter]
  );
  const existingAccountIds = React.useMemo(() => accounts.map((a) => a.id), [accounts]);

  // Connect is gated while the App ID and Secret are known to be missing:
  // the action is disabled and the reason is shown next to it, instead of
  // letting a user start a connect flow that cannot succeed.
  const isConnectGated = isConnectGatedByMissingCredentials(byocStatus);
  const isConnectDisabled = byocStatus.isLoading || isConnectGated;
  const settingsFacebookHref = `/tenant/${subdomain}/settings?tab=byoc`;

  const attentionCount = React.useMemo(
    () => accounts.filter((a) => a.status === 'expired').length,
    [accounts]
  );
  const isFiltered = searchQuery.trim().length > 0 || statusFilter !== 'all';
  const situationalSubtitle = React.useMemo(
    () =>
      computeAccountsSubtitle(accounts, filteredAccounts.length, isFiltered),
    [accounts, filteredAccounts.length, isFiltered]
  );

  let contentNode: React.ReactNode;
  if (isLoading) {
    contentNode = <AccountsLoadingSkeleton />;
  } else if (accountsQuery.isError && accounts.length === 0) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="accounts-load-error"
        title="Couldn't load your accounts"
        description="Please try again."
        action={
          <Button
            type="button"
            data-testid="accounts-load-retry-btn"
            onClick={() => {
              void accountsQuery.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (accounts.length === 0) {
    contentNode = (
      <AccountsEmptyState
        onConnect={handleOpenNewConnect}
        isConnectDisabled={isConnectDisabled}
        credentialsMissing={isConnectGated}
        settingsHref={settingsFacebookHref}
      />
    );
  } else if (filteredAccounts.length === 0) {
    contentNode = (
      <div
        data-testid="accounts-filter-empty"
        className="rounded-md border border-line bg-panel p-6 text-center"
      >
        <p className="mb-4 text-body text-ink-sub">
          No accounts match your search or filter.
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="accounts-clear-filters-btn"
          onClick={() => {
            setSearchQuery('');
            setStatusFilter('all');
          }}
        >
          Clear filters
        </Button>
      </div>
    );
  } else {
    contentNode = (
      <div
        data-testid="accounts-grid"
        className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
      >
        {filteredAccounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            highlighted={account.id === highlightedAccountId}
            onReconnect={handleReconnect}
            onDisconnect={(acc) => setDisconnectingAccount(acc)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="facebook-accounts-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      {/* Flow-scoped toaster for connect confirmations only: TOP-RIGHT
          (the shared tenant Toaster stays bottom-right everywhere else).
          Toasts reach it via toasterId, never via the shared default. */}
      <Toast
        id={ACCOUNTS_CONNECT_TOASTER_ID}
        position="top-right"
        toastOptions={ACCOUNTS_CONNECT_TOAST_OPTIONS}
      />
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="accounts-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Facebook Accounts
          </h1>
          <p data-testid="accounts-page-subtitle" className="m-0 text-body text-ink-sub">
            {situationalSubtitle}
          </p>
        </div>

        {accounts.length > 0 && (
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              data-testid="header-connect-button"
              disabled={isConnectDisabled}
              aria-describedby={
                isConnectGated ? 'header-connect-gated-reason' : undefined
              }
              onClick={handleOpenNewConnect}
            >
              <PlusIcon aria-hidden />
              <span>Connect Account</span>
            </Button>
            {isConnectGated && (
              <span
                id="header-connect-gated-reason"
                data-testid="header-connect-gated-reason"
                className="text-metadata leading-body text-ink-sub"
              >
                Add your App ID and Secret first.{' '}
                <Link
                  href={settingsFacebookHref}
                  data-testid="header-connect-settings-link"
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
        <ByocRetryBanner
          message={byocStatus.error}
          onRetry={() => {
            void byocQuery.refetch();
          }}
        />
      )}

      {/* BYOC Required Warning Banner */}
      {!byocStatus.isLoading && !byocStatus.isConfigured && !byocStatus.error && (
        <ByocRequiredBanner subdomain={subdomain} />
      )}

      {/* Search & Status Filter Bar */}
      {!isLoading && accounts.length > 0 && (
        <AccountsFilterBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          attentionCount={attentionCount}
        />
      )}

      {/* Main Content Area */}
      {contentNode}

      {/* Connect Account Modal */}
      <ConnectAccountModal
        subdomain={subdomain}
        open={isConnectOpen}
        onOpenChange={handleConnectOpenChange}
        onAccountConnected={refetchAccounts}
        onConnectionNotice={handleConnectionNotice}
        existingAccountIds={existingAccountIds}
        reconnectingAccount={reconnectingAccount}
        initialAccounts={accounts}
      />

      {/* Disconnect Safety Dialog */}
      <DisconnectAccountDialog
        account={disconnectingAccount}
        open={Boolean(disconnectingAccount)}
        onOpenChange={(open) => !open && setDisconnectingAccount(null)}
        onConfirm={handleConfirmDisconnect}
        isDisconnecting={disconnectMutation.isPending}
      />

      {/* BYOC Configuration Advisory Modal */}
      <ByocConfigPromptModal
        subdomain={subdomain}
        open={isByocPromptOpen}
        onClose={() => setIsByocPromptOpen(false)}
      />
    </div>
  );
}
