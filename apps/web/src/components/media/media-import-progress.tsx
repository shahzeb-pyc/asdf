'use client';

/**
 * Import progress chrome (spec 133 PR-133-4, spec §6.5 / PB-18,
 * OD-133-4(a)).
 *
 * Header: the title, the destination subtext, the overall percent
 * (header shows overall progress only) and the aggregate bar — its
 * fill width is a dynamic value, the ratchet's sanctioned
 * inline-style case (spec §7.10). Completion lands on the summary
 * ("Import complete — 8 of 10 uploaded" / "Import canceled —
 * nothing was uploaded", Peak-End, UI Rule 26) inside the dialog —
 * never a bare toast.
 *
 * The minimised state ("Keep working") is OD-133-4(a): a small
 * in-surface fixed progress chip built from primitives —
 * persistent, expandable, keyboard-reachable, never a toast.
 */

import React from 'react';

import { Button } from '@/components/shared/ui/button';
import { formatBytes } from './media-types';

/**
 * The modal's props live with the modal (media-import-modal.tsx);
 * re-exported here because the explorer's public type surface has
 * always sourced them from this module.
 */
export type { MediaImportModalProps } from './media-import-modal';

// -----------------------------------------------------------------------------
// Progress header (title, subtext, overall % + aggregate bar)
// -----------------------------------------------------------------------------
export interface ImportProgressHeaderProps {
  step: 'progress' | 'complete';
  destinationFolderName: string;
  completedCount: number;
  totalCount: number;
  isAllCancelled: boolean;
  overallProgressPercent: number;
  /** P9: byte-weighted totals for the "120 MB of 400 MB" line. */
  uploadedBytes: number;
  totalBytes: number;
}

export function ImportProgressHeader({
  step,
  destinationFolderName,
  completedCount,
  totalCount,
  isAllCancelled,
  overallProgressPercent,
  uploadedBytes,
  totalBytes,
}: Readonly<ImportProgressHeaderProps>) {
  const title =
    step === 'complete'
      ? isAllCancelled
        ? 'Import canceled'
        : 'Import complete'
      : 'Importing media';

  const subtext =
    step === 'complete'
      ? isAllCancelled
        ? 'Import canceled — nothing was uploaded'
        : `Import complete — ${completedCount} of ${totalCount} uploaded`
      : `Adding to ${destinationFolderName}`;

  const barPercent =
    step === 'complete' && !isAllCancelled ? 100 : overallProgressPercent;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <p
          data-testid="import-progress-subtext"
          className="m-0 text-body text-ink-sub"
        >
          {subtext}
        </p>

        {/* Overall percentage (header shows overall progress only) */}
        <div
          data-testid="overall-progress-percentage"
          className="text-xl leading-none font-bold text-link tabular-nums"
          aria-label={`${title}: ${barPercent}%`}
        >
          {barPercent}%
        </div>
      </div>

      {/* P9: byte-weighted progress in bytes, not a per-file average. */}
      {totalBytes > 0 && (
        <p
          data-testid="import-progress-bytes"
          className="m-0 text-metadata text-ink-dim tabular-nums"
        >
          {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)} ·{' '}
          {completedCount} of {totalCount} files
        </p>
      )}

      {/* Aggregate progress track */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
        {/* Dynamic overall progress width — allowlisted (§7.10). */}
        <div
          data-testid="aggregate-progress-bar"
          className="h-full bg-primary transition-all duration-base"
          style={{ width: `${barPercent}%` }}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Progress footer (leave warning, Cancel remaining, Keep working, Done)
// -----------------------------------------------------------------------------
export interface ImportProgressFooterProps {
  step: 'progress' | 'complete';
  isUploading: boolean;
  canCancelRemaining: boolean;
  /** P6: failed rows available for a one-tap retry-all. */
  failedCount?: number | undefined;
  onRetryAllFailed?: (() => void) | undefined;
  onCancelRemaining: () => void;
  onKeepWorking: () => void;
  onDone: () => void;
}

export function ImportProgressFooter({
  step,
  isUploading,
  canCancelRemaining,
  failedCount = 0,
  onRetryAllFailed,
  onCancelRemaining,
  onKeepWorking,
  onDone,
}: Readonly<ImportProgressFooterProps>) {
  if (step === 'complete') {
    return (
      <div className="flex items-center justify-between gap-3">
        {failedCount > 0 ? (
          <Button
            type="button"
            variant="link"
            data-testid="retry-all-failed-btn"
            onClick={onRetryAllFailed}
            className="h-11 px-0 text-metadata text-link"
          >
            Retry all failed ({failedCount})
          </Button>
        ) : (
          <span />
        )}
        <Button type="button" data-testid="import-done-btn" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {canCancelRemaining && (
          <Button
            type="button"
            variant="link"
            data-testid="cancel-remaining-btn"
            onClick={onCancelRemaining}
            className="h-11 px-0 text-metadata text-brand-rose"
          >
            Cancel remaining
          </Button>
        )}
        {failedCount > 0 && (
          <Button
            type="button"
            variant="link"
            data-testid="retry-all-failed-btn"
            onClick={onRetryAllFailed}
            className="h-11 px-0 text-metadata text-link"
          >
            Retry all failed ({failedCount})
          </Button>
        )}
        {isUploading && (
          <span className="text-metadata text-ink-dim">
            Leaving now will cancel the remaining uploads.
          </span>
        )}
      </div>

      <Button
        type="button"
        variant="secondary"
        data-testid="keep-working-btn"
        onClick={onKeepWorking}
      >
        Keep working
      </Button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Minimised progress chip (OD-133-4(a))
// -----------------------------------------------------------------------------
interface MinimizedUploadPillProps {
  completedCount: number;
  totalCount: number;
  overallPercent: number;
  onRestore: () => void;
}

export function MinimizedUploadPill({
  completedCount,
  totalCount,
  overallPercent,
  onRestore,
}: Readonly<MinimizedUploadPillProps>) {
  return (
    <aside
      aria-label="Upload progress dock"
      data-testid="minimized-upload-dock"
      className="fixed right-4 bottom-4 z-dialog flex items-center gap-3 rounded-md border border-line bg-panel p-2 pl-4 shadow-modal"
    >
      <div className="flex min-w-32 flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-metadata font-medium text-ink">
            Uploading {completedCount} of {totalCount}
          </span>
          <span className="text-metadata font-semibold text-link tabular-nums">
            {overallPercent}%
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-subtle">
          {/* Dynamic overall progress width — allowlisted (§7.10). */}
          <div
            className="h-full bg-primary transition-all duration-base"
            style={{ width: `${overallPercent}%` }}
          />
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="restore-modal-btn"
        onClick={onRestore}
        aria-label={`Restore upload dialog: Uploading ${completedCount} of ${totalCount}`}
        className="min-h-11 sm:min-h-8"
      >
        View
      </Button>
    </aside>
  );
}
