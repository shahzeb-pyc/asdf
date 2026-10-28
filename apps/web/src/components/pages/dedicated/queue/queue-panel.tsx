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
 *   (queued rows only), publish now (queued rows, fresh idempotency
 *   key per tap), retry (failed rows, fresh idempotency key per tap).
 *   Published rows refuse edit/delete in the UI (server 400s
 *   regardless). Every mutation invalidates the whole queue cache,
 *   so the shell summary and dashboard stay in sync.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

  const reorderMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      api.post(buildTenantApiPath(subdomain, '/publishing/queue/reorder'), { pageId, itemIds }, {
        schema: ReorderQueueItemsResponseSchema,
      }),
    onSuccess: () => {
      invalidateQueue();
      toast.success('Queue order updated.');
    },
    onError: (error) => {
      toast.error(errorMessage(error, "Couldn't reorder the queue. Please try again."));
    },
  });

  const runMutation = React.useCallback(
    async (action: string, itemId: string, fn: () => Promise<unknown>) => {
      setBusy({ action, itemId });
      try {
        await fn();
      } catch (_e) {
        // The mutation's onError already toasted; nothing else to do.
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

  const handleMove = React.useCallback(
    async (item: QueueItem, direction: -1 | 1) => {
      const order = queuedList.map((queued) => queued.id);
      const index = order.indexOf(item.id);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= order.length) return;
      const next = [...order];
      const moved = next[index]!;
      const displaced = next[target]!;
      next[index] = displaced;
      next[target] = moved;
      await runMutation('reorder', item.id, () => reorderMutation.mutateAsync(next));
    },
    [runMutation, reorderMutation, queuedList]
  );

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
          className="flex flex-col items-center gap-4 rounded-md border border-brand-rose/40 bg-panel px-6 py-12 text-center"
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
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
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
