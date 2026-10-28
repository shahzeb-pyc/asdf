'use client';

import { deriveDefaultCaptionFromFilename, type MediaItemResponse } from '@fbuploadpro/contracts';

export type UploadStatus =
  | 'staged'
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ImportQueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  mediaType: 'video' | 'image';
  destinationFolderId: string | null;
  status: UploadStatus;
  progressPercent: number;
  isDuplicate: boolean;
  duplicateResolution?: 'skip' | 'upload_anyway' | 'keep';
  validationError?: string | null;
  abortController?: AbortController;
  retryCount: number;
  previewUrl?: string | null;
  uploadedItem?: MediaItemResponse;
  /** Resumable-upload state (P3): only for files over
   *  MULTIPART_THRESHOLD_BYTES. Survives pause and auto-retry so a
   *  large file resumes from its last completed part instead of
   *  restarting from zero. Cleared on cancel. (Each field carries
   *  an explicit `| undefined`: the repo typechecks with
   *  exactOptionalPropertyTypes, so clearing a field with
   *  `undefined` must be assignable.) */
  multipartUploadId?: string | undefined;
  multipartMediaId?: string | undefined;
  multipartMediaKey?: string | undefined;
  multipartThumbnailUploadUrl?: string | undefined;
  multipartThumbnailKey?: string | undefined;
  multipartPublicThumbnailUrl?: string | undefined;
  /** Parts the server has already accepted (part numbers only — the
   *  complete route lists etags itself, so no etag round-trips). */
  multipartCompletedParts?: number[] | undefined;
  /** Bytes confirmed uploaded across completed parts. */
  multipartUploadedBytes?: number | undefined;
  /** Public URL of the assembled object (for the confirm step). */
  multipartPublicMediaUrl?: string | undefined;
  /** True once a NoSuchUpload restart has been spent for this file. */
  multipartRestarted?: boolean | undefined;
}

/**
 * Multipart (resumable) uploads (P3): files larger than this use
 * R2's S3-compatible multipart API instead of a single PUT, so
 * pause, failure, and presigned-URL expiry resume from the last
 * completed part. Parts are 8 MiB (above S3's 5 MiB minimum for
 * non-final parts); a file just over the threshold still splits
 * into at least two parts.
 */
export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Byte-weighted overall progress (P9): uploaded bytes are the
 * completed files' full sizes plus each in-flight file's size
 * scaled by its per-file percent (which the XHR already reports
 * in bytes). This replaces the unweighted per-file percent
 * average, where ten 1 KB files finishing outweighed one 400 MB
 * file barely started.
 */
export function computeOverallBytesProgress(items: ImportQueueItem[]): {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
} {
  const counted = items.filter((item) => item.status !== 'cancelled');
  const totalBytes = counted.reduce((sum, item) => sum + item.size, 0);
  const uploadedBytes = counted.reduce((sum, item) => {
    if (item.status === 'completed') return sum + item.size;
    return sum + Math.round((item.size * item.progressPercent) / 100);
  }, 0);
  return {
    uploadedBytes,
    totalBytes,
    percent: totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100),
  };
}

export type BatchCaptionMode = 'replace' | 'append';

export function deriveDefaultCaption(fileName: string): string {
  return deriveDefaultCaptionFromFilename(fileName);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatUploadDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const totalSec = Math.round(seconds);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatMediaDetails(
  aspectRatio: string | null | undefined,
  durationSeconds: number | null | undefined
): string {
  const parts: string[] = [];
  if (aspectRatio && aspectRatio !== 'unknown') {
    parts.push(aspectRatio);
  }
  const dur = formatDuration(durationSeconds);
  if (dur) {
    parts.push(dur);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}


export type MediaViewMode = 'grid' | 'table';
export type MediaTypeFilterKey = 'all' | 'video' | 'image';
export type AspectRatioFilterKey = 'all' | '9:16' | '16:9' | '1:1' | '4:5';
export type CaptionStatusFilterKey = 'all' | 'has_caption' | 'empty_caption';
export type SortOptionKey =
  | 'created_at:desc'
  | 'created_at:asc'
  | 'name:asc'
  | 'file_size:desc';

export type MediaSmartViewKey = 'everything' | 'needs_caption';
