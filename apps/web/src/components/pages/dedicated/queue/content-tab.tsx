'use client';

/**
 * Per-destination queue panel (spec 134 PR-134-1) — rebuilt clean-room
 * on shared/ui primitives + tokens and the 137 data layer.
 *
 * Data path (coordinator ruling, 2026-10-23, on the Step-1 verification;
 * updated for the Phase 7 drop, 2026-10-24): the panel builds on the
 * Page-section queue routes over the EXISTING keys (`queue.items`,
 * `queue.statusCounts`, `pages.slots`) — the typed client + React
 * Query, no dual-read. At the ruling, those routes served the
 * pre-unification queue table while the worker claimed from unified
 * `queue_items`; since the Phase 7 drop the same routes read and
 * write the unified table itself (composer creates land there too,
 * via the destination enqueue), so this panel and the worker now
 * share one queue.
 *
 * PROPS BRIDGE DELETED (spec 131 PR-131-3, this panel's named
 * deleter duty from PR-134-1): the section route no longer fetches
 * queue data and no longer passes the items prop or the mutation
 * callback. The panel reads the shared React Query keys directly and
 * its mutations invalidate those keys — the frame's Queue count and
 * dashboard tab read the same cache entry and stay in sync. The query
 * cache is the only copy of queue data: the legacy panel's `useState`
 * item mirror stays deleted.
 *
 * Feedback: the hand-rolled queue-toasts stack is deleted; every
 * outcome goes through the single shared Toast system, with spec 112's
 * reorder strings preserved verbatim (below). The `applyReorder`
 * silent path is fixed (§3.1.1): a zero-assignment plan now
 * acknowledges visibly instead of returning silently.
 */

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { api, buildTenantApiPath } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import {
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
  QueueItemSchema,
  type QueueItem,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import {
  contentChecklistDismissedPreference,
  getPreference,
  setPreference,
} from '@/lib/storage/preferences';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { TableBatchBar, TableToolbar } from '@/components/shared/ui/table';
import { toast } from '@/components/shared/ui/toast';

import { BulkAddModal } from '../bulk/bulk-add-modal';
import { formatSlotShort } from '../composer/queue-slot-utils';
import { formatLabel } from '../bulk/bulk-utils';
import type { PageSlotSummary } from '../tab-dashboard';
import { QueueSummaryHeader } from './queue-summary-header';
import { QueueFilterTabs } from './queue-filter-tabs';
import { QueueRow, type QueueRowBucket } from './queue-row';
import { QueueFailedBanner } from './queue-failed-banner';
import { QueueEmptyStates } from './queue-empty-states';
import {
  computeRetryTime,
  countByFilter,
  filterItems,
  getFailedReason,
  isSlotBased,
  planReorder,
  resolveFormat,
  sortForDisplay,
} from './queue-logic';
import type { DedicatedQueueItem, PageTabQueueProps, QueueFilter } from './queue-types';
import { QUEUE_FILTER_LABELS } from './queue-types';

export type { DedicatedQueueItem, PageTabQueueProps } from './queue-types';

/** Shown after a queue reorder saves successfully (spec 112, verbatim). */
export const QUEUE_REORDER_SUCCESS_MESSAGE = 'Queue reordered — posting times updated.';

/** Shown when a queue reorder could not be saved (spec 112, verbatim). */
export const QUEUE_REORDER_ERROR_MESSAGE = "Couldn't save the new order.";

/**
 * Shown when a reorder attempt changes nothing (§3.1.1's fix — distinct
 * from the success and error strings above).
 */
export const QUEUE_REORDER_NOOP_MESSAGE =
  'That post is already in that position — the order did not change.';

/** Undo window for single deletes (spec 105 §5.1.6). */
const UNDO_DURATION_MS = 8000;
/** Rows rendered per window past the virtualisation threshold (OD134-4). */
const WINDOW_SIZE = 50;

const QueueRescheduleDialog = dynamic(
  () => import('./queue-reschedule-dialog').then((m) => m.QueueRescheduleDialog),
  { ssr: false }
);
const QueueBulkDeleteDialog = dynamic(
  () => import('./queue-bulk-delete-dialog').then((m) => m.QueueBulkDeleteDialog),
  { ssr: false }
);

/** Passthrough ack for queue mutations whose bodies the panel does not
 *  consume (same pattern as composer-submit): the typed client's error
 *  taxonomy still applies in full — failures throw, never vanish. */
const AckSchema = z.object({}).passthrough();

function toSlotSummary(slot: {
  id: string;
  slotTime: string;
  timezone: string;
  isActive: boolean;
  allowedFormats: string[];
}): PageSlotSummary {
  return {
    id: slot.id,
    slotTime: slot.slotTime,
    timezone: slot.timezone,
    isActive: slot.isActive,
    allowedFormats: slot.allowedFormats,
  };
}

function fromQueueItem(item: QueueItem): DedicatedQueueItem {
  return {
    id: item.id,
    mediaId: item.mediaId,
    postFormat: item.postFormat,
    linkUrl: item.linkUrl ?? null,
    caption: item.caption,
    firstComment: item.firstComment,
    scheduledTime: item.scheduledTime,
    status: item.status,
    retryCount: item.retryCount,
    maxRetries: item.maxRetries,
    fbPostId: item.fbPostId,
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    media: item.media
      ? {
          name: item.media.name,
          mediaType: item.media.mediaType,
          thumbnailUrl: item.media.thumbnailUrl,
          url: item.media.url,
          aspectRatio: item.media.aspectRatio,
          durationSeconds: item.media.durationSeconds,
        }
      : null,
  };
}


export function PageTabQueue(props: Readonly<PageTabQueueProps>) {
  const { page, isLoading = false } = props;
  const params = useParams();
  const subdomain = (params.subdomain as string) || '';
  const pageId = page.id;
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const itemsKey = tenant.queue.items(pageId);
  const slotsKey = tenant.pages.slots(pageId);

  const queuePath = buildTenantApiPath(subdomain, '/publishing/queue');
  const slotsPath = buildTenantApiPath(subdomain, `/pages/${pageId}/slots`);
  const accountsPath = buildTenantApiPath(subdomain, '/accounts');

  // --- queries ------------------------------------------------------------
  // The panel reads the shared queue key directly (props bridge deleted
  // by spec 131 PR-131-3 — see the header note). The route server-
  // prefetches this same key, so first paint renders the prefetched
  // state and the background refetch reconciles with the API.
  const itemsQuery = useQuery({
    queryKey: itemsKey,
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: { pageId },
        signal,
      }),
    enabled: Boolean(subdomain),
  });

  const slotsQuery = useQuery({
    queryKey: slotsKey,
    queryFn: ({ signal }) =>
      api.get(slotsPath, { schema: ListQueueSlotsResponseSchema, signal }),
    enabled: Boolean(subdomain),
  });

  const items: DedicatedQueueItem[] = React.useMemo(() => {
    const raw = itemsQuery.data?.items ?? [];
    return raw.map((item) => fromQueueItem(item as QueueItem));
  }, [itemsQuery.data]);

  const slots: PageSlotSummary[] = React.useMemo(
    () => (slotsQuery.data?.slots ?? []).map(toSlotSummary),
    [slotsQuery.data]
  );
  const slotsLoaded = slotsQuery.isSuccess || slotsQuery.isError;
  const timeZone = page.timezone || slots.find((s) => s.timezone)?.timezone || 'UTC';

  const failedCount = React.useMemo(
    () => items.filter((item) => item.status === 'failed').length,
    [items]
  );

  // Connection health gates failed-post retry (§3.5): a failed read is
  // surfaced by React Query's error state and leaves retry enabled
  // (health unknown) — it is never a silent `if (!res.ok) return`.
  const accountsQuery = useQuery({
    queryKey: tenant.accounts.list,
    queryFn: ({ signal }) =>
      api.get(accountsPath, { schema: ListFacebookAccountsResponseSchema, signal }),
    enabled: Boolean(subdomain) && failedCount > 0,
  });
  const connectionExpired: boolean | null = React.useMemo(() => {
    if (!accountsQuery.data) return null;
    const account = accountsQuery.data.accounts.find((a) => a.id === page.facebookAccountId);
    return account ? account.status !== 'active' : false;
  }, [accountsQuery.data, page.facebookAccountId]);

  // --- panel state ---------------------------------------------------------
  const [filter, setFilter] = React.useState<QueueFilter>('all');
  const [selecting, setSelecting] = React.useState(false);
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = React.useState(false);
  const [rescheduleItem, setRescheduleItem] = React.useState<DedicatedQueueItem | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [busyRow, setBusyRow] = React.useState<{ id: string; action: 'retry' | 'delete' } | null>(
    null
  );
  const [renderWindow, setRenderWindow] = React.useState(WINDOW_SIZE);

  // OD134-4 windowed rendering: past 50 rows the list renders a window
  // that expands as the reader scrolls (sentinel), while reorder always
  // operates on the full set in the cache — order is the data.
  const sentinelRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setRenderWindow((w) => w + WINDOW_SIZE);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [checklistDismissed, setChecklistDismissed] = React.useState<boolean>(() =>
    getPreference(contentChecklistDismissedPreference(pageId))
  );

  const invalidateQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
    void queryClient.invalidateQueries({ queryKey: itemsKey });
  }, [queryClient, itemsKey]);

  const setCachedItems = React.useCallback(
    (updater: (prev: DedicatedQueueItem[]) => DedicatedQueueItem[]) => {
      queryClient.setQueryData(itemsKey, (prev: unknown) => {
        const prevItems = (prev as { items?: QueueItem[] } | undefined)?.items ?? [];
        const next = updater(prevItems.map((i) => fromQueueItem(i as QueueItem)));
        return {
          items: next,
          total: next.length,
          limit: next.length,
          offset: 0,
        };
      });
    },
    [queryClient, itemsKey]
  );

  // --- derived -------------------------------------------------------------
  const counts = React.useMemo(
    () => countByFilter(items, slots, timeZone, slotsLoaded),
    [items, slots, timeZone, slotsLoaded]
  );
  const visibleItems = React.useMemo(
    () => sortForDisplay(filterItems(items, filter, slots, timeZone, slotsLoaded)),
    [items, filter, slots, timeZone, slotsLoaded]
  );
  const reorderableItems = React.useMemo(
    () =>
      sortForDisplay(items.filter((i) => i.status === 'queued' || i.status === 'publishing')),
    [items]
  );

  const bucketFor = React.useCallback(
    (item: DedicatedQueueItem): QueueRowBucket => {
      if (item.status === 'failed') return 'failed';
      if (item.status === 'published') return 'published';
      if (!slotsLoaded) return 'queued';
      return isSlotBased(item, slots, timeZone) ? 'queued' : 'scheduled';
    },
    [slots, timeZone, slotsLoaded]
  );

  // --- mutations -------------------------------------------------------------
  const patchItem = React.useCallback(
    async (id: string, data: Record<string, unknown>): Promise<boolean> => {
      try {
        await api.patch(buildTenantApiPath(subdomain, `/publishing/queue/${id}`), data, {
          schema: AckSchema,
        });
        return true;
      } catch {
        return false;
      }
    },
    [subdomain]
  );

  const applyPatch = React.useCallback(
    async (id: string, data: Record<string, unknown>): Promise<boolean> => {
      const ok = await patchItem(id, data);
      if (ok) {
        setCachedItems((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, ...(data as Partial<DedicatedQueueItem>) } : item
          )
        );
      }
      return ok;
    },
    [patchItem, setCachedItems]
  );

  const reorderMutation = useMutation({
    mutationFn: async (assignments: Array<{ id: string; scheduledTime: string }>) => {
      const results = await Promise.all(
        assignments.map(async (a) => {
          try {
            await api.patch(buildTenantApiPath(subdomain, `/publishing/queue/${a.id}`), {
              scheduledTime: a.scheduledTime,
            }, { schema: AckSchema });
            return true;
          } catch {
            return false;
          }
        })
      );
      if (results.some((ok) => !ok)) throw new Error('reorder-failed');
    },
    onMutate: (assignments) => {
      const timesById = new Map(assignments.map((a) => [a.id, a.scheduledTime]));
      const snapshot = queryClient.getQueryData(itemsKey);
      setCachedItems((prev) =>
        prev.map((item) =>
          timesById.has(item.id)
            ? { ...item, scheduledTime: timesById.get(item.id) as string }
            : item
        )
      );
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context?.snapshot !== undefined) {
        queryClient.setQueryData(itemsKey, context.snapshot);
      }
      toast.error(QUEUE_REORDER_ERROR_MESSAGE);
      invalidateQueue();
    },
    onSuccess: () => {
      toast.success(QUEUE_REORDER_SUCCESS_MESSAGE);
      invalidateQueue();
    },
  });

  const applyReorder = React.useCallback(
    (fromIndex: number, toIndex: number) => {
      const plan = planReorder({
        ordered: reorderableItems,
        fromIndex,
        toIndex,
        slots,
        timeZone,
      });
      if ('blocked' in plan) {
        setBlockedMessage(plan.blocked);
        setAnnouncement(plan.blocked);
        return;
      }
      if (plan.assignments.length === 0) {
        // §3.1.1 fix: a no-op reorder attempt acknowledges visibly —
        // the legacy silent return is deleted.
        toast.info(QUEUE_REORDER_NOOP_MESSAGE);
        setAnnouncement(QUEUE_REORDER_NOOP_MESSAGE);
        return;
      }
      setBlockedMessage(null);
      const targetTime = reorderableItems[toIndex]?.scheduledTime;
      if (targetTime) {
        const newTimeText = formatSlotShort(new Date(targetTime), timeZone);
        setAnnouncement(
          `Moved to position ${toIndex + 1} of ${reorderableItems.length}, due ${newTimeText} ${timeZone}.`
        );
      }
      reorderMutation.mutate(plan.assignments);
    },
    [reorderableItems, slots, timeZone, reorderMutation]
  );

  const handleDropOnRow = React.useCallback(
    (targetId: string) => {
      const fromIndex = reorderableItems.findIndex((i) => i.id === dragId);
      const toIndex = reorderableItems.findIndex((i) => i.id === targetId);
      setDragId(null);
      setDragOverId(null);
      if (!dragId || fromIndex < 0 || toIndex < 0) {
        // Invalid drop target: restore + acknowledge (§3.1.1 audit).
        if (dragId) {
          toast.info(QUEUE_REORDER_NOOP_MESSAGE);
          setAnnouncement(QUEUE_REORDER_NOOP_MESSAGE);
        }
        return;
      }
      applyReorder(fromIndex, toIndex);
    },
    [dragId, reorderableItems, applyReorder]
  );

  const handleMove = React.useCallback(
    (id: string, direction: -1 | 1) => {
      const index = reorderableItems.findIndex((i) => i.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= reorderableItems.length) {
        // Edge Moves are prevented by disabled-with-reason controls in
        // the row; this path only fires from a stale render — ack it.
        toast.info(QUEUE_REORDER_NOOP_MESSAGE);
        setAnnouncement(QUEUE_REORDER_NOOP_MESSAGE);
        return;
      }
      applyReorder(index, target);
    },
    [reorderableItems, applyReorder]
  );

  // --- delete + undo restore -------------------------------------------------
  const restoreDeletedItem = React.useCallback(
    async (snapshot: DedicatedQueueItem) => {
      try {
        const created = await api.post(queuePath, {
          pageId,
          mediaId: snapshot.mediaId ?? null,
          postFormat: resolveFormat(snapshot),
          linkUrl: snapshot.linkUrl ?? null,
          scheduledTime: new Date(snapshot.scheduledTime).toISOString(),
          caption: snapshot.caption ?? '',
          firstComment: snapshot.firstComment ?? null,
        }, { schema: QueueItemSchema });
        const mapped = fromQueueItem(created);
        setCachedItems((prev) =>
          prev.some((c) => c.id === mapped.id) ? prev : [...prev, mapped]
        );
        toast.success('Post restored.');
      } catch {
        toast.error("Couldn't restore this post.");
      }
    },
    [queuePath, pageId, setCachedItems]
  );

  const handleDelete = React.useCallback(
    async (item: DedicatedQueueItem) => {
      setBusyRow({ id: item.id, action: 'delete' });
      let ok = false;
      try {
        await api.delete(buildTenantApiPath(subdomain, `/publishing/queue/${item.id}`), {
          schema: AckSchema,
        });
        ok = true;
      } catch {
        ok = false;
      }
      setBusyRow(null);
      if (!ok) {
        toast.error("Couldn't delete this post. Please try again.");
        return;
      }
      setCachedItems((prev) => prev.filter((c) => c.id !== item.id));
      setSelection((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      toast.success('Post deleted.', {
        duration: UNDO_DURATION_MS,
        action: { label: 'Undo', onClick: () => void restoreDeletedItem(item) },
      });
    },
    [subdomain, setCachedItems, restoreDeletedItem]
  );

  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const handleBulkDelete = React.useCallback(async () => {
    const ids = [...selection];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.delete(buildTenantApiPath(subdomain, `/publishing/queue/${id}`), {
          schema: AckSchema,
        });
      } catch {
        failed += 1;
      }
    }
    const deleted = ids.length - failed;
    setBulkDeleting(false);
    setShowBulkDeleteConfirm(false);
    setSelecting(false);
    setSelection(new Set());
    if (deleted > 0) {
      const deletedIds = new Set(ids);
      setCachedItems((prev) => prev.filter((i) => !deletedIds.has(i.id)));
    }
    if (deleted === ids.length) {
      toast.success(`${deleted} ${deleted === 1 ? 'post' : 'posts'} deleted.`);
    } else {
      toast.error(`Deleted ${deleted} of ${ids.length} posts.`);
      invalidateQueue();
    }
  }, [selection, subdomain, setCachedItems, invalidateQueue]);

  // --- retry -------------------------------------------------------------------
  const handleRetry = React.useCallback(
    async (item: DedicatedQueueItem) => {
      if (connectionExpired) return;
      setBusyRow({ id: item.id, action: 'retry' });
      const retryTime = computeRetryTime(item, slots, timeZone);
      if (!retryTime) {
        setBusyRow(null);
        toast.error(`No posting time covers ${formatLabel(resolveFormat(item))}s yet.`);
        return;
      }
      const ok = await applyPatch(item.id, {
        status: 'queued',
        scheduledTime: retryTime.toISOString(),
      });
      setBusyRow(null);
      if (!ok) {
        toast.error("Couldn't retry this post. Please try again.");
        return;
      }
      toast.success(`Retrying ${formatSlotShort(retryTime, timeZone)}.`);
    },
    [connectionExpired, slots, timeZone, applyPatch]
  );

  // --- selection + checklist -----------------------------------------------------
  const toggleSelect = React.useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dismissChecklist = React.useCallback(() => {
    setPreference(contentChecklistDismissedPreference(pageId), true);
    setChecklistDismissed(true);
  }, [pageId]);

  const handleSlotsChanged = React.useCallback(
    (next: PageSlotSummary[]) => {
      queryClient.setQueryData(slotsKey, {
        slots: next.map((s) => ({
          id: s.id,
          userId: '',
          pageId,
          slotTime: s.slotTime,
          timezone: s.timezone,
          isActive: s.isActive,
          allowedFormats: (s.allowedFormats ?? []) as Array<
            'text' | 'image' | 'reel' | 'video' | 'story'
          >,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        total: next.length,
      });
    },
    [queryClient, slotsKey, pageId]
  );

  // --- render ----------------------------------------------------------------------
  const showLoading = (isLoading || itemsQuery.isPending) && items.length === 0;
  const showLoadError = itemsQuery.isError && items.length === 0;

  if (showLoading) {
    return (
      <div className="flex flex-col gap-4" aria-label="Loading posts" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="size-14" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (showLoadError) {
    return (
      <Banner
        variant="critical"
        title="Couldn't load your posts."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: itemsKey });
              void queryClient.invalidateQueries({ queryKey: slotsKey });
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const isEmpty = items.length === 0;
  const windowedItems = visibleItems.slice(0, renderWindow);
  const hasMoreWindow = visibleItems.length > windowedItems.length;

  return (
    <div data-testid="content-tab" className="flex flex-col gap-4">
      <div aria-live="polite" role="status" data-testid="queue-reorder-announcer" className="sr-only">
        {announcement}
      </div>

      {!isEmpty && (
        <>
          <QueueFailedBanner count={failedCount} onReview={() => setFilter('failed')} />
          <TableToolbar className="justify-between">
            <QueueSummaryHeader items={items} timeZone={timeZone} />
            <div className="flex flex-wrap items-center gap-2">
              {!selecting ? (
                <Button variant="ghost" size="sm" onClick={() => setSelecting(true)}>
                  Select
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelecting(false);
                    setSelection(new Set());
                  }}
                >
                  Done
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                data-testid="queue-bulk-add-btn"
                onClick={() => setBulkOpen(true)}
              >
                Bulk add
              </Button>
            </div>
          </TableToolbar>
          <QueueFilterTabs counts={counts} active={filter} onChange={setFilter} />

          {selecting && (
            <TableBatchBar
              selectedCount={selection.size}
              onClearSelection={() => setSelection(new Set())}
            >
              <Button
                variant="destructive"
                size="sm"
                disabled={selection.size === 0}
                onClick={() => setShowBulkDeleteConfirm(true)}
              >
                Delete ({selection.size})
              </Button>
            </TableBatchBar>
          )}

          {blockedMessage && (
            <Banner
              variant="warning"
              title={blockedMessage}
              onDismiss={() => setBlockedMessage(null)}
            />
          )}
        </>
      )}

      {isEmpty ? (
        <QueueEmptyStates
          pageId={pageId}
          subdomain={subdomain}
          slots={slots}
          onSlotsChanged={handleSlotsChanged}
          onBulkAdd={() => setBulkOpen(true)}
          checklistDismissed={checklistDismissed}
          onDismissChecklist={dismissChecklist}
        />
      ) : visibleItems.length === 0 ? (
        <QueueEmptyStates
          pageId={pageId}
          subdomain={subdomain}
          slots={slots}
          onSlotsChanged={handleSlotsChanged}
          onBulkAdd={() => setBulkOpen(true)}
          checklistDismissed={checklistDismissed}
          onDismissChecklist={dismissChecklist}
          variant="no-results"
          filterLabel={QUEUE_FILTER_LABELS[filter]}
          onClearFilters={() => setFilter('all')}
        />
      ) : (
        <>
          <ul aria-label="Posts" className="m-0 flex list-none flex-col p-0">
            {windowedItems.map((item) => {
              const bucket = bucketFor(item);
              const reorderable =
                (item.status === 'queued' || item.status === 'publishing') &&
                (filter === 'all' || filter === 'queued' || filter === 'scheduled');
              const reorderIndex = reorderableItems.findIndex((i) => i.id === item.id);
              return (
                <QueueRow
                  key={item.id}
                  item={item}
                  timeZone={timeZone}
                  bucket={bucket}
                  selectable={selecting}
                  selected={selection.has(item.id)}
                  onToggleSelect={toggleSelect}
                  reorderable={reorderable}
                  isDragOver={dragOverId === item.id}
                  onDragStart={setDragId}
                  onDragOverRow={(id) => {
                    if (dragId && id !== dragId) setDragOverId(id);
                  }}
                  onDropOnRow={handleDropOnRow}
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  onMove={handleMove}
                  onReschedule={setRescheduleItem}
                  onDelete={(target) => void handleDelete(target)}
                  onRetry={(target) => void handleRetry(target)}
                  retryBlocked={connectionExpired === true}
                  failedReason={
                    bucket === 'failed' ? getFailedReason(item, connectionExpired === true) : null
                  }
                  busyAction={busyRow?.id === item.id ? busyRow.action : null}
                  reorderIndex={reorderIndex}
                  reorderCount={reorderableItems.length}
                  onAnnounce={setAnnouncement}
                  destinationName={page.pageName}
                />
              );
            })}
          </ul>
          {hasMoreWindow && (
            <div ref={sentinelRef} className="flex justify-center py-2">
              <Button
                variant="secondary"
                data-testid="queue-show-more-btn"
                onClick={() => setRenderWindow((w) => w + WINDOW_SIZE)}
              >
                Show more posts ({visibleItems.length - windowedItems.length} more)
              </Button>
            </div>
          )}
        </>
      )}

      {rescheduleItem && (
        <QueueRescheduleDialog
          item={rescheduleItem}
          items={items}
          slots={slots}
          timeZone={timeZone}
          onPatch={applyPatch}
          onClose={() => setRescheduleItem(null)}
          onSaved={(message) => {
            toast.success(message);
            invalidateQueue();
          }}
          onError={(message) => toast.error(message)}
        />
      )}

      {showBulkDeleteConfirm && (
        <QueueBulkDeleteDialog
          count={selection.size}
          deleting={bulkDeleting}
          onCancel={() => setShowBulkDeleteConfirm(false)}
          onConfirm={() => void handleBulkDelete()}
        />
      )}

      {bulkOpen && (
        <BulkAddModal
          pageId={pageId}
          subdomain={subdomain}
          slots={slots}
          isOpen={bulkOpen}
          onClose={() => setBulkOpen(false)}
          onComplete={() => {
            setBulkOpen(false);
            invalidateQueue();
          }}
        />
      )}
    </div>
  );
}
