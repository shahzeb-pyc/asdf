'use client';

import * as React from 'react';
import { Banner, Button } from '@/components/shared/ui';
import { cn } from '@/lib/utils';
import {
  getProgressTone,
  type DownloaderProgressTone,
} from './media-downloader-helpers';
import type { DownloaderBatchProgressState } from './downloader-data';

/**
 * Batch progress presentation (spec 140 PR-140-2, T14) — the status
 * line rides the shared/ui Banner (variant carries the state: info
 * while saving, success when completed, critical when cancelled) and
 * the bar is a native determinate `<progress>` element coloured with
 * the token accent utility. Visible copy is byte-identical to the
 * legacy banner (§3 item 7/8).
 */

const TONE_TEXT_CLASS: Record<DownloaderProgressTone, string> = {
  primary: 'text-primary',
  success: 'text-brand-emerald',
  danger: 'text-signal-critical',
};

export function DownloaderProgress({
  batchProgress,
  onAbort,
}: Readonly<{
  batchProgress: DownloaderBatchProgressState | null;
  onAbort: () => void;
}>) {
  if (!batchProgress || batchProgress.status === 'idle') {
    return null;
  }

  const isDownloading = batchProgress.status === 'downloading';
  const progressPercent =
    batchProgress.totalLinks > 0
      ? Math.min(
          100,
          Math.round(
            (batchProgress.completedLinks / batchProgress.totalLinks) * 100
          )
        )
      : 0;
  const tone = getProgressTone(batchProgress.status);

  const descriptionParts: string[] = [];
  if (batchProgress.stage && isDownloading) {
    descriptionParts.push(
      batchProgress.stage === 'streaming'
        ? '[Streaming media bytes...]'
        : '[Resolving media link...]'
    );
  }
  if (batchProgress.currentUrl && isDownloading) {
    descriptionParts.push(batchProgress.currentUrl);
  }
  const description =
    descriptionParts.length > 0 ? descriptionParts.join(' ') : undefined;

  return (
    <section
      data-testid="downloader-batch-progress"
      aria-label="Batch download progress"
      className="flex flex-col gap-2"
    >
      <Banner
        variant={
          batchProgress.status === 'completed'
            ? 'success'
            : batchProgress.status === 'cancelled'
              ? 'critical'
              : 'info'
        }
        title={`Saving ${batchProgress.completedLinks} of ${batchProgress.totalLinks} ${
          batchProgress.totalLinks === 1 ? 'link' : 'links'
        } to Media Library...`}
        {...(description ? { description } : {})}
        action={
          <div className="flex items-center gap-4">
            <span
              data-testid="downloader-progress-percent"
              className={cn(
                'text-body font-bold tabular-nums',
                TONE_TEXT_CLASS[tone]
              )}
            >
              {batchProgress.status === 'cancelled'
                ? 'Cancelled'
                : `${progressPercent}%`}
            </span>
            {isDownloading && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="abort-download-btn"
                onClick={onAbort}
              >
                Abort Download
              </Button>
            )}
          </div>
        }
      />
      <progress
        data-testid="downloader-progress-bar-fill"
        value={progressPercent}
        max={100}
        aria-label="Overall batch download progress"
        className={cn(
          'h-2 w-full',
          batchProgress.status === 'completed'
            ? 'accent-brand-emerald'
            : 'accent-primary'
        )}
      />
    </section>
  );
}
