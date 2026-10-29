'use client';

/**
 * Preview media pane (spec 133 §6.6 / PR-133-5, PB-8 / PB-14).
 *
 * The left column of the preview dialog: the asset itself (image via
 * next/image, video via <video> with a minimal scrubber), rendered on
 * the design system — token surfaces and hairline dividers only, no
 * inline styles, no hand-rolled layering.
 *
 * Preview integrity (spec 113, preserved verbatim as behaviour): a
 * video carries its thumbnail as `poster` so the pane never paints
 * black before playback; a still image renders the full-size URL
 * first and falls back to the thumbnail URL (the exact source the
 * grid renders) when it fails; when every source has failed — or a
 * failed video has a thumbnail — the pane shows the thumbnail still
 * or a placeholder on a token surface, never a silent black box.
 * `resolvePreviewImageSrc` is that fallback chain.
 *
 * Frame capture ("Set Current Frame as Thumbnail", video only) lives
 * here with the video element it reads; the capture itself is the
 * pure `video-frame-capture.ts` utility. Previous/Next controls are
 * rendered at the pane edges when the consumer wires navigation —
 * real, visible, 44px targets (the legacy modal rendered them
 * display:none purely as test anchors).
 */

import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { MediaItemResponse } from '@fbuploadpro/contracts';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  ImageIcon,
  PauseIcon,
  PlayIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDuration } from './media-types';
import {
  captureVideoFrameAsWebp,
  type CapturedVideoFrame,
} from './video-frame-capture';

/**
 * Still-image source for the preview pane. The full-size `item.url` is
 * primary; when it fails to load, fall back to `item.thumbnailUrl` —
 * the same source the grid/table thumbnails render (they use
 * `thumbnailUrl || url` and render fine for assets whose preview pane
 * previously stayed black). Returns null when neither source is usable,
 * so the caller can show the placeholder instead of a black pane.
 */
export function resolvePreviewImageSrc(
  item: Pick<MediaItemResponse, 'url' | 'thumbnailUrl'>,
  failedSrcs: ReadonlySet<string>
): string | null {
  if (!failedSrcs.has(item.url)) return item.url;
  if (
    item.thumbnailUrl &&
    item.thumbnailUrl !== item.url &&
    !failedSrcs.has(item.thumbnailUrl)
  ) {
    return item.thumbnailUrl;
  }
  return null;
}

/** How long the "frame saved" success message stays visible. */
const FRAME_SUCCESS_DURATION_MS = 3000;

export interface MediaPreviewViewerProps {
  item: MediaItemResponse;
  /** Lockout from the shell: a save/delete is in flight (PB/§6.6). */
  isBusy: boolean;
  /** Grid placement from the shell's two-column layout. */
  className?: string | undefined;
  hasPrevious?: boolean | undefined;
  hasNext?: boolean | undefined;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onUpdateThumbnail?:
    | ((mediaId: string, captured: CapturedVideoFrame) => Promise<void> | void)
    | undefined;
}

export function MediaPreviewViewer({
  item,
  isBusy,
  className,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onUpdateThumbnail,
}: Readonly<MediaPreviewViewerProps>) {
  const isVideo = item.mediaType === 'video';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isCapturingFrame, setIsCapturingFrame] = useState(false);
  const [frameSuccessMessage, setFrameSuccessMessage] = useState<string | null>(null);

  // The pane background is a dark token surface, so a media element
  // that fails (or, for video, has not painted a frame yet) would be
  // indistinguishable from a black image. Track failed sources and
  // fall back to the thumbnail — the exact source the grid renders —
  // then to a placeholder, mirroring MediaAssetCard/MediaTableRow.
  // Keyed by URL so a different asset is never affected by a previous
  // asset's failure.
  const [failedSrcs, setFailedSrcs] = useState<ReadonlySet<string>>(new Set());
  const markSrcFailed = (src: string) => {
    setFailedSrcs((prev) => {
      if (prev.has(src)) return prev;
      const next = new Set(prev);
      next.add(src);
      return next;
    });
  };

  // Navigating to another asset restarts playback state (the legacy
  // shell reset the same fields when the item changed).
  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    setFrameSuccessMessage(null);
  }, [item.id]);

  useEffect(() => {
    return () => {
      if (frameSuccessTimerRef.current) {
        clearTimeout(frameSuccessTimerRef.current);
        frameSuccessTimerRef.current = null;
      }
    };
  }, []);

  const imageSrc = isVideo ? null : resolvePreviewImageSrc(item, failedSrcs);
  const videoFailed = isVideo && failedSrcs.has(item.url);
  const showVideoFallbackStill =
    videoFailed && item.thumbnailUrl !== null && !failedSrcs.has(item.thumbnailUrl);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
      setDuration(videoRef.current.duration || 0);
    }
  };

  const handleScrubberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = Number.parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
  };

  const handleTogglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    }
  };

  const handleCaptureFrame = async () => {
    if (!videoRef.current || !onUpdateThumbnail || isCapturingFrame || isBusy) return;
    setIsCapturingFrame(true);
    setFrameSuccessMessage(null);
    try {
      const captured = await captureVideoFrameAsWebp(videoRef.current);
      await onUpdateThumbnail(item.id, captured);
      setFrameSuccessMessage('Frame captured as thumbnail');
      if (frameSuccessTimerRef.current) {
        clearTimeout(frameSuccessTimerRef.current);
      }
      frameSuccessTimerRef.current = setTimeout(
        () => setFrameSuccessMessage(null),
        FRAME_SUCCESS_DURATION_MS
      );
    } finally {
      setIsCapturingFrame(false);
    }
  };

  const mediaWidth = item.width ?? 1280;
  const mediaHeight = item.height ?? 720;
  const showNavigation =
    hasPrevious !== undefined || hasNext !== undefined || Boolean(onPrevious) || Boolean(onNext);

  let mediaContent: React.ReactNode;
  if (isVideo && !videoFailed) {
    mediaContent = (
      <video
        ref={videoRef}
        data-testid="modal-video-player"
        src={item.url}
        // Poster is the captured-frame thumbnail: without it the video
        // element paints black until playback, even though the thumbnail
        // renders fine in the grid.
        poster={item.thumbnailUrl ?? undefined}
        preload="metadata"
        controls={false}
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
        onEnded={() => setIsPlaying(false)}
        onError={() => markSrcFailed(item.url)}
        className="max-h-110 w-full rounded-xs object-contain"
      >
        <track kind="captions" />
      </video>
    );
  } else if (isVideo && showVideoFallbackStill) {
    mediaContent = (
      <Image
        data-testid="modal-video-fallback-still"
        src={item.thumbnailUrl ?? ''}
        alt={item.name}
        width={mediaWidth}
        height={mediaHeight}
        sizes="(max-width: 767px) 100vw, 540px"
        onError={() => {
          if (item.thumbnailUrl) markSrcFailed(item.thumbnailUrl);
        }}
        className="h-auto max-h-110 w-full rounded-xs object-contain"
      />
    );
  } else if (!isVideo && imageSrc) {
    mediaContent = (
      <Image
        data-testid="modal-image-preview"
        src={imageSrc}
        alt={item.name}
        width={mediaWidth}
        height={mediaHeight}
        sizes="(max-width: 767px) 100vw, 540px"
        onError={() => markSrcFailed(imageSrc)}
        className="h-auto max-h-110 w-full rounded-xs object-contain"
      />
    );
  } else {
    mediaContent = (
      <div
        data-testid="modal-preview-placeholder"
        className="flex min-h-50 w-full flex-col items-center justify-center gap-2 rounded-xs bg-subtle text-ink-dim"
      >
        {isVideo ? (
          <FilmIcon className="size-7" aria-hidden />
        ) : (
          <ImageIcon className="size-7" aria-hidden />
        )}
        <span className="text-metadata">Preview unavailable</span>
      </div>
    );
  }

  const navButtonClass =
    'absolute top-1/2 z-10 inline-flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-line bg-neutral-black/75 text-neutral-white backdrop-blur-sm outline-none transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 border-b border-line bg-canvas p-4 sm:p-6 md:border-r md:border-b-0',
        className
      )}
    >
      <div className="relative flex max-h-110 w-full items-center justify-center overflow-hidden rounded-xs">
        {mediaContent}

        {showNavigation ? (
          <>
            <button
              type="button"
              data-testid="preview-prev-btn"
              aria-label="Previous asset"
              disabled={hasPrevious === false || isBusy}
              onClick={onPrevious}
              className={cn(navButtonClass, 'left-2')}
            >
              <ChevronLeftIcon className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              data-testid="preview-next-btn"
              aria-label="Next asset"
              disabled={hasNext === false || isBusy}
              onClick={onNext}
              className={cn(navButtonClass, 'right-2')}
            >
              <ChevronRightIcon className="size-5" aria-hidden />
            </button>
          </>
        ) : null}
      </div>

      {isVideo ? (
        <div className="flex w-full flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTogglePlay}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xs text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            >
              {isPlaying ? (
                <PauseIcon className="size-5" aria-hidden />
              ) : (
                <PlayIcon className="size-5" aria-hidden />
              )}
            </button>

            <input
              type="range"
              aria-label="Seek"
              min={0}
              max={duration || 100}
              step={0.01}
              value={currentTime}
              onChange={handleScrubberChange}
              className="min-w-0 flex-1 cursor-pointer accent-primary"
            />

            <span className="min-w-14 text-right text-metadata text-ink-dim tabular-nums">
              {formatDuration(currentTime) || '0:00'} /{' '}
              {formatDuration(duration || item.durationSeconds) || '0:00'}
            </span>
          </div>

          <div className="flex min-h-11 items-center gap-2">
            <button
              type="button"
              data-testid="set-video-frame-thumbnail-btn"
              aria-label="Set Current Frame as Thumbnail"
              onClick={handleCaptureFrame}
              disabled={isCapturingFrame || isBusy}
              className="cursor-pointer border-0 bg-transparent p-2 text-metadata font-medium text-link outline-none focus-visible:outline-2 focus-visible:outline-link disabled:cursor-wait disabled:opacity-60"
            >
              {isCapturingFrame ? 'Capturing frame...' : 'Capture frame'}
            </button>
            {frameSuccessMessage ? (
              <span className="inline-flex items-center gap-1 text-metadata text-ink-sub">
                <CheckIcon className="size-3.5" aria-hidden />
                {frameSuccessMessage}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
