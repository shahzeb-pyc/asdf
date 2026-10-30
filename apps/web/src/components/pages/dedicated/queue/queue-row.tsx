'use client';

/**
 * One queued-post row in the Queue section, shaped like the old
 * inapp-schedule list view: a structured, bordered card, dense and
 * informative — not a sparse flat line. Left to right: the queue
 * position number with small up/down buttons (queued rows only; the
 * old drag grip is deliberately NOT revived — buttons are the
 * mobile-safe reorder mechanism), a thumbnail slot (real media
 * thumbnail for media posts, a type icon in the same slot for text
 * posts, never a placeholder box), the middle (type tag, caption at
 * readable size truncated to two lines, the unmatched-posts inline
 * flag where it applies), a gold-tinted estimate pill, and visible
 * action buttons on the right.
 *
 * Adapted, not copied, from the old model:
 * - The pill shows the DERIVED estimate ("Est. …"), never a stored
 *   scheduled time — publisher-driven posts carry no time per post.
 * - No first-comment line (the new model has no first comment).
 * - No 5-minute edit lock (no scheduled_at lock concept here).
 * - No bulk-batch chip, no calendar view.
 * Published rows refuse edit/delete in the UI (the server 400s
 * regardless); move + publish-now exist on queued rows only, retry
 * on failed rows only. Cancelled rows keep their current treatment:
 * no position, no pill, no primary button — Edit/Delete as usual.
 */
import * as React from 'react';
import Image from 'next/image';
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  TypeIcon,
  VideoIcon,
} from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Tag } from '@/components/shared/ui/tag';
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
  /** 1-based position in true queue order; null = no queue position. */
  position: number | null;
  /** Derived estimate for queued rows; null = no estimate computed. */
  estimate: Date | null;
  /** Queued row whose format no active posting time covers. */
  unmatched: boolean;
  pageTimezone: string;
  /**
   * Status-family gate: when non-null, Publish Now and Retry are
   * disabled with this plain reason (title + aria-label) — the
   * server gate enforces the same rule. Null = page is active.
   */
  publishBlockedReason?: string | null;
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
  position,
  estimate,
  unmatched,
  pageTimezone,
  publishBlockedReason = null,
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

  // Thumbnail slot: real thumbnail for media posts (image falls back
  // to its own URL; video without a thumbnail gets the video icon),
  // a type icon in the same slot for text posts.
  const thumbnailSrc =
    media?.mediaType === 'image'
      ? (media.thumbnailUrl ?? media.url)
      : (media?.thumbnailUrl ?? null);
  const showThumbnailImage = thumbnailSrc !== null;

  // The pill: derived estimate for queued rows, published time for
  // published rows. Nothing for failed/cancelled/publishing rows —
  // their state lives in the middle line instead.
  let pillText: string | null = null;
  if (isQueued && estimate) {
    pillText = `Est. ${formatQueueTime(estimate.toISOString(), pageTimezone) ?? ''}`;
  } else if (isPublished && item.publishedAt) {
    pillText = `Published ${formatQueueTime(item.publishedAt, pageTimezone) ?? ''}`;
  }

  return (
    <li
      data-testid={`queue-row-${item.id}`}
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 md:flex-row md:flex-wrap md:items-center"
    >
      {/* Order controls: position number + up/down buttons, queued only. */}
      {isQueued ? (
        <div className="flex shrink-0 items-center gap-2">
          {position !== null ? (
            <span
              data-testid="queue-row-position"
              className="rounded bg-subtle px-2 py-0.5 font-mono text-xs font-semibold text-ink-sub"
            >
              {`#${position}`}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
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
            size="icon-sm"
            data-testid="queue-row-move-down"
            aria-label="Move down"
            disabled={busy || !canMoveDown}
            onClick={onMoveDown}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
        </div>
      ) : null}

      {/* Thumbnail slot: real thumbnail, or the type icon for text. */}
      <div
        data-testid="queue-row-thumbnail"
        className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-subtle"
      >
        {showThumbnailImage ? (
          <Image
            src={thumbnailSrc}
            alt={media?.name ?? 'Post media'}
            fill
            className="object-cover"
          />
        ) : (
          <span className="text-ink-sub">
            {media?.mediaType === 'video' ? (
              <VideoIcon aria-hidden className="size-5" />
            ) : media?.mediaType === 'image' ? (
              <ImageIcon aria-hidden className="size-5" />
            ) : (
              <TypeIcon aria-hidden className="size-5" />
            )}
          </span>
        )}
      </div>

      {/* Middle: type tag, caption, status, unmatched flag. */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Tag variant="outline">{typeLabel}</Tag>
          <span className={isFailed ? 'text-signal-critical' : 'text-ink-sub'}>
            {formatQueueStatus(item.status)}
          </span>
          {isFailed ? (
            <span className="text-ink-sub">{`· Retry ${item.retryCount} of ${item.maxRetries}`}</span>
          ) : null}
        </div>
        <p className="m-0 line-clamp-2 text-body text-ink">
          {item.caption ? (
            item.caption
          ) : (
            <span className="italic text-ink-sub">No caption</span>
          )}
        </p>
        {isQueued && unmatched ? (
          <p className="m-0 text-metadata text-link">{UNMATCHED_NOTE}</p>
        ) : null}
      </div>

      {/* Estimate pill, gold-tinted like the old scheduled-time pill. */}
      {pillText ? (
        <span
          data-testid="queue-row-estimate"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-link/20 bg-link/10 px-2.5 py-1 text-metadata font-semibold text-link"
        >
          <CalendarClockIcon aria-hidden className="size-3.5" />
          {pillText}
        </span>
      ) : null}

      {/* Actions: primary for the row's state, then visible Edit/Delete.
          Shrinkable + wrapping: at narrow tablet widths the buttons
          drop to a second line instead of pushing the row off-screen. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {isQueued ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            data-testid="queue-row-publish-now"
            disabled={busy || publishBlockedReason !== null}
            title={publishBlockedReason ?? undefined}
            aria-label={publishBlockedReason ?? undefined}
            onClick={onPublishNow}
          >
            Publish now
          </Button>
        ) : null}
        {isFailed ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            data-testid="queue-row-retry"
            disabled={busy || publishBlockedReason !== null}
            title={publishBlockedReason ?? undefined}
            aria-label={publishBlockedReason ?? undefined}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="queue-row-edit"
          disabled={busy || isPublished}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="queue-row-delete"
          disabled={busy || isPublished}
          onClick={onDelete}
          className="border-signal-critical/30 text-signal-critical hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
