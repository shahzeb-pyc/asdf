'use client';

import * as React from 'react';
import Image from 'next/image';
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, ImageIcon, PlayIcon, TypeIcon } from 'lucide-react';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { StatusDot, type Status } from '@/components/shared/ui/status-dot';
import { cn } from '@/lib/utils';
import { formatLabel } from '../bulk/bulk-utils';
import { formatQueueRowTime, resolveFormat } from './queue-logic';
import type { DedicatedQueueItem } from './queue-types';

export type QueueRowBucket = 'queued' | 'scheduled' | 'published' | 'failed';

export interface QueueRowProps {
  item: DedicatedQueueItem;
  timeZone: string;
  bucket: QueueRowBucket;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  reorderable: boolean;
  isDragOver: boolean;
  onDragStart: (id: string) => void;
  onDragOverRow: (id: string) => void;
  onDropOnRow: (id: string) => void;
  onDragEnd: () => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReschedule: (item: DedicatedQueueItem) => void;
  onDelete: (item: DedicatedQueueItem) => void;
  onRetry: (item: DedicatedQueueItem) => void;
  retryBlocked: boolean;
  /** Why retry is blocked, stated under the button (spec 134 §3.5's
   *  platform-named shape). Defaults to the Facebook wording this row
   *  shipped with; the unified destination panel passes its platform's. */
  retryBlockedReason?: string;
  failedReason: string | null;
  busyAction: 'retry' | 'delete' | null;
  /** Position within the reorderable list (0-based) — drives edge states. */
  reorderIndex?: number;
  reorderCount?: number;
  /** Keyboard-reorder announcement sink (position + new time, §3.1.1). */
  onAnnounce?: (message: string) => void;
  destinationName?: string;
}

const STATUS_BY_BUCKET: Record<QueueRowBucket, { status: Status; label: string }> = {
  queued: { status: 'queued', label: 'Queued' },
  scheduled: { status: 'queued', label: 'Scheduled' },
  published: { status: 'operational', label: 'Published' },
  failed: { status: 'critical', label: 'Failed' },
};

function Thumbnail({ item }: Readonly<{ item: DedicatedQueueItem }>) {
  const format = resolveFormat(item);
  const thumbnailUrl = item.media?.thumbnailUrl ?? item.media?.url ?? null;
  const classes =
    'flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-subtle text-ink-sub';

  if (format === 'text') {
    return (
      <div className={classes} aria-hidden="true">
        <TypeIcon className="size-6" />
      </div>
    );
  }
  if (thumbnailUrl) {
    return (
      <div className={classes}>
        <Image
          src={thumbnailUrl}
          alt=""
          width={56}
          height={56}
          sizes="56px"
          className="size-full object-cover"
        />
      </div>
    );
  }
  return (
    <div className={classes} aria-hidden="true">
      {item.media?.mediaType === 'video' ? (
        <PlayIcon className="size-6" />
      ) : (
        <ImageIcon className="size-6" />
      )}
    </div>
  );
}

/**
 * One queue row (spec 134 §3.1, rebuilt clean-room on shared/ui):
 * identifier first (thumbnail + caption), format badge, publish time with
 * its timezone label, status as colour + icon + text, and always-visible
 * text actions. Reorder ships with all its twins (UI Rule 21): drag
 * handle, Move up/down (disabled-with-reason at the edges), keyboard
 * reorder on the handle (Space lifts/drops, arrows move — the panel
 * announces the new position and time), and Reschedule in the panel.
 */
export function QueueRow({
  item,
  timeZone,
  bucket,
  selectable,
  selected,
  onToggleSelect,
  reorderable,
  isDragOver,
  onDragStart,
  onDragOverRow,
  onDropOnRow,
  onDragEnd,
  onMove,
  onReschedule,
  onDelete,
  onRetry,
  retryBlocked,
  retryBlockedReason = 'Reconnect your Facebook account to retry.',
  failedReason,
  busyAction,
  reorderIndex,
  reorderCount,
  onAnnounce,
  destinationName,
}: Readonly<QueueRowProps>) {
  const format = resolveFormat(item);
  const caption = (item.caption ?? '').trim();
  const actionsDisabled = busyAction !== null;
  const [lifted, setLifted] = React.useState(false);

  const isFirst = reorderIndex !== undefined && reorderIndex <= 0;
  const isLast =
    reorderIndex !== undefined && reorderCount !== undefined && reorderIndex >= reorderCount - 1;
  const timeText = formatQueueRowTime(item, bucket, timeZone);
  const statusMeta = STATUS_BY_BUCKET[bucket];
  const statusLabel = item.status === 'publishing' ? 'Publishing' : statusMeta.label;
  const context = destinationName ?? 'this page';

  const handleHandleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (lifted) {
        setLifted(false);
        onAnnounce?.(
          `Dropped. Post is at position ${(reorderIndex ?? 0) + 1} of ${reorderCount ?? 0}, due ${timeText}.`
        );
      } else {
        setLifted(true);
        onAnnounce?.(
          `Lifted. Post is at position ${(reorderIndex ?? 0) + 1} of ${reorderCount ?? 0}, due ${timeText}. Use the arrow keys to move it, then press Space to drop it.`
        );
      }
      return;
    }
    if (!lifted) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMove(item.id, event.key === 'ArrowUp' ? -1 : 1);
    }
    if (event.key === 'Escape') {
      setLifted(false);
    }
  };

  return (
    <li
      data-testid={`queue-row-${item.id}`}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverRow(item.id);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropOnRow(item.id);
      }}
      className={cn(
        'flex list-none items-start gap-2 border-b border-line py-4',
        isDragOver && 'border-t-2 border-t-primary bg-hover',
        lifted && 'bg-active'
      )}
    >
      {selectable && (
        <span className="shrink-0 pt-0.5">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(item.id)}
            aria-label={caption ? `Select post: ${caption.slice(0, 40)}` : 'Select post'}
          />
        </span>
      )}

      {reorderable && (
        <span className="flex shrink-0 flex-col items-center">
          <button
            type="button"
            draggable
            data-testid={`queue-drag-handle-${item.id}`}
            aria-label={`Reorder post for ${context}, due ${timeText}. Press Space to lift, arrow keys to move, Space to drop.`}
            aria-pressed={lifted}
            title="Drag to reorder"
            onDragStart={(event) => {
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
              onDragStart(item.id);
            }}
            onDragEnd={onDragEnd}
            onKeyDown={handleHandleKeyDown}
            className="inline-flex size-11 cursor-grab items-center justify-center rounded-sm text-ink-sub outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
          >
            <GripVerticalIcon className="size-5" aria-hidden />
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move up post for ${context}, due ${timeText}`}
            {...(isFirst
              ? { disabledReason: 'This post is already at the top of the queue.' }
              : {})}
            disabled={actionsDisabled && !isFirst}
            onClick={() => onMove(item.id, -1)}
          >
            <ChevronUpIcon aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move down post for ${context}, due ${timeText}`}
            {...(isLast
              ? { disabledReason: 'This post is already at the end of the queue.' }
              : {})}
            disabled={actionsDisabled && !isLast}
            onClick={() => onMove(item.id, 1)}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </span>
      )}

      <Thumbnail item={item} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-metadata font-semibold tracking-wide text-ink-sub uppercase">
            {formatLabel(format)}
          </span>
          <span className="text-body font-medium text-ink">{timeText}</span>
        </div>

        {caption && <p className="mt-1 line-clamp-2 text-body text-ink">{caption}</p>}

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusDot status={statusMeta.status} label={statusLabel} />
          {failedReason && <span className="text-metadata text-ink-sub">— {failedReason}</span>}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {bucket === 'failed' && (
            <span className="inline-flex flex-col gap-0.5">
              <Button
                variant="link"
                size="sm"
                {...(retryBlocked ? { disabledReason: retryBlockedReason } : {})}
                disabled={actionsDisabled && !retryBlocked}
                loading={busyAction === 'retry'}
                aria-label={`Retry post for ${context}, due ${timeText}`}
                onClick={() => onRetry(item)}
              >
                Retry
              </Button>
              {retryBlocked && (
                <span className="text-metadata text-ink-sub">{retryBlockedReason}</span>
              )}
            </span>
          )}
          {(bucket === 'queued' || bucket === 'scheduled') && (
            <Button
              variant="link"
              size="sm"
              disabled={actionsDisabled}
              aria-label={`Reschedule post for ${context}, due ${timeText}`}
              onClick={() => onReschedule(item)}
            >
              Reschedule
            </Button>
          )}
          <Button
            variant="link"
            size="sm"
            disabled={actionsDisabled}
            loading={busyAction === 'delete'}
            aria-label={`Delete post for ${context}, due ${timeText}`}
            onClick={() => onDelete(item)}
          >
            Delete
          </Button>
        </div>
      </div>
    </li>
  );
}
