'use client';

/**
 * Preview dialog footer (spec 133 §6.6 / PR-133-5, PB-8).
 *
 * The arrangement is round-2 behaviour, preserved exactly: Delete as
 * a danger text action on the left; Cancel + "Save changes" (the
 * dialog's single primary) on the right. A save failure presents
 * inline above the actions — at the scope of the operation, never a
 * bare return or a generic toast (spec §7.2). Every action locks out
 * while a save or delete is in flight, so no duplicate action can
 * start (spec 071 lockouts).
 */

import * as React from 'react';

import { Button } from '@/components/shared/ui/button';
import { cn } from '@/lib/utils';

export interface MediaPreviewFooterProps {
  hasDelete: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  saveError: string | null;
  onDelete?: (() => void) | undefined;
  onCancel: () => void;
  onSave: () => void;
  /**
   * Picker use: hide the default "Save changes" button entirely, so
   * a preview that cannot save never shows a dead Save. A
   * primaryAction (single-mode Attach) still renders when present.
   */
  hideSave?: boolean | undefined;
  /**
   * Picker single-attach use (P7): replaces "Save changes" with one
   * explicit action — "Attach this file" — so tapping a tile never
   * attaches instantly; the user previews first, then attaches.
   */
  primaryAction?:
    | { label: string; onClick: () => void; testid?: string | undefined }
    | undefined;
}

export function MediaPreviewFooter({
  hasDelete,
  isSaving,
  isDeleting,
  saveError,
  onDelete,
  onCancel,
  onSave,
  hideSave = false,
  primaryAction,
}: Readonly<MediaPreviewFooterProps>) {
  const isBusy = isSaving || isDeleting;

  return (
    <div className="border-t border-line px-4 py-3 sm:px-6">
      {saveError ? (
        <p role="alert" className="m-0 pb-2 text-right text-metadata font-medium text-signal-critical">
          {saveError}
        </p>
      ) : null}
      {/* PB-8 arrangement on sm+: Delete left, Cancel + Save right,
          one row. On phones the row is wider than the dialog, so it
          stacks — Delete on its own row, the actions right-aligned
          below — and nothing clips (spec 142). */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        {hasDelete ? (
          <Button
            variant="ghost"
            data-testid="modal-delete-media-btn"
            disabled={isBusy}
            onClick={onDelete}
            className={cn(
              'self-start text-signal-critical hover:bg-signal-critical/10 hover:text-signal-critical-on-tint sm:self-auto'
            )}
          >
            {isDeleting ? 'Deleting...' : 'Delete asset'}
          </Button>
        ) : (
          <span className="max-sm:hidden" />
        )}

        <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
          <Button variant="ghost" disabled={isBusy} onClick={onCancel}>
            Cancel
          </Button>
          {primaryAction ? (
            <Button
              data-testid={primaryAction.testid ?? 'modal-primary-action-btn'}
              disabled={isBusy}
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </Button>
          ) : hideSave ? null : (
            <Button
              data-testid="modal-save-caption-btn"
              disabled={isBusy}
              loading={isSaving}
              onClick={onSave}
            >
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
