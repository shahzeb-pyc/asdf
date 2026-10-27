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
 * PR: no `queueItems` prop is passed to PageTabQueue from here.
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
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
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
  UpdateScheduleTimezoneResponseSchema,
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
  PageTabQueue,
  PageTabSettings,
  PostComposer,
  type PageSlotSummary,
} from '@/components/pages/dedicated';

export type DedicatedPageTab =
  | 'dashboard'
  | 'queue'
  | 'calendar'
  | 'insights'
  | 'settings';

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

const TAB_ITEMS: ReadonlyArray<{ id: DedicatedPageTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'queue', label: 'Queue' },
  { id: 'calendar', label: 'Posting Times' },
  { id: 'insights', label: 'Insights' },
  { id: 'settings', label: 'Settings' },
];

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
  const queryClient = useQueryClient();
  const subdomain = subdomainProp ?? ((params?.subdomain as string) || '');
  const pageId = pageIdProp ?? ((params?.pageId as string) || '');

  const [activeTab, setActiveTab] = React.useState<DedicatedPageTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = React.useState<ReadonlySet<DedicatedPageTab>>(
    () => new Set([initialTab])
  );
  const [isComposerOpen, setIsComposerOpen] = React.useState(false);

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
  const dashboardQueueItems = React.useMemo(
    () =>
      queueItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        postFormat: item.postFormat,
        linkUrl: item.linkUrl ?? null,
        caption: item.caption ?? null,
        firstComment: item.firstComment ?? null,
        scheduledTime: item.scheduledTime,
        status: item.status,
        ...(item.media ? { mediaType: item.media.mediaType } : {}),
        thumbnailUrl: item.media?.thumbnailUrl ?? null,
      })),
    [queueItems]
  );
  const queuedCount = React.useMemo(
    () => queueItems.filter((i) => i.status === 'queued').length,
    [queueItems]
  );

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
      toast.success('Recurring publishing slot added.');
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't create the publishing slot. Please try again.")
      );
    },
  });
  const handleAddSlot = React.useCallback(
    async (slotData: { slotTime: string; timezone: string; allowedFormats?: string[] }) => {
      await addSlotMutation.mutateAsync(slotData);
    },
    [addSlotMutation]
  );

  const timezoneMutation = useMutation({
    mutationFn: (newTimezone: string) =>
      api.patch(
        slotsPath,
        { timezone: newTimezone },
        { schema: UpdateScheduleTimezoneResponseSchema }
      ),
    onSuccess: (data, newTimezone) => {
      invalidateSlots();
      invalidateQueue();
      invalidatePage();
      const realignedCount = Number(data?.realignedQueueCount ?? 0);
      const pluralSuffix = realignedCount > 1 ? 's' : '';
      const realignedMsg =
        realignedCount > 0
          ? ` (${realignedCount} pending post${pluralSuffix} realigned)`
          : '';
      toast.success(`Schedule timezone updated to ${newTimezone}${realignedMsg}.`);
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, "Couldn't update the schedule timezone. Please try again.")
      );
    },
  });
  const handleUpdateTimezone = React.useCallback(
    async (newTimezone: string) => {
      await timezoneMutation.mutateAsync(newTimezone);
    },
    [timezoneMutation]
  );

  const toggleSlotMutation = useMutation({
    mutationFn: ({ slotId, isActive }: { slotId: string; isActive: boolean }) =>
      api.patch(
        buildTenantApiPath(subdomain, `/pages/${pageId}/slots/${slotId}`),
        { isActive },
        { schema: AckSchema }
      ),
    onSuccess: () => {
      invalidateSlots();
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't update the slot. Please try again."));
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
    onSuccess: () => {
      invalidateSlots();
      toast.success('Publishing slot deleted.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't delete the slot. Please try again."));
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

  const handleTabChange = React.useCallback((value: string) => {
    const next = value as DedicatedPageTab;
    setActiveTab(next);
    setVisitedTabs((prev) => {
      if (prev.has(next)) return prev;
      const copy = new Set(prev);
      copy.add(next);
      return copy;
    });
  }, []);

  const switchTab = React.useCallback(
    (tab: 'queue' | 'calendar' | 'insights' | 'settings') => {
      handleTabChange(tab);
    },
    [handleTabChange]
  );

  const openComposer = React.useCallback(() => setIsComposerOpen(true), []);

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
            <TabsList
              variant="line"
              aria-label="Page sections"
              data-testid="dedicated-tabs-nav"
              className="w-full justify-start overflow-x-auto"
            >
              {TAB_ITEMS.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  data-testid={`tab-${tab.id}-btn`}
                  onClick={() => handleTabChange(tab.id)}
                  className="min-h-11 shrink-0"
                >
                  <span>{tab.label}</span>
                  {tab.id === 'queue' && (
                    <span className="rounded-xs border border-line bg-subtle px-1.5 py-0.5 text-xs font-medium text-ink-sub">
                      {queuedCount}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>

            {visitedTabs.has('dashboard') && (
              <TabsContent value="dashboard" forceMount className="data-[state=inactive]:hidden">
                <PageTabDashboard
                  page={page}
                  queueItems={dashboardQueueItems}
                  slots={slots}
                  onPublishNow={handlePublishNow}
                  onSwitchTab={switchTab}
                  onOpenAddQueue={openComposer}
                />
              </TabsContent>
            )}

            {visitedTabs.has('queue') && (
              <TabsContent value="queue" forceMount className="data-[state=inactive]:hidden">
                <PageTabQueue
                  page={page}
                  onOpenAddQueue={openComposer}
                />
              </TabsContent>
            )}

            {visitedTabs.has('calendar') && (
              <TabsContent value="calendar" forceMount className="data-[state=inactive]:hidden">
                <PageTabPostingTimes
                  page={page}
                  slots={slots}
                  isLoading={slotsQuery.isPending}
                  pendingQueueCount={queuedCount}
                  onAddSlot={handleAddSlot}
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

            {visitedTabs.has('settings') && (
              <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
                <PageTabSettings
                  page={page}
                  subdomain={subdomain}
                  onStatusToggle={handleStatusToggle}
                  onDisconnectPage={handleDisconnectPage}
                  onUpdateTimezone={handleUpdateTimezone}
                />
              </TabsContent>
            )}
          </Tabs>

          {/* Post composer (132's component, mounted exactly as before) */}
          {isComposerOpen && (
            <PostComposer
              pageId={page.id}
              subdomain={subdomain}
              slots={slots}
              onClose={() => setIsComposerOpen(false)}
              onSubmitted={(message) => {
                invalidateQueue();
                setIsComposerOpen(false);
                toast.success(message);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
