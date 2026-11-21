'use client';

/**
 * Bulk Delete Posts page (spec 213) — delete live published Facebook
 * posts in bulk. Modelled on Publish Now's wizard (accounts, then
 * pages discovered live from Facebook) and on the old bulk-delete
 * section (`~/workspace/old-fbuploadpro`,
 * agency/facebook/bulk-delete):
 *
 *   Step 1 Select accounts (search, rows, Select All) — expired
 *     accounts shown but NOT selectable, with Reconnect.
 *   Step 2 Select pages (search, 2-column grid grouped by account,
 *     Select All / Deselect All, pages-found count). A page under two
 *     accounts is de-duplicated to the first account.
 *   Smart Filter — type (All / Posts / Photos / Reels), sort
 *     (Oldest / Newest First), date From/To, Preview Targets.
 *     Preview returns up to 500 candidates across all selected
 *     pages; all previewed items are pre-selected.
 *   Manual Curation — live list for one page at a time (page
 *     switcher when several pages are selected), type tabs, cursor
 *     pagination, Load More. Selection persists across pages/tabs.
 *   Delete — floating bar with the selected count and "Delete
 *     Selected". NO confirmation dialog (explicit owner decision for
 *     this section only). The run is client-driven in batches of 20
 *     with a 60-second pause between batches, and STOPS if the tab
 *     closes. Progress overlay: ring %, Processed / Succeeded /
 *     Failed / ETA, failures panel.
 *
 * Nothing here writes to the database. The account token is resolved
 * server-side by the API routes; the browser never sees or sends one.
 */

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Loader2, SearchIcon, Trash2Icon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  BULK_DELETE_CLIENT_BATCH_SIZE,
  BULK_DELETE_CLIENT_PAUSE_SECONDS,
  BULK_DELETE_MAX_PREVIEW,
  BulkDeleteBatchResponseSchema,
  BulkDeleteContentResponseSchema,
  BulkDeletePreviewResponseSchema,
  DiscoverPagesResponseSchema,
  type BulkDeleteContentType,
  type BulkDeletePreviewType,
  type BulkDeleteSort,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { Progress } from '@/components/shared/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { toast } from '@/components/shared/ui/toast';
import { getAccountHealth } from '@/components/accounts/account-health';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { buildDirectConnectUrl } from '@/components/accounts/connect-account-modal';
import { getUserInitials } from '@/lib/user-initials';
import { buildAccountsHref } from '@/components/pages/add-page-helpers';
import { cn } from '@/lib/utils';
import type {
  BulkDeleteCandidate,
  BulkDeleteDiscoveredGroup,
  BulkDeleteDiscoveredPage,
  BulkDeleteRunFailure,
  BulkDeleteRunState,
} from './types';

const PREVIEW_PAGE_SIZE = 12;
const MANUAL_PAGE_SIZE = 20;
const MANUAL_FETCH_LIMIT = 25;

const PREVIEW_TYPES: Array<{ id: BulkDeletePreviewType; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'posts', label: 'Posts' },
  { id: 'photos', label: 'Photos' },
  { id: 'reels', label: 'Reels' },
];

const MANUAL_TYPES: Array<{ id: BulkDeleteContentType; label: string }> = [
  { id: 'posts', label: 'Posts' },
  { id: 'photos', label: 'Photos' },
  { id: 'reels', label: 'Reels' },
];

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    if (error.message && error.message !== 'INVALID_REQUEST') return error.message;
    return fallback;
  }
  if (error instanceof Error && error.message && error.message !== 'INVALID_REQUEST') {
    return error.message;
  }
  return fallback;
}

function Avatar({
  name,
  pictureUrl,
  size = 'md',
}: Readonly<{
  name: string;
  pictureUrl?: string | null | undefined;
  size?: 'md' | 'lg' | undefined;
}>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg = Boolean(pictureUrl) && failedUrl !== pictureUrl;
  const initials = getUserInitials(name) || 'FB';
  const sizeClass = size === 'lg' ? 'size-12' : 'size-9';
  if (showImg) {
    return (
      <Image
        src={pictureUrl!}
        alt={name}
        width={size === 'lg' ? 48 : 36}
        height={size === 'lg' ? 48 : 36}
        onError={() => setFailedUrl(pictureUrl ?? '__error__')}
        className={cn(sizeClass, 'shrink-0 rounded-full border border-line object-cover')}
      />
    );
  }
  return (
    <div
      className={cn(
        sizeClass,
        'flex shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-body font-bold text-ink',
      )}
    >
      {initials}
    </div>
  );
}

function formatEta(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return '—';
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

function typeLabel(type: BulkDeleteContentType): string {
  if (type === 'posts') return 'Posts';
  if (type === 'photos') return 'Photos';
  return 'Reels';
}

export function BulkDeletePage({ subdomain }: Readonly<{ subdomain: string }>) {
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [accountSearchQuery, setAccountSearchQuery] = React.useState('');
  const [pageSearchQuery, setPageSearchQuery] = React.useState('');
  const [groups, setGroups] = React.useState<BulkDeleteDiscoveredGroup[]>([]);
  const [selectedPageKeys, setSelectedPageKeys] = React.useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const [mode, setMode] = React.useState<'smart' | 'manual'>('smart');
  const [previewType, setPreviewType] = React.useState<BulkDeletePreviewType>('all');
  const [sort, setSort] = React.useState<BulkDeleteSort>('oldest_first');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [previewItems, setPreviewItems] = React.useState<BulkDeleteCandidate[]>([]);
  const [previewTotal, setPreviewTotal] = React.useState(0);
  const [isPreviewing, setIsPreviewing] = React.useState(false);
  const [hasPreviewed, setHasPreviewed] = React.useState(false);
  const [previewPage, setPreviewPage] = React.useState(1);
  // Pages whose preview call failed on the last Preview Targets run.
  // Shown alongside the partial results so the user knows what is
  // missing and can retry just those pages.
  const [previewFailures, setPreviewFailures] = React.useState<
    Array<{ pageName: string; reason: string }>
  >([]);

  const [manualPageKeyOverride, setManualPageKeyOverride] = React.useState<string | null>(null);
  const [manualType, setManualType] = React.useState<BulkDeleteContentType>('posts');
  const [manualPage, setManualPage] = React.useState(1);

  const [selectedContentIds, setSelectedContentIds] = React.useState<string[]>([]);
  const [runState, setRunState] = React.useState<BulkDeleteRunState | null>(null);

  // Every listed candidate, keyed by id, so a delete run can resolve
  // each selected id back to its account (the batch route is per
  // account). Refilled on every preview / manual load.
  const candidatesRef = React.useRef(new Map<string, BulkDeleteCandidate>());
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const accountsQuery = useQuery({
    queryKey: ['bulk-delete', 'accounts', subdomain],
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
        query: { page: 1, limit: 50 },
        signal,
      }),
  });

  const accounts = React.useMemo<FacebookAccountItem[]>(
    () => (accountsQuery.data?.accounts ?? []) as FacebookAccountItem[],
    [accountsQuery.data],
  );
  const activeAccounts = React.useMemo(
    () => accounts.filter((acc) => getAccountHealth(acc) === 'connected'),
    [accounts],
  );
  const nonSelectableAccounts = React.useMemo(
    () =>
      accounts.filter((acc) => {
        const health = getAccountHealth(acc);
        return health === 'expired' || health === 'error';
      }),
    [accounts],
  );
  const filteredActiveAccounts = React.useMemo(() => {
    const query = accountSearchQuery.trim().toLowerCase();
    if (!query) return activeAccounts;
    return activeAccounts.filter((acc) => acc.displayName.toLowerCase().includes(query));
  }, [activeAccounts, accountSearchQuery]);

  const allPages = React.useMemo<BulkDeleteDiscoveredPage[]>(
    () => groups.flatMap((group) => group.pages),
    [groups],
  );
  const selectedPages = React.useMemo(
    () => allPages.filter((page) => selectedPageKeys.includes(`${page.accountId}:${page.fbPageId}`)),
    [allPages, selectedPageKeys],
  );
  const filteredGroups = React.useMemo(() => {
    const query = pageSearchQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups
      .map((group) => ({
        ...group,
        pages: group.pages.filter((page) => page.pageName.toLowerCase().includes(query)),
      }))
      .filter((group) => group.pages.length > 0);
  }, [groups, pageSearchQuery]);

  const toggleAccount = React.useCallback((accountId: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId],
    );
  }, []);

  const toggleSelectAllAccounts = React.useCallback(() => {
    const allSelected =
      activeAccounts.length > 0 &&
      activeAccounts.every((account) => selectedAccountIds.includes(account.id));
    setSelectedAccountIds(allSelected ? [] : activeAccounts.map((account) => account.id));
  }, [activeAccounts, selectedAccountIds]);

  const handleDiscoverPages = React.useCallback(async () => {
    const selectedAccounts = activeAccounts.filter((acc) => selectedAccountIds.includes(acc.id));
    if (selectedAccounts.length === 0) return;
    setIsDiscovering(true);
    setErrorMessage(null);
    try {
      // Live discovery: the selected accounts' pages are discovered
      // live from Facebook each time — nothing is imported or saved.
      // One account failing never blocks the others.
      const settled = await Promise.allSettled(
        selectedAccounts.map((account) =>
          api.get(buildTenantApiPath(subdomain, `/accounts/${account.id}/pages/discover`), {
            schema: DiscoverPagesResponseSchema,
          }),
        ),
      );
      const seenPageIds = new Set<string>();
      const nextGroups: BulkDeleteDiscoveredGroup[] = [];
      const failures: string[] = [];
      settled.forEach((result, index) => {
        const account = selectedAccounts[index];
        if (!account) return;
        if (result.status === 'rejected') {
          failures.push(account.displayName);
          nextGroups.push({ accountId: account.id, accountName: account.displayName, pages: [] });
          return;
        }
        const pages: BulkDeleteDiscoveredPage[] = [];
        for (const page of result.value.pages) {
          if (seenPageIds.has(page.fbPageId)) continue;
          seenPageIds.add(page.fbPageId);
          pages.push({
            accountId: account.id,
            accountName: account.displayName,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            profilePictureUrl: page.profilePictureUrl ?? null,
            followers: page.currentFollowers,
          });
        }
        nextGroups.push({ accountId: account.id, accountName: account.displayName, pages });
      });
      setGroups(nextGroups);
      setSelectedPageKeys([]);
      setManualPageKeyOverride(null);
      setPreviewItems([]);
      setPreviewTotal(0);
      setHasPreviewed(false);
      setPreviewFailures([]);
      // The manual list is derived (React Query + Load More appends), so
      // clearing it means clearing the appended extras and pagination.
      setExtraItems([]);
      setExtraAfter(undefined);
      setManualPage(1);
      setSelectedContentIds([]);
      candidatesRef.current.clear();
      if (failures.length > 0) {
        setErrorMessage(
          "Couldn't load pages from this Facebook account. Please check the account connection and try again.",
        );
      }
    } catch (error) {
      setErrorMessage(
        errorText(error, 'An error occurred while loading pages from Facebook. Please try again.'),
      );
    } finally {
      setIsDiscovering(false);
    }
  }, [activeAccounts, selectedAccountIds, subdomain]);

  const togglePage = React.useCallback((key: string) => {
    setSelectedPageKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  const toggleSelectAllPages = React.useCallback(() => {
    const selectableKeys = allPages.map((page) => `${page.accountId}:${page.fbPageId}`);
    const allSelected =
      selectableKeys.length > 0 && selectableKeys.every((key) => selectedPageKeys.includes(key));
    setSelectedPageKeys(allSelected ? [] : selectableKeys);
  }, [allPages, selectedPageKeys]);

  // The manual list browses one page at a time. The browsed page is
  // derived, never stored: the user's override while it is still
  // selected, otherwise the first selected page. No effect needed.
  const manualSelectedPage =
    selectedPages.find(
      (page) => `${page.accountId}:${page.fbPageId}` === manualPageKeyOverride,
    ) ?? selectedPages[0] ?? null;
  const manualPageKey = manualSelectedPage
    ? `${manualSelectedPage.accountId}:${manualSelectedPage.fbPageId}`
    : null;

  // ---- Manual list (React Query; Load More appends via event) ----
  const manualQuery = useQuery({
    queryKey: ['bulk-delete', 'content', subdomain, manualPageKey, manualType],
    enabled: manualPageKey !== null && mode === 'manual',
    queryFn: async ({ signal }) => {
      if (!manualSelectedPage) throw new Error('No page selected.');
      return api.get(
        buildTenantApiPath(subdomain, '/bulk-delete/content'),
        {
          schema: BulkDeleteContentResponseSchema,
          query: {
            accountId: manualSelectedPage.accountId,
            pageId: manualSelectedPage.fbPageId,
            type: manualType,
            limit: MANUAL_FETCH_LIMIT,
          },
          signal,
        },
      );
    },
  });

  const [extraItems, setExtraItems] = React.useState<BulkDeleteCandidate[]>([]);
  const [extraAfter, setExtraAfter] = React.useState<string | null | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);

  const manualBaseItems = React.useMemo<BulkDeleteCandidate[]>(() => {
    if (!manualSelectedPage || !manualQuery.data) return [];
    return manualQuery.data.items.map((item) => ({
      ...item,
      accountId: manualSelectedPage.accountId,
      pageId: manualSelectedPage.fbPageId,
      pageName: manualSelectedPage.pageName,
    }));
  }, [manualQuery.data, manualSelectedPage]);

  const manualItems = React.useMemo(
    () => [...manualBaseItems, ...extraItems],
    [manualBaseItems, extraItems],
  );
  const manualCursor = extraAfter !== undefined ? extraAfter : (manualQuery.data?.paging.after ?? null);

  // Keep the delete-run registry current. Ref mutation in effects only;
  // the registry is never rendered, so it is not component state.
  React.useEffect(() => {
    for (const item of previewItems) candidatesRef.current.set(item.id, item);
  }, [previewItems]);
  React.useEffect(() => {
    for (const item of manualItems) candidatesRef.current.set(item.id, item);
  }, [manualItems]);

  const resetManualExtras = React.useCallback(() => {
    setExtraItems([]);
    setExtraAfter(undefined);
    setManualPage(1);
  }, []);

  const handleLoadMoreManual = React.useCallback(async () => {
    if (!manualSelectedPage || !manualCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const response = await api.get(
        buildTenantApiPath(subdomain, '/bulk-delete/content'),
        {
          schema: BulkDeleteContentResponseSchema,
          query: {
            accountId: manualSelectedPage.accountId,
            pageId: manualSelectedPage.fbPageId,
            type: manualType,
            limit: MANUAL_FETCH_LIMIT,
            after: manualCursor,
          },
        },
      );
      const next: BulkDeleteCandidate[] = response.items.map((item) => ({
        ...item,
        accountId: manualSelectedPage.accountId,
        pageId: manualSelectedPage.fbPageId,
        pageName: manualSelectedPage.pageName,
      }));
      setExtraItems((prev) => [...prev, ...next]);
      setExtraAfter(response.paging.after);
    } catch (error) {
      setErrorMessage(
        errorText(error, "Couldn't load more posts. Please try again."),
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [manualSelectedPage, manualCursor, isLoadingMore, subdomain, manualType]);

  // ---- Smart Filter preview ----
  const previewTargets = React.useCallback(
    async (keepFailedIds?: ReadonlySet<string>) => {
      if (selectedPages.length === 0) return;
      setIsPreviewing(true);
      setErrorMessage(null);
      setPreviewFailures([]);
      try {
        const merged: BulkDeleteCandidate[] = [];
        const failures: Array<{ pageName: string; reason: string }> = [];
        // One page at a time, sequentially — bounded, rate-limit
        // friendly. Each page is fetched in its own try/catch, so a
        // single page failing (dead token, removed/unpublished page,
        // transient Graph error) is recorded and the loop continues
        // with the remaining pages instead of discarding everything.
        for (const page of selectedPages) {
          try {
            const response = await api.post(
              buildTenantApiPath(subdomain, '/bulk-delete/preview'),
              {
                accountId: page.accountId,
                pageId: page.fbPageId,
                type: previewType,
                sort,
                ...(dateFrom ? { dateFrom } : {}),
                ...(dateTo ? { dateTo } : {}),
              },
              { schema: BulkDeletePreviewResponseSchema },
            );
            for (const item of response.candidates) {
              merged.push({
                ...item,
                accountId: page.accountId,
                pageId: page.fbPageId,
                pageName: page.pageName,
              });
            }
          } catch (error) {
            failures.push({
              pageName: page.pageName,
              reason: errorText(error, "Couldn't preview this page."),
            });
          }
        }
        if (merged.length === 0 && failures.length > 0) {
          // Every page failed: keep the current behaviour — generic
          // error, no stale preview presented as fresh.
          setErrorMessage("Couldn't preview posts to delete. Please try again.");
          setPreviewFailures(failures);
          return;
        }
        const sorted = [...merged].sort((a, b) => {
          const av = a.createdTime ? Date.parse(a.createdTime) : 0;
          const bv = b.createdTime ? Date.parse(b.createdTime) : 0;
          return sort === 'oldest_first' ? av - bv : bv - av;
        });
        const candidates = sorted.slice(0, BULK_DELETE_MAX_PREVIEW);
        setPreviewItems(candidates);
        setPreviewTotal(candidates.length);
        setHasPreviewed(true);
        setPreviewPage(1);
        setPreviewFailures(failures);
        if (keepFailedIds) {
          const kept = new Set(candidates.map((c) => c.id));
          setSelectedContentIds((prev) => prev.filter((id) => keepFailedIds.has(id) && kept.has(id)));
        } else {
          // Old behaviour: everything previewed is pre-selected.
          setSelectedContentIds(candidates.map((c) => c.id));
        }
      } finally {
        setIsPreviewing(false);
      }
    },
    [selectedPages, subdomain, previewType, sort, dateFrom, dateTo],
  );

  // ---- Selection ----
  const toggleContent = React.useCallback((id: string) => {
    setSelectedContentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const previewPageItems = React.useMemo(() => {
    const start = (previewPage - 1) * PREVIEW_PAGE_SIZE;
    return previewItems.slice(start, start + PREVIEW_PAGE_SIZE);
  }, [previewItems, previewPage]);
  const previewPageCount = Math.max(1, Math.ceil(previewItems.length / PREVIEW_PAGE_SIZE));

  const manualPageItems = React.useMemo(() => {
    const start = (manualPage - 1) * MANUAL_PAGE_SIZE;
    return manualItems.slice(start, start + MANUAL_PAGE_SIZE);
  }, [manualItems, manualPage]);
  const manualPageCount = Math.max(1, Math.ceil(manualItems.length / MANUAL_PAGE_SIZE));

  const selectAllPreview = React.useCallback(() => {
    setSelectedContentIds((prev) => {
      const next = new Set(prev);
      for (const item of previewItems) next.add(item.id);
      return [...next];
    });
  }, [previewItems]);
  const deselectAllPreview = React.useCallback(() => {
    setSelectedContentIds((prev) => {
      const previewIds = new Set(previewItems.map((item) => item.id));
      return prev.filter((id) => !previewIds.has(id));
    });
  }, [previewItems]);
  const selectAllManual = React.useCallback(() => {
    setSelectedContentIds((prev) => {
      const next = new Set(prev);
      for (const item of manualItems) next.add(item.id);
      return [...next];
    });
  }, [manualItems]);
  const deselectAllManual = React.useCallback(() => {
    setSelectedContentIds((prev) => {
      const manualIds = new Set(manualItems.map((item) => item.id));
      return prev.filter((id) => !manualIds.has(id));
    });
  }, [manualItems]);

  // ---- Delete run (client-driven; closing the tab stops it) ----
  const executeDelete = React.useCallback(async () => {
    const ids = selectedContentIds;
    if (ids.length === 0 || runState !== null) return;
    const byAccount = new Map<string, string[]>();
    const missing: string[] = [];
    for (const id of ids) {
      const candidate = candidatesRef.current.get(id);
      if (!candidate) {
        missing.push(id);
        continue;
      }
      const list = byAccount.get(candidate.accountId) ?? [];
      list.push(id);
      byAccount.set(candidate.accountId, list);
    }
    if (missing.length > 0) {
      setErrorMessage(
        'Some selected posts could not be found. Preview again and try once more.',
      );
      return;
    }
    const batches: Array<{ accountId: string; ids: string[] }> = [];
    for (const [accountId, accountIds] of byAccount) {
      for (let i = 0; i < accountIds.length; i += BULK_DELETE_CLIENT_BATCH_SIZE) {
        batches.push({ accountId, ids: accountIds.slice(i, i + BULK_DELETE_CLIENT_BATCH_SIZE) });
      }
    }
    const startedAt = Date.now();
    setRunState({
      status: 'running',
      total: ids.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      currentBatch: 1,
      totalBatches: batches.length,
      startedAt,
      pauseSecondsLeft: 0,
      failures: [],
    });
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const failures: BulkDeleteRunFailure[] = [];
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      if (!batch || !mountedRef.current) return;
      setRunState((prev) =>
        prev ? { ...prev, status: 'running', currentBatch: b + 1, pauseSecondsLeft: 0 } : prev,
      );
      try {
        const response = await api.post(
          buildTenantApiPath(subdomain, '/bulk-delete/batch-delete'),
          { accountId: batch.accountId, contentIds: batch.ids },
          { schema: BulkDeleteBatchResponseSchema },
        );
        for (const result of response.results) {
          if (result.success) {
            succeeded += 1;
          } else {
            failed += 1;
            failures.push({
              id: result.id,
              pageName: candidatesRef.current.get(result.id)?.pageName ?? '',
              error: result.error ?? 'Failed to delete',
            });
          }
        }
      } catch (error) {
        // The whole batch failed (dead token, network): every id in
        // it failed, reported individually so the user can retry them.
        for (const id of batch.ids) {
          failed += 1;
          failures.push({
            id,
            pageName: candidatesRef.current.get(id)?.pageName ?? '',
            error: errorText(error, 'Failed to delete'),
          });
        }
      }
      processed += batch.ids.length;
      if (!mountedRef.current) return;
      setRunState((prev) =>
        prev ? { ...prev, processed, succeeded, failed, failures: [...failures] } : prev,
      );
      if (b < batches.length - 1) {
        setRunState((prev) =>
          prev ? { ...prev, status: 'paused', pauseSecondsLeft: BULK_DELETE_CLIENT_PAUSE_SECONDS } : prev,
        );
        for (let wait = BULK_DELETE_CLIENT_PAUSE_SECONDS; wait > 0; wait -= 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!mountedRef.current) return;
          const left = wait - 1;
          setRunState((prev) => (prev ? { ...prev, pauseSecondsLeft: left } : prev));
        }
      }
    }
    if (!mountedRef.current) return;
    setRunState((prev) => (prev ? { ...prev, status: 'done', pauseSecondsLeft: 0 } : prev));
    // Keep failed ids selected for a retry; clear the succeeded ones.
    const failedIds = new Set(failures.map((failure) => failure.id));
    setSelectedContentIds((prev) => prev.filter((id) => failedIds.has(id)));
    if (failed === 0) {
      toast.success(`Deleted ${succeeded} ${succeeded === 1 ? 'post' : 'posts'}.`);
    } else {
      toast.error(`${succeeded} deleted, ${failed} failed.`);
    }
    // Refresh the active list so deleted posts disappear.
    if (mode === 'smart') {
      await previewTargets(failedIds);
    } else {
      resetManualExtras();
      await manualQuery.refetch();
    }
  }, [selectedContentIds, runState, subdomain, mode, previewTargets, resetManualExtras, manualQuery]);

  const runPercent =
    runState && runState.total > 0 ? Math.round((runState.processed / runState.total) * 100) : 0;
  const runEtaSeconds = React.useMemo(() => {
    if (!runState || runState.processed === 0 || runState.status === 'done') return null;
    const elapsedSeconds = Math.max(1, (Date.now() - runState.startedAt) / 1000);
    const rate = runState.processed / elapsedSeconds;
    if (rate <= 0) return null;
    const remaining = runState.total - runState.processed;
    const remainingBatches = runState.totalBatches - runState.currentBatch;
    return remaining / rate + remainingBatches * BULK_DELETE_CLIENT_PAUSE_SECONDS;
  }, [runState]);

  const pickersRef = React.useRef<HTMLDivElement>(null);
  const isRunActive = runState !== null && runState.status !== 'done';
  const selectedAccountNames = React.useMemo(
    () =>
      [...new Set(selectedPages.map((page) => page.accountName))].join(', '),
    [selectedPages],
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-metadata text-ink-sub">
          Facebook&nbsp;&nbsp;/&nbsp;&nbsp;<b className="font-semibold text-ink-sub">Bulk Delete Posts</b>
        </p>
        <h1 className="flex items-center gap-3 text-2xl font-bold text-ink">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-link">
            <Trash2Icon className="size-5" aria-hidden />
          </span>
          Bulk Delete Posts
        </h1>
        <p className="mt-1 max-w-160 text-body leading-body text-ink-sub">
          View live Facebook page content and bulk delete selected items.
        </p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-sm border border-signal-critical/35 bg-signal-critical/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          {errorMessage}
        </div>
      )}

      {previewFailures.length > 0 && (
        <div
          role="alert"
          className="rounded-sm border border-signal-critical/35 bg-signal-critical/10 px-3 py-2.5 text-body leading-body text-ink"
        >
          <p className="font-semibold">
            Couldn&apos;t preview{' '}
            {previewFailures.length === 1 ? 'this page' : 'these pages'} — the posts below
            are from the pages that did load:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {previewFailures.map((failure, index) => (
              <li key={`${failure.pageName}-${index}`}>
                {failure.pageName} — {failure.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            Retry Preview Targets to try {previewFailures.length === 1 ? 'it' : 'them'} again.
          </p>
        </div>
      )}

      {selectedPages.length > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-subtle p-4">
          <div className="flex items-center">
            {selectedPages.slice(0, 3).map((page, index) => (
              <span key={`${page.accountId}:${page.fbPageId}`} className={index > 0 ? '-ml-2' : ''}>
                <Avatar name={page.pageName} pictureUrl={page.profilePictureUrl} />
              </span>
            ))}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-body font-semibold text-ink">
                {selectedPages.length} {selectedPages.length === 1 ? 'page' : 'pages'} selected
              </span>
              <span className="rounded-full border border-link px-2 py-0.5 text-metadata font-bold uppercase tracking-body text-link">
                Selected
              </span>
            </div>
            <div className="truncate text-metadata text-ink-sub">via {selectedAccountNames}</div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => pickersRef.current?.scrollIntoView({ behavior: 'smooth' })}
          >
            Change selection
          </Button>
        </div>
      )}

      <div ref={pickersRef} className="space-y-6">
        <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
          <div className="mb-6 flex items-baseline gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-body font-bold text-on-primary">
              1
            </span>
            <h2 className="text-xl font-semibold text-ink">Select accounts</h2>
            <p className="text-metadata text-ink-sub">
              Choose one or more accounts — pages are discovered live from Facebook.
            </p>
          </div>

          {accountsQuery.isPending && (
            <div className="p-6 text-center text-body text-ink-sub">
              Loading connected Facebook accounts...
            </div>
          )}
          {accountsQuery.isError && (
            <div className="p-6 text-center text-body text-ink-sub">
              Couldn&apos;t load your Facebook accounts. Please try again.
            </div>
          )}
          {!accountsQuery.isPending &&
            !accountsQuery.isError &&
            activeAccounts.length === 0 &&
            nonSelectableAccounts.length === 0 && (
              <div className="flex flex-col items-center p-6 text-center">
                <div className="mb-1 text-body font-semibold text-ink">
                  No Facebook accounts connected
                </div>
                <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
                  Connect a Facebook account before deleting posts.
                </p>
                <Button asChild>
                  <Link href={buildAccountsHref(subdomain)}>Go to Facebook Accounts</Link>
                </Button>
              </div>
            )}

          {!accountsQuery.isPending && activeAccounts.length > 0 && (
            <>
              <div className="relative mb-4">
                <SearchIcon
                  className="pointer-events-none absolute left-4 top-3.5 size-4 text-ink-dim"
                  aria-hidden
                />
                <Input
                  type="text"
                  value={accountSearchQuery}
                  onChange={(event) => setAccountSearchQuery(event.target.value)}
                  placeholder="Search accounts..."
                  aria-label="Search accounts"
                  className="border-line bg-canvas pl-11 shadow-none"
                />
              </div>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="text-metadata text-ink-sub">
                  {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} ·{' '}
                  {selectedAccountIds.length} of {activeAccounts.length} accounts selected
                </span>
                <button
                  type="button"
                  aria-pressed={activeAccounts.every((account) =>
                    selectedAccountIds.includes(account.id),
                  )}
                  onClick={toggleSelectAllAccounts}
                  className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                >
                  {activeAccounts.every((account) => selectedAccountIds.includes(account.id))
                    ? 'Deselect All'
                    : 'Select All'}
                </button>
              </div>
              <div className="flex max-h-75 flex-col gap-1 overflow-y-auto pr-2">
                {filteredActiveAccounts.length === 0 && (
                  <div className="p-8 text-center text-ink-sub">No accounts match your search</div>
                )}
                {filteredActiveAccounts.map((account) => {
                  const checked = selectedAccountIds.includes(account.id);
                  return (
                    <label
                      key={account.id}
                      className={cn(
                        'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-sm px-row py-row outline-none transition-colors hover:bg-hover sm:gap-4',
                        checked && 'bg-hover',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleAccount(account.id)}
                      />
                      <Avatar
                        name={account.displayName}
                        pictureUrl={account.profilePictureUrl}
                        size="lg"
                      />
                      <span className="min-w-0 truncate text-lg font-semibold text-ink">
                        {account.displayName}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {!accountsQuery.isPending && nonSelectableAccounts.length > 0 && (
            <div className={cn('flex flex-col gap-1', activeAccounts.length > 0 && 'mt-4')}>
              {nonSelectableAccounts.map((account) => {
                const expired = getAccountHealth(account) === 'expired';
                return (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-sm px-row py-row opacity-55 sm:gap-4"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <Avatar
                        name={account.displayName}
                        pictureUrl={account.profilePictureUrl}
                        size="lg"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-body font-semibold text-ink">
                          {account.displayName}
                        </div>
                        <div className="mt-0.5 text-metadata text-ink-sub">
                          {expired ? 'Session expired' : 'Disconnected'}
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 border-signal-critical/35 font-semibold text-signal-critical hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
                      onClick={() => {
                        window.location.href = buildDirectConnectUrl({
                          id: account.id,
                          fbAccountId: account.fbAccountId,
                          displayName: account.displayName,
                          status: account.status,
                          updatedAt: account.updatedAt,
                        });
                      }}
                    >
                      Reconnect
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-6 sm:text-right">
            <Button
              type="button"
              disabled={selectedAccountIds.length === 0 || isDiscovering}
              onClick={() => void handleDiscoverPages()}
              className="w-full sm:w-auto"
            >
              {isDiscovering
                ? 'Finding pages...'
                : selectedAccountIds.length === 0
                  ? 'Find pages'
                  : `Find pages (${selectedAccountIds.length} ${selectedAccountIds.length === 1 ? 'account' : 'accounts'})`}
            </Button>
          </div>
        </div>

        {groups.length > 0 && (
          <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
            <div className="mb-6 flex items-baseline gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-body font-bold text-on-primary">
                2
              </span>
              <h2 className="text-xl font-semibold text-ink">Select pages</h2>
              <p className="text-metadata text-ink-sub">
                Pick one page, or several at once. Pages from all selected accounts are shown,
                grouped by account.
              </p>
            </div>
            {isDiscovering && (
              <div className="p-6 text-center text-body text-ink-sub">Finding Facebook Pages...</div>
            )}
            {!isDiscovering && allPages.length === 0 && (
              <div className="p-6 text-center text-body text-ink-sub">
                No Facebook Pages were found on the selected accounts.
              </div>
            )}
            {!isDiscovering && allPages.length > 0 && (
              <>
                <div className="relative mb-4">
                  <SearchIcon
                    className="pointer-events-none absolute left-4 top-3.5 size-4 text-ink-dim"
                    aria-hidden
                  />
                  <Input
                    type="text"
                    value={pageSearchQuery}
                    onChange={(event) => setPageSearchQuery(event.target.value)}
                    placeholder="Search pages..."
                    aria-label="Search pages"
                    className="border-line bg-canvas pl-11 shadow-none"
                  />
                </div>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <span className="text-metadata text-ink-sub">
                    {allPages.length} {allPages.length === 1 ? 'page found' : 'pages found'} ·{' '}
                    {selectedPages.length} of {allPages.length} pages selected
                  </span>
                  <button
                    type="button"
                    aria-pressed={allPages.every((page) =>
                      selectedPageKeys.includes(`${page.accountId}:${page.fbPageId}`),
                    )}
                    onClick={toggleSelectAllPages}
                    className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                  >
                    {allPages.every((page) =>
                      selectedPageKeys.includes(`${page.accountId}:${page.fbPageId}`),
                    )
                      ? 'Deselect All'
                      : 'Select All'}
                  </button>
                </div>
                <div className="max-h-100 overflow-y-auto pr-2">
                  {filteredGroups.map((group) => (
                    <div key={group.accountId} className="mb-4">
                      <div className="mb-2 px-1 text-metadata font-semibold tracking-body text-ink-sub">
                        {group.accountName}
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {group.pages.map((page) => {
                          const key = `${page.accountId}:${page.fbPageId}`;
                          const checked = selectedPageKeys.includes(key);
                          return (
                            <label
                              key={key}
                              className={cn(
                                'flex cursor-pointer items-center gap-3 rounded-sm border border-line bg-canvas p-3 outline-none transition-colors hover:bg-hover',
                                checked && 'border-link bg-primary/5',
                              )}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => togglePage(key)}
                              />
                              <Avatar name={page.pageName} pictureUrl={page.profilePictureUrl} />
                              <span className="min-w-0">
                                <span className="block truncate text-body font-semibold text-ink">
                                  {page.pageName}
                                </span>
                                <span className="block text-metadata text-ink-sub">
                                  {page.followers.toLocaleString('en-US')} followers
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {selectedPages.length > 0 && (
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value === 'manual' ? 'manual' : 'smart')}
        >
          <div className="flex justify-center">
            <TabsList>
              <TabsTrigger value="smart">Smart Filter</TabsTrigger>
              <TabsTrigger value="manual">Manual Curation</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="smart" className="mt-6">
            <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
              <div className="mb-4">
                <h2 className="text-xl font-semibold text-ink">Bulk Delete Criteria</h2>
                <p className="text-metadata text-ink-sub">
                  Filter live posts to delete by date range and type.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                  <span className="mb-2 block text-body font-semibold text-ink-sub">
                    Date Range
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-metadata font-semibold uppercase tracking-body text-ink-sub">
                        From
                      </span>
                      <Input
                        type="date"
                        value={dateFrom}
                        onChange={(event) => setDateFrom(event.target.value)}
                        aria-label="From date"
                        className="border-line bg-canvas shadow-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-metadata font-semibold uppercase tracking-body text-ink-sub">
                        To
                      </span>
                      <Input
                        type="date"
                        value={dateTo}
                        onChange={(event) => setDateTo(event.target.value)}
                        aria-label="To date"
                        className="border-line bg-canvas shadow-none"
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-body font-semibold text-ink-sub">
                    Content Settings
                  </span>
                  <span className="mb-1 block text-metadata text-ink-sub">Type</span>
                  <div className="flex flex-wrap gap-2">
                    {PREVIEW_TYPES.map((type) => (
                      <FilterChip
                        key={type.id}
                        active={previewType === type.id}
                        onClick={() => setPreviewType(type.id)}
                      >
                        {type.label}
                      </FilterChip>
                    ))}
                  </div>
                  <span className="mb-1 mt-3 block text-metadata text-ink-sub">Sort</span>
                  <div className="flex flex-wrap gap-2">
                    <FilterChip active={sort === 'oldest_first'} onClick={() => setSort('oldest_first')}>
                      Oldest First
                    </FilterChip>
                    <FilterChip active={sort === 'newest_first'} onClick={() => setSort('newest_first')}>
                      Newest First
                    </FilterChip>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-metadata text-ink-sub">
                  Preview up to 500 items · live published posts only — queued / scheduled posts
                  are not touched.
                </p>
                <Button
                  type="button"
                  disabled={isPreviewing}
                  onClick={() => void previewTargets()}
                >
                  {isPreviewing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden /> Previewing...
                    </>
                  ) : (
                    'Preview Targets'
                  )}
                </Button>
              </div>
            </div>

            {hasPreviewed && (
              <div className="mt-6">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-ink">
                      <span className="mr-2 inline-flex size-8 items-center justify-center rounded-full bg-primary/10 font-bold text-link">
                        {previewTotal}
                      </span>
                      Items Found
                    </h2>
                    <p className="mt-1 text-metadata text-ink-sub">
                      Previewing matches based on your criteria. All items on this page are
                      pre-selected.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={selectAllPreview}>
                      Select All
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={deselectAllPreview}>
                      Deselect All
                    </Button>
                  </div>
                </div>
                {previewItems.length === 0 ? (
                  <div className="rounded-2xl border border-line bg-subtle p-8 text-center text-body text-ink-sub">
                    No posts match these criteria.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                      {previewPageItems.map((item) => (
                        <ContentCard
                          key={item.id}
                          candidate={item}
                          checked={selectedContentIds.includes(item.id)}
                          onToggle={() => toggleContent(item.id)}
                        />
                      ))}
                    </div>
                    <div className="mt-4 flex items-center justify-center gap-4 text-metadata text-ink-sub">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={previewPage <= 1}
                        onClick={() => setPreviewPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <span>
                        Page {previewPage} of {previewPageCount} · {PREVIEW_PAGE_SIZE} per page
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={previewPage >= previewPageCount}
                        onClick={() => setPreviewPage((p) => Math.min(previewPageCount, p + 1))}
                      >
                        Next
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="manual" className="mt-6">
            {selectedPages.length > 1 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {selectedPages.map((page) => {
                  const key = `${page.accountId}:${page.fbPageId}`;
                  return (
                    <FilterChip
                      key={key}
                      active={manualPageKey === key}
                      onClick={() => {
                        setManualPageKeyOverride(key);
                        resetManualExtras();
                      }}
                    >
                      {page.pageName}
                    </FilterChip>
                  );
                })}
              </div>
            )}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {MANUAL_TYPES.map((type) => (
                  <FilterChip
                    key={type.id}
                    active={manualType === type.id}
                    onClick={() => {
                      setManualType(type.id);
                      resetManualExtras();
                    }}
                  >
                    {type.label}
                  </FilterChip>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-metadata text-ink-sub">
                  <b className="text-ink">{selectedContentIds.length} selected</b>
                </span>
                <Button type="button" variant="outline" size="sm" onClick={selectAllManual}>
                  Select All
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={deselectAllManual}>
                  Deselect All
                </Button>
              </div>
            </div>
            {manualQuery.isPending && (
              <div className="rounded-2xl border border-line bg-subtle p-8 text-center text-body text-ink-sub">
                Loading live page content...
              </div>
            )}
            {manualQuery.isError && (
              <div className="rounded-2xl border border-line bg-subtle p-8 text-center text-body text-ink-sub">
                Couldn&apos;t load this page&apos;s content. Please try again.
              </div>
            )}
            {!manualQuery.isPending && !manualQuery.isError && (
              <>
                {manualItems.length === 0 ? (
                  <div className="rounded-2xl border border-line bg-subtle p-8 text-center text-body text-ink-sub">
                    No {typeLabel(manualType).toLowerCase()} found on this page.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                      {manualPageItems.map((item) => (
                        <ContentCard
                          key={item.id}
                          candidate={item}
                          checked={selectedContentIds.includes(item.id)}
                          onToggle={() => toggleContent(item.id)}
                        />
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-4 text-metadata text-ink-sub">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={manualPage <= 1}
                        onClick={() => setManualPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <span>
                        Page {manualPage} of {manualPageCount} · {MANUAL_PAGE_SIZE} per page
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={manualPage >= manualPageCount}
                        onClick={() => setManualPage((p) => Math.min(manualPageCount, p + 1))}
                      >
                        Next
                      </Button>
                      {manualCursor && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isLoadingMore}
                          onClick={() => void handleLoadMoreManual()}
                        >
                          {isLoadingMore ? 'Loading...' : 'Load More'}
                        </Button>
                      )}
                    </div>
                    <p className="mt-2 text-center text-metadata text-ink-sub">
                      Manual lists live page content with cursor paging — “Load More” loads the
                      next 25.
                    </p>
                  </>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      )}

      {selectedContentIds.length > 0 && !runState && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 whitespace-nowrap rounded-full border border-line bg-subtle px-5 py-2 shadow-elevated">
          <span className="text-body font-bold text-ink">
            {selectedContentIds.length} items selected
          </span>
          <span className="hidden text-metadata text-ink-sub sm:inline">
            No confirmation — deletes directly
          </span>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => setSelectedContentIds([])}
            className="flex size-8 items-center justify-center rounded-full bg-hover text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-link"
          >
            ×
          </button>
          <Button type="button" variant="destructive" onClick={() => void executeDelete()}>
            <Trash2Icon className="size-4" aria-hidden /> Delete Selected
          </Button>
        </div>
      )}

      {runState && (
        <div
          role="dialog"
          aria-label="Deleting posts"
          className="fixed inset-0 z-50 overflow-y-auto bg-canvas/95 px-4 py-12"
        >
          <div className="mx-auto w-full max-w-2xl text-center">
            <h2 className="text-2xl font-bold text-ink">
              {runState.status === 'done' ? 'Deletion complete' : 'Executing Deletion'}
            </h2>
            <p className="mt-1 text-body text-ink-sub">
              {runState.status === 'done'
                ? `${runState.succeeded} deleted, ${runState.failed} failed.`
                : `Deleting batch ${runState.currentBatch} of ${runState.totalBatches}...`}
            </p>
            <div className="relative mx-auto mt-8 size-55">
              <svg width="220" height="220" viewBox="0 0 220 220" className="size-55 -rotate-90">
                <circle
                  cx="110"
                  cy="110"
                  r="100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-ink-dim"
                />
                <circle
                  cx="110"
                  cy="110"
                  r="100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray="628.3"
                  strokeDashoffset={628.3 * (1 - runPercent / 100)}
                  className="text-primary"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-bold text-ink">{runPercent}%</span>
                <span className="text-metadata font-bold uppercase tracking-body text-ink-sub">
                  Completed
                </span>
              </div>
            </div>
            <Progress value={runPercent} className="mt-6" aria-label="Deletion progress" />
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-line bg-subtle p-4">
                <div className="text-metadata font-bold uppercase tracking-body text-ink-sub">
                  Processed
                </div>
                <div className="mt-1 text-2xl font-bold text-ink">
                  {runState.processed}{' '}
                  <span className="text-body font-normal text-ink-sub">/ {runState.total}</span>
                </div>
              </div>
              <div className="rounded-lg border border-line bg-subtle p-4">
                <div className="text-metadata font-bold uppercase tracking-body text-ink-sub">
                  Succeeded
                </div>
                <div className="mt-1 text-2xl font-bold text-brand-emerald">
                  {runState.succeeded}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-subtle p-4">
                <div className="text-metadata font-bold uppercase tracking-body text-ink-sub">
                  Failed
                </div>
                <div className="mt-1 text-2xl font-bold text-signal-critical">
                  {runState.failed}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-subtle p-4">
                <div className="text-metadata font-bold uppercase tracking-body text-ink-sub">
                  ETA
                </div>
                <div className="mt-1 text-2xl font-bold text-ink">
                  {formatEta(runEtaSeconds)}
                </div>
              </div>
            </div>
            {runState.status === 'paused' && (
              <p className="mt-4 font-bold text-link">
                API limits reached. Waiting {runState.pauseSecondsLeft}s…
              </p>
            )}
            {isRunActive && (
              <p className="mt-2 text-metadata text-ink-sub">
                Batches of 20 · 60-second pause between batches · Closing this tab stops the
                deletion.
              </p>
            )}
            {runState.failures.length > 0 && (
              <div className="mt-6 rounded-lg border border-signal-critical/35 bg-signal-critical/10 p-4 text-left">
                <h3 className="mb-3 flex items-center gap-2 font-semibold text-signal-critical">
                  <span className="flex size-6 items-center justify-center rounded-full bg-brand-rose text-body font-bold text-neutral-white">
                    ×
                  </span>
                  {runState.failures.length} {runState.failures.length === 1 ? 'Item' : 'Items'}{' '}
                  Failed
                </h3>
                {runState.failures.map((failure) => (
                  <div
                    key={failure.id}
                    className="mb-2 flex gap-3 rounded-sm border border-signal-critical/35 bg-canvas p-3"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-rose text-body font-bold text-neutral-white">
                      ×
                    </span>
                    <div className="min-w-0">
                      <code className="break-all text-metadata text-ink-sub">{failure.id}</code>
                      <div className="font-semibold text-signal-critical">{failure.error}</div>
                    </div>
                  </div>
                ))}
                <p className="text-metadata text-ink-sub">
                  Failures list the post ID and the reason. Graph permission errors are shown as
                  “Failed to delete”.
                </p>
              </div>
            )}
            {runState.status === 'done' && (
              <div className="mt-8">
                <Button type="button" onClick={() => setRunState(null)} className="px-12">
                  Done
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: Readonly<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-4 py-2 text-body font-semibold outline-none transition-colors focus-visible:outline-2 focus-visible:outline-link',
        active
          ? 'border-transparent bg-primary text-on-primary'
          : 'border-line bg-canvas text-ink-sub hover:bg-hover',
      )}
    >
      {children}
    </button>
  );
}

function ContentCard({
  candidate,
  checked,
  onToggle,
}: Readonly<{
  candidate: BulkDeleteCandidate;
  checked: boolean;
  onToggle: () => void;
}>) {
  const date = candidate.createdTime
    ? new Date(candidate.createdTime).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'Unknown date';
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-subtle',
        checked ? 'border-link shadow-elevated' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        aria-label={`${candidate.title} — ${typeLabel(candidate.type)}`}
        className="block w-full text-left outline-none focus-visible:outline-2 focus-visible:outline-link"
      >
        <span className="relative block aspect-square w-full bg-canvas">
          {candidate.previewImageUrl ? (
            <Image
              src={candidate.previewImageUrl}
              alt=""
              fill
              sizes="(max-width: 640px) 50vw, 25vw"
              className="object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-ink-dim">
              {candidate.type === 'posts' ? (
                <span className="text-4xl" aria-hidden>
                  ✎
                </span>
              ) : candidate.type === 'photos' ? (
                <span className="text-4xl" aria-hidden>
                  ▦
                </span>
              ) : (
                <span className="text-4xl" aria-hidden>
                  ▶
                </span>
              )}
            </span>
          )}
          <span
            className={cn(
              'absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border-2 text-body font-bold',
              checked
                ? 'border-transparent bg-primary text-on-primary'
                : 'border-neutral-white bg-black/60 text-neutral-white',
            )}
          >
            {checked ? '✓' : ''}
          </span>
        </span>
        <span className="block p-3">
          <span className="mb-1 inline-block rounded-full border border-line px-2 py-0.5 text-metadata font-bold uppercase tracking-body text-ink-sub">
            {typeLabel(candidate.type)}
          </span>
          <span className="block text-body font-semibold leading-body text-ink line-clamp-2 overflow-hidden">
            {candidate.title}
          </span>
          <span className="mt-0.5 block text-metadata text-ink-sub">
            {date} · {candidate.pageName}
          </span>
        </span>
      </button>
    </div>
  );
}
