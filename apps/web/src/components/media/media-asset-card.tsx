'use client';

import React, { useState, useRef, useEffect } from 'react';
import Image from 'next/image';
import type { MediaItemResponse } from '@fbuploadpro/contracts';
import { CheckIcon, CircleAlertIcon, FilmIcon, ImageIcon, MoreVerticalIcon } from 'lucide-react';

import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/shared/ui/menu';
import { cn } from '@/lib/utils';
import { formatBytes, formatUploadDate, formatDuration } from './media-types';

export const HOVER_VIDEO_PREVIEW_DELAY_MS = 300;
export { formatDuration };

export interface MediaAssetCardProps {
  item: MediaItemResponse;
  selected?: boolean | undefined;
  initialHoverPlaying?: boolean | undefined;
  initialEditingCaption?: boolean | undefined;
  folderPathLabel?: string | null | undefined;
  onNavigateFolder?: ((folderId: string | null) => void) | undefined;
  onToggleSelect?:
    | ((mediaId: string, options?: { shiftKey?: boolean | undefined } | undefined) => void)
    | undefined;
  onPreview?: ((item: MediaItemResponse) => void) | undefined;
  /**
   * Optional override for the thumbnail tile's click action. When set,
   * the tile calls this instead of onPreview; the dedicated Preview
   * buttons still call onPreview. The Media Library picker passes its
   * selection toggle here in multi mode so a tile tap selects instead
   * of previewing. Unset everywhere else, so the library page is
   * unchanged.
   */
  onTileClick?: ((item: MediaItemResponse) => void) | undefined;
  onUpdateCaption?:
    | ((mediaId: string, captionText: string) => Promise<void> | void)
    | undefined;
  onMoveRequest?: ((item: MediaItemResponse) => void) | undefined;
  onDeleteRequest?: ((item: MediaItemResponse) => void) | undefined;
  onDragStartMedia?:
    | ((e: React.DragEvent<HTMLElement>, item: MediaItemResponse) => void)
    | undefined;
}

interface MediaThumbnailProps {
  item: MediaItemResponse;
  isVideo: boolean;
  isHoverPlaying: boolean;
  previewSrc: string | null;
}

function MediaThumbnail({
  item,
  isVideo,
  isHoverPlaying,
  previewSrc,
}: Readonly<MediaThumbnailProps>) {
  const [imgError, setImgError] = useState(false);

  if (isHoverPlaying && isVideo && item.url) {
    return (
      <video
        data-testid={`hover-video-preview-${item.id}`}
        src={item.url}
        muted
        loop
        playsInline
        autoPlay
        className="pointer-events-none block h-full w-full object-cover"
      >
        <track kind="captions" />
      </video>
    );
  }

  if (previewSrc && !imgError) {
    return (
      <Image
        src={previewSrc}
        alt={item.name}
        width={640}
        height={360}
        sizes="(max-width: 768px) 50vw, (max-width: 1280px) 33vw, 20vw"
        onError={() => setImgError(true)}
        className="block h-full w-full object-cover"
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-subtle text-ink-dim">
      {isVideo ? (
        <FilmIcon className="size-7" aria-hidden />
      ) : (
        <ImageIcon className="size-7" aria-hidden />
      )}
    </div>
  );
}

/**
 * Asset tile (spec 133 §6.2 / PB-16): no card box — a rounded thumbnail
 * tile with its metadata directly underneath on the page background.
 * Selection is the shared grid/table model: the Checkbox (shared/ui)
 * toggles, shift-click ranges (the shift state is captured on the
 * wrapping label's click, before Radix toggles). Hover-revealed
 * actions (Preview + overflow Menu with Move/Delete) are equally
 * available on focus-within and are always visible where hover is
 * unavailable or the viewport is small (UI Rule 19). The 300ms muted
 * hover video preview is suppressed under prefers-reduced-motion.
 * No Schedule action, no eligibility tags (PB-9).
 */
export function MediaAssetCard({
  item,
  selected = false,
  initialHoverPlaying = false,
  initialEditingCaption = false,
  folderPathLabel = null,
  onNavigateFolder,
  onToggleSelect,
  onPreview,
  onTileClick,
  onMoveRequest,
  onDeleteRequest,
  onDragStartMedia,
}: Readonly<MediaAssetCardProps>) {
  const [isHoverPlaying, setIsHoverPlaying] = useState(initialHoverPlaying);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shiftKeyRef = useRef(false);

  const isVideo = item.mediaType === 'video';
  const previewSrc = item.thumbnailUrl || (!isVideo ? item.url : null);
  const hasCaption = Boolean(item.captionText && item.captionText.trim().length > 0);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  const handleMouseEnter = () => {
    if (!isVideo || !item.url) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setIsHoverPlaying(true);
    }, HOVER_VIDEO_PREVIEW_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHoverPlaying(false);
  };

  return (
    <div
      data-testid={`media-card-${item.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer?.setData(
          'application/x-fbuploadpro-media',
          JSON.stringify({ mediaId: item.id })
        );
        onDragStartMedia?.(e, item);
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative flex select-none flex-col gap-1"
    >
      {/* Rounded Thumbnail Tile (NO outer card panel box) */}
      <div
        data-testid={`media-thumbnail-surface-${item.id}`}
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-md bg-subtle outline outline-line',
          selected && 'outline-2 outline-offset-2 outline-primary'
        )}
      >
        <button
          type="button"
          data-testid={`preview-media-${item.id}`}
          onClick={() => (onTileClick ?? onPreview)?.(item)}
          aria-label={`Preview ${item.name}`}
          className="flex h-full w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          <MediaThumbnail
            item={item}
            isVideo={isVideo}
            isHoverPlaying={isHoverPlaying}
            previewSrc={previewSrc}
          />
        </button>

        {/* Top-Left Selection Checkbox (hover / focus-within / touch-visible) */}
        <span
          onClickCapture={(e) => {
            shiftKeyRef.current = e.shiftKey;
          }}
          className={cn(
            'absolute top-1 left-1 transition-opacity',
            selected
              ? 'opacity-100'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100'
          )}
        >
          <label
            data-testid={`select-label-${item.id}`}
            className="flex size-10 cursor-pointer items-center justify-center rounded-xs bg-canvas/90"
          >
            <Checkbox
              data-testid={`select-media-${item.id}`}
              checked={selected}
              onCheckedChange={() =>
                onToggleSelect?.(item.id, { shiftKey: shiftKeyRef.current })
              }
              aria-label={`Select ${item.name}`}
            />
          </label>
        </span>

        {/* Hover/Focus Action Overlay: Preview Button + Overflow Menu */}
        <div
          className={cn(
            'absolute top-1 right-1 flex items-center gap-1 transition-opacity',
            'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100'
          )}
        >
          <button
            type="button"
            data-testid={`hover-preview-${item.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onPreview?.(item);
            }}
            aria-label="Preview asset"
            className="inline-flex h-10 cursor-pointer items-center rounded-xs border border-line bg-neutral-black/75 px-2 text-xs font-medium text-neutral-white backdrop-blur-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
          >
            Preview
          </button>

          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                data-testid={`overflow-menu-btn-${item.id}`}
                onClick={(e) => e.stopPropagation()}
                aria-label="More actions"
                className="inline-flex size-10 cursor-pointer items-center justify-center rounded-xs border border-line bg-neutral-black/75 text-neutral-white backdrop-blur-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
              >
                <MoreVerticalIcon className="size-4" aria-hidden />
              </button>
            </MenuTrigger>
            <MenuContent align="end" data-testid={`overflow-menu-${item.id}`}>
              {onMoveRequest && (
                <MenuItem
                  data-testid={`menu-move-${item.id}`}
                  onSelect={() => onMoveRequest(item)}
                >
                  Move
                </MenuItem>
              )}
              {onDeleteRequest && (
                <MenuItem
                  data-testid={`menu-delete-${item.id}`}
                  variant="destructive"
                  onSelect={() => onDeleteRequest(item)}
                >
                  Delete
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>

        {/* Bottom-Right Aspect Ratio Badge */}
        {item.aspectRatio && item.aspectRatio !== 'unknown' && (
          <div
            data-testid={`media-ratio-badge-${item.id}`}
            className="pointer-events-none absolute right-1 bottom-1 rounded-xs border border-line bg-neutral-black/75 px-1.5 py-0.5 text-xs font-semibold text-neutral-white tabular-nums backdrop-blur-sm"
          >
            {item.aspectRatio}
            {item.durationSeconds ? (
              <span className="sr-only">{formatDuration(item.durationSeconds)}</span>
            ) : null}
          </div>
        )}
      </div>

      {/* Metadata Directly Underneath on the Page Background (NO card box) */}
      <div className="flex flex-col gap-0.5 pt-0.5">
        {/* Line 1: File Name */}
        <span
          title={item.name}
          data-testid={`media-name-${item.id}`}
          className="truncate text-metadata font-medium text-ink"
        >
          {item.name}
        </span>

        {/* Line 2: Size · Upload Date (e.g. "10.3 KB · Oct 18, 2026") */}
        <span
          data-testid={`media-meta-${item.id}`}
          className="text-xs text-ink-dim tabular-nums"
        >
          {formatBytes(item.fileSize)} · {formatUploadDate(item.createdAt)}
        </span>

        {/* Line 3: Caption Status — colour + icon + text (UX Rule 27) */}
        <span
          data-testid={`media-caption-status-${item.id}`}
          className={cn(
            'inline-flex items-center gap-1 text-xs font-medium',
            hasCaption ? 'text-ink-sub' : 'text-brand-rose'
          )}
        >
          {hasCaption ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <CircleAlertIcon className="size-3.5" aria-hidden />
          )}
          {hasCaption ? 'Caption added' : 'Missing caption'}
        </span>

        {/* Caption anchor: the asset's caption text (screen-reader / parity) */}
        <span data-testid={`inline-caption-${item.id}`} className="sr-only">
          {item.captionText || ''}
        </span>

        {/* Optional Folder Path Label (e.g. during global search) */}
        {folderPathLabel && (
          <button
            type="button"
            data-testid={`media-folder-path-${item.id}`}
            onClick={() => onNavigateFolder?.(item.folderId ?? null)}
            className="max-w-full cursor-pointer self-start truncate border-0 bg-transparent p-0 text-left text-xs text-ink-dim outline-none focus-visible:outline-2 focus-visible:outline-link"
          >
            {folderPathLabel}
          </button>
        )}

        {/* Editing caption input (seeded state, spec 029 parity anchor) */}
        {initialEditingCaption && (
          <input
            type="text"
            data-testid={`inline-caption-input-${item.id}`}
            defaultValue={item.captionText || item.name.replace(/\.[^/.]+$/, '')}
            className="hidden"
            readOnly
          />
        )}
      </div>
    </div>
  );
}
