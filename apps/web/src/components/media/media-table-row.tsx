'use client';

import React, { useRef, useState } from 'react';
import Image from 'next/image';
import type { MediaItemResponse } from '@fbuploadpro/contracts';
import { FilmIcon, ImageIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { TableCell, TableRow } from '@/components/shared/ui/table';
import { cn } from '@/lib/utils';
import {
  deriveDefaultCaption,
  formatBytes,
  formatUploadDate,
  formatMediaDetails,
} from './media-types';

export interface MediaTableRowProps {
  item: MediaItemResponse;
  /**
   * Picker-compact rendering: hides the Details and Date columns and
   * hides Caption/Size below the sm breakpoint, so the table fits a
   * dialogue card with no horizontal scrolling. Default off — the
   * full library page keeps all eight columns.
   */
  compact?: boolean | undefined;
  selected?: boolean | undefined;
  initialEditingCaption?: boolean | undefined;
  folderPathLabel?: string | null | undefined;
  onNavigateFolder?: ((folderId: string | null) => void) | undefined;
  onToggleSelect?:
    | ((mediaId: string, options?: { shiftKey?: boolean | undefined } | undefined) => void)
    | undefined;
  onPreview?: ((item: MediaItemResponse) => void) | undefined;
  /**
   * Optional override for the thumbnail button's click action. When set,
   * the thumbnail calls this instead of onPreview; the dedicated Preview
   * action still calls onPreview. The Media Library picker passes its
   * selection toggle here in multi mode so a thumbnail tap selects
   * instead of previewing. Unset everywhere else, so the library page
   * is unchanged.
   */
  onTileClick?: ((item: MediaItemResponse) => void) | undefined;
  /**
   * Optional override for the filename's click action. When set, the
   * filename renders as a button calling this; when unset, it renders
   * as the inert text the library page has always shown. The Media
   * Library picker passes its tile gesture here so a filename click
   * selects (multi mode) or previews (single mode) instead of doing
   * nothing. Unset everywhere else, so the library page is unchanged.
   */
  onNameClick?: ((item: MediaItemResponse) => void) | undefined;
  /**
   * Picker-only: the caption is never editable and its click follows
   * the tile gesture (onTileClick ?? onPreview) instead of opening the
   * inline editor. The Media Library picker passes this because it is
   * browse + select only; caption editing lives on the full library
   * page. Default off, so the library page is unchanged.
   */
  disableCaptionEditing?: boolean | undefined;
  onUpdateCaption?:
    | ((mediaId: string, captionText: string) => Promise<void> | void)
    | undefined;
  onMoveRequest?: ((item: MediaItemResponse) => void) | undefined;
  onDeleteRequest?: ((item: MediaItemResponse) => void) | undefined;
}

/**
 * Table row for one asset (spec 133 §6.2 / PB-6), rebuilt on the
 * shared/ui Table pattern: hairline row divider, sticky-header table
 * (in media-library-grid), first column the human identifier
 * (thumbnail + name), size right-aligned in tabular figures, caption
 * click-to-edit inline, and row actions Preview / Move / Delete —
 * always visible, never hover-only (UI Rule 19). No Schedule action
 * (PB-9). The thumbnail is next/image (spec §6.7).
 *
 * Caption (PB-20): a real caption renders as text; with no caption the
 * filename-derived fallback renders visually distinguished (italic,
 * muted, marked data-fallback) — it is a display fallback only and
 * never satisfies a caption status anywhere.
 */
export function MediaTableRow({
  item,
  compact = false,
  selected = false,
  initialEditingCaption = false,
  folderPathLabel = null,
  onNavigateFolder,
  onToggleSelect,
  onPreview,
  onTileClick,
  onNameClick,
  disableCaptionEditing = false,
  onUpdateCaption,
  onMoveRequest,
  onDeleteRequest,
}: Readonly<MediaTableRowProps>) {
  const hasCaption = Boolean(item.captionText && item.captionText.trim().length > 0);
  const resolvedCaption = hasCaption ? item.captionText! : deriveDefaultCaption(item.name);

  const [isEditingCaption, setIsEditingCaption] = useState(initialEditingCaption);
  const [captionDraft, setCaptionDraft] = useState(resolvedCaption);
  const [isSavingCaption, setIsSavingCaption] = useState(false);
  const [imgError, setImgError] = useState(false);
  const shiftKeyRef = useRef(false);

  const isVideo = item.mediaType === 'video';
  const detailsLabel = formatMediaDetails(item.aspectRatio, item.durationSeconds);
  const thumbnailSrc = item.thumbnailUrl || (!isVideo ? item.url : null);

  const handleSaveCaption = async () => {
    const trimmed = captionDraft.trim() || deriveDefaultCaption(item.name);
    setIsEditingCaption(false);
    if (trimmed === resolvedCaption) return;

    setIsSavingCaption(true);
    try {
      await onUpdateCaption?.(item.id, trimmed);
    } finally {
      setIsSavingCaption(false);
    }
  };

  return (
    <TableRow
      data-testid={`media-row-${item.id}`}
      data-state={selected ? 'selected' : undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer?.setData(
          'application/x-fbuploadpro-media',
          JSON.stringify({ mediaId: item.id })
        );
      }}
    >
      {/* 1. Selection Checkbox (shared selection model, shift-range) */}
      <TableCell className="w-10">
        <span
          onClickCapture={(e) => {
            shiftKeyRef.current = e.shiftKey;
          }}
          className="inline-flex"
        >
          <label className="flex size-10 cursor-pointer items-center justify-center">
            <Checkbox
              data-testid={`select-row-${item.id}`}
              checked={selected}
              onCheckedChange={() =>
                onToggleSelect?.(item.id, { shiftKey: shiftKeyRef.current })
              }
              aria-label={`Select ${item.name}`}
            />
          </label>
        </span>
      </TableCell>

      {/* 2. Preview Thumbnail */}
      <TableCell className="w-12 px-0">
        <button
          type="button"
          onClick={() => (onTileClick ?? onPreview)?.(item)}
          aria-label={`Preview ${item.name}`}
          className="flex h-10 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-xs border border-line bg-subtle p-0 text-ink-dim outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          {thumbnailSrc && !imgError ? (
            <Image
              src={thumbnailSrc}
              alt={item.name}
              width={88}
              height={80}
              sizes="44px"
              onError={() => setImgError(true)}
              className="block h-full w-full object-cover"
            />
          ) : isVideo ? (
            <FilmIcon className="size-4" aria-hidden />
          ) : (
            <ImageIcon className="size-4" aria-hidden />
          )}
        </button>
      </TableCell>

      {/* 3. File (Name + Folder Ancestry Link) */}
      <TableCell className={compact ? 'whitespace-normal' : 'w-55 whitespace-normal'}>
        <div className="flex flex-col gap-0.5">
          {onNameClick ? (
            <button
              type="button"
              onClick={() => onNameClick(item)}
              title={item.name}
              data-testid={`row-name-${item.id}`}
              className="block w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-metadata font-medium text-ink outline-none focus-visible:outline-2 focus-visible:outline-link"
            >
              {item.name}
            </button>
          ) : (
            <span
              title={item.name}
              data-testid={`row-name-${item.id}`}
              className="truncate text-metadata font-medium text-ink"
            >
              {item.name}
            </span>
          )}
          {folderPathLabel && (
            <button
              type="button"
              onClick={() => onNavigateFolder?.(item.folderId ?? null)}
              title={`Open folder: ${folderPathLabel}`}
              className="inline-flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-left text-xs text-ink-dim outline-none focus-visible:outline-2 focus-visible:outline-link"
            >
              <span>{folderPathLabel}</span>
            </button>
          )}
        </div>
      </TableCell>

      {/* 4. Caption (Click-to-Edit) */}
      <TableCell
        className={
          compact
            ? 'hidden whitespace-normal sm:table-cell'
            : 'w-60 whitespace-normal'
        }
      >
        {isEditingCaption && !disableCaptionEditing ? (
          <Input
            type="text"
            data-testid={`table-caption-input-${item.id}`}
            value={captionDraft}
            onChange={(e) => setCaptionDraft(e.target.value)}
            onBlur={() => void handleSaveCaption()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSaveCaption();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setIsEditingCaption(false);
                setCaptionDraft(resolvedCaption);
              }
            }}
            className="h-9 text-xs"
          />
        ) : disableCaptionEditing ? (
          <button
            type="button"
            data-testid={`table-inline-caption-${item.id}`}
            data-fallback={hasCaption ? undefined : 'filename'}
            onClick={() => (onTileClick ?? onPreview)?.(item)}
            className={cn(
              'block w-full cursor-pointer truncate border-0 bg-transparent p-0 py-0.5 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-link',
              hasCaption ? 'text-ink' : 'text-ink-dim italic'
            )}
          >
            {isSavingCaption ? 'Saving...' : resolvedCaption}
          </button>
        ) : (
          <button
            type="button"
            data-testid={`table-inline-caption-${item.id}`}
            data-fallback={hasCaption ? undefined : 'filename'}
            onClick={() => setIsEditingCaption(true)}
            title="Click to edit caption"
            className={cn(
              'block w-full cursor-text truncate border-0 bg-transparent p-0 py-0.5 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-link',
              hasCaption ? 'text-ink' : 'text-ink-dim italic'
            )}
          >
            {isSavingCaption ? 'Saving...' : resolvedCaption}
          </button>
        )}
      </TableCell>

      {/* 5. Details (Merged Ratio & Duration, e.g. "1:1 · 0:45") —
          omitted in compact mode: the picker card has no room for it,
          and the ratio still shows on the grid tile badge. */}
      {!compact && (
        <TableCell
          data-testid={`row-details-${item.id}`}
          className="text-xs text-ink-sub tabular-nums"
        >
          {detailsLabel}
        </TableCell>
      )}

      {/* 6. Size (right-aligned, tabular) */}
      <TableCell
        data-testid={`row-size-${item.id}`}
        className={
          compact
            ? 'hidden text-right text-xs text-ink-dim tabular-nums sm:table-cell'
            : 'text-right text-xs text-ink-dim tabular-nums'
        }
      >
        {formatBytes(item.fileSize)}
      </TableCell>

      {/* 7. Upload Date (e.g. "Oct 18, 2026") — omitted in compact mode. */}
      {!compact && (
        <TableCell
          data-testid={`row-date-${item.id}`}
          className="text-xs text-ink-dim tabular-nums"
        >
          {formatUploadDate(item.createdAt)}
        </TableCell>
      )}

      {/* 8. Actions (Preview, Move, Delete) — NO Schedule button (PB-9) */}
      <TableCell className="text-right">
        <div className="inline-flex items-center gap-1.5">
          {onPreview && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`row-action-preview-${item.id}`}
              onClick={() => onPreview(item)}
              aria-label="Preview asset"
              className="h-11 px-3 lg:h-8"
            >
              Preview
            </Button>
          )}

          {onMoveRequest && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={`row-action-move-${item.id}`}
              onClick={() => onMoveRequest(item)}
              aria-label="Move asset"
              className="h-11 px-3 lg:h-8"
            >
              Move
            </Button>
          )}

          {onDeleteRequest && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`row-action-delete-${item.id}`}
              onClick={() => onDeleteRequest(item)}
              aria-label="Delete asset"
              className="h-11 px-3 text-signal-critical hover:text-signal-critical-on-tint lg:h-8"
            >
              Delete
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
