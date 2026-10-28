'use client';

/**
 * One queued-post row in the Queue section: content first, so the row
 * reads as a POST, not an admin list item. The caption is the post
 * body at normal body size (clamped to a few lines so one row cannot
 * blow up the list); image/video posts show a proper attachment
 * preview below the caption — natural aspect ratio, never cropped,
 * height capped (reels keep their vertical shape within the cap).
 * Text posts get no preview box at all — the caption IS the row.
 * Status + time are one small secondary line, with the type pill
 * small and muted beside it (never competing with the caption).
 * Actions stay compact and secondary: small Publish now / Retry,
 * small reorder icon buttons, Edit/Delete in the row menu.
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

/**
 * next/image dimensions from the stored ratio ("16:9", "9:16",
 * "1:1", "4:5", or a raw "W:H" / "unknown"). The CSS below caps the
 * rendered height and lets the width follow, so the ratio — not the
 * absolute numbers — is what matters; "unknown" falls back to 4:3.
 */
function ratioDimensions(aspectRatio: string): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/.exec(aspectRatio.trim());
  if (match) {
    const width = Number.parseInt(match[1]!, 10);
    const height = Number.parseInt(match[2]!, 10);
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: 1200, height: 900 };
}

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
  const media = item.media ?? null;
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
    <li data-testid={`queue-row-${item.id}`} className="py-4">
      {/* The post itself: caption as body text, then the attachment. */}
      {item.caption ? (
        <p className="m-0 text-body text-ink line-clamp-4">{item.caption}</p>
      ) : null}
      {media?.mediaType === 'image' ? (
        <div data-testid="queue-row-media-preview" className="mt-3">
          {/* Ratio from the stored aspect ratio; the height cap + auto
              width keep the natural shape, never cropped. */}
          <Image
            src={media.url}
            alt={media.name}
            {...ratioDimensions(media.aspectRatio)}
            className="h-auto max-h-80 w-auto max-w-full rounded-lg object-contain"
          />
        </div>
      ) : null}
      {media?.mediaType === 'video' ? (
        <div data-testid="queue-row-media-preview" className="mt-3">
          <video
            src={media.url}
            poster={media.thumbnailUrl ?? undefined}
            controls
            preload="metadata"
            className="max-h-80 w-auto max-w-full rounded-lg object-contain"
          />
        </div>
      ) : null}
      {/* Quiet meta: small muted pill + status + time, nothing more. */}
      <p className="m-0 mt-2 flex flex-wrap items-center gap-2 text-metadata text-ink-sub">
        <span className="inline-flex shrink-0 items-center rounded-full border border-line bg-subtle px-2 py-0.5 text-metadata text-ink-sub">
          {typeLabel}
        </span>
        <span className={isFailed ? 'text-brand-rose' : undefined}>
          {formatQueueStatus(item.status)}
        </span>
        {timeMeta ? <span>{`· ${timeMeta}`}</span> : null}
      </p>
      {isQueued && unmatched ? (
        <p className="m-0 mt-1 text-metadata text-brand-gold">{UNMATCHED_NOTE}</p>
      ) : null}
      {/* Compact, secondary actions — the post above is the row. */}
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
    </li>
  );
}
