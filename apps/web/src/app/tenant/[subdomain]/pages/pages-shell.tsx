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
 * arrival — an account id (what the card link sends since R16) or,
 * for old/bookmarked links, a display name — and syncs toolbar
 * changes back to the URL with router.replace, so the filtered view
 * is shareable and refresh-stable. An unknown param falls back to
 * 'all'. The shell already renders inside the route's Suspense
 * boundary (page.tsx), so useSearchParams needs no new boundary
 * here.
 *
 * R16: the account filter's values are account ids, never display
 * names, so two accounts sharing a name never collapse into one
 * option; the accounts list behind the options is the COMPLETE
 * set (paged through under the hood), not page 1 plus the current
 * 30-row page slice.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import { ListFacebookPagesResponseSchema } from '@/lib/api/schemas/pages';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { queryKeys } from '@/lib/data/query-keys';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { Toast, toast } from '@/components/shared/ui/toast';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import {
  PageCard,
  isPageNeedsAttention,
  type FacebookPageItem,
} from '@/components/pages/page-card';
import { PagesEmptyState } from '@/components/pages/pages-empty-state';
import {
  PagesScaleToolbar,
  type PageAccountFilterOption,
} from '@/components/pages/pages-toolbar';
import {
  computeSituationalSubtitle,
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
  // K9: the list query runs on the debounced search, not on every
  // keystroke; the toolbar input itself stays immediate.
  const debouncedSearchQuery = useDebouncedValue(searchQuery);
  const [statusFilter, setStatusFilter] =
    React.useState<PageStatusFilter>('all');
  const [accountFilter, setAccountFilter] = React.useState('all');

  const pagesQuery = useQuery({
    queryKey: tenant.pages.listPage({
      page,
      limit: DEFAULT_PAGE_SIZE,
      search: debouncedSearchQuery.trim(),
      status: statusFilter,
      account: accountFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, '/pages'), {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(debouncedSearchQuery.trim()
            ? { search: debouncedSearchQuery.trim() }
            : {}),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
          ...(accountFilter !== 'all' ? { account: accountFilter } : {}),
        }),
        {
          schema: ListFacebookPagesResponseSchema,
          signal,
        }
      ),
    // Perf: keep the previous page visible while the next one
    // loads instead of flashing the skeleton on every page,
    // search, or filter change.
    placeholderData: keepPreviousData,
  });
  // R16: the accounts read here feeds the account-filter options,
  // so it pages through the WHOLE accounts list (limit 50, the
  // server max, until the reported total is covered) instead of
  // taking only page 1. A repeated id or an empty page ends the
  // loop defensively, so a concurrent mutation mid-loop cannot
  // spin it forever.
  const accountsQuery = useQuery({
    queryKey: tenant.accounts.listAll,
    queryFn: async ({ signal }) => {
      const all: FacebookAccountItem[] = [];
      const seenIds = new Set<string>();
      let page = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const data = await api.get(
          buildUrl(buildTenantApiPath(subdomain, '/accounts'), {
            page,
            limit: 50,
          }),
          {
            schema: ListFacebookAccountsResponseSchema,
            signal,
          }
        );
        const batch = data.accounts as FacebookAccountItem[];
        if (batch.length === 0) break;
        let added = false;
        for (const account of batch) {
          if (account.id && !seenIds.has(account.id)) {
            seenIds.add(account.id);
            all.push(account);
            added = true;
          }
        }
        if (!added) break;
        total = data.total;
        page += 1;
      }
      return { accounts: all, total: all.length };
    },
  });
  const byocQuery = useQuery({
    queryKey: tenant.settings.byoc,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/settings/byoc'), {
        schema: ByocSettingsResponseSchema,
        signal,
      }),
  });

  // The API already returns the slice attention-first; the sort here
  // is a stable no-op on real data and keeps the documented order
  // for any cache seeded out of order.
  const pages = React.useMemo<FacebookPageItem[]>(
    () =>
      sortPagesAttentionFirst(
        (pagesQuery.data?.pages ?? []) as FacebookPageItem[]
      ),
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

  // The API returns the filtered, attention-first page slice, so the
  // grid renders it directly — no client-side filter anymore.
  // total/totalPages come from the API's filtered total.
  const total = pagesQuery.data?.total ?? 0;
  const totalPages = pagesQuery.data?.totalPages ?? 0;

  // An out-of-range ?page= is clamped by the API; sync the state (and
  // the URL, via the effect below) to the page that actually came back.
  // Placeholder data is excluded on purpose: while a new page
  // loads, keepPreviousData serves the previous payload, and
  // syncing to its page would drag the user back (the Threads
  // snap-back bug). Only a settled response may clamp.
  React.useEffect(() => {
    if (!pagesQuery.isPlaceholderData && pagesQuery.data && pagesQuery.data.page !== undefined && pagesQuery.data.page !== page) {
      setPage(pagesQuery.data.page);
    }
  }, [pagesQuery.data, pagesQuery.isPlaceholderData, page]);

  // Keep ?page= in the URL in step with state (page 1 omits the param).
  // A query-only replace resolves against the current pathname, so no
  // usePathname dependency is needed. Other params (e.g. ?account=)
  // are preserved because the effect builds from current searchParams.
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
  const handleStatusFilterChange = React.useCallback((value: PageStatusFilter) => {
    setStatusFilter(value);
    setPage(1);
  }, []);
  // Toolbar account changes sync back to the URL so the filtered view
  // is shareable and refresh-stable; choosing 'all' removes the param.
  // Other existing params are preserved, and any account change also
  // restarts at page 1 (the page effect then drops ?page= from the URL).
  // This is the single handler for toolbar account changes, so the URL
  // sync and the page reset cannot drift apart.
  const handleAccountFilterChange = React.useCallback(
    (value: string) => {
      setAccountFilter(value);
      setPage(1);
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
  const handleClearFilters = React.useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    handleAccountFilterChange('all');
  }, [handleAccountFilterChange]);

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

  // R16: filter values are account ids; labels are display names,
  // with an id suffix only where two accounts share a name (so the
  // two options stay distinguishable, never collapsed). A
  // page-slice account the accounts list does not carry keeps a
  // legacy display-name option, so its pages stay filterable —
  // the server matches a non-UUID filter by display_name.
  const accountOptions = React.useMemo<PageAccountFilterOption[]>(() => {
    const options: PageAccountFilterOption[] = [];
    const seenIds = new Set<string>();
    const nameCounts = new Map<string, number>();
    for (const a of accounts) {
      if (a.displayName) {
        nameCounts.set(
          a.displayName,
          (nameCounts.get(a.displayName) ?? 0) + 1
        );
      }
    }
    for (const a of accounts) {
      if (!a.id || seenIds.has(a.id)) continue;
      seenIds.add(a.id);
      const sharedName = (nameCounts.get(a.displayName) ?? 0) > 1;
      options.push({
        value: a.id,
        label: sharedName
          ? `${a.displayName} · …${a.id.slice(-6)}`
          : a.displayName,
      });
    }
    const knownNames = new Set(accounts.map((a) => a.displayName));
    for (const p of pages) {
      if (!p.accountDisplayName || knownNames.has(p.accountDisplayName)) {
        continue;
      }
      options.push({
        value: p.accountDisplayName,
        label: p.accountDisplayName,
      });
    }
    return options;
  }, [pages, accounts]);

  // Page-slice attention count: only a fallback for payloads that
  // predate the attentionTotal field. The subtitle and the toolbar
  // badge must count the FULL filtered set, not the visible page —
  // counting the slice made the "requires reconnecting" fragment
  // vanish on pages whose attention items sit beyond page 1.
  const attentionCount = React.useMemo(
    () => pages.filter((p) => isPageNeedsAttention(p.status)).length,
    [pages]
  );
  const attentionTotal = pagesQuery.data?.attentionTotal ?? attentionCount;

  const isFiltered =
    debouncedSearchQuery.trim().length > 0 ||
    statusFilter !== 'all' ||
    accountFilter !== 'all';

  // The subtitle counts from the API total and the full-set
  // attention total; the pagination line below ("Showing X–Y of Z")
  // is the authoritative window, not a substitute for the count.
  const situationalSubtitle = React.useMemo(() => {
    if (total === 0 && !isFiltered) {
      return computeSituationalSubtitle(0, 0, 0, false);
    }
    if (isFiltered) {
      return `${total} matching ${total === 1 ? 'page' : 'pages'}`;
    }
    return computeSituationalSubtitle(total, total, attentionTotal, false);
  }, [total, attentionTotal, isFiltered]);

  const handleSelectPage = (page: FacebookPageItem) => {
    router.push(`/tenant/${subdomain}/pages/${page.id}`);
  };

  const handlePagesImported = (result: {
    importedCount: number;
    importedPageIds: string[];
    accountId?: string | undefined;
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
    // K9: the imported cards must actually be visible — a filter
    // or page the user was sitting on used to strand them
    // off-slice with only a toast to show for it. Clear the
    // search/status filters and land on the imported account's
    // first page (all accounts when the account is unknown).
    // Residual limit, stated honestly: with more than one page of
    // results the imported card can still sit beyond page 1
    // (attention-first order); jumping straight to it would need
    // a server-side position lookup, which this does not add.
    setSearchQuery('');
    setStatusFilter('all');
    handleAccountFilterChange(result.accountId ?? 'all');
    void queryClient.invalidateQueries({ queryKey: tenant.pages.list });
    void queryClient.invalidateQueries({ queryKey: tenant.accounts.list });
  };

  const activeFilterLabels = React.useMemo(() => {
    const labels: string[] = [];
    if (debouncedSearchQuery.trim()) {
      labels.push(`Search: ${debouncedSearchQuery.trim()}`);
    }
    if (statusFilter !== 'all') {
      labels.push(
        statusFilter === 'needs_attention'
          ? 'Status: Needs Attention'
          : `Status: ${statusFilter.charAt(0).toUpperCase()}${statusFilter.slice(1)}`
      );
    }
    if (accountFilter !== 'all') {
      const option = accountOptions.find((o) => o.value === accountFilter);
      labels.push(`Account: ${option?.label ?? accountFilter}`);
    }
    return labels;
  }, [debouncedSearchQuery, statusFilter, accountFilter, accountOptions]);

  // K9: a failed accounts/BYOC read must not leave a stale grid
  // (or an empty filter list) unexplained. isRefetchError covers
  // the stale-grid case — a background refetch that fails while
  // old data is still shown — where isError alone stays false.
  // The grid itself keeps rendering; this notice only explains
  // that the account side of it may be out of date, with a Retry
  // that refetches just the failed queries.
  const secondaryQueryFailed =
    accountsQuery.isError ||
    accountsQuery.isRefetchError ||
    byocQuery.isError ||
    byocQuery.isRefetchError;

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
  } else if (pages.length === 0 && !isFiltered) {
    contentNode = (
      <PagesEmptyState
        onAddPage={() => setIsAddModalOpen(true)}
        subdomain={subdomain}
        facebookAppConfigured={facebookAppConfigured}
        byocPending={byocQuery.isPending}
        byocError={byocQuery.isError}
      />
    );
  } else if (pages.length === 0 && isFiltered) {
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
              onClick={handleClearFilters}
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
          data-testid="pages-grid"
          className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3"
        >
          {pages.map((page) => (
            <PageCard
              key={page.id}
              page={page}
              subdomain={subdomain}
              onSelectPage={handleSelectPage}
              highlighted={highlightedPageIds.includes(page.id)}
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
          (the shared tenant Toaster is top-right too, see the tenant
          layout mount).
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
            error: 'text-signal-critical',
            warning: 'text-link',
            info: 'text-ink',
          },
        }}
      />

      {/* Secondary-query failure notice (K9): the grid below keeps
          showing, but account filters / app-config guidance may be
          stale or missing until these queries succeed again. */}
      {secondaryQueryFailed && (
        <div
          data-testid="pages-secondary-error"
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-sm border border-link/25 bg-link/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          <span>
            Account information couldn&apos;t be refreshed, so account
            filters may be incomplete.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="pages-secondary-retry-btn"
            onClick={() => {
              void accountsQuery.refetch();
              void byocQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Scale Toolbar — always visible, at any page count. The old >4
          gate cannot survive pagination — its input was the unfiltered
          client-side list length, which no longer exists — and
          search/filters are what drive the paginated query, so hiding
          them would strand the user on a filtered page with no way
          back. */}
      {!isLoading && (
        <PagesScaleToolbar
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          statusFilter={statusFilter}
          onStatusFilterChange={handleStatusFilterChange}
          accountFilter={accountFilter}
          onAccountFilterChange={handleAccountFilterChange}
          accountOptions={accountOptions}
          attentionCount={attentionTotal}
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
        accountsPending={accountsQuery.isPending}
        onSuccess={handlePagesImported}
        onNavigateToAccounts={() => router.push(`/tenant/${subdomain}/accounts`)}
        facebookAppConfigured={facebookAppConfigured}
        byocPending={byocQuery.isPending}
        byocError={byocQuery.isError}
        onNavigateToSettingsFacebook={() =>
          router.push(`/tenant/${subdomain}/settings?tab=byoc`)
        }
        onReconnectAccount={handleReconnect}
      />
    </div>
  );
}
