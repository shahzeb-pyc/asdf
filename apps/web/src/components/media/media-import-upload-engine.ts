'use client';

import { useCallback, useEffect } from 'react';
import { z } from 'zod';
import type { MediaItemResponse } from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  MediaItemSchema,
  UploadUrlResponseSchema,
  type MediaItem as ApiMediaItem,
} from '@/lib/api/schemas/media';
import type { ImportQueueItem } from './media-types';
import {
  deriveDefaultCaption,
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
} from './media-types';
import { toMediaItemResponse } from './media-data';
import {
  generateThumbnailBlob,
  classifyAspectRatio,
  isBatchCompleted,
  probeVideoMetadata,
  MAX_CONCURRENT_UPLOADS,
} from './media-import-utils';

interface UseImportUploadParams {
  subdomain: string;
  selectedFolderId: string | null;
  queue: ImportQueueItem[];
  step: string;
  setQueue: React.Dispatch<React.SetStateAction<ImportQueueItem[]>>;
  setStep: (step: 'staging' | 'progress' | 'complete') => void;
  updateItemProgress: (id: string, pct: number) => void;
  onUploadSuccess?: (item: MediaItemResponse) => void;
}

/** Base delay for upload retry backoff (doubles with each retry). */
const UPLOAD_RETRY_BASE_DELAY_MS = 1000;
/** Max automatic retries after a failed attempt (manual Retry is always available). */
const UPLOAD_MAX_AUTO_RETRIES = 3;

/** Network timeouts: a stalled request must surface an error, never hang at 95%. */
const PRESIGN_TIMEOUT_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 30_000;
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 60_000;
/** Abort the R2 PUT when no bytes move for this long (stall detection). */
const UPLOAD_INACTIVITY_TIMEOUT_MS = 60_000;

/** Progress stages past the 95% XHR cap so the bar keeps moving honestly. */
const PROGRESS_XHR_DONE = 96;
const PROGRESS_THUMBNAIL_DONE = 98;

const TIMEOUT_MESSAGE = 'Upload timed out. Check your connection and try again.';
const NETWORK_MESSAGE = 'Network error during upload. Check your connection and try again.';
const GENERIC_MESSAGE = 'Upload failed. Please try again.';

/** Internal marker for step timeouts (mapped to plain language before display). */
export class StepTimeoutError extends Error {
  constructor(step: string) {
    super(`StepTimeout:${step}`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Map any caught error to plain-language copy safe for the progress row.
 * Technical detail stays in the console; the user sees what to do next.
 */
export function resolveUploadErrorMessage(err: unknown): string {
  if (err instanceof StepTimeoutError) return TIMEOUT_MESSAGE;
  if (err instanceof DOMException && err.name === 'AbortError') return TIMEOUT_MESSAGE;
  if (isApiError(err)) {
    // Typed-client failures (spec 137 §3.1): a request that never reached
    // the server is a connection problem; an aborted one ran out of time
    // (user aborts are filtered before this mapper is consulted). Step
    // functions translate HTTP/parse failures into their own plain
    // messages before rethrowing, so anything else lands on the generic.
    if (err.kind === 'network') return NETWORK_MESSAGE;
    if (err.kind === 'aborted') return TIMEOUT_MESSAGE;
    if (err.kind === 'session-expired') return err.message;
    return GENERIC_MESSAGE;
  }
  if (err instanceof Error) {
    if (err.message === TIMEOUT_MESSAGE || err.message === NETWORK_MESSAGE) return err.message;
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) return NETWORK_MESSAGE;
    // Messages we already wrote in plain language pass through untouched.
    return err.message;
  }
  return GENERIC_MESSAGE;
}

interface StepSignal {
  /** Signal to hand to the typed client: fires on user abort or timeout. */
  signal: AbortSignal;
  /** True when the step's own deadline fired (vs the user's abort). */
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Combine the user's abort signal with a per-step deadline for a typed
 * client call. The typed client has no timeout option of its own; the
 * deadline aborts the request with a StepTimeoutError reason, which the
 * step functions translate back into the timeout path.
 */
function createStepSignal(userSignal: AbortSignal, timeoutMs: number): StepSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new StepTimeoutError('request'));
  }, timeoutMs);
  const onUserAbort = () =>
    controller.abort(userSignal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (userSignal.aborted) {
    onUserAbort();
  } else {
    userSignal.addEventListener('abort', onUserAbort);
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      userSignal.removeEventListener('abort', onUserAbort);
    },
  };
}

/**
 * Translate a typed-client step failure: user aborts and step timeouts
 * keep their dedicated errors; HTTP/parse failures become the step's
 * plain-language message (the server's wording never reaches the row).
 */
function translateStepError(
  err: unknown,
  userSignal: AbortSignal,
  step: StepSignal,
  plainMessage: string
): unknown {
  if (userSignal.aborted) {
    return new DOMException('Upload aborted', 'AbortError');
  }
  if (step.timedOut()) {
    return new StepTimeoutError('request');
  }
  if (isApiError(err) && (err.kind === 'http' || err.kind === 'parse')) {
    return new Error(plainMessage);
  }
  return err;
}

/**
 * fetch with an explicit timeout. The caller's own AbortSignal (pause/cancel)
 * takes precedence: when it fires, the abort is the user's, not a timeout.
 *
 * This survives the typed-client migration for exactly one call: the
 * thumbnail PUT to the presigned storage URL (spec 133 §6.5 — a direct
 * fetch by design: it is not an app-API call, carries no JSON and no
 * schema; its failures degrade to the type-icon fallback like every
 * other engine step's). App-API calls go through the typed client.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  userSignal?: AbortSignal
): Promise<Response> {
  const combined = new AbortController();
  const timer = setTimeout(() => {
    combined.abort(new StepTimeoutError('request'));
  }, timeoutMs);
  const onUserAbort = () => combined.abort(userSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
  userSignal?.addEventListener('abort', onUserAbort);
  try {
    return await fetch(url, { ...init, signal: combined.signal });
  } catch (err) {
    if (userSignal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }
    if (combined.signal.reason instanceof StepTimeoutError) {
      throw combined.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', onUserAbort);
  }
}

/**
 * PUT a file to R2 with real progress events and an inactivity watchdog.
 * Progress is capped at 95 while bytes are in flight; the caller advances it
 * through the thumbnail/confirm stages so the bar never freezes at 95%.
 */
interface R2PutContext {
  xhr: XMLHttpRequest;
  userSignal: AbortSignal;
  onProgress: (pct: number) => void;
  /** Raw bytes moved, for multipart part progress (uncapped, unlike pct). */
  onBytes?: ((loaded: number) => void) | undefined;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  handleUserAbort: () => void;
}

function settleR2Put(ctx: R2PutContext, fn: () => void): void {
  if (ctx.settled) return;
  ctx.settled = true;
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.timer = null;
  ctx.userSignal.removeEventListener('abort', ctx.handleUserAbort);
  fn();
}

function armR2Watchdog(ctx: R2PutContext): void {
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.timer = setTimeout(() => {
    ctx.xhr.abort();
    settleR2Put(ctx, () => ctx.reject(new StepTimeoutError('upload')));
  }, UPLOAD_INACTIVITY_TIMEOUT_MS);
}

function resolveR2Put(ctx: R2PutContext): void {
  if (ctx.xhr.status >= 200 && ctx.xhr.status < 300) {
    ctx.resolve();
  } else {
    ctx.reject(
      new Error(`Upload failed (server responded ${ctx.xhr.status}). Please try again.`)
    );
  }
}

function reportR2Progress(ctx: R2PutContext, e: ProgressEvent): void {
  armR2Watchdog(ctx);
  if (e.lengthComputable) {
    ctx.onProgress(Math.min(95, Math.round((e.loaded / e.total) * 100)));
    ctx.onBytes?.(e.loaded);
  }
}

function putFileToR2(
  uploadUrl: string,
  file: File,
  mimeType: string,
  userSignal: AbortSignal,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const ctx: R2PutContext = {
      xhr,
      userSignal,
      onProgress,
      resolve,
      reject,
      settled: false,
      timer: null,
      handleUserAbort: () => {},
    };
    ctx.handleUserAbort = () => {
      xhr.abort();
      settleR2Put(ctx, () => reject(new DOMException('Upload aborted', 'AbortError')));
    };

    xhr.upload.onprogress = (e) => reportR2Progress(ctx, e);
    xhr.onload = () => settleR2Put(ctx, () => resolveR2Put(ctx));
    xhr.onerror = () => settleR2Put(ctx, () => reject(new Error(NETWORK_MESSAGE)));
    // Backstop for unexpected aborts; the watchdog and user-abort paths
    // already rejected with the right error.
    xhr.onabort = () =>
      settleR2Put(ctx, () => reject(new DOMException('Upload aborted', 'AbortError')));

    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', mimeType);
    userSignal.addEventListener('abort', ctx.handleUserAbort);
    armR2Watchdog(ctx);
    xhr.send(file);
  });
}

interface PresignedUpload {
  mediaUploadUrl: string;
  mediaKey: string;
  mediaId: string;
  thumbnailUploadUrl: string | null;
  thumbnailKey: string | null;
  publicMediaUrl: string;
  publicThumbnailUrl: string | null;
}

interface ThumbnailResult {
  blob: Blob | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** Step 1: request the presigned R2 URLs (typed client, spec 133 §6.5). */
async function requestPresignedUpload(
  subdomain: string,
  item: ImportQueueItem,
  userSignal: AbortSignal
): Promise<PresignedUpload> {
  const step = createStepSignal(userSignal, PRESIGN_TIMEOUT_MS);
  try {
    const presignData = await api.post(
      buildTenantApiPath(subdomain, '/media/upload-url'),
      {
        fileName: item.name,
        fileSize: item.size,
        mimeType: item.mimeType,
      },
      { schema: UploadUrlResponseSchema, signal: step.signal }
    );

    return {
      mediaUploadUrl: presignData.mediaUploadUrl,
      mediaKey: presignData.mediaKey,
      mediaId: presignData.mediaId,
      thumbnailUploadUrl: presignData.thumbnailUploadUrl,
      thumbnailKey: presignData.thumbnailKey,
      publicMediaUrl: presignData.publicMediaUrl,
      publicThumbnailUrl: presignData.publicThumbnailUrl,
    };
  } catch (err) {
    throw translateStepError(
      err,
      userSignal,
      step,
      "Couldn't start the upload. Please try again."
    );
  } finally {
    step.dispose();
  }
}

/** Everything the thumbnail + confirm steps need (no single-PUT URL). */
type UploadTarget = Omit<PresignedUpload, 'mediaUploadUrl'>;

interface MultipartPresigned extends UploadTarget {
  uploadId: string;
}

const MultipartInitiateResponseSchema = z.object({
  mediaId: z.string(),
  mediaKey: z.string(),
  uploadId: z.string(),
  publicMediaUrl: z.string(),
  thumbnailUploadUrl: z.string().nullable(),
  thumbnailKey: z.string().nullable(),
  publicThumbnailUrl: z.string().nullable(),
});

const MultipartPartUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  expiresInSeconds: z.number(),
});

const MultipartCompleteResponseSchema = z.object({
  key: z.string(),
});

/**
 * Multipart upload (P3) — R2's S3-compatible multipart API.
 *
 * VERDICT: supported. The storage layer is an S3 client pointed at
 * R2 (lib/storage.ts), and R2 implements the S3 multipart calls
 * (CreateMultipartUpload / UploadPart / CompleteMultipartUpload),
 * so chunked upload with byte-range resume is available without
 * any new storage provider. The server routes below mint the
 * presigned part URLs; the complete route lists the parts itself
 * (ListParts) instead of trusting client-reported etags, so no
 * CORS exposed-header dependency exists for the ETag.
 *
 * Files over MULTIPART_THRESHOLD_BYTES upload in
 * MULTIPART_PART_SIZE_BYTES parts, sequentially within the file
 * (the 3-file concurrency cap is unchanged). Pause, failure, and
 * presigned-URL expiry resume from the last completed part:
 * completed parts and their byte count live on the queue item and
 * survive pause and auto-retry; a fresh presign is minted per
 * remaining part on every attempt, so an expired URL can never
 * strand a large file. Cancel aborts the server-side upload
 * (best effort) and clears the resume state.
 */

/** A 503 from a multipart step means R2 is not configured here
 *  (dev mock storage) — the caller falls back to the single PUT
 *  instead of failing a file that used to upload fine. */
function isStorageUnavailableError(err: unknown): boolean {
  return isApiError(err) && err.kind === 'http' && err.status === 503;
}

/** Multipart step 1: create the upload server-side (also mints the thumbnail URL). */
async function initiateMultipartUpload(
  subdomain: string,
  item: ImportQueueItem,
  userSignal: AbortSignal
): Promise<MultipartPresigned> {
  const step = createStepSignal(userSignal, PRESIGN_TIMEOUT_MS);
  try {
    const data = await api.post(
      buildTenantApiPath(subdomain, '/media/multipart/initiate'),
      {
        fileName: item.name,
        fileSize: item.size,
        mimeType: item.mimeType,
        thumbnailMimeType: 'image/webp',
      },
      { schema: MultipartInitiateResponseSchema, signal: step.signal }
    );
    return {
      mediaId: data.mediaId,
      mediaKey: data.mediaKey,
      uploadId: data.uploadId,
      thumbnailUploadUrl: data.thumbnailUploadUrl,
      thumbnailKey: data.thumbnailKey,
      publicMediaUrl: data.publicMediaUrl,
      publicThumbnailUrl: data.publicThumbnailUrl,
    };
  } catch (err) {
    // No R2 here (dev mock) must stay recognisable so the caller
    // can fall back to the single PUT instead of failing the file.
    if (isStorageUnavailableError(err)) {
      throw err;
    }
    throw translateStepError(
      err,
      userSignal,
      step,
      "Couldn't start the upload. Please try again."
    );
  } finally {
    step.dispose();
  }
}

/** Multipart step 2a: presign one part (fresh each attempt — expiry-proof). */
async function presignMultipartPart(
  subdomain: string,
  mediaKey: string,
  uploadId: string,
  partNumber: number,
  userSignal: AbortSignal
): Promise<string> {
  const step = createStepSignal(userSignal, PRESIGN_TIMEOUT_MS);
  try {
    const data = await api.post(
      buildTenantApiPath(subdomain, '/media/multipart/part-url'),
      { key: mediaKey, uploadId, partNumber },
      { schema: MultipartPartUrlResponseSchema, signal: step.signal }
    );
    return data.uploadUrl;
  } catch (err) {
    // A vanished server-side upload must stay recognisable so the
    // caller can restart it once instead of failing the file, and
    // a 503 (no R2 here) must stay recognisable for the single-PUT
    // fallback.
    if (
      (isApiError(err) && err.kind === 'http' && /NoSuchUpload/i.test(err.message)) ||
      isStorageUnavailableError(err)
    ) {
      throw err;
    }
    throw translateStepError(
      err,
      userSignal,
      step,
      "Couldn't start the upload. Please try again."
    );
  } finally {
    step.dispose();
  }
}

/** Multipart step 2b: PUT one slice with byte progress + stall watchdog. */
function putPartToR2(
  uploadUrl: string,
  part: Blob,
  mimeType: string,
  userSignal: AbortSignal,
  onBytes: (loaded: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const ctx: R2PutContext = {
      xhr,
      userSignal,
      onProgress: () => {},
      onBytes,
      resolve,
      reject,
      settled: false,
      timer: null,
      handleUserAbort: () => {},
    };
    ctx.handleUserAbort = () => {
      xhr.abort();
      settleR2Put(ctx, () => reject(new DOMException('Upload aborted', 'AbortError')));
    };

    xhr.upload.onprogress = (e) => reportR2Progress(ctx, e);
    xhr.onload = () => settleR2Put(ctx, () => resolveR2Put(ctx));
    xhr.onerror = () => settleR2Put(ctx, () => reject(new Error(NETWORK_MESSAGE)));
    xhr.onabort = () =>
      settleR2Put(ctx, () => reject(new DOMException('Upload aborted', 'AbortError')));

    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', mimeType);
    userSignal.addEventListener('abort', ctx.handleUserAbort);
    armR2Watchdog(ctx);
    xhr.send(part);
  });
}

/** Multipart step 3: assemble the parts server-side (server lists part etags). */
async function completeMultipartUpload(
  subdomain: string,
  mediaKey: string,
  uploadId: string,
  expectedPartCount: number,
  userSignal: AbortSignal
): Promise<void> {
  const step = createStepSignal(userSignal, CONFIRM_TIMEOUT_MS);
  try {
    await api.post(
      buildTenantApiPath(subdomain, '/media/multipart/complete'),
      { key: mediaKey, uploadId, expectedPartCount },
      { schema: MultipartCompleteResponseSchema, signal: step.signal }
    );
  } catch (err) {
    // A vanished server-side upload must stay recognisable so the
    // caller can restart it once instead of failing the file, and
    // a 503 (no R2 here) must stay recognisable for the single-PUT
    // fallback.
    if (
      (isApiError(err) && err.kind === 'http' && /NoSuchUpload/i.test(err.message)) ||
      isStorageUnavailableError(err)
    ) {
      throw err;
    }
    throw translateStepError(
      err,
      userSignal,
      step,
      "Upload finished but we couldn't save it to your library. Please try again."
    );
  } finally {
    step.dispose();
  }
}

/**
 * Multipart step 4 (best effort, never throws): abort the server-side
 * upload when the user cancels, so no orphaned multipart upload
 * lingers in R2. Called from the modal's cancel paths.
 */
export async function abortMultipartUpload(
  subdomain: string,
  mediaKey: string,
  uploadId: string
): Promise<void> {
  try {
    await api.post(
      buildTenantApiPath(subdomain, '/media/multipart/abort'),
      { key: mediaKey, uploadId },
      { schema: z.object({ ok: z.boolean() }) }
    );
  } catch (err) {
    // Best effort only — R2 aborts incomplete multipart uploads
    // on its own lifecycle; a failed abort must never surface to
    // the user, but it is logged instead of swallowed so a broken
    // abort path is observable in devtools.
    console.warn('Multipart abort request failed (best effort, ignoring):', err);
  }
}

/**
 * Run a multipart upload for one file, resuming from the last
 * completed part when the queue item already carries multipart
 * state (paused or auto-retried attempt). Returns the upload
 * target the thumbnail + confirm steps need.
 */
async function runMultipartUpload(
  subdomain: string,
  item: ImportQueueItem,
  userSignal: AbortSignal,
  updateProgress: (id: string, pct: number) => void,
  patchQueue: (id: string, patch: Partial<ImportQueueItem>) => void
): Promise<MultipartPresigned> {
  let presigned: MultipartPresigned;
  const completedParts = new Set<number>(item.multipartCompletedParts ?? []);
  let uploadedBytes = item.multipartUploadedBytes ?? 0;

  if (
    item.multipartUploadId &&
    item.multipartMediaId &&
    item.multipartMediaKey &&
    item.multipartPublicMediaUrl
  ) {
    // Resume: the server-side upload still exists; parts already
    // accepted are never re-sent.
    presigned = {
      mediaId: item.multipartMediaId,
      mediaKey: item.multipartMediaKey,
      uploadId: item.multipartUploadId,
      thumbnailUploadUrl: item.multipartThumbnailUploadUrl ?? null,
      thumbnailKey: item.multipartThumbnailKey ?? null,
      publicMediaUrl: item.multipartPublicMediaUrl,
      publicThumbnailUrl: item.multipartPublicThumbnailUrl ?? null,
    };
  } else {
    presigned = await initiateMultipartUpload(subdomain, item, userSignal);
    patchQueue(item.id, {
      multipartUploadId: presigned.uploadId,
      multipartMediaId: presigned.mediaId,
      multipartMediaKey: presigned.mediaKey,
      multipartThumbnailUploadUrl: presigned.thumbnailUploadUrl ?? undefined,
      multipartThumbnailKey: presigned.thumbnailKey ?? undefined,
      multipartPublicThumbnailUrl: presigned.publicThumbnailUrl ?? undefined,
      multipartPublicMediaUrl: presigned.publicMediaUrl,
      multipartCompletedParts: [],
      multipartUploadedBytes: 0,
    });
  }

  const totalParts = Math.ceil(item.size / MULTIPART_PART_SIZE_BYTES);
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (completedParts.has(partNumber)) continue;
    const start = (partNumber - 1) * MULTIPART_PART_SIZE_BYTES;
    const end = Math.min(start + MULTIPART_PART_SIZE_BYTES, item.size);
    const slice = item.file.slice(start, end);
    // Fresh presign per part on every attempt: a URL that expired
    // while the file was paused cannot strand the upload.
    const partUrl = await presignMultipartPart(
      subdomain,
      presigned.mediaKey,
      presigned.uploadId,
      partNumber,
      userSignal
    );
    await putPartToR2(partUrl, slice, item.mimeType, userSignal, (loaded) => {
      const pct = Math.min(
        95,
        Math.round(((uploadedBytes + loaded) / item.size) * 100)
      );
      updateProgress(item.id, pct);
    });
    uploadedBytes += end - start;
    completedParts.add(partNumber);
    patchQueue(item.id, {
      multipartCompletedParts: [...completedParts],
      multipartUploadedBytes: uploadedBytes,
    });
  }

  await completeMultipartUpload(
    subdomain,
    presigned.mediaKey,
    presigned.uploadId,
    totalParts,
    userSignal
  );
  return presigned;
}

/** Step 3: PUT the client-generated thumbnail (best effort — falls back to the type icon). */
async function uploadThumbnail(
  presigned: UploadTarget,
  thumbData: ThumbnailResult,
  userSignal: AbortSignal
): Promise<string | null> {
  if (!thumbData.blob || !presigned.thumbnailUploadUrl) return null;
  try {
    const thumbRes = await fetchWithTimeout(
      presigned.thumbnailUploadUrl,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: thumbData.blob,
      },
      THUMBNAIL_UPLOAD_TIMEOUT_MS,
      userSignal
    );
    if (userSignal.aborted) throw new DOMException('Upload aborted', 'AbortError');
    return thumbRes.ok ? presigned.publicThumbnailUrl : null;
  } catch {
    if (userSignal.aborted) throw new DOMException('Upload aborted', 'AbortError');
    // Ignore thumbnail upload error; fall back to type icon
    return null;
  }
}

/**
 * Parse the confirm response. The confirm API returns the media item
 * directly as the response body (see
 * `app/api/tenant/[subdomain]/media/confirm/route.ts`: it responds with
 * `MediaItemResponseSchema.parse(...)` unwrapped) — there is no
 * `{ item: ... }` envelope. The typed client validates the body against
 * the lib/api media schema; this maps it onto the contracts surface
 * type the rest of the surface (and `onUploadSuccess`) speaks.
 */
export function parseConfirmUploadResponse(confirmData: unknown): MediaItemResponse {
  return toMediaItemResponse(confirmData as ApiMediaItem);
}

/** Step 4: confirm the upload so it lands in the library (typed client). */
async function confirmMediaUpload(
  subdomain: string,
  selectedFolderId: string | null,
  item: ImportQueueItem,
  presigned: UploadTarget,
  thumbData: ThumbnailResult,
  uploadedThumbnailUrl: string | null,
  userSignal: AbortSignal,
  /** P4: metadata-probe dimensions win over thumbnail dimensions —
   *  the probe survives the thumbnail's 3-second canvas budget. */
  videoMeta?: { width: number; height: number; duration: number | null } | null
): Promise<MediaItemResponse> {
  const step = createStepSignal(userSignal, CONFIRM_TIMEOUT_MS);
  try {
    const width = videoMeta?.width ?? thumbData.width;
    const height = videoMeta?.height ?? thumbData.height;
    const confirmData = await api.post(
      buildTenantApiPath(subdomain, '/media/confirm'),
      {
        mediaId: presigned.mediaId,
        name: item.name,
        fileSize: item.size,
        mimeType: item.mimeType,
        mediaType: item.mediaType,
        storageKey: presigned.mediaKey,
        folderId: selectedFolderId,
        url: presigned.publicMediaUrl,
        thumbnailKey: uploadedThumbnailUrl ? presigned.thumbnailKey : null,
        thumbnailUrl: uploadedThumbnailUrl,
        durationSeconds: videoMeta?.duration ?? thumbData.duration,
        aspectRatio: classifyAspectRatio(width || 0, height || 0),
        width,
        height,
        captionText: deriveDefaultCaption(item.name),
      },
      { schema: MediaItemSchema, signal: step.signal }
    );

    return parseConfirmUploadResponse(confirmData);
  } catch (err) {
    throw translateStepError(
      err,
      userSignal,
      step,
      "Upload finished but we couldn't save it to your library. Please try again."
    );
  } finally {
    step.dispose();
  }
}

/**
 * Requeue a failed attempt after backoff. The timer only fires when this
 * exact attempt is still the live one — a pause, cancel, or manual retry in
 * the meantime leaves the queue untouched.
 */
function scheduleAutoRetry(
  setQueue: React.Dispatch<React.SetStateAction<ImportQueueItem[]>>,
  item: ImportQueueItem,
  attemptController: AbortController
): void {
  setTimeout(() => {
    setQueue((prev) => {
      const current = prev.find((it) => it.id === item.id);
      if (
        current?.status !== 'uploading' ||
        current.abortController !== attemptController
      ) {
        return prev;
      }
      return prev.map((it) =>
        it.id === item.id ? { ...it, status: 'queued', retryCount: it.retryCount + 1 } : it
      );
    });
  }, UPLOAD_RETRY_BASE_DELAY_MS * Math.pow(2, item.retryCount));
}

function markUploadFailed(
  setQueue: React.Dispatch<React.SetStateAction<ImportQueueItem[]>>,
  item: ImportQueueItem,
  message: string
): void {
  setQueue((prev) =>
    prev.map((it) =>
      it.id === item.id ? { ...it, status: 'failed', validationError: message } : it
    )
  );
}

export function useImportUpload({
  subdomain,
  selectedFolderId,
  queue,
  step,
  setQueue,
  setStep,
  updateItemProgress,
  onUploadSuccess,
}: UseImportUploadParams) {
const patchQueueItem = useCallback(
  (id: string, patch: Partial<ImportQueueItem>) => {
    setQueue((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
    );
  },
  [setQueue]
);

const uploadFile = useCallback(
  async (item: ImportQueueItem) => {
    const abortCtrl = new AbortController();
    // Captured so a stale retry timer can never resurrect a paused,
    // cancelled, or already-retried attempt.
    const attemptController = abortCtrl;

    // A resumed multipart file re-enters at its confirmed byte count,
    // never back at 1% — restarting the bar from zero is exactly the
    // silent-restart behaviour P3 forbids.
    const resumePercent =
      item.multipartUploadedBytes && item.multipartUploadedBytes > 0
        ? Math.round((item.multipartUploadedBytes / item.size) * 100)
        : 1;

    setQueue((prev) =>
      prev.map((it) =>
        it.id === item.id
          ? {
              ...it,
              status: 'uploading',
              abortController: abortCtrl,
              progressPercent: resumePercent,
              validationError: null,
            }
          : it
      )
    );

    const userSignal = abortCtrl.signal;

    try {
      let presigned: UploadTarget | null = null;
      if (item.size > MULTIPART_THRESHOLD_BYTES) {
        // P3: large files upload in resumable parts.
        try {
          try {
            presigned = await runMultipartUpload(
              subdomain,
              item,
              userSignal,
              updateItemProgress,
              patchQueueItem
            );
          } catch (err) {
            // The server-side upload vanished (aborted/expired) — start
            // one fresh upload exactly once, then let any further
            // failure take the normal retry path.
            if (!item.multipartRestarted && err instanceof Error && /NoSuchUpload/i.test(err.message)) {
              patchQueueItem(item.id, {
                multipartUploadId: undefined,
                multipartMediaId: undefined,
                multipartMediaKey: undefined,
                multipartThumbnailUploadUrl: undefined,
                multipartThumbnailKey: undefined,
                multipartPublicThumbnailUrl: undefined,
                multipartPublicMediaUrl: undefined,
                multipartCompletedParts: [],
                multipartUploadedBytes: 0,
                multipartRestarted: true,
              });
              presigned = await runMultipartUpload(
                subdomain,
                {
                  ...item,
                  multipartUploadId: undefined,
                  multipartMediaId: undefined,
                  multipartMediaKey: undefined,
                  multipartCompletedParts: [],
                  multipartUploadedBytes: 0,
                  multipartRestarted: true,
                },
                userSignal,
                updateItemProgress,
                patchQueueItem
              );
            } else {
              throw err;
            }
          }
        } catch (err) {
          // No R2 here (dev mock storage): fall through to the
          // single PUT below instead of failing a file that used
          // to upload fine. Any other failure propagates.
          if (!isStorageUnavailableError(err)) throw err;
        }
      }
      if (!presigned) {
        // 1. Request presigned upload URL
        const single = await requestPresignedUpload(subdomain, item, userSignal);

        // 2. Direct R2 upload via XHR for real progress events (watchdog aborts stalls)
        await putFileToR2(single.mediaUploadUrl, item.file, item.mimeType, userSignal, (pct) =>
          updateItemProgress(item.id, pct)
        );
        updateItemProgress(item.id, PROGRESS_XHR_DONE);
        presigned = single;
      }

      // 3. Client-side thumbnail generation (already self-times-out in 3s)
      // plus the P4 metadata probe in parallel: for video, the probe's
      // dimensions/duration survive a thumbnail timeout, so a vertical
      // video still derives as a reel.
      const [thumbData, videoMeta] = await Promise.all([
        generateThumbnailBlob(item.file, item.mediaType),
        item.mediaType === 'video'
          ? probeVideoMetadata(item.file)
          : Promise.resolve(null),
      ]);
      const uploadedThumbnailUrl = await uploadThumbnail(presigned, thumbData, userSignal);
      updateItemProgress(item.id, PROGRESS_THUMBNAIL_DONE);

      // 4. Confirm upload to Supabase DB
      const uploadedItem = await confirmMediaUpload(
        subdomain,
        selectedFolderId,
        item,
        presigned,
        thumbData,
        uploadedThumbnailUrl,
        userSignal,
        videoMeta
      );

      setQueue((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? {
                ...it,
                status: 'completed',
                progressPercent: 100,
                uploadedItem,
                // Resume state is spent: the file is done.
                multipartUploadId: undefined,
                multipartMediaId: undefined,
                multipartMediaKey: undefined,
                multipartThumbnailUploadUrl: undefined,
                multipartThumbnailKey: undefined,
                multipartPublicThumbnailUrl: undefined,
                multipartPublicMediaUrl: undefined,
                multipartCompletedParts: undefined,
                multipartUploadedBytes: undefined,
              }
            : it
        )
      );

      // The typed confirm either returns the item or throws — success
      // is only ever announced with a real, server-confirmed item
      // (spec 114 / UX Rule 17).
      onUploadSuccess?.(uploadedItem);
    } catch (err: unknown) {
      // Pause/cancel: the user stopped this attempt — stay silent, no retry.
      if (userSignal.aborted) {
        return;
      }

      // Auto-retry up to N times with exponential backoff; otherwise surface
      // the real error in plain language with the manual Retry button.
      if (item.retryCount < UPLOAD_MAX_AUTO_RETRIES) {
        scheduleAutoRetry(setQueue, item, attemptController);
      } else {
        markUploadFailed(setQueue, item, resolveUploadErrorMessage(err));
      }
    }
  },
  [subdomain, selectedFolderId, onUploadSuccess, updateItemProgress, patchQueueItem]
);

// Concurrency Engine Loop (Cap = MAX_CONCURRENT_UPLOADS)
useEffect(() => {
  if (step !== 'progress') return;

  const currentUploading = queue.filter((it) => it.status === 'uploading');
  const availableSlots = MAX_CONCURRENT_UPLOADS - currentUploading.length;

  if (availableSlots > 0) {
    const nextItems = queue
      .filter((it) => it.status === 'queued')
      .slice(0, availableSlots);

    for (const item of nextItems) {
      void uploadFile(item);
    }
  }

  if (isBatchCompleted(queue, step)) {
    setStep('complete');
  }
  }, [subdomain, selectedFolderId, queue, step, setQueue, setStep, updateItemProgress, onUploadSuccess]);

  return uploadFile;
}
