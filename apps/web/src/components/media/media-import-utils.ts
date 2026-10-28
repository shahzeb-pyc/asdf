'use client';

export const MAX_CONCURRENT_UPLOADS = 3;
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

import { AllowedMediaMimeTypes } from '@fbuploadpro/contracts';
import type { ImportQueueItem } from './media-types';

/** The contracts tuple widened once, so membership checks stay typed. */
const ALLOWED_MIME_TYPES: readonly string[] = AllowedMediaMimeTypes;

const EXTENSION_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function resolveMimeType(file: File): string {
  if (file.type && ALLOWED_MIME_TYPES.includes(file.type)) {
    return file.type;
  }
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return EXTENSION_TO_MIME[ext] || '';
}

export function resolveMediaType(mimeType: string): 'video' | 'image' {
  return mimeType.startsWith('video/') ? 'video' : 'image';
}

export function classifyAspectRatio(width: number, height: number): string {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.08) return '9:16';
  if (Math.abs(ratio - 16 / 9) < 0.08) return '16:9';
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  if (Math.abs(ratio - 4 / 5) < 0.08) return '4:5';
  return `${width}:${height}`;
}

export async function generateThumbnailBlob(
  file: File,
  mediaType: 'video' | 'image'
): Promise<{ blob: Blob | null; width: number | null; height: number | null; duration: number | null }> {
  const fallback = { blob: null, width: null, height: null, duration: null };
  if (typeof window === 'undefined') return fallback;

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(fallback);
      }
    }, 3000);

    const finish = (result: { blob: Blob | null; width: number | null; height: number | null; duration: number | null }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      const url = URL.createObjectURL(file);

      if (mediaType === 'image') {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const maxDim = 480;
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(img, 0, 0, w, h);
            canvas.toBlob(
              (blob) => {
                URL.revokeObjectURL(url);
                finish({ blob, width: img.width, height: img.height, duration: null });
              },
              'image/webp',
              0.82
            );
          } catch {
            URL.revokeObjectURL(url);
            finish(fallback);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          finish(fallback);
        };
        img.src = url;
      } else {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';

        video.onloadedmetadata = () => {
          video.currentTime = Math.min(1.0, (video.duration || 1) / 2);
        };

        video.onseeked = () => {
          try {
            const canvas = document.createElement('canvas');
            const maxDim = 480;
            let w = video.videoWidth;
            let h = video.videoHeight;
            if (w > maxDim || h > maxDim) {
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
            }
            canvas.width = w || 320;
            canvas.height = h || 240;
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                URL.revokeObjectURL(url);
                finish({
                  blob,
                  width: video.videoWidth || null,
                  height: video.videoHeight || null,
                  duration: Number.isFinite(video.duration) ? video.duration : null,
                });
              },
              'image/webp',
              0.82
            );
          } catch {
            URL.revokeObjectURL(url);
            finish(fallback);
          }
        };

        video.onerror = () => {
          URL.revokeObjectURL(url);
          finish(fallback);
        };
        video.src = url;
      }
    } catch {
      finish(fallback);
    }
  });
}
let itemSeq = 0;
export function nextUniqueId(): string {
  itemSeq += 1;
  return `${Date.now()}-${itemSeq}`;
}

/**
 * Video metadata probe (P4) — separate from the thumbnail budget.
 *
 * `generateThumbnailBlob` renders a canvas frame under a 3-second
 * timeout; when that gives up, the video's dimensions were lost
 * and a vertical video silently derived as a plain video post
 * instead of a reel. This probe reads only the metadata
 * (dimensions + duration, no seek, no canvas) under its own
 * longer 15-second budget, so the derivation rule ("a reel must
 * be proven vertical") keeps getting real dimensions even when
 * thumbnail rendering times out. Returns null on any failure —
 * callers fall back to whatever the thumbnail step found.
 */
export async function probeVideoMetadata(file: File): Promise<{
  width: number;
  height: number;
  duration: number | null;
} | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const objectUrl = URL.createObjectURL(file);
    let settled = false;
    const finish = (result: {
      width: number;
      height: number;
      duration: number | null;
    } | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(null), 15_000);
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish({
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : null,
        });
      } else {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = objectUrl;
  });
}

export function computeFurthestAlong(
  uploadingItems: ImportQueueItem[]
): { name: string; progressPercent: number } | null {
  if (uploadingItems.length === 0) return null;
  return uploadingItems.reduce<{ name: string; progressPercent: number } | null>((acc, curr) => {
    if (!acc || curr.progressPercent > acc.progressPercent) {
      return { name: curr.name, progressPercent: curr.progressPercent };
    }
    return acc;
  }, null);
}

export function validateFileForImport(file: File, mime: string): string | null {
  if (file.size === 0) {
    return 'empty file';
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'too large — 500 MB max';
  }
  if (!mime || !ALLOWED_MIME_TYPES.includes(mime)) {
    return "can't upload — not a supported format";
  }
  return null;
}

export function createImagePreviewUrl(file: File, mime: string): string | null {
  if (!mime.startsWith('image/')) return null;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  // A preview is best-effort presentation: when the platform cannot mint
  // an object URL the row degrades to its type icon (the staging row's
  // fallback), so the failure is absorbed by assignment, never a throw
  // into the staging path.
  let previewUrl: string | null = null;
  try {
    previewUrl = URL.createObjectURL(file);
  } catch {
    previewUrl = null;
  }
  return previewUrl;
}

export function generateQueueItemId(): string {
  const uniqueId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : nextUniqueId();
  return `item-${Date.now()}-${uniqueId}`;
}

export function buildImportQueueItems(
  files: File[],
  folderId: string | null,
  existingQueue: ImportQueueItem[] = []
): ImportQueueItem[] {
  const existingKeys = new Set(existingQueue.map((item) => `${item.name}-${item.size}`));
  const existingNames = new Set(existingQueue.map((item) => item.name));
  const newItems: ImportQueueItem[] = [];

  for (const file of files) {
    const key = `${file.name}-${file.size}`;
    if (existingKeys.has(key)) continue;

    const mime = resolveMimeType(file);
    const isDuplicateName =
      existingNames.has(file.name) ||
      newItems.some((it) => it.name === file.name);

    newItems.push({
      id: generateQueueItemId(),
      file,
      name: file.name,
      size: file.size,
      mimeType: mime,
      mediaType: resolveMediaType(mime),
      destinationFolderId: folderId,
      status: 'staged',
      progressPercent: 0,
      isDuplicate: isDuplicateName,
      validationError: validateFileForImport(file, mime),
      retryCount: 0,
      previewUrl: createImagePreviewUrl(file, mime),
    });
  }

  return newItems;
}

export function isItemReadyToImport(item: ImportQueueItem): boolean {
  return item.status === 'staged' && !item.validationError && !item.isDuplicate;
}

export function isBatchCompleted(queue: ImportQueueItem[], step: string): boolean {
  if (step !== 'progress' || queue.length === 0) return false;
  // A paused file is still pending: the batch must never report "complete"
  // while any item is queued, uploading, or paused.
  const pending = queue.filter(
    (it) => it.status === 'queued' || it.status === 'uploading' || it.status === 'paused'
  );
  if (pending.length > 0) return false;
  return queue.some(
    (it) => it.status === 'completed' || it.status === 'failed' || it.status === 'cancelled'
  );
}
