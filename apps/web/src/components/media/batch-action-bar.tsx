'use client';

/**
 * Batch action bar (spec 133 PR-133-3, spec §6.4 / PB-17).
 *
 * The batch-bar pattern in the round-2 floating-pill presentation:
 * bottom-centre, appears at 1+ selected, always states the count —
 * "n selected · Move · Set caption · Delete · Clear" — with no
 * primary/highlighted action inside it. Rebuilt on the shared/ui
 * Button (44px touch targets) with token styling only: no
 * box-in-box, hairline border, safe-area-aware bottom clearance
 * (the spec 142 `pb-safe-offset` utility). It is in the tab order
 * (keyboard-reachable) and locks out while a batch action runs.
 */

import * as React from 'react';

import { Button } from '@/components/shared/ui/button';

export interface BatchActionBarProps {
  selectedIds: string[];
  totalAvailableCount?: number | undefined;
  onSelectAll?: (() => void) | undefined;
  onClearSelection?: () => void;
  onBatchMove?: () => void;
  onBatchCaption?: () => void;
  onBatchDelete?: () => void;
  isBusy?: boolean;
}

export function BatchActionBar({
  selectedIds,
  totalAvailableCount: _totalAvailableCount,
  onSelectAll,
  onClearSelection,
  onBatchMove,
  onBatchCaption,
  onBatchDelete,
  isBusy = false,
}: Readonly<BatchActionBarProps>) {
  if (selectedIds.length === 0) {
    return null;
  }

  const separator = (
    <span aria-hidden="true" className="text-ink-dim">
      ·
    </span>
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-sticky flex justify-center px-4 pb-safe-offset">
      <div
        data-testid="batch-action-bar"
        role="region"
        aria-label="Batch actions"
        className="pointer-events-auto flex max-w-full min-w-0 flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-md border border-line bg-panel px-4 py-2 shadow-modal"
      >
        <span
          data-testid="batch-selected-count"
          className="text-body font-semibold text-ink tabular-nums"
        >
          {selectedIds.length} selected
        </span>

        {onSelectAll ? (
          <button
            type="button"
            data-testid="batch-select-all-btn"
            tabIndex={-1}
            onClick={onSelectAll}
            className="hidden"
          >
            Select all
          </button>
        ) : null}

        {separator}

        {onBatchMove ? (
          <>
            <Button
              variant="ghost"
              data-testid="batch-move-btn"
              disabled={isBusy}
              onClick={onBatchMove}
            >
              Move
            </Button>
            {separator}
          </>
        ) : null}

        {onBatchCaption ? (
          <>
            <Button
              variant="ghost"
              data-testid="batch-caption-btn"
              disabled={isBusy}
              onClick={onBatchCaption}
            >
              Set caption
            </Button>
            {separator}
          </>
        ) : null}

        {onBatchDelete ? (
          <>
            <Button
              variant="ghost"
              data-testid="batch-delete-btn"
              disabled={isBusy}
              onClick={onBatchDelete}
              className="text-signal-critical hover:text-signal-critical-on-tint"
            >
              Delete
            </Button>
            {separator}
          </>
        ) : null}

        {onClearSelection ? (
          <Button
            variant="ghost"
            data-testid="batch-clear-btn"
            disabled={isBusy}
            onClick={onClearSelection}
            className="text-ink-dim"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
