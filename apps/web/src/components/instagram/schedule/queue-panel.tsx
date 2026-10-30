'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import { z } from 'zod';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  VideoIcon,
} from 'lucide-react';
import { IDEMPOTENCY_KEY_HEADER } from '@fbuploadpro/contracts';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { getErrorMessage } from '@/lib/api/errors';
import {
  ListInstagramScheduleQueueResponseSchema,
  type InstagramScheduleQueueItem,
} from '@/lib/api/schemas/instagram-schedule';
import { QueueItemSchema } from '@/lib/api/schemas/queue';
import { ReorderQueueItemsResponseSchema } from '@fbuploadpro/contracts';
import { queryKeys } from '@/lib/data/query-keys';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { Textarea } from '@/components/shared/ui/textarea';
import { toast } from '@/components/shared/ui/toast';

/**
 * Instagram Schedule queue panel — the Pages queue panel's actions
 * for Instagram: edit caption, delete, publish now (queued only),
 * retry (failed only), and move up/down reorder over the full
 * queued set. Reorder is disabled with a plain note when more than
 * 50 posts are queued, because the reorder route requires the full
 * queued set in one call and the list page is 50 rows.
 *
 * Published rows refuse edit/delete in the UI (the server refuses
 * regardless). When the destination is not active, publish-now and
 * retry are disabled with a plain reason; the server remains the
 * final gate.
 */

const AckSchema = z.object({}).passthrough();

type QueueStatusFilter =
  | 'all'
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

const STATUS_OPTIONS: Array<{ value: QueueStatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'publishing', label: 'Publishing' },
  { value: 'published', label: 'Published' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function typeLabel(item: InstagramScheduleQueueItem): string {
  if (item.displayFormat === 'carousel') return 'Carousel';
  if (item.displayFormat === 'reel') return 'Reel';
  return 'Photo';
}

function formatScheduledTime(
  scheduledTime: string | null,
  timezone: string
): string {
  if (!scheduledTime) return 'Next posting time';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(scheduledTime));
  } catch {
    return new Date(scheduledTime).toLocaleString();
  }
}

function statusMarkFor(status: string) {
  switch (status) {
    case 'published':
      return { kind: 'operational' as const, label: 'Published' };
    case 'queued':
      return { kind: 'queued' as const, label: 'Queued' };
    case 'publishing':
      return { kind: 'queued' as const, label: 'Publishing' };
    case 'failed':
      return { kind: 'critical' as const, label: 'Failed' };
    case 'cancelled':
      return { kind: 'idle' as const, label: 'Cancelled' };
    default:
      return { kind: 'idle' as const, label: status };
  }
}

export function QueuePanel({
  subdomain,
  destinationId,
  timezone,
  detailStatus,
  onCreatePost,
}: Readonly<{
  subdomain: string;
  destinationId: string;
  timezone: string;
  detailStatus: string;
  onCreatePost: () => void;
}>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<QueueStatusFilter>('all');
  const [editItem, setEditItem] = React.useState<InstagramScheduleQueueItem | null>(null);
  const [editCaption, setEditCaption] = React.useState('');
  const [deleteItem, setDeleteItem] = React.useState<InstagramScheduleQueueItem | null>(null);

  const queuePath = buildTenantApiPath(
    subdomain,
    `/instagram/schedule/${destinationId}/queue`
  );
  const queueQuery = useQuery({
    queryKey: tenant.instagramSchedule.queue(destinationId, {
      page: String(page),
      status: statusFilter,
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(queuePath, {
          page,
          limit: DEFAULT_PAGE_SIZE,
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        }),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });

  const queuedIdsQuery = useQuery({
    queryKey: tenant.instagramSchedule.queue(destinationId, {
      page: '1',
      status: 'queued',
      ids: 'all',
    }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(queuePath, { page: 1, limit: 50, status: 'queued' }),
        { schema: ListInstagramScheduleQueueResponseSchema, signal }
      ),
  });

  // The queue key factory includes the params object, so invalidation
  // must match every queue key for this destination, not one param set.
  const invalidateAllQueue = React.useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey.includes('instagram') &&
        query.queryKey.includes('schedule') &&
        query.queryKey.includes(destinationId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenant.instagramSchedule.detail(destinationId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenant.instagramSchedule.list,
    });
  }, [queryClient, destinationId, tenant.instagramSchedule]);

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`), {
        schema: AckSchema,
      }),
    onSuccess: () => {
      invalidateAllQueue();
      toast.success('Post deleted.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't delete the post. Please try again."));
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ itemId, caption }: { itemId: string; caption: string }) =>
      api.patch(
        buildTenantApiPath(subdomain, `/publishing/queue/${itemId}`),
        { caption },
        { schema: QueueItemSchema }
      ),
    onSuccess: () => {
      invalidateAllQueue();
      setEditItem(null);
      toast.success('Caption updated.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't update the caption. Please try again."));
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
      invalidateAllQueue();
      toast.success('Publishing triggered successfully.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, 'Publication trigger failed'));
    },
  });

  const retryMutation = useMutation({
    mutationFn: (itemId: string) =>
      api.post(
        buildTenantApiPath(
          subdomain,
          `/destinations/${destinationId}/queue/${itemId}/retry`
        ),
        undefined,
        {
          schema: AckSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
        }
      ),
    onSuccess: () => {
      invalidateAllQueue();
      toast.success('Post queued again.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't retry the post. Please try again."));
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      api.post(
        buildTenantApiPath(subdomain, '/publishing/queue/reorder'),
        { pageId: destinationId, itemIds },
        { schema: ReorderQueueItemsResponseSchema }
      ),
    onSuccess: () => {
      invalidateAllQueue();
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't reorder the queue. Please try again."));
    },
  });

  const items = queueQuery.data?.items ?? [];
  const total = queueQuery.data?.total ?? 0;
  const queuedIds = queuedIdsQuery.data?.items.map((item) => item.id) ?? [];
  const queuedTotal = queuedIdsQuery.data?.total ?? 0;
  const reorderAvailable = queuedTotal <= 50;
  const publishBlocked =
    detailStatus !== 'active'
      ? detailStatus === 'paused'
        ? 'This account is paused. Resume it to publish.'
        : 'This account needs to be reconnected before publishing.'
      : null;

  const moveItem = React.useCallback(
    (itemId: string, direction: -1 | 1) => {
      const index = queuedIds.indexOf(itemId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= queuedIds.length) return;
      const next = [...queuedIds];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(target, 0, moved);
      reorderMutation.mutate(next);
    },
    [queuedIds, reorderMutation]
  );

  const busy =
    deleteMutation.isPending ||
    editMutation.isPending ||
    publishNowMutation.isPending ||
    retryMutation.isPending ||
    reorderMutation.isPending;

  return (
    <div data-testid="instagram-schedule-queue-panel">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value as QueueStatusFilter);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Filter by status" className="w-45">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" onClick={onCreatePost}>
          Create post
        </Button>
        {!reorderAvailable && (
          <p className="m-0 text-body text-ink-sub">
            Reordering is available when there are 50 or fewer queued posts.
          </p>
        )}
      </div>

      {queueQuery.isPending && <p className="text-body text-ink-sub">Loading queue…</p>}
      {queueQuery.isError && (
        <EmptyState
          type="not-found"
          title="Couldn't load the queue"
          description="Please try again."
          action={
            <Button type="button" onClick={() => void queueQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {!queueQuery.isPending && !queueQuery.isError && items.length === 0 && (
        <EmptyState
          type="no-results"
          title="No posts in the queue yet"
          description="Create a post for this account and it will appear here."
          action={
            <Button type="button" onClick={onCreatePost}>
              Create post
            </Button>
          }
        />
      )}

      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const mark = statusMarkFor(item.status);
          const position =
            item.status === 'queued' ? queuedIds.indexOf(item.id) + 1 : null;
          const canMoveUp =
            item.status === 'queued' &&
            reorderAvailable &&
            position !== null &&
            position > 1;
          const canMoveDown =
            item.status === 'queued' &&
            reorderAvailable &&
            position !== null &&
            position < queuedIds.length;
          return (
            <article
              key={item.id}
              data-testid={`instagram-schedule-queue-row-${item.id}`}
              className="flex flex-wrap items-start gap-4 rounded-md border border-line bg-panel px-4 py-3"
            >
              <div className="flex shrink-0 flex-col items-center gap-1">
                {position !== null && (
                  <span className="text-metadata font-semibold text-ink-sub">
                    {position}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Move up"
                  disabled={!canMoveUp || busy}
                  onClick={() => moveItem(item.id, -1)}
                >
                  <ChevronUpIcon aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Move down"
                  disabled={!canMoveDown || busy}
                  onClick={() => moveItem(item.id, 1)}
                >
                  <ChevronDownIcon aria-hidden />
                </Button>
              </div>
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-subtle">
                {item.media?.thumbnailUrl || item.media?.url ? (
                  <Image
                    src={item.media.thumbnailUrl ?? item.media.url}
                    alt=""
                    width={64}
                    height={64}
                    className="size-16 object-cover"
                  />
                ) : item.displayFormat === 'reel' ? (
                  <VideoIcon aria-hidden className="size-6 text-ink-sub" />
                ) : (
                  <ImageIcon aria-hidden className="size-6 text-ink-sub" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-metadata font-semibold text-ink-sub">
                  {typeLabel(item)} · {formatScheduledTime(item.scheduledTime, timezone)}
                </p>
                <p className="mt-1 mb-0 line-clamp-2 text-body text-ink">
                  {item.caption || 'No caption'}
                </p>
                {item.firstComment && (
                  <p className="mt-1 mb-0 truncate text-body text-ink-sub">
                    First comment: {item.firstComment}
                  </p>
                )}
                <div className="mt-2">
                  <StatusMark
                    kind={mark.kind}
                    label={mark.label}
                    testId={`instagram-schedule-queue-status-${item.id}`}
                  />
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {item.status !== 'published' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditItem(item);
                      setEditCaption(item.caption);
                    }}
                  >
                    Edit
                  </Button>
                )}
                {item.status !== 'published' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDeleteItem(item)}
                  >
                    Delete
                  </Button>
                )}
                {item.status === 'queued' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(publishBlocked)}
                    title={publishBlocked ?? undefined}
                    onClick={() => publishNowMutation.mutate(item.id)}
                  >
                    Publish now
                  </Button>
                )}
                {item.status === 'failed' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || Boolean(publishBlocked)}
                    title={publishBlocked ?? undefined}
                    onClick={() => retryMutation.mutate(item.id)}
                  >
                    Retry
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {total > 0 && (
        <ListPagination
          page={page}
          totalPages={Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE))}
          total={total}
          limit={DEFAULT_PAGE_SIZE}
          onPageChange={setPage}
        />
      )}

      <Dialog
        open={editItem !== null}
        onOpenChange={(next) => {
          if (!next) setEditItem(null);
        }}
      >
        <DialogContent data-testid="instagram-schedule-edit-dialog">
          <DialogHeader>
            <DialogTitle>Edit caption</DialogTitle>
          </DialogHeader>
          <Textarea
            data-testid="instagram-schedule-edit-caption-input"
            value={editCaption}
            maxLength={2200}
            onChange={(event) => setEditCaption(event.target.value)}
            rows={4}
          />
          <p className="m-0 text-metadata text-ink-sub">
            {editCaption.length} / 2200 characters
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditItem(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={editMutation.isPending || !editItem}
              onClick={() => {
                if (editItem) {
                  editMutation.mutate({ itemId: editItem.id, caption: editCaption });
                }
              }}
            >
              Save caption
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteItem !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteItem(null);
        }}
      >
        <AlertDialogContent data-testid="instagram-schedule-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This post will be removed from the queue. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteItem) deleteMutation.mutate(deleteItem.id);
                setDeleteItem(null);
              }}
            >
              Delete post
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
