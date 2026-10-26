'use client';

/**
 * Pages shell — the client island of the Pages route
 * (spec 131 PR-131-2, spec §8.1/§8.4).
 *
 * Data: initial pages + accounts + BYOC status arrive server-first
 * through the route's dehydration (see page.tsx) and are read /
 * refetched here with React Query over the typed API client — zero
 * raw fetch, zero fetch-on-mount for initial data. The BYOC status
 * shares the Settings surface's single cache entry
 * (`queryKeys.settings.byoc`, one shape per key, spec §8.3) and only
 * the `fbAppId`/`hasSecret` fields are read here.
 *
 * Mutations (named invalidation): a completed Add Page import
 * invalidates `queryKeys.pages.list` and `queryKeys.accounts.list`.
 *
 * Behaviour parity (spec §6): attention-first ordering, the
 * all/active/needs-attention/paused status filters, text search,
 * the account filter, and the situational subtitle — computed by the
 * same helpers the parity suites pin (`components/pages/pages-helpers`).
 * The Add Page finish confirmation is a top-right toast + gold card
 * highlight (see handlePagesImported), never a banner.
 *
 * Pages list redesign: the toolbar renders at any page count (no
 * >4 gate), cards use the Accounts-style tick/cross mark with no
 * dot, and there is NO expired-connection banner here — expired
 * accounts belong in the Accounts section, not Pages. The
 * Reconnect routing below survives only for the Add Page modal's
 * expired-account rows (Settings → Facebook when the workspace app
 * details are not configured, direct OAuth when they are).
 *
 * ?account= contract (Accounts card "pages linked" link): the shell
 * initialises its account filter from the `account` URL param on
 * arrival — a display name (what the card link sends) or an account
 * id — and syncs toolbar changes back to the URL with
 * router.replace, so the filtered view is shareable and
 * refresh-stable. An unknown param falls back to 'all'. The shell
 * already renders inside the route's Suspense boundary (page.tsx),
 * so useSearchParams needs no new boundary here.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import { ListFacebookPagesResponseSchema } from '@/lib/api/schemas/pages';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { queryKeys } from '@/lib/data/query-keys';
import { Toast, toast } from '@/components/shared/ui/toast';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import {
  PageCard,
  isPageNeedsAttention,
  type FacebookPageItem,
} from '@/components/pages/page-card';
import { PagesEmptyState } from '@/components/pages/pages-empty-state';
import { PagesScaleToolbar } from '@/components/pages/pages-toolbar';
import {
  computeSituationalSubtitle,
  filterPagesList,
  sortPagesAttentionFirst,
  type PageStatusFilter,
} from '@/components/pages/pages-helpers';
import { AddPageModal } from '@/components/pages/add-page-modal';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { buildDirectConnectUrl } from '@/components/accounts/connect-account-modal';

export interface PagesShellProps {
  subdomain: string;
}

/** Id of the Pages-only toaster: top-right, used solely by Add Page confirmations. */
const PAGES_IMPORT_TOASTER_ID = 'pages-import-toaster';

function PagesLoadingSkeleton() {
  return (
    <div
      data-testid="pages-loading-skeleton"
      aria-busy="true"
      aria-label="Loading pages"
      className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
    >
      {[1, 2].map((i) => (
        <Skeleton key={i} className="h-50 w-full rounded-md" />
      ))}
    </div>
  );
}

export function PagesShell({ subdomain }: Readonly<PagesShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const pagesQuery = useQuery({
    queryKey: tenant.pages.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/pages'), {
        schema: ListFacebookPagesResponseSchema,
        signal,
      }),
  });
  const accountsQuery = useQuery({
    queryKey: tenant.accounts.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
        signal,
      }),
  });
  const byocQuery = useQuery({
    queryKey: tenant.settings.byoc,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/settings/byoc'), {
        schema: ByocSettingsResponseSchema,
        signal,
      }),
  });

  const pages = React.useMemo<FacebookPageItem[]>(
    () => (pagesQuery.data?.pages ?? []) as FacebookPageItem[],
    [pagesQuery.data]
  );
  const accounts = React.useMemo<FacebookAccountItem[]>(
    () => (accountsQuery.data?.accounts ?? []) as FacebookAccountItem[],
    [accountsQuery.data]
  );
  const isLoading = pagesQuery.isPending;

  // Undefined until the credentials check has completed, so guidance
  // surfaces never claim the App ID and Secret are missing before
  // that is known (spec §6.2.2 — never gate on a failed check either:
  // an errored check also leaves this undefined here, and Reconnect
  // falls back to the Settings route, exactly as before).
  const facebookAppConfigured = byocQuery.data
    ? Boolean(byocQuery.data.fbAppId && byocQuery.data.hasSecret)
    : undefined;

  const [isAddModalOpen, setIsAddModalOpen] = React.useState(false);

  // Add Page confirmation (approved redesign): a briefly gold-highlighted
  // card for each just-imported page, shown while its top-right toast is
  // up — the same language as the Accounts connected dialogue. The
  // highlight clears after the toast duration (5s); no banner ever
  // pushes the grid down.
  const [highlightedPageIds, setHighlightedPageIds] = React.useState<string[]>([]);
  const highlightTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashHighlight = React.useCallback((pageIds: string[]) => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    setHighlightedPageIds(pageIds);
    if (pageIds.length > 0) {
      highlightTimeoutRef.current = setTimeout(() => {
        setHighlightedPageIds([]);
      }, 5000);
    }
  }, []);
  React.useEffect(
    () => () => {
      if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    },
    []
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<PageStatusFilter>('all');
  const [accountFilter, setAccountFilter] = React.useState('all');

  // ?account= initialisation (see the file header): applied once,
  // after the initial pages/accounts data is known, so an unknown
  // param can fall back to 'all' instead of an empty list. The raw
  // param is kept as the filter value (not resolved to a display
  // name) so an id filter stays exact when two accounts share a
  // display name; filterPagesList matches both forms. The applied
  // flag means later user changes are never clobbered by this effect.
  const accountParamAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (accountParamAppliedRef.current) return;
    if (pagesQuery.isPending || accountsQuery.isPending) return;
    if (!pagesQuery.data && !accountsQuery.data) return;
    accountParamAppliedRef.current = true;
    const param = searchParams.get('account');
    if (!param || param === 'all') return;
    // Only values filterPagesList can match count as known: a page's
    // display name or facebookAccountId, or an account's display name
    // or internal id (which is what pages carry as facebookAccountId).
    // The account's Facebook user id (fbAccountId) is deliberately NOT
    // accepted — the helper cannot match it, so accepting it would
    // produce an empty list instead of the 'all' fallback.
    const known =
      pages.some(
        (p) => p.accountDisplayName === param || p.facebookAccountId === param
      ) ||
      accounts.some((a) => a.displayName === param || a.id === param);
    if (known) {
      setAccountFilter(param);
    }
  }, [
    pagesQuery.isPending,
    accountsQuery.isPending,
    pagesQuery.data,
    accountsQuery.data,
    pages,
    accounts,
    searchParams,
  ]);

  // Toolbar (and Clear filters) changes sync back to the URL so the
  // filtered view is shareable and refresh-stable; choosing 'all'
  // removes the param. Other existing params are preserved.
  const handleAccountFilterChange = React.useCallback(
    (value: string) => {
      setAccountFilter(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'all') {
        params.delete('account');
      } else {
        params.set('account', value);
      }
      const query = params.toString();
      router.replace(
        query ? `/tenant/${subdomain}/pages?${query}` : `/tenant/${subdomain}/pages`
      );
    },
    [router, searchParams, subdomain]
  );

  const handleReconnect = React.useCallback(
    (account: FacebookAccountItem) => {
      if (byocQuery.isPending) return;
      if (!facebookAppConfigured) {
        // No workspace app credentials: send the user to Settings → Facebook,
        // which explains why the app details are needed before reconnecting.
        router.push(`/tenant/${subdomain}/settings?tab=byoc&notice=reconnect`);
        return;
      }
      // Credentials present: start the OAuth reconnect immediately.
      window.location.href = buildDirectConnectUrl({
        id: account.id,
        fbAccountId: account.fbAccountId,
        displayName: account.displayName,
        status: account.status,
        updatedAt: account.updatedAt,
      });
    },
    [byocQuery.isPending, facebookAppConfigured, router, subdomain]
  );

  const sortedPages = React.useMemo(() => sortPagesAttentionFirst(pages), [pages]);

  const accountOptions = React.useMemo(() => {
    const names = new Set<string>();
    for (const p of pages) {
      if (p.accountDisplayName) {
        names.add(p.accountDisplayName);
      }
    }
    for (const a of accounts) {
      if (a.displayName) {
        names.add(a.displayName);
      }
    }
    return Array.from(names);
  }, [pages, accounts]);

  const filteredPages = React.useMemo(
    () => filterPagesList(sortedPages, searchQuery, statusFilter, accountFilter),
    [sortedPages, searchQuery, statusFilter, accountFilter]
  );

  const attentionCount = React.useMemo(
    () => pages.filter((p) => isPageNeedsAttention(p.status)).length,
    [pages]
  );

  const isFiltered =
    searchQuery.trim().length > 0 || statusFilter !== 'all' || accountFilter !== 'all';

  const situationalSubtitle = React.useMemo(
    () =>
      computeSituationalSubtitle(
        pages.length,
        filteredPages.length,
        attentionCount,
        isFiltered
      ),
    [pages.length, filteredPages.length, attentionCount, isFiltered]
  );

  const handleSelectPage = (page: FacebookPageItem) => {
    router.push(`/tenant/${subdomain}/pages/${page.id}`);
  };

  const handlePagesImported = (result: {
    importedCount: number;
    importedPageIds: string[];
  }) => {
    // Sonner toasts carry role="status" / aria-live, so no extra live
    // region is needed; the toast text names the count, so the
    // highlight never relies on colour alone.
    toast.success(
      result.importedCount === 1
        ? '1 Facebook Page added'
        : `${result.importedCount} Facebook Pages added`,
      { toasterId: PAGES_IMPORT_TOASTER_ID }
    );
    flashHighlight(result.importedPageIds);
    void queryClient.invalidateQueries({ queryKey: tenant.pages.list });
    void queryClient.invalidateQueries({ queryKey: tenant.accounts.list });
  };

  const activeFilterLabels = React.useMemo(() => {
    const labels: string[] = [];
    if (searchQuery.trim()) labels.push(`Search: ${searchQuery.trim()}`);
    if (statusFilter !== 'all') {
      labels.push(
        statusFilter === 'needs_attention'
          ? 'Status: Needs Attention'
          : `Status: ${statusFilter.charAt(0).toUpperCase()}${statusFilter.slice(1)}`
      );
    }
    if (accountFilter !== 'all') labels.push(`Account: ${accountFilter}`);
    return labels;
  }, [searchQuery, statusFilter, accountFilter]);

  let contentNode: React.ReactNode;
  if (isLoading) {
    contentNode = <PagesLoadingSkeleton />;
  } else if (pagesQuery.isError && pages.length === 0) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="pages-load-error"
        title="Couldn't load your pages"
        description="Please try again."
        action={
          <Button
            type="button"
            data-testid="pages-load-retry-btn"
            onClick={() => {
              void pagesQuery.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (pages.length === 0) {
    contentNode = (
      <PagesEmptyState
        onAddPage={() => setIsAddModalOpen(true)}
        subdomain={subdomain}
        facebookAppConfigured={facebookAppConfigured}
      />
    );
  } else if (filteredPages.length === 0) {
    contentNode = (
      <div
        data-testid="pages-filter-empty"
        className="rounded-md border border-line bg-panel"
      >
        <EmptyState
          type="no-results"
          title="No Facebook Pages match your search or filter."
          activeFilters={activeFilterLabels}
          action={
            <Button
              type="button"
              variant="outline"
              data-testid="pages-clear-filters-btn"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
                handleAccountFilterChange('all');
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
      <div
        data-testid="pages-grid"
        className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
      >
        {filteredPages.map((page) => (
          <PageCard
            key={page.id}
            page={page}
            subdomain={subdomain}
            onSelectPage={handleSelectPage}
            highlighted={highlightedPageIds.includes(page.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      data-testid="facebook-pages-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      {/* Page Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            data-testid="pages-page-title"
            className="mb-1 text-xxl font-bold tracking-h1 text-ink"
          >
            Facebook Pages
          </h1>
          <p data-testid="pages-page-subtitle" className="m-0 text-body text-ink-sub">
            {situationalSubtitle}
          </p>
        </div>

        <Button
          type="button"
          data-testid="header-add-page-btn"
          onClick={() => setIsAddModalOpen(true)}
        >
          <PlusIcon aria-hidden />
          <span>Add Page</span>
        </Button>
      </div>

      {/* Flow-scoped toaster for Add Page confirmations only: TOP-RIGHT
          (the shared tenant Toaster stays bottom-right everywhere else).
          Toasts reach it via toasterId, never via the shared default.
          NOTE: passing toastOptions here replaces the shared Toast's
          defaults wholesale (its {...props} spread comes last), so the
          base slots below are copied verbatim from shared/ui/toast.tsx
          and only `success` is changed: the import toast is visibly
          GREEN (green-tinted background + green border, green tick
          icon via text-brand-emerald). Sonner joins the slots with
          tailwind-merge, so the success slot wins over the base
          border-line / bg-panel. Only this flow's success toast goes
          green — the shared tenant Toaster is untouched. */}
      <Toast
        id={PAGES_IMPORT_TOASTER_ID}
        position="top-right"
        toastOptions={{
          classNames: {
            toast:
              'group toast group flex items-start gap-2 rounded-md border border-line bg-panel p-4 text-body text-ink shadow-elevated',
            title: 'font-medium',
            description: 'text-ink-sub',
            actionButton: 'bg-primary text-on-primary rounded-sm px-3 h-9 font-medium',
            cancelButton: 'bg-subtle text-ink rounded-sm px-3 h-9 font-medium',
            closeButton: 'text-ink-sub hover:text-ink',
            success: 'border-brand-emerald bg-brand-emerald/15 text-brand-emerald',
            error: 'text-brand-rose',
            warning: 'text-brand-gold',
            info: 'text-ink',
          },
        }}
      />

      {/* Scale Toolbar — always visible, at any page count */}
      {!isLoading && (
        <PagesScaleToolbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          accountFilter={accountFilter}
          onAccountFilterChange={handleAccountFilterChange}
          accountOptions={accountOptions}
          attentionCount={attentionCount}
        />
      )}

      {/* Main Content */}
      {contentNode}

      {/* Two-Step Add Page Modal */}
      <AddPageModal
        subdomain={subdomain}
        open={isAddModalOpen}
        onOpenChange={setIsAddModalOpen}
        accounts={accounts}
        onSuccess={handlePagesImported}
        onNavigateToAccounts={() => router.push(`/tenant/${subdomain}/accounts`)}
        facebookAppConfigured={facebookAppConfigured}
        onNavigateToSettingsFacebook={() =>
          router.push(`/tenant/${subdomain}/settings?tab=byoc`)
        }
        onReconnectAccount={handleReconnect}
      />
    </div>
  );
}
