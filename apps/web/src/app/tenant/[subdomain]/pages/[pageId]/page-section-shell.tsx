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
import {
  assignQueueEstimates,
  IDEMPOTENCY_KEY_HEADER,
} from '@fbuploadpro/contracts';
import {
  DisconnectPageResponseSchema,
  ListFacebookPagesResponseSchema,
  type ListFacebookPagesResponse,
  PageDetailResponseSchema,
  UpdatePageResponseSchema,
  type FacebookPageView,
} from '@/lib/api/schemas/pages';
import {
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
  type ListQueueItemsResponse,
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
// Direct path, not the dedicated barrel: the composer dialogue is
// new work and the barrel is owned by parallel branch work.
import { CreatePostsDialog } from '@/components/pages/dedicated/create-posts/create-posts-dialog';
// Direct path, same reason: the Queue panel is new work.
import { QueuePanel } from '@/components/pages/dedicated/queue/queue-panel';
// Direct path, same reason: the Calendar View panel is new work.
import { CalendarViewPanel } from '@/components/pages/dedicated/calendar-view/calendar-view-panel';

export type DedicatedPageTab =
  | 'dashboard'
  | 'insights'
  | 'queue'
  | 'calendar-view'
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

// Final tab scope (Shahzeb, 2026-10-27, Calendar View added
// 2026-10-29): Dashboard, Insights, Queue, Calendar View, Posting
// Times — no Settings tab. Queue is the real section now
// (dedicated/queue/QueuePanel), not a placeholder.
const TAB_ITEMS: ReadonlyArray<{ id: DedicatedPageTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'insights', label: 'Insights' },
  { id: 'queue', label: 'Queue' },
  { id: 'calendar-view', label: 'Calendar View' },
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
  // Create Posts dialogue: opened by the header's Create Posts
  // button (previously a rendered-only no-op). The dialogue owns
  // its own state; the shell only opens it.
  const [isCreatePostsOpen, setIsCreatePostsOpen] = React.useState(false);
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
  // R20: the list route paginates (30/page by default, max 50), so
  // the old single unparameterised fetch only ever saw page 1 — a
  // real page beyond it fell through to a false Not Found. Walk
  // pages at max size until the page is found, the reported total
  // is covered, or the walk cap is hit. Cap: 200 pages x 50 =
  // 10,000 pages (the destination-redirector precedent); a walk
  // stops at the first short page / totalPages boundary, so a
  // typical workspace costs one or two requests, never the cap.
  // staleTime 0 matters: the route server-prefetches page 1 into
  // this key, and without it that fresh page-1 slice would satisfy
  // the fallback without ever walking. refetchOnWindowFocus is off
  // here — this is an error-path search, not live data, and a focus
  // refetch would re-walk on every window focus while failed.
  const listQuery = useQuery({
    queryKey: tenant.pages.list,
    queryFn: async ({ signal }) => {
      const all: ListFacebookPagesResponse['pages'] = [];
      let total = 0;
      let totalPages = 0;
      for (let pageCount = 1; pageCount <= 200; pageCount += 1) {
        const res = await api.get(pagesListPath, {
          schema: ListFacebookPagesResponseSchema,
          query: { page: pageCount, limit: 50 },
          signal,
        });
        all.push(...res.pages);
        total = res.total;
        totalPages = res.totalPages ?? 0;
        if (all.length >= total || res.pages.length < 50) break;
        if (totalPages > 0 && pageCount >= totalPages) break;
      }
      return {
        pages: all,
        total,
        page: 1,
        limit: 50,
        totalPages: totalPages > 0 ? totalPages : undefined,
      };
    },
    enabled: Boolean(subdomain) && !initialPage && detailFailed,
    staleTime: 0,
    refetchOnWindowFocus: false,
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

  // R19: the old code rendered every failure as "Page Not Found"
  // with no retry, whatever actually failed. Branch on the HTTP
  // status where the error shape allows it — ApiError carries it
  // (see lib/api/errors.ts); a non-ApiError failure has no status
  // and falls to the generic load-failure branch, never to a
  // misdiagnosed "couldn't locate". The error state waits until
  // the fallback list walk has settled (isFetching false), so a
  // page beyond page 1 is not flashed as Not Found mid-walk.
  // Only a proven absence — detail 404 AND a settled list walk
  // without the page — is "Page Not Found", and only that branch
  // omits Retry. A disconnected page lands here too: detail
  // returns null for it and the list excludes it.
  function apiStatus(error: unknown): number | undefined {
    return isApiError(error) ? error.status : undefined;
  }
  type PageErrorState = {
    title: string;
    message: string;
    showRetry: boolean;
  };
  const pageError: PageErrorState | null = (() => {
    if (page || initialPage || !detailFailed) return null;
    if (listQuery.isFetching) return null;
    if (!listQuery.isError && !listQuery.isSuccess) return null;
    const detailStatus = apiStatus(detailQuery.error);
    const listStatus = apiStatus(listQuery.error);
    if (detailStatus === 401 || listStatus === 401) {
      return {
        title: 'Session Expired',
        message: 'Your session has expired. Sign in again, then try again.',
        showRetry: true,
      };
    }
    if (detailStatus === 403 || listStatus === 403) {
      return {
        title: 'Access Denied',
        message: "You don't have access to this Facebook Page.",
        showRetry: true,
      };
    }
    if (detailStatus === 500 || listStatus === 500) {
      return {
        title: 'Something Went Wrong',
        message:
          'The page could not be loaded because of a server error. Please try again.',
        showRetry: true,
      };
    }
    if (detailStatus === 404 && listQuery.isSuccess) {
      return {
        title: 'Page Not Found',
        message: "Couldn't locate the requested Facebook Page.",
        showRetry: false,
      };
    }
    return {
      title: "Couldn't Load This Page",
      message: 'Check your connection and try again.',
      showRetry: true,
    };
  })();
  const isLoadingPage = !page && !pageError;

  // --- frame-level summaries: queue items + slots (shared cache) -------
  // Slots resolve BEFORE the dashboard estimates below: the estimate
  // computation reads slots, so the declaration order matters (TDZ).
  // K11: gated on the page existing, not just subdomain+pageId —
  // for a not-found page these used to fire (and fail) alongside
  // the detail/list failure. Panels only mount when `page` exists,
  // so this gate is also what keeps their data from firing early.
  // refetchOnWindowFocus only while a slots/queue-consuming tab is
  // active: Insights uses neither, so a focus event on Insights
  // must not refetch frame queue/slots data for hidden panels.
  const slotsQuery = useQuery({
    queryKey: tenant.pages.slots(pageId),
    queryFn: ({ signal }) =>
      api.get(slotsPath, { schema: ListQueueSlotsResponseSchema, signal }),
    enabled: Boolean(subdomain && pageId && page),
    refetchOnWindowFocus: activeTab !== 'insights',
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

  // Estimates tick: passing time moves estimates even without a
  // refetch (a slot passing, a claim firing), so recompute on a
  // 60-second clock instead of freezing `now` at the last fetch.
  const [estimateNow, setEstimateNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setEstimateNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const queueQuery = useQuery({
    queryKey: tenant.queue.items(pageId),
    // The list route caps at 100 per page, but estimates must see
    // the FULL queued set: with only the first page, posts past it
    // got no estimate and visible ones ignored the backlog ahead
    // of them. Page through until the total is reached (bounded:
    // 100 pages max, so a runaway total cannot loop forever).
    queryFn: async ({ signal }) => {
      const all: ListQueueItemsResponse['items'] = [];
      let offset = 0;
      let total = 0;
      for (let pageCount = 0; pageCount < 100; pageCount += 1) {
        const res = await api.get(queuePath, {
          schema: ListQueueItemsResponseSchema,
          query: { pageId, limit: 100, offset },
          signal,
        });
        all.push(...res.items);
        total = res.total;
        if (all.length >= total || res.items.length < 100) break;
        offset += 100;
      }
      return { items: all, total, limit: 100, offset: 0 };
    },
    enabled: Boolean(subdomain && pageId && page),
    refetchOnWindowFocus: activeTab !== 'insights',
  });
  const queueItems = React.useMemo(
    () => queueQuery.data?.items ?? [],
    [queueQuery.data]
  );
  // R4/R5: failure is carried as state, never as an empty list.
  // The dashboard, posting-times, and queue tabs branch on these
  // instead of rendering first-use empty states for a failed fetch.
  const queueError = queueQuery.isError;
  const slotsError = slotsQuery.isError;
  // R10: the shell's dashboard fetch caps at 100 pages x 100 items.
  // When the accumulated list is shorter than the reported total,
  // the cap bit — the dashboard says so instead of implying the
  // estimates cover the whole queue.
  const dashboardQueueTruncated = queueQuery.data
    ? queueQuery.data.items.length < queueQuery.data.total
    : false;
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
        now: estimateNow,
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
    [queueItems, slots, pageTimezone, estimateNow]
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
  // Awaitable (not void): the status mutation awaits it before
  // toasting, so the success toast fires after the header refetch
  // has settled (K11 toast-before-refetch), not before it. Other
  // call sites keep the `void` prefix — awaiting is opt-in.
  const invalidatePage = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: tenant.pages.detail(pageId) });
    await queryClient.invalidateQueries({ queryKey: tenant.pages.list });
  }, [queryClient, tenant.pages, pageId]);

  // R19 retry for the page error state: re-run detail, and the
  // list fallback re-walks if detail fails again (its `enabled`
  // follows detailFailed).
  const handleRetryPage = React.useCallback(() => {
    void invalidatePage();
  }, [invalidatePage]);

  const invalidateQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
  }, [queryClient, tenant.queue]);

  const invalidateSlots = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.pages.slots(pageId) });
  }, [queryClient, tenant.pages, pageId]);

  // Retry for the dashboard/posting-times error states: re-run both
  // fetches (queue + slots) so one tap recovers either failure.
  const handleRetryData = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
    void queryClient.invalidateQueries({ queryKey: tenant.pages.slots(pageId) });
  }, [queryClient, tenant.queue, tenant.pages, pageId]);

  // K11: the toast fires only after the page refetch settles, so
  // the header the toast describes already shows the new state.
  // The header's own "Updating…" feedback is untouched: it stays
  // up until this mutation (now including its refetch) settles.
  // `source` distinguishes the checkpoint banner's Mark Verified
  // from a plain menu Resume — same endpoint, same mutation, but
  // the success toast must not claim a plain resume happened when
  // the user just verified a checkpoint (and vice versa).
  const statusMutation = useMutation({
    mutationFn: ({
      nextStatus,
    }: {
      nextStatus: 'active' | 'paused';
      source?: 'menu' | 'reactivate';
    }) =>
      api.patch(pagePath, { status: nextStatus }, { schema: UpdatePageResponseSchema }),
    onSuccess: async (_data, variables) => {
      await invalidatePage().catch(() => undefined);
      toast.success(
        variables.source === 'reactivate'
          ? 'Page marked verified and automation resumed.'
          : variables.nextStatus === 'paused'
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
      await statusMutation
        .mutateAsync({ nextStatus, source: 'menu' })
        .catch(() => undefined);
    },
    [statusMutation]
  );
  const handleMarkVerified = React.useCallback(async () => {
    await statusMutation
      .mutateAsync({ nextStatus: 'active', source: 'reactivate' })
      .catch(() => undefined);
  }, [statusMutation]);

  const publishNowMutation = useMutation({
    // One fresh idempotency key per tap: a retried request whose
    // response was lost returns the stored acknowledgement instead
    // of dispatching the item a second time.
    mutationFn: (itemId: string) =>
      api.post(
        buildTenantApiPath(subdomain, `/publishing/queue/${itemId}/publish-now`),
        undefined,
        {
          schema: AckSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
        }
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
      void invalidatePage();
      toast.success('Posting time added.');
    },
    // No onError toast: the posting-time form shows the failure
    // inline (serverError) and keeps the modal open — a toast here
    // duplicated every save failure (nit: slot error duplication).
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
  // Nit: the update path carries NO timezone — slots have no
  // per-slot timezone column (the page timezone lives on the
  // destination; the slot route answers it per slot). The form
  // still sends one for the add path; the tab strips it before
  // calling onUpdateSlot, so this mutation never forwards a dead
  // field the server would silently ignore.
  const updateSlotMutation = useMutation({
    mutationFn: ({
      slotId,
      data,
    }: {
      slotId: string;
      data: {
        slotTime?: string;
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
      void invalidatePage();
      toast.success('Posting time updated.');
    },
    // No onError toast: same duplication rule as add — the form's
    // inline serverError is the failure surface, modal stays open.
  });
  const handleUpdateSlot = React.useCallback(
    async (
      slotId: string,
      data: {
        slotTime?: string;
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
      void invalidatePage();
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
      void invalidatePage();
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
      void invalidatePage();
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
      // R23: invalidate the Pages list (like statusMutation does),
      // so the just-disconnected page does not linger in the list
      // cache for up to 60s after the redirect.
      void invalidatePage();
      router.push(`/tenant/${subdomain}/pages`);
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't disconnect the page. Please try again.")
      );
    },
  });
  // R22: propagate the error (no .catch(() => undefined) here) so
  // the header's disconnect dialogue can stay open on failure
  // instead of closing as if disconnect had succeeded. The header
  // catches it; the toast above is the failure signal.
  const handleDisconnectPage = React.useCallback(async () => {
    await disconnectMutation.mutateAsync();
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

  // Nit: an unknown ?tab= (?tab=bogus, ?tab=settings) falls back
  // to the current tab in state but used to leave the bogus value
  // in the URL — a copied link then re-triggered the fallback on
  // every open. Normalise with replace (never push: a bogus value
  // is not a history entry, and valid tabs keep push-history).
  // Other query params are preserved; a missing ?tab= is already
  // clean and is left alone.
  React.useEffect(() => {
    if (urlTab === null || TAB_IDS.has(urlTab) || !subdomain || !pageId) return;
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set('tab', activeTabRef.current);
    router.replace(`/tenant/${subdomain}/pages/${pageId}?${nextParams.toString()}`, {
      scroll: false,
    });
  }, [urlTab, router, searchParams, subdomain, pageId]);

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

  // R27: a deep-linked or back-navigated later tab must be visible
  // on narrow screens, where the tab row scrolls horizontally. On
  // mount and on every ?tab= change (click, push, or popstate —
  // all funnel through activeTab), scroll just the active trigger
  // into view, inline-nearest: a no-op when it is already fully
  // visible, and it never scrolls on any other render — page?.id
  // (not the page object) is the dependency, so refetches that
  // replace the page object do not re-scroll. The scroll event
  // itself re-runs the edge-fade computation, so the fades stay
  // truthful after a programmatic scroll.
  React.useEffect(() => {
    if (!page) return;
    const list = tabListRef.current;
    if (!list) return;
    const trigger = list.querySelector(`[data-testid="tab-${activeTab}-btn"]`);
    if (
      trigger &&
      typeof (trigger as HTMLElement).scrollIntoView === 'function'
    ) {
      (trigger as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    updateTabScrollEdges();
  }, [activeTab, page?.id, updateTabScrollEdges]);


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

      {/* Page load error (R19: branched by failure kind, not a
          blanket Not Found — only a proven absence omits Retry). */}
      {pageError && !page && (
        <div
          data-testid="page-error-state"
          className="flex flex-col items-center gap-4 rounded-md border border-signal-critical/40 bg-panel px-6 py-12 text-center"
        >
          <h3 className="m-0 text-lg font-semibold text-signal-critical">{pageError.title}</h3>
          <p className="m-0 text-body text-ink-sub">{pageError.message}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {pageError.showRetry && (
              <Button type="button" data-testid="page-error-retry-btn" onClick={handleRetryPage}>
                Retry
              </Button>
            )}
            <Button
              type="button"
              variant={pageError.showRetry ? 'secondary' : undefined}
              data-testid="page-error-return-btn"
              onClick={() => router.push(pagesListHref)}
            >
              Return to Pages
            </Button>
          </div>
        </div>
      )}

      {/* Loaded page control plane */}
      {page && (
        <>
          <DedicatedPageHeader
            page={page}
            subdomain={subdomain}
            onStatusToggle={handleStatusToggle}
            onMarkVerified={handleMarkVerified}
            onDisconnectRequest={handleDisconnectPage}
            onCreatePosts={() => setIsCreatePostsOpen(true)}
          />
          <CreatePostsDialog
            open={isCreatePostsOpen}
            onOpenChange={setIsCreatePostsOpen}
            subdomain={subdomain}
            page={page}
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
                  queueError={queueError}
                  slotsError={slotsError}
                  queueTruncated={dashboardQueueTruncated}
                  onRetryData={handleRetryData}
                />
              </TabsContent>
            )}

            {/* Tab-panel DOM order matches tab order (Dashboard,
                Insights, Queue, Calendar View, Posting Times) —
                Radix matches panels by value, so reordering the
                blocks changes nothing about mount-on-first-visit:
                each panel still mounts only once visited. */}
            {visitedTabs.has('insights') && (
              <TabsContent value="insights" forceMount className="data-[state=inactive]:hidden">
                <PageTabInsights page={page} subdomain={subdomain} pageTimezone={pageTimezone} />
              </TabsContent>
            )}

            {visitedTabs.has('queue') && (
              <TabsContent value="queue" forceMount className="data-[state=inactive]:hidden">
                <QueuePanel
                  subdomain={subdomain}
                  pageId={pageId}
                  pageTimezone={pageTimezone}
                  pageStatus={page.status}
                  slots={slots}
                  slotsError={slotsError}
                  onRetrySlots={invalidateSlots}
                  onCreatePost={() => setIsCreatePostsOpen(true)}
                  isActive={activeTab === 'queue'}
                />
              </TabsContent>
            )}

            {visitedTabs.has('calendar-view') && (
              <TabsContent value="calendar-view" forceMount className="data-[state=inactive]:hidden">
                <CalendarViewPanel
                  subdomain={subdomain}
                  pageId={pageId}
                  pageTimezone={pageTimezone}
                  slots={slots}
                  isActive={activeTab === 'calendar-view'}
                />
              </TabsContent>
            )}

            {visitedTabs.has('calendar') && (
              <TabsContent value="calendar" forceMount className="data-[state=inactive]:hidden">
                <PageTabPostingTimes
                  page={page}
                  slots={slots}
                  isLoading={slotsQuery.isPending}
                  slotsError={slotsError}
                  onRetrySlots={invalidateSlots}
                  queuedCount={queuedCount}
                  onAddSlot={handleAddSlot}
                  onUpdateSlot={handleUpdateSlot}
                  onUpdateTimezone={handleUpdateTimezone}
                  onToggleSlot={handleToggleSlot}
                  onDeleteSlot={handleDeleteSlot}
                />
              </TabsContent>
            )}

          </Tabs>
        </>
      )}
    </div>
  );
}
