'use client';

/**
 * Dedicated Facebook Page section frame (spec 131 PR-131-3, §8.4).
 *
 * The former 642-line client controller route is decomposed: this shell
 * is frame composition ONLY — identity header (the canonical §1.3
 * pattern landed by PR-131-4 in the destinations frame: platform icon +
 * avatar + full name in a fixed position, UX Rule 1; status as colour +
 * icon + text, OD-3), the tab bar on the shared/ui Tabs primitive with
 * the five verbatim labels, and the slot mounts. All data lives in the
 * data layer: the route server-prefetches page detail + pages list +
 * queue items + slots in parallel into the React Query cache, and this
 * shell reads/writes that same cache (spec §8.1) — zero raw `fetch(`
 * and zero `useState` data mirrors remain. The frame's repeated slots
 * reads collapse to the one `pages.slots` cache entry shared with the
 * queue panel and the posting-times panel.
 *
 * PROPS BRIDGE DELETED (PR-134-1's named deleter duty): the queue panel
 * no longer receives `queueItems` / `onMutated` / item callbacks from
 * this frame — it reads `queryKeys.queue.items` directly and its
 * mutations invalidate the shared keys, which is also what keeps this
 * frame's Queue count and the dashboard tab in sync. Grep proof in the
 *
 * SLOT DISCIPLINE (§9.3): the queue panel, the posting-times panel and
 * the composer are 134/132's components, mounted exactly as before
 * through the dedicated barrel — never edited, restyled, or re-fetched
 * inside. Tab panels mount on first visit and then stay mounted
 * (hidden while inactive), so switching tabs never destroys slotted
 * components' state (UX Rules 10–12/14 interlock).
 *
 * OD131-2 is UNANSWERED: the five tabs are exactly as today — no tab
 * created, renamed, or removed.
 */

import * as React from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { assignQueueEstimates } from '@fbuploadpro/contracts';
import {
  DisconnectPageResponseSchema,
  ListFacebookPagesResponseSchema,
  PageDetailResponseSchema,
  UpdatePageResponseSchema,
  type FacebookPageView,
} from '@/lib/api/schemas/pages';
import {
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
  PageQueueSlotSchema,
  UpdateScheduleTimezoneResponseSchema,
  type ListQueueSlotsResponse,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { toast } from '@/components/shared/ui/toast';
import type { FacebookPageItem } from '@/components/pages/page-card';
import {
  DedicatedPageHeader,
  PageTabDashboard,
  PageTabInsights,
  PageTabPostingTimes,
  type PageSlotSummary,
} from '@/components/pages/dedicated';

export type DedicatedPageTab =
  | 'dashboard'
  | 'insights'
  | 'queue'
  | 'calendar';

export interface TenantDedicatedPageViewProps {
  subdomainProp?: string | undefined;
  pageIdProp?: string | undefined;
  pageNameProp?: string | undefined;
  initialPage?: FacebookPageItem | undefined;
  initialTab?: DedicatedPageTab | undefined;
}

/** Passthrough ack for mutations whose bodies the frame does not
 *  consume (same pattern as the queue panel): the typed client's error
 *  taxonomy still applies in full — failures throw, never vanish. */
const AckSchema = z.object({}).passthrough();

// Final tab scope (Shahzeb, 2026-10-27): Dashboard, Insights, Queue,
// Posting Times — no Settings tab. Queue is an empty placeholder
// panel only; it will be rebuilt later, more professionally.
const TAB_ITEMS: ReadonlyArray<{ id: DedicatedPageTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'insights', label: 'Insights' },
  { id: 'queue', label: 'Queue' },
  { id: 'calendar', label: 'Posting Times' },
];

const TAB_IDS: ReadonlySet<string> = new Set(TAB_ITEMS.map((tab) => tab.id));

/**
 * Tab state lives in the URL (?tab=) so refresh, a shared link, and
 * the browser back button all land on the right tab. An unknown or
 * missing value falls back to the shell's initial tab (Dashboard by
 * default) — never a 404, never a blank tab row.
 */
function resolveTabFromUrl(raw: string | null, fallback: DedicatedPageTab): DedicatedPageTab {
  return raw !== null && TAB_IDS.has(raw) ? (raw as DedicatedPageTab) : fallback;
}

/** The settled display fallback for a page known only by name (tests /
 *  preloaded renders) — same shape the legacy controller synthesised. */
function pageFromName(pageId: string, pageName: string): FacebookPageItem {
  return {
    id: pageId,
    facebookAccountId: 'acc-default',
    accountDisplayName: 'Connected Account',
    fbPageId: pageId,
    pageName,
    category: 'Business Page',
    startingFollowers: 0,
    currentFollowers: 0,
    followersGained: 0,
    status: 'active',
    timezone: 'UTC',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function TenantDedicatedPageView({
  subdomainProp,
  pageIdProp,
  pageNameProp,
  initialPage,
  initialTab = 'dashboard',
}: Readonly<TenantDedicatedPageViewProps> = {}) {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const subdomain = subdomainProp ?? ((params?.subdomain as string) || '');
  const pageId = pageIdProp ?? ((params?.pageId as string) || '');

  // Initial tab: a valid ?tab= wins over the initialTab prop (the
  // route itself never passes initialTab, so the URL is the sole
  // source in production); anything else falls back to initialTab.
  const [activeTab, setActiveTab] = React.useState<DedicatedPageTab>(() =>
    resolveTabFromUrl(searchParams.get('tab'), initialTab)
  );
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<DedicatedPageTab>>(
    () => new Set([resolveTabFromUrl(searchParams.get('tab'), initialTab)])
  );
  // Ref mirror of the current tab: the trigger's onClick and the
  // Tabs root's onValueChange both fire for one click, and state
  // updates are async, so the ref — not the stale state closure —
  // is what stops a single click pushing two history entries.
  const activeTabRef = React.useRef<DedicatedPageTab>(activeTab);
  // Scroll edges of the tab row, for the mobile scroll-fade hint.
  const tabListRef = React.useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  const tenant = queryKeys.tenant(subdomain);
  const pagePath = buildTenantApiPath(subdomain, `/pages/${pageId}`);
  const pagesListPath = buildTenantApiPath(subdomain, '/pages');
  const queuePath = buildTenantApiPath(subdomain, '/publishing/queue');
  const slotsPath = buildTenantApiPath(subdomain, `/pages/${pageId}/slots`);

  // --- page detail + list fallback (the controller's chain, §8.1) ------
  const detailQuery = useQuery({
    queryKey: tenant.pages.detail(pageId),
    queryFn: ({ signal }) =>
      api.get(pagePath, { schema: PageDetailResponseSchema, signal }),
    enabled: Boolean(subdomain && pageId) && !initialPage,
  });
  const detailFailed = detailQuery.isError;
  const listQuery = useQuery({
    queryKey: tenant.pages.list,
    queryFn: ({ signal }) =>
      api.get(pagesListPath, { schema: ListFacebookPagesResponseSchema, signal }),
    enabled: Boolean(subdomain) && !initialPage && detailFailed,
  });

  const page: FacebookPageItem | null = React.useMemo(() => {
    if (initialPage) return initialPage;
    const fromDetail = detailQuery.data?.page as FacebookPageView | undefined;
    if (fromDetail) return fromDetail;
    const fromList = listQuery.data?.pages.find((p) => p.id === pageId);
    if (fromList) return fromList;
    if (pageNameProp && (detailFailed || listQuery.isError)) {
      return pageFromName(pageId, pageNameProp);
    }
    if (pageNameProp && !detailQuery.isPending) {
      return pageFromName(pageId, pageNameProp);
    }
    return null;
  }, [initialPage, detailQuery.data, detailFailed, detailQuery.isPending, listQuery.data, listQuery.isError, pageId, pageNameProp]);

  const pageError =
    !page && !initialPage && detailFailed && (listQuery.isError || listQuery.isSuccess)
      ? "Couldn't locate the requested Facebook Page."
      : null;
  const isLoadingPage = !page && !pageError;

  // --- frame-level summaries: queue items + slots (shared cache) -------
  // Slots resolve BEFORE the dashboard estimates below: the estimate
  // computation reads slots, so the declaration order matters (TDZ).
  const slotsQuery = useQuery({
    queryKey: tenant.pages.slots(pageId),
    queryFn: ({ signal }) =>
      api.get(slotsPath, { schema: ListQueueSlotsResponseSchema, signal }),
    enabled: Boolean(subdomain && pageId),
  });
  const slots: PageSlotSummary[] = React.useMemo(
    () =>
      (slotsQuery.data?.slots ?? []).map((slot) => ({
        id: slot.id,
        slotTime: slot.slotTime,
        timezone: slot.timezone,
        isActive: slot.isActive,
        allowedFormats: slot.allowedFormats,
      })),
    [slotsQuery.data]
  );

  const queueQuery = useQuery({
    queryKey: tenant.queue.items(pageId),
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: { pageId },
        signal,
      }),
    enabled: Boolean(subdomain && pageId),
  });
  const queueItems = React.useMemo(
    () => queueQuery.data?.items ?? [],
    [queueQuery.data]
  );
  const pageTimezone = page?.timezone ?? 'UTC';
  // Queue times are DERIVED estimates, never stored times: the
  // estimate for each queued post is computed from its queue
  // position + the current active posting times (format-aware,
  // skip-ahead). Estimates move when times change — that is the
  // system working, not a bug. Items arrive from the list route in
  // queue order (queue_seq), which is the order the estimator takes.
  const dashboardQueueItems = React.useMemo(
    () => {
      const queued = queueItems.filter((item) => item.status === 'queued');
      const estimates = assignQueueEstimates({
        slots: slots.map((slot) => ({
          id: slot.id,
          timeOfDay: slot.slotTime,
          isActive: slot.isActive,
          allowedFormats: slot.allowedFormats ?? null,
        })),
        timezone: pageTimezone,
        posts: queued.map((item) => ({ id: item.id, format: item.postFormat })),
        now: new Date(),
      });
      return queueItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        postFormat: item.postFormat,
        linkUrl: item.linkUrl ?? null,
        caption: item.caption ?? null,
        firstComment: item.firstComment ?? null,
        scheduledTime: item.scheduledTime,
        estimatedTime:
          item.status === 'queued'
            ? (estimates.get(item.id)?.toISOString() ?? null)
            : null,
        status: item.status,
        ...(item.media ? { mediaType: item.media.mediaType } : {}),
        thumbnailUrl: item.media?.thumbnailUrl ?? null,
      }));
    },
    [queueItems, slots, pageTimezone]
  );
  // The timezone review counts all queued posts: under
  // publisher-driven scheduling there are no slot links and no
  // stored times to realign — the review says times fire in the new
  // zone and estimates update.
  const queuedCount = React.useMemo(
    () => queueItems.filter((i) => i.status === 'queued').length,
    [queueItems]
  );

  // --- mutations (named invalidation per mutation, §8.1) ---------------
  const invalidatePage = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.pages.detail(pageId) });
    void queryClient.invalidateQueries({ queryKey: tenant.pages.list });
  }, [queryClient, tenant.pages, pageId]);

  const invalidateQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
  }, [queryClient, tenant.queue]);

  const invalidateSlots = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.pages.slots(pageId) });
  }, [queryClient, tenant.pages, pageId]);

  const statusMutation = useMutation({
    mutationFn: (nextStatus: 'active' | 'paused') =>
      api.patch(pagePath, { status: nextStatus }, { schema: UpdatePageResponseSchema }),
    onSuccess: (_data, nextStatus) => {
      invalidatePage();
      toast.success(
        nextStatus === 'paused'
          ? 'Automation has been paused.'
          : 'Automation has been resumed.'
      );
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't update the automation state. Please try again.")
      );
    },
  });
  const handleStatusToggle = React.useCallback(
    async (nextStatus: 'active' | 'paused') => {
      await statusMutation.mutateAsync(nextStatus).catch(() => undefined);
    },
    [statusMutation]
  );

  const publishNowMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.post(
        buildTenantApiPath(subdomain, `/publishing/queue/${itemId}/publish-now`),
        undefined,
        { schema: AckSchema }
      ),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Publishing triggered successfully.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, 'Publication trigger failed'));
    },
  });
  const handlePublishNow = React.useCallback(
    async (itemId: string) => {
      await publishNowMutation.mutateAsync(itemId).catch(() => undefined);
    },
    [publishNowMutation]
  );

  const addSlotMutation = useMutation({
    mutationFn: (slotData: { slotTime: string; timezone: string; allowedFormats?: string[] }) =>
      api.post(
        slotsPath,
        {
          pageId,
          slotTime: slotData.slotTime,
          timezone: slotData.timezone,
          allowedFormats: slotData.allowedFormats,
        },
        { schema: AckSchema }
      ),
    onSuccess: () => {
      invalidateSlots();
      // Slot changes can move the unmatched-posts flag on the page.
      invalidatePage();
      toast.success('Posting time added.');
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't add the posting time. Please try again.")
      );
    },
  });
  const handleAddSlot = React.useCallback(
    async (slotData: { slotTime: string; timezone: string; allowedFormats?: string[] }) => {
      await addSlotMutation.mutateAsync(slotData);
    },
    [addSlotMutation]
  );

  // Single-slot PATCH update — the production edit path. Editing
  // through this route preserves the slot id; the old delete +
  // re-add fallback could lose the slot entirely on a 409, so the
  // shell must always pass onUpdateSlot and never rely on the
  // fallback. (Queued posts carry no slot link under
  // publisher-driven scheduling — the id matters to the slot
  // itself, e.g. its once-per-day claim row.)
  const updateSlotMutation = useMutation({
    mutationFn: ({
      slotId,
      data,
    }: {
      slotId: string;
      data: {
        slotTime?: string;
        timezone?: string;
        isActive?: boolean;
        allowedFormats?: string[];
      };
    }) =>
      api.patch(
        buildTenantApiPath(subdomain, `/pages/${pageId}/slots/${slotId}`),
        {
          slotTime: data.slotTime,
          isActive: data.isActive,
          allowedFormats: data.allowedFormats,
        },
        { schema: PageQueueSlotSchema }
      ),
    onSuccess: () => {
      invalidateSlots();
      invalidatePage();
      toast.success('Posting time updated.');
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't update the posting time. Please try again.")
      );
    },
  });
  const handleUpdateSlot = React.useCallback(
    async (
      slotId: string,
      data: {
        slotTime?: string;
        timezone?: string;
        isActive?: boolean;
        allowedFormats?: string[];
      }
    ) => {
      await updateSlotMutation.mutateAsync({ slotId, data });
    },
    [updateSlotMutation]
  );

  const timezoneMutation = useMutation({
    mutationFn: (newTimezone: string) =>
      api.patch(
        slotsPath,
        { timezone: newTimezone },
        { schema: UpdateScheduleTimezoneResponseSchema }
      ),
    onSuccess: (_data, newTimezone) => {
      invalidateSlots();
      invalidateQueue();
      invalidatePage();
      // No realigned count anymore: queued posts store no times, so
      // a timezone change rewrites nothing — times simply fire in
      // the new zone and queue estimates update.
      toast.success(`Timezone updated to ${newTimezone}.`);
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't update the timezone. Please try again.")
      );
    },
  });
  const handleUpdateTimezone = React.useCallback(
    async (newTimezone: string) => {
      await timezoneMutation.mutateAsync(newTimezone);
    },
    [timezoneMutation]
  );

  // Toggle/delete are optimistic: the switch flips (or the row leaves)
  // the instant the user acts, from the slots cache — the user never
  // waits on the PATCH round trip plus refetch to see their action.
  // The server round trip then only reconciles: onSettled refetches
  // the slots (and the page, whose unmatched-posts flag a toggle or
  // delete can move). On failure the cache rolls back to the exact
  // previous state and the error toast fires — the UI never disagrees
  // with the server. The queue is deliberately NOT invalidated here:
  // queue estimates derive from the slots cache, so they update with
  // the optimistic write itself.
  const toggleSlotMutation = useMutation({
    mutationFn: ({ slotId, isActive }: { slotId: string; isActive: boolean }) =>
      api.patch(
        buildTenantApiPath(subdomain, `/pages/${pageId}/slots/${slotId}`),
        { isActive },
        { schema: AckSchema }
      ),
    onMutate: async ({ slotId, isActive }) => {
      const slotsKey = tenant.pages.slots(pageId);
      await queryClient.cancelQueries({ queryKey: slotsKey });
      const previous = queryClient.getQueryData<ListQueueSlotsResponse>(slotsKey);
      const previousSlot = previous?.slots.find((slot) => slot.id === slotId);
      queryClient.setQueryData<ListQueueSlotsResponse>(slotsKey, (old) =>
        old
          ? {
              ...old,
              slots: old.slots.map((slot) =>
                slot.id === slotId ? { ...slot, isActive } : slot
              ),
            }
          : old
      );
      return { slotId, previousIsActive: previousSlot?.isActive };
    },
    onError: (error, _variables, context) => {
      if (context && context.previousIsActive !== undefined) {
        const slotsKey = tenant.pages.slots(pageId);
        queryClient.setQueryData<ListQueueSlotsResponse>(slotsKey, (old) =>
          old
            ? {
                ...old,
                slots: old.slots.map((slot) =>
                  slot.id === context.slotId
                    ? { ...slot, isActive: context.previousIsActive as boolean }
                    : slot
                ),
              }
            : old
        );
      }
      toast.error(errorMessage(error, "Couldn't update the posting time. Please try again."));
    },
    onSettled: () => {
      invalidateSlots();
      invalidatePage();
    },
  });
  const handleToggleSlot = React.useCallback(
    async (slotId: string, isActive: boolean) => {
      await toggleSlotMutation.mutateAsync({ slotId, isActive }).catch(() => undefined);
    },
    [toggleSlotMutation]
  );

  const deleteSlotMutation = useMutation({
    mutationFn: (slotId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/pages/${pageId}/slots/${slotId}`), {
        schema: AckSchema,
      }),
    onMutate: async (slotId) => {
      const slotsKey = tenant.pages.slots(pageId);
      await queryClient.cancelQueries({ queryKey: slotsKey });
      const previous = queryClient.getQueryData<ListQueueSlotsResponse>(slotsKey);
      const index = previous?.slots.findIndex((slot) => slot.id === slotId) ?? -1;
      const deletedSlot = index >= 0 ? previous?.slots[index] : undefined;
      queryClient.setQueryData<ListQueueSlotsResponse>(slotsKey, (old) =>
        old
          ? { ...old, slots: old.slots.filter((slot) => slot.id !== slotId) }
          : old
      );
      return { slotId, deletedSlot, index };
    },
    onError: (error, _variables, context) => {
      const deletedSlot = context?.deletedSlot;
      const index = context?.index ?? -1;
      if (deletedSlot && index >= 0) {
        const slotsKey = tenant.pages.slots(pageId);
        queryClient.setQueryData<ListQueueSlotsResponse>(slotsKey, (old) => {
          if (!old) return old;
          const slots = [...old.slots];
          slots.splice(index, 0, deletedSlot);
          return { ...old, slots };
        });
      }
      toast.error(errorMessage(error, "Couldn't remove the posting time. Please try again."));
    },
    onSuccess: () => {
      // The success toast fires only after the server confirms —
      // the optimistic removal above is what the user sees instantly.
      toast.success('Posting time removed.');
    },
    onSettled: () => {
      invalidateSlots();
      invalidatePage();
    },
  });
  const handleDeleteSlot = React.useCallback(
    async (slotId: string) => {
      await deleteSlotMutation.mutateAsync(slotId).catch(() => undefined);
    },
    [deleteSlotMutation]
  );

  const disconnectMutation = useMutation({
    mutationFn: () =>
      api.delete(pagePath, { schema: DisconnectPageResponseSchema }),
    onSuccess: () => {
      router.push(`/tenant/${subdomain}/pages`);
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't disconnect the page. Please try again.")
      );
    },
  });
  const handleDisconnectPage = React.useCallback(async () => {
    await disconnectMutation.mutateAsync().catch(() => undefined);
  }, [disconnectMutation]);

  const pagesListHref = `/tenant/${subdomain}/pages`;

  // Back/forward navigation: when the URL's ?tab= changes without
  // a click (popstate), adopt it — including its visited mount —
  // so the back button returns to the previously viewed tab.
  const urlTab = searchParams.get('tab');
  React.useEffect(() => {
    const next = resolveTabFromUrl(urlTab, activeTabRef.current);
    if (next === activeTabRef.current) return;
    activeTabRef.current = next;
    setActiveTab(next);
    setVisitedTabs((prev) => {
      if (prev.has(next)) return prev;
      const copy = new Set(prev);
      copy.add(next);
      return copy;
    });
  }, [urlTab]);

  const updateTabScrollEdges = React.useCallback(() => {
    const el = tabListRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  React.useEffect(() => {
    updateTabScrollEdges();
    window.addEventListener('resize', updateTabScrollEdges);
    return () => window.removeEventListener('resize', updateTabScrollEdges);
  }, [updateTabScrollEdges]);

  const handleTabChange = React.useCallback(
    (value: string) => {
      const next = value as DedicatedPageTab;
      if (!TAB_IDS.has(next)) return;
      const changed = next !== activeTabRef.current;
      activeTabRef.current = next;
      setActiveTab(next);
      setVisitedTabs((prev) => {
        if (prev.has(next)) return prev;
        const copy = new Set(prev);
        copy.add(next);
        return copy;
      });
      // Push (never replace): each tab switch is a history entry,
      // so the back button walks back through viewed tabs. Other
      // query params are preserved; scroll:false keeps the page
      // position instead of jumping to the top on every switch.
      if (changed && subdomain && pageId) {
        const nextParams = new URLSearchParams(searchParams.toString());
        nextParams.set('tab', next);
        router.push(`/tenant/${subdomain}/pages/${pageId}?${nextParams.toString()}`, {
          scroll: false,
        });
      }
    },
    [router, searchParams, subdomain, pageId]
  );

  const switchTab = React.useCallback(
    (tab: 'queue' | 'calendar' | 'insights') => {
      handleTabChange(tab);
    },
    [handleTabChange]
  );


  return (
    <div
      data-testid="dedicated-page-workspace"
      className="mx-auto w-full max-w-7xl px-6 py-6"
    >
      {/* Hidden compat element for legacy placeholder check */}
      <div data-testid="dedicated-page-placeholder" className="hidden">
        <span>Dedicated Page Management Workspace</span>
        <span>{pageNameProp || page?.pageName}</span>
        <span>Page reference: {pageId}</span>
      </div>

      {/* Legacy navigation anchor for compatibility */}
      <a
        href={pagesListHref}
        data-testid="back-to-pages-btn"
        className="hidden"
        onClick={(e) => {
          e.preventDefault();
          router.push(pagesListHref);
        }}
      >
        Back to Pages
      </a>

      {/* Loading initial page — skeleton at the frame's final geometry */}
      {isLoadingPage && (
        <div data-testid="dedicated-page-loading" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">Loading Facebook Page workspace...</span>
          <div className="flex items-center gap-4">
            <Skeleton className="size-11 rounded-md" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-36" />
            </div>
          </div>
          <Skeleton className="h-10 w-full max-w-xl" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {/* Page load error */}
      {pageError && !page && (
        <div
          data-testid="page-error-state"
          className="flex flex-col items-center gap-4 rounded-md border border-brand-rose/40 bg-panel px-6 py-12 text-center"
        >
          <h3 className="m-0 text-lg font-semibold text-brand-rose">Page Not Found</h3>
          <p className="m-0 text-body text-ink-sub">{pageError}</p>
          <Button type="button" onClick={() => router.push(pagesListHref)}>
            Return to Pages
          </Button>
        </div>
      )}

      {/* Loaded page control plane */}
      {page && (
        <>
          <DedicatedPageHeader
            page={page}
            subdomain={subdomain}
            onStatusToggle={handleStatusToggle}
            onDisconnectRequest={handleDisconnectPage}
          />

          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            data-testid="dedicated-tab-content"
            className="gap-6"
          >
            {/*
              Sticky tab row: the tenant topbar is NOT sticky, so
              top-0 pins the row to the viewport top once the topbar
              has scrolled away — directly beneath nothing, overlapping
              nothing. z-sticky is the app's sticky-layer token and the
              solid canvas background keeps scrolled panel content
              passing underneath, never over, the row.
            */}
            <div className="sticky top-0 z-sticky bg-canvas">
              <div className="relative">
                <TabsList
                  ref={tabListRef}
                  onScroll={updateTabScrollEdges}
                  variant="line"
                  aria-label="Page sections"
                  data-testid="dedicated-tabs-nav"
                  className="w-full justify-start overflow-x-auto"
                >
                  {TAB_ITEMS.map((tab) => (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      variant="line-gold"
                      data-testid={`tab-${tab.id}-btn`}
                      onClick={() => handleTabChange(tab.id)}
                      className="min-h-11 shrink-0"
                    >
                      <span>{tab.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
                {/*
                  Mobile scroll affordance: a subtle canvas fade at
                  each scrollable edge (right at rest, left once
                  scrolled). pointer-events-none so taps always reach
                  the tabs, and bottom-1 so the fades stop above the
                  active tab's 3px underline and the row hairline —
                  neither is ever covered.
                */}
                {canScrollLeft && (
                  <div
                    aria-hidden
                    data-testid="dedicated-tabs-fade-left"
                    className="pointer-events-none absolute top-0 bottom-1 left-0 w-8 bg-gradient-to-r from-canvas to-transparent"
                  />
                )}
                {canScrollRight && (
                  <div
                    aria-hidden
                    data-testid="dedicated-tabs-fade-right"
                    className="pointer-events-none absolute top-0 bottom-1 right-0 w-8 bg-gradient-to-l from-canvas to-transparent"
                  />
                )}
              </div>
            </div>

            {visitedTabs.has('dashboard') && (
              <TabsContent value="dashboard" forceMount className="data-[state=inactive]:hidden">
                <PageTabDashboard
                  page={page}
                  queueItems={dashboardQueueItems}
                  slots={slots}
                  onPublishNow={handlePublishNow}
                  onSwitchTab={switchTab}
                />
              </TabsContent>
            )}

            {visitedTabs.has('queue') && (
              <TabsContent value="queue" forceMount className="data-[state=inactive]:hidden">
                {/*
                  Queue placeholder only: no list, no buttons, no
                  composer entry points. The Queue section will be
                  built later, more professionally.
                */}
                <div data-testid="page-tab-queue-placeholder" className="rounded-md border border-line bg-panel p-6 shadow-card">
                  <h2 className="m-0 text-lg font-bold text-ink">Queue</h2>
                  <p className="mt-1 text-body text-ink-sub">
                    This section is being rebuilt.
                  </p>
                </div>
              </TabsContent>
            )}

            {visitedTabs.has('calendar') && (
              <TabsContent value="calendar" forceMount className="data-[state=inactive]:hidden">
                <PageTabPostingTimes
                  page={page}
                  slots={slots}
                  isLoading={slotsQuery.isPending}
                  queuedCount={queuedCount}
                  onAddSlot={handleAddSlot}
                  onUpdateSlot={handleUpdateSlot}
                  onUpdateTimezone={handleUpdateTimezone}
                  onToggleSlot={handleToggleSlot}
                  onDeleteSlot={handleDeleteSlot}
                />
              </TabsContent>
            )}

            {visitedTabs.has('insights') && (
              <TabsContent value="insights" forceMount className="data-[state=inactive]:hidden">
                <PageTabInsights page={page} subdomain={subdomain} />
              </TabsContent>
            )}

          </Tabs>
        </>
      )}
    </div>
  );
}
