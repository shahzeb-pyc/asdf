'use client';

/**
 * Import staging (spec 133 PR-133-4, spec §6.5 / PB-2, PB-12).
 *
 * Rebuilt on the design system: rows are list rows (46px thumbnail
 * tile, name, size, state) — never cards-in-a-box (PB-1). The
 * destination picker is the shared/ui Select (PB-12: "To: <folder>"
 * defaults to the folder being viewed). Validation flags sit on
 * their rows and exclude the file from the Start-import count;
 * duplicates carry a per-row Skip / Keep choice. "Start import (n)"
 * is disabled at 0 valid files with the reason present (UX Rule 19).
 *
 * The staging thumbnail is a transient `blob:` object URL of a file
 * that has not uploaded yet — OD-133-1(b): an allowlisted raw img element
 * (the image optimiser cannot process blob: URLs), recorded with its
 * reason in apps/web/img-baseline.txt.
 */

import React, { useState } from 'react';
import type { MediaFolder } from '@fbuploadpro/contracts';
import { FilmIcon, FolderIcon, ImageIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { formatBytes, type ImportQueueItem } from './media-types';

/** Select value standing for the library root (Radix needs a string). */
const ROOT_VALUE = 'library';

// -----------------------------------------------------------------------------
// Destination picker + header
// -----------------------------------------------------------------------------
export interface ImportStagingHeaderProps {
  totalCount: number;
  destinationFolderName: string;
  selectedFolderId: string | null;
  folders: MediaFolder[];
  onSelectFolder: (folderId: string | null) => void;
  /** When true, the destination is fixed: static text, no picker. */
  lockDestination?: boolean | undefined;
}

export function ImportStagingHeader({
  totalCount,
  destinationFolderName,
  selectedFolderId,
  folders,
  onSelectFolder,
  lockDestination = false,
}: Readonly<ImportStagingHeaderProps>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p
          data-testid="import-staging-subtext"
          className="m-0 text-body text-ink-sub"
        >
          {totalCount} file{totalCount === 1 ? '' : 's'} selected · will be added to{' '}
          {destinationFolderName}
        </p>
        <p className="m-0 text-metadata text-ink-dim">
          Images and videos up to 500 MB each.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <FolderIcon className="size-4 shrink-0 text-brand-gold" aria-hidden />
        {lockDestination ? (
          <span
            data-testid="destination-folder-locked"
            className="text-body font-medium text-ink"
          >
            To:&nbsp;{destinationFolderName}
          </span>
        ) : (
        <Select
          value={selectedFolderId ?? ROOT_VALUE}
          onValueChange={(value) =>
            onSelectFolder(value === ROOT_VALUE ? null : value)
          }
        >
          <SelectTrigger
            size="sm"
            data-testid="destination-folder-pill"
            aria-label={`Import destination: ${destinationFolderName}`}
            className="min-h-11 sm:min-h-8"
          >
            <span>To:&nbsp;</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid="destination-dropdown">
            <SelectItem value={ROOT_VALUE} data-testid="destination-option-root">
              Library
            </SelectItem>
            {folders.map((f) => (
              <SelectItem
                key={f.id}
                value={f.id}
                data-testid={`destination-option-${f.id}`}
              >
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Staging row (46px thumbnail tile, name/size, flags, remove)
// -----------------------------------------------------------------------------
export interface ImportStagingRowProps {
  item: ImportQueueItem;
  onRemove: (id: string) => void;
  onKeepDuplicate: (id: string) => void;
}

export function ImportStagingRow({
  item,
  onRemove,
  onKeepDuplicate,
}: Readonly<ImportStagingRowProps>) {
  const [imageError, setImageError] = useState(false);
  const showPreview =
    item.mediaType === 'image' && Boolean(item.previewUrl) && !imageError;

  return (
    <div
      data-testid={`import-row-${item.id}`}
      className="flex items-center justify-between gap-3 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {/* 46px thumbnail tile */}
        <div
          data-testid={`thumbnail-tile-${item.id}`}
          className="flex size-11.5 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-subtle"
        >
          {showPreview ? (
            /* OD-133-1(b): transient blob: preview of a not-yet-uploaded
               file — allowlisted raw img element; next/image cannot optimise
               blob: URLs. Reason recorded in apps/web/img-baseline.txt.
               (The no-img-element rule is frozen off for this file in
               eslint.config.mjs, per the baseline.) */
            <img
              src={item.previewUrl ?? undefined}
              alt={item.name}
              onError={() => setImageError(true)}
              className="size-full object-cover"
            />
          ) : item.mediaType === 'video' ? (
            <FilmIcon className="size-5 text-brand-gold" aria-hidden />
          ) : (
            <ImageIcon className="size-5 text-brand-gold" aria-hidden />
          )}
        </div>

        {/* File name & size */}
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

      {/* Row status & per-row actions */}
      <div className="flex shrink-0 items-center gap-2">
        {item.validationError && (
          <span
            data-testid={`validation-error-${item.id}`}
            className="text-metadata font-medium text-brand-rose"
          >
            {item.validationError}
          </span>
        )}

        {item.isDuplicate && !item.validationError && (
          <div className="flex items-center gap-1.5">
            <span
              data-testid={`duplicate-flag-${item.id}`}
              className="text-metadata font-semibold text-brand-gold"
            >
              possible duplicate
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`keep-duplicate-${item.id}`}
              onClick={() => onKeepDuplicate(item.id)}
              className="min-h-11 sm:min-h-8"
            >
              Keep
            </Button>
          </div>
        )}

        {/* Per-row remove / skip — always a 44px target (spec 142). */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={`remove-staged-${item.id}`}
          onClick={() => onRemove(item.id)}
          aria-label={item.isDuplicate ? `Skip ${item.name}` : `Remove ${item.name}`}
          title={item.isDuplicate ? 'Skip' : 'Remove'}
          className="size-11 text-ink-sub"
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Staging footer
// -----------------------------------------------------------------------------
export interface ImportStagingFooterProps {
  validCount: number;
  isStarting: boolean;
  onAddMore: () => void;
  /** P1: single-attach mode hides "+ Add more" (one file only). */
  hideAddMore?: boolean | undefined;
  /** P6: rows that cannot be imported (too large, unsupported, empty). */
  invalidCount?: number | undefined;
  onRemoveInvalid?: (() => void) | undefined;
  onCancel: () => void;
  onStart: () => void;
}

export function ImportStagingFooter({
  validCount,
  isStarting,
  onAddMore,
  hideAddMore = false,
  invalidCount = 0,
  onRemoveInvalid,
  onCancel,
  onStart,
}: Readonly<ImportStagingFooterProps>) {
  const isStartDisabled = validCount === 0 || isStarting;
  return (
    <div className="flex flex-col gap-2">
      {/* Wraps at phone widths (spec 142): "+ Add more" keeps its own
          line rather than squeezing the actions off the panel. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-3">
          {hideAddMore ? (
            <span />
          ) : (
            <Button
              type="button"
              variant="link"
              data-testid="add-more-files-btn"
              onClick={onAddMore}
              className="h-11 px-0"
            >
              + Add more
            </Button>
          )}
          {invalidCount > 0 && (
            <Button
              type="button"
              variant="link"
              data-testid="remove-invalid-btn"
              onClick={onRemoveInvalid}
              className="h-11 px-0 text-brand-rose"
            >
              Remove invalid ({invalidCount})
            </Button>
          )}
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="cancel-staging-btn"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="start-import-btn"
            disabled={isStartDisabled}
            loading={isStarting}
            onClick={onStart}
            {...(validCount === 0 && !isStarting
              ? { disabledReason: 'Add a file that can be uploaded first.' }
              : {})}
          >
            {isStarting ? 'Starting...' : `Start import (${validCount})`}
          </Button>
        </div>
      </div>
      {validCount === 0 && !isStarting && (
        <p className="m-0 text-right text-metadata text-ink-dim">
          Add a file that can be uploaded first.
        </p>
      )}
    </div>
  );
}
