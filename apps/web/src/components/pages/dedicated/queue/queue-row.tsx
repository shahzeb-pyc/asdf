'use client';

/**
 * One queued-post row in the Queue section: flat row with a divider
 * (no card per row — the list carries divide-y), a small type pill
 * next to the caption, status + time meta with no repeated type, and
 * a single action hierarchy. Media posts keep their REAL thumbnail;
 * text posts get no thumbnail box at all — the pill carries the type.
 * Published rows refuse edit/delete in the UI (the server 400s
 * regardless); move + publish-now exist on queued rows only, retry on
 * failed rows only. Edit/Delete live in the row menu as disabled
 * items on published rows, never removed.
 */
import * as React from 'react';
import Image from 'next/image';
import { ChevronDownIcon, ChevronUpIcon, MoreVerticalIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/shared/ui/menu';
import type { QueueItem } from '@/lib/api/schemas/queue';
import {
  formatQueuePostType,
  formatQueueStatus,
  formatQueueTime,
} from './queue-utils';

/** Exact inline flag copy for posts no active posting time covers. */
export const UNMATCHED_NOTE =
  'No posting time matches this post type yet — add one and it will get an estimate';

export interface QueueRowProps {
  item: QueueItem;
  /** Derived estimate for queued rows; null = no estimate computed. */
  estimate: Date | null;
  /** Queued row whose format no active posting time covers. */
  unmatched: boolean;
  pageTimezone: string;
  /** True while any mutation for this row is in flight. */
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPublishNow: () => void;
  onRetry: () => void;
}

export function QueueRow({
  item,
  estimate,
  unmatched,
  pageTimezone,
  busy,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
  onPublishNow,
  onRetry,
}: Readonly<QueueRowProps>) {
  const isPublished = item.status === 'published';
  const isQueued = item.status === 'queued';
  const isFailed = item.status === 'failed';
  const thumbnailUrl = item.media?.thumbnailUrl ?? null;
  const typeLabel = formatQueuePostType(item.postFormat);

  let timeMeta: string | null = null;
  if (isQueued && estimate) {
    timeMeta = `Est. ${formatQueueTime(estimate.toISOString(), pageTimezone) ?? ''}`;
  } else if (item.status === 'published' && item.publishedAt) {
    timeMeta = `Published ${formatQueueTime(item.publishedAt, pageTimezone) ?? ''}`;
  } else if (isFailed) {
    timeMeta = `Retry ${item.retryCount} of ${item.maxRetries}`;
  }

  return (
    <li data-testid={`queue-row-${item.id}`} className="flex gap-3 py-3">
      {thumbnailUrl ? (
        <Image
          src={thumbnailUrl}
          alt={item.media?.name ?? ''}
          width={96}
          height={96}
          className="size-14 shrink-0 rounded-md object-cover"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className="inline-flex shrink-0 items-center rounded-full border border-line bg-subtle px-2 py-0.5 text-metadata text-ink-dim">
            {typeLabel}
          </span>
          {item.caption ? (
            <p className="m-0 min-w-0 flex-1 line-clamp-2 text-body text-ink">
              {item.caption}
            </p>
          ) : null}
        </div>
        <p className="m-0 mt-1 text-metadata text-ink-sub">
          <span className={isFailed ? 'text-brand-rose' : undefined}>
            {formatQueueStatus(item.status)}
          </span>
          {timeMeta ? ` · ${timeMeta}` : ''}
        </p>
        {isQueued && unmatched ? (
          <p className="m-0 mt-1 text-metadata text-brand-gold">{UNMATCHED_NOTE}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {isQueued ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="queue-row-move-up"
                aria-label="Move up"
                disabled={busy || !canMoveUp}
                onClick={onMoveUp}
              >
                <ChevronUpIcon aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="queue-row-move-down"
                aria-label="Move down"
                disabled={busy || !canMoveDown}
                onClick={onMoveDown}
              >
                <ChevronDownIcon aria-hidden />
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                data-testid="queue-row-publish-now"
                disabled={busy}
                onClick={onPublishNow}
              >
                Publish now
              </Button>
            </>
          ) : null}
          {isFailed ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="queue-row-retry"
              disabled={busy}
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="queue-row-menu"
                aria-label="Row actions"
                disabled={busy}
              >
                <MoreVerticalIcon aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                data-testid="queue-row-edit"
                disabled={busy || isPublished}
                onSelect={() => onEdit()}
              >
                Edit
              </MenuItem>
              <MenuItem
                data-testid="queue-row-delete"
                variant="destructive"
                disabled={busy || isPublished}
                onSelect={() => onDelete()}
              >
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
    </li>
  );
}
