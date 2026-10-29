'use client';

/**
 * Queue section for a dedicated Page: the real list on top of the
 * existing queue/slots APIs. Single list in queue order (queue_seq —
 * the publish order, never grouped by day, so reorder stays honest).
 *
 * - Filters: All / Queued / Failed / Published with the API's
 *   per-status counts. Default: All.
 * - Pagination: shared ListPagination, 30 per page, page in ?page=.
 * - Queued rows show derived estimates (slots from the shell's cache
 *   + page timezone + assignQueueEstimates, exactly like the shell's
 *   dashboard computation). Estimates are computed over the full
 *   queued list (up to the API's 100-item list cap), NOT over the
 *   visible page — otherwise later pages would get wrong estimates.
 * - Rows whose format no active posting time covers show the inline
 *   unmatched note (the page banner behaviour is untouched).
 * - Actions: delete (confirmed), caption-only edit, up/down reorder
 *   (queued rows only, OPTIMISTIC — the row moves on click and the
 *   reorder POST syncs in the background; buttons stay live during
 *   the sync, rapid clicks coalesce to the newest order, and a
 *   failed sync rolls back to the last server-confirmed order),
 *   publish now (queued rows, fresh idempotency key per tap), retry
 *   (failed rows, fresh idempotency key per tap).
 *   Published rows refuse edit/delete in the UI (server 400s
 *   regardless). Every mutation invalidates the whole queue cache,
 *   so the shell summary and dashboard stay in sync.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  assignQueueEstimates,
  IDEMPOTENCY_KEY_HEADER,
  ReorderQueueItemsResponseSchema,
  slotMatchesFormat,
} from '@fbuploadpro/contracts';
import {
  ListQueueItemsResponseSchema,
  QueueItemSchema,
  type ListQueueItemsResponse,
  type QueueItem,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { toast } from '@/components/shared/ui/toast';
import type { PageSlotSummary } from '../tab-dashboard';
import { QueueRow } from './queue-row';
import { QueueEditDialog } from './queue-edit-dialog';
import { QueueDeleteConfirm } from './queue-delete-confirm';

/** Ack-style responses (publish-now, retry, delete): success is all the UI needs. */
const AckSchema = z.object({}).passthrough();

const PAGE_LIMIT = 30;
/** The list API caps limit at 100: estimates + reorder order cover at most this many queued posts. */
const ESTIMATES_LIMIT = 100;

type QueueFilter = 'all' | 'queued' | 'failed' | 'published';

const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'failed', label: 'Failed' },
  { id: 'published', label: 'Published' },
];

/**
 * Reorder a full queued list to a new id order. Items missing from
 * the order keep their relative order at the end (defensive only —
 * the panel always passes the complete queued set).
 */
function reorderFullItems(items: QueueItem[], nextIds: string[]): QueueItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = nextIds
    .map((id) => byId.get(id))
    .filter((item): item is QueueItem => item !== undefined);
  const rest = items.filter((item) => !nextIds.includes(item.id));
  return [...ordered, ...rest];
}

/**
 * Reorder only the queued items of one rendered page, in place: queued
 * slots take the new order while published/failed/cancelled rows stay
 * exactly where they were, so a mixed page never scrambles.
 */
function reorderPageItems(items: QueueItem[], nextIds: string[]): QueueItem[] {
  const rank = new Map(nextIds.map((id, index) => [id, index]));
  const queued = items
    .filter((item) => item.status === 'queued')
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  let queuedIndex = 0;
  return items.map((item) =>
    item.status === 'queued' ? (queued[queuedIndex++] ?? item) : item
  );
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

type QueueCacheSnapshot = Array<{
  queryKey: QueryKey;
  data: ListQueueItemsResponse;
}>;

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export interface QueuePanelProps {
  subdomain: string;
  pageId: string;
  pageTimezone: string;
  /** Active + paused posting times, from the shell's slots cache. */
  slots: PageSlotSummary[];
  onCreatePost: () => void;
}

export function QueuePanel({
  subdomain,
  pageId,
  pageTimezone,
  slots,
  onCreatePost,
}: Readonly<QueuePanelProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const queuePath = buildTenantApiPath(subdomain, '/publishing/queue');

  const [filter, setFilter] = React.useState<QueueFilter>('all');
  const [itemToEdit, setItemToEdit] = React.useState<QueueItem | null>(null);
  const [itemToDelete, setItemToDelete] = React.useState<QueueItem | null>(null);
  const [busy, setBusy] = React.useState<{ action: string; itemId: string } | null>(null);

  const rawPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const pushPageParam = React.useCallback(
    (nextPage: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.set('page', String(nextPage));
      router.push(`/tenant/${subdomain}/pages/${pageId}?${nextParams.toString()}`, {
        scroll: false,
      });
    },
    [router, searchParams, subdomain, pageId]
  );

  const displayQuery = useQuery({
    queryKey: [...tenant.queue.items(pageId), 'panel', { status: filter, page }] as const,
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: {
          pageId,
          ...(filter !== 'all' ? { status: filter } : {}),
          limit: PAGE_LIMIT,
          offset: (page - 1) * PAGE_LIMIT,
        },
        signal,
      }),
    enabled: Boolean(subdomain && pageId),
  });

  // Full queued list in queue order, for estimates + reorder. The
  // display query alone cannot feed estimates: a row on page 2 must
  // keep the estimate its queue position earns, not restart at zero.
  const estimatesQuery = useQuery({
    queryKey: [...tenant.queue.items(pageId), 'panel', 'estimates'] as const,
    queryFn: ({ signal }) =>
      api.get(queuePath, {
        schema: ListQueueItemsResponseSchema,
        query: { pageId, status: 'queued', limit: ESTIMATES_LIMIT, offset: 0 },
        signal,
      }),
    enabled: Boolean(subdomain && pageId),
  });

  const items = displayQuery.data?.items ?? [];
  const total = displayQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const counts = displayQuery.data;
  const queuedList = estimatesQuery.data?.items ?? [];
  const totalQueued = estimatesQuery.data?.total ?? 0;
  const orderTruncated = totalQueued > ESTIMATES_LIMIT;

  const estimates = React.useMemo(() => {
    if (queuedList.length === 0) return new Map<string, Date | null>();
    return assignQueueEstimates({
      slots: slots.map((slot) => ({
        id: slot.id,
        timeOfDay: slot.slotTime,
        isActive: slot.isActive,
        allowedFormats: slot.allowedFormats ?? null,
      })),
      timezone: pageTimezone,
      posts: queuedList.map((item) => ({ id: item.id, format: item.postFormat })),
    });
  }, [queuedList, slots, pageTimezone]);

  const invalidateQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tenant.queue.all });
  }, [queryClient, tenant.queue]);

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`), {
        schema: AckSchema,
      }),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Post deleted.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't delete the post. Please try again."));
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ itemId, caption }: { itemId: string; caption: string }) =>
      api.patch(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`), { caption }, {
        schema: QueueItemSchema,
      }),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Caption updated.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't update the caption. Please try again."));
    },
  });

  const publishNowMutation = useMutation({
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

  const retryMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.post(
        buildTenantApiPath(subdomain, `/destinations/${pageId}/queue/${itemId}/retry`),
        undefined,
        {
          schema: AckSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
        }
      ),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Post queued again.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't retry the post. Please try again."));
    },
  });

  // Optimistic reorder state. The panel never disables the move
  // buttons while a reorder sync is in flight: every click applies
  // to the cache immediately, and the serializer below sends only
  // the newest order — a stale order never overwrites a newer one.
  // `snapshot` is the last server-confirmed cache state, taken when
  // the first optimistic move lands; a failed sync restores it.
  const reorderSyncRef = React.useRef<{
    inFlight: boolean;
    pending: string[] | null;
    snapshot: QueueCacheSnapshot | null;
    active: boolean;
  }>({ inFlight: false, pending: null, snapshot: null, active: false });

  const snapshotQueueCache = (): QueueCacheSnapshot => {
    const snapshot: QueueCacheSnapshot = [];
    for (const entry of queryClient
      .getQueryCache()
      .findAll({ queryKey: tenant.queue.items(pageId) })) {
      const data = entry.state.data as ListQueueItemsResponse | undefined;
      if (data && Array.isArray(data.items)) {
        snapshot.push({ queryKey: entry.queryKey, data });
      }
    }
    return snapshot;
  };

  const applyOrderToCache = (nextIds: string[]) => {
    for (const entry of queryClient
      .getQueryCache()
      .findAll({ queryKey: tenant.queue.items(pageId) })) {
      const data = entry.state.data as ListQueueItemsResponse | undefined;
      if (!data || !Array.isArray(data.items)) continue;
      const nextItems = entry.queryKey.includes('estimates')
        ? reorderFullItems(data.items, nextIds)
        : reorderPageItems(data.items, nextIds);
      queryClient.setQueryData(entry.queryKey, { ...data, items: nextItems });
    }
  };

  const runReorderSync = async (order: string[]) => {
    const state = reorderSyncRef.current;
    if (state.inFlight) {
      // A sync is already running: remember only the newest order.
      state.pending = order;
      return;
    }
    state.inFlight = true;
    try {
      let current = order;
      for (;;) {
        try {
          await api.post(
            buildTenantApiPath(subdomain, '/publishing/queue/reorder'),
            { pageId, itemIds: current },
            { schema: ReorderQueueItemsResponseSchema }
          );
        } catch (error) {
          // Failed sync: roll back to the last server-confirmed
          // order, then re-read server truth. The failure toast is
          // the only toast reorder ever shows — success stays silent
          // so rapid moves never spam it.
          if (state.snapshot) {
            for (const { queryKey, data } of state.snapshot) {
              queryClient.setQueryData(queryKey, data);
            }
          }
          state.snapshot = null;
          state.active = false;
          state.pending = null;
          toast.error(errorMessage(error, "Couldn't reorder the queue. Please try again."));
          invalidateQueue();
          return;
        }
        if (state.pending && !sameOrder(state.pending, current)) {
          current = state.pending;
          state.pending = null;
          continue;
        }
        state.pending = null;
        break;
      }
      state.snapshot = null;
      state.active = false;
      invalidateQueue();
    } finally {
      state.inFlight = false;
    }
  };

  const runMutation = React.useCallback(
    async (action: string, itemId: string, fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy({ action, itemId });
      try {
        await fn();
        return true;
      } catch {
        // The mutation's onError already surfaced the failure via toast;
        // converting the rejection to a status keeps callers rejection-free.
        return false;
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const handleDelete = React.useCallback(
    async (item: QueueItem) => {
      await runMutation('delete', item.id, () => deleteMutation.mutateAsync(item.id));
      setItemToDelete(null);
    },
    [runMutation, deleteMutation]
  );

  const handleSaveEdit = React.useCallback(
    async (caption: string) => {
      if (!itemToEdit) return;
      await runMutation('edit', itemToEdit.id, () =>
        editMutation.mutateAsync({ itemId: itemToEdit.id, caption })
      );
      setItemToEdit(null);
    },
    [runMutation, editMutation, itemToEdit]
  );

  // Optimistic move: swap the rows in the cache immediately (the
  // rendered list, positions, and derived estimates all follow the
  // cache, so the row visibly moves on click with no wait), then
  // sync the new order in the background. Buttons are deliberately
  // NOT put into the shared busy state here — consecutive clicks
  // keep working while a sync is in flight.
  const handleMove = (item: QueueItem, direction: -1 | 1) => {
    const order = queuedList.map((queued) => queued.id);
    const index = order.indexOf(item.id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= order.length) return;
    const next = [...order];
    const moved = next[index]!;
    const displaced = next[target]!;
    next[index] = displaced;
    next[target] = moved;
    const state = reorderSyncRef.current;
    if (!state.active) {
      state.snapshot = snapshotQueueCache();
      state.active = true;
    }
    applyOrderToCache(next);
    void runReorderSync(next);
  };

  const handleFilterChange = React.useCallback(
    (next: QueueFilter) => {
      setFilter(next);
      pushPageParam(1);
    },
    [pushPageParam]
  );

  const queuedCount = counts?.queuedCount ?? 0;
  const publishedCount = counts?.publishedCount ?? 0;
  const failedCount = counts?.failedCount ?? 0;
  const cancelledCount = counts?.cancelledCount ?? 0;
  const skippedCount = counts?.skippedCount ?? 0;
  const allCount =
    filter === 'all'
      ? total
      : queuedCount + publishedCount + failedCount + cancelledCount + skippedCount;
  const filterCounts: Record<QueueFilter, number> = {
    all: allCount,
    queued: queuedCount,
    failed: failedCount,
    published: publishedCount,
  };

  const queuedOrder = React.useMemo(
    () => queuedList.map((queued) => queued.id),
    [queuedList]
  );

  return (
    <div data-testid="queue-panel" className="flex flex-col gap-4">
      <div>
        <h2 className="m-0 text-lg font-bold text-ink">Queue</h2>
        <p className="m-0 mt-1 text-body text-ink-sub">
          Posts waiting to go out, in the order they will publish.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter queue by status">
        {FILTERS.map((chip) => (
          <Button
            key={chip.id}
            type="button"
            size="sm"
            variant={filter === chip.id ? 'default' : 'outline'}
            data-testid={`queue-filter-${chip.id}`}
            onClick={() => handleFilterChange(chip.id)}
          >
            {chip.label} ({filterCounts[chip.id]})
          </Button>
        ))}
      </div>

      {displayQuery.isPending ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading queue...</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : displayQuery.isError ? (
        <div
          data-testid="queue-error-state"
          className="flex flex-col items-center gap-4 rounded-md border border-signal-critical/40 bg-panel px-6 py-12 text-center"
        >
          <p className="m-0 text-body text-ink-sub">Couldn't load the queue.</p>
          <Button type="button" onClick={() => void displayQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div
          data-testid="queue-empty-state"
          className="flex flex-col items-center gap-4 rounded-md border border-line bg-panel px-6 py-12 text-center"
        >
          <p className="m-0 text-body text-ink-sub">
            {filter === 'all'
              ? 'No posts in your queue yet.'
              : `No ${filter} posts.`}
          </p>
          {filter === 'all' ? (
            <Button type="button" data-testid="queue-create-post-btn" onClick={onCreatePost}>
              Create a post
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((item) => {
              const isQueued = item.status === 'queued';
              const orderIndex = queuedOrder.indexOf(item.id);
              const unmatched =
                isQueued &&
                !slots.some(
                  (slot) =>
                    slot.isActive &&
                    slotMatchesFormat(item.postFormat, slot.allowedFormats ?? null)
                );
              return (
                <QueueRow
                  key={item.id}
                  item={item}
                  position={isQueued && orderIndex >= 0 ? orderIndex + 1 : null}
                  estimate={isQueued ? (estimates.get(item.id) ?? null) : null}
                  unmatched={unmatched}
                  pageTimezone={pageTimezone}
                  busy={busy?.itemId === item.id}
                  canMoveUp={
                    isQueued && !orderTruncated && orderIndex > 0
                  }
                  canMoveDown={
                    isQueued && !orderTruncated && orderIndex >= 0 && orderIndex < queuedOrder.length - 1
                  }
                  onMoveUp={() => void handleMove(item, -1)}
                  onMoveDown={() => void handleMove(item, 1)}
                  onEdit={() => setItemToEdit(item)}
                  onDelete={() => setItemToDelete(item)}
                  onPublishNow={() =>
                    void runMutation('publish-now', item.id, () =>
                      publishNowMutation.mutateAsync(item.id)
                    )
                  }
                  onRetry={() =>
                    void runMutation('retry', item.id, () =>
                      retryMutation.mutateAsync(item.id)
                    )
                  }
                />
              );
            })}
          </ul>
          {orderTruncated ? (
            <p className="m-0 text-metadata text-ink-sub">
              Reorder is unavailable while more than 100 posts are queued.
            </p>
          ) : null}
          <ListPagination
            page={page}
            totalPages={totalPages}
            total={total}
            limit={PAGE_LIMIT}
            onPageChange={pushPageParam}
          />
        </>
      )}

      <QueueEditDialog
        item={itemToEdit}
        isSaving={busy?.action === 'edit' && busy.itemId === itemToEdit?.id}
        onClose={() => setItemToEdit(null)}
        onSave={handleSaveEdit}
      />
      <QueueDeleteConfirm
        item={itemToDelete}
        isDeleting={busy?.action === 'delete' && busy.itemId === itemToDelete?.id}
        onClose={() => setItemToDelete(null)}
        onConfirmDelete={async () => {
          if (itemToDelete) await handleDelete(itemToDelete);
        }}
      />
    </div>
  );
}
