'use client';

/**
 * Import progress row (spec 133 PR-133-4, spec §6.5 / PB-3, PB-18).
 *
 * One row per file in the progress mode: 46px thumbnail tile, name,
 * size, and the file's state presented as text + colour (never colour
 * alone, UX Rule 27): "queued · #n" beyond the active slots, a thin
 * progress bar + percent while uploading/paused, per-file
 * pause/resume/cancel, "failed — retry" with the plain-language
 * reason, and "uploaded" on server confirmation. Every control is a
 * ≥44px target (spec 142).
 *
 * The thumbnail is the same transient `blob:` preview as staging —
 * OD-133-1(b) allowlisted raw img element, reason in img-baseline.txt.
 * The bar's fill width is a per-file dynamic value — the ratchet's
 * sanctioned dynamic-value case (spec §7.10), kept to this one
 * element per row.
 */

import React from 'react';
import { CheckIcon, FilmIcon, ImageIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { cn } from '@/lib/utils';
import { formatBytes, type ImportQueueItem } from './media-types';

export interface ImportProgressRowProps {
  item: ImportQueueItem;
  destinationFolderName: string;
  /** 1-based position among the waiting files, for "queued · #n". */
  queuePosition?: number | undefined;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}

export function ImportProgressRow({
  item,
  destinationFolderName,
  queuePosition,
  onPause,
  onResume,
  onCancel,
  onRetry,
}: Readonly<ImportProgressRowProps>) {
  const isQueued = item.status === 'queued';
  const isUploading = item.status === 'uploading';
  const isCompleted = item.status === 'completed';
  const isFailed = item.status === 'failed';
  const isPaused = item.status === 'paused';
  const isCancelled = item.status === 'cancelled';

  return (
    <div
      data-testid={`import-row-${item.id}`}
      className={cn(
        'flex items-center justify-between gap-3 py-2',
        isCancelled && 'opacity-45'
      )}
    >
      {/* 46px thumbnail & file info */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <div className="flex size-11.5 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-subtle">
          {item.mediaType === 'image' && item.previewUrl ? (
            /* OD-133-1(b): transient blob: preview — allowlisted raw
               img element; see media-import-staging.tsx and img-baseline.txt.
               (Rule frozen off for this file in eslint.config.mjs.) */
            <img
              src={item.previewUrl}
              alt={item.name}
              className="size-full object-cover"
            />
          ) : item.mediaType === 'video' ? (
            <FilmIcon className="size-5 text-link" aria-hidden />
          ) : (
            <ImageIcon className="size-5 text-link" aria-hidden />
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <span
            title={item.name}
            className="truncate text-body font-medium text-ink"
          >
            {item.name}
          </span>
          <span className="text-metadata text-ink-dim tabular-nums">
            {formatBytes(item.size)}
          </span>
        </div>
      </div>

      {/* Row status & controls */}
      <div className="flex shrink-0 items-center gap-2">
        {isQueued && (
          <div className="flex items-center gap-1">
            <span className="text-metadata text-ink-dim">
              {queuePosition ? `queued · #${queuePosition}` : 'queued'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid={`cancel-queued-${item.id}`}
              onClick={() => onCancel(item.id)}
              aria-label={`Cancel ${item.name}`}
              className="size-11 text-ink-dim"
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        )}

        {(isUploading || isPaused) && (
          <div className="flex min-w-32 items-center gap-1">
            <div className="flex flex-1 flex-col gap-0.5">
              <div className="h-1 w-full overflow-hidden rounded-full bg-subtle">
                {/* Dynamic per-file progress width — the inline-style
                    ratchet's allowlisted dynamic-value case (§7.10). */}
                <div
                  className={cn(
                    'h-full transition-all duration-base',
                    isPaused ? 'bg-ink-dim' : 'bg-primary'
                  )}
                  style={{ width: `${item.progressPercent}%` }}
                />
              </div>
              <span className="text-metadata text-ink-dim tabular-nums">
                {item.progressPercent}%
              </span>
            </div>
            {isPaused && (
              <span className="text-metadata text-ink-dim">paused</span>
            )}
            {isUploading && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={`pause-upload-${item.id}`}
                onClick={() => onPause(item.id)}
                aria-label={`Pause ${item.name}`}
                className="min-h-11 text-metadata sm:min-h-8"
              >
                Pause
              </Button>
            )}
            {isPaused && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`resume-upload-${item.id}`}
                onClick={() => onResume(item.id)}
                className="min-h-11 sm:min-h-8"
              >
                Resume
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid={
                isPaused ? `cancel-paused-${item.id}` : `cancel-upload-${item.id}`
              }
              onClick={() => onCancel(item.id)}
              aria-label={`Cancel ${item.name}`}
              className="size-11 text-ink-dim"
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        )}

        {isCompleted && (
          <div className="flex items-center gap-1">
            <span className="text-metadata font-medium text-brand-emerald">
              uploaded to {destinationFolderName}
            </span>
            <CheckIcon className="size-3.5 text-brand-emerald" aria-hidden />
          </div>
        )}

        {isFailed && (
          <div className="flex items-center gap-1.5">
            <span className="text-metadata text-signal-critical">
              {item.validationError || 'failed — retry'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`retry-upload-${item.id}`}
              onClick={() => onRetry(item.id)}
              className="min-h-11 text-link sm:min-h-8"
            >
              Retry
            </Button>
          </div>
        )}

        {isCancelled && (
          <span className="text-metadata text-ink-dim">cancelled</span>
        )}
      </div>
    </div>
  );
}
