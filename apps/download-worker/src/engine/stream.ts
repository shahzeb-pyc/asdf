import {
  DOWNLOAD_JOB_MAX_BYTES,
  deriveDefaultCaptionFromFilename,
  validateSafeRemoteUrl,
  type IStorageService,
  type RemoteMediaCandidate,
} from '@fbuploadpro/contracts';
import {
  deriveFileNameFromUrl,
  extractFilenameFromContentDisposition,
  fetchCandidateResponse,
  fetchWithTimeoutToHeaders,
  MediaDownloaderError,
  MEDIA_FETCH_TIMEOUT_MS,
  resolveAllowedMimeType,
  ResumeUnsupportedError,
  sanitizeFileNameWithExtension,
  validateAndNormalizeStreamUrl,
  type AllowedMediaMime,
} from '@fbuploadpro/downloader-engine';

/**
 * Workers-native single-candidate stream (spec 149 backend revision
 * §3, §6). This replaces the web storage-upload orchestrator for the
 * Worker: same mime/filename/caption/thumbnail/cap rules, but with
 * Range resume, a forced media id for the first item (the
 * pending_media_id fix, §4.1), and no Node APIs — media id comes
 * from crypto.randomUUID(), never node:crypto.
 *
 * Candidates are processed SEQUENTIALLY by the caller (§3.2): one
 * invocation has 6 simultaneous outgoing connections and 128 MB
 * memory, so parallel candidate streams are not attempted.
 */

const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_CAPTION_LENGTH = 5000;

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

/** Destination for streamed media bytes. Same shape as the web sink. */
export interface MediaStreamSink {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ key: string; byteLength: number; publicUrl: string }>;
  abort(): Promise<void>;
}

export interface ResumeState {
  /** Resolved media URL the checkpoint belongs to. */
  streamUrl: string;
  /** Bytes already uploaded for that URL. */
  bytes: number;
}

export interface DownloadedItem {
  mediaId: string;
  name: string;
  fileSize: number;
  mimeType: AllowedMediaMime;
  mediaType: 'video' | 'image';
  storageKey: string;
  url: string;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  aspectRatio: string;
  captionText: string;
}

export interface StreamCandidateOptions {
  candidate: RemoteMediaCandidate;
  index: number;
  userId: string;
  storage: IStorageService;
  fetchFn?: typeof fetch | undefined;
  /** Prefetched direct-media response from resolution (non-resume only). */
  prefetchedResponse?: Response | undefined;
  /** Media id to use for this item; defaults to a fresh random id. */
  forcedMediaId?: string | undefined;
  /** Resume state for this candidate's stream, when checkpointed. */
  resume?: ResumeState | undefined;
  onProgress?: ((progress: DownloadProgress) => void) | undefined;
  createSink: (key: string, contentType: string) => MediaStreamSink;
}

function assertWithinCap(declaredBytes: number | null, startByte: number): void {
  if (declaredBytes !== null && startByte + declaredBytes > DOWNLOAD_JOB_MAX_BYTES) {
    throw new MediaDownloaderError(
      'FILE_TOO_LARGE',
      'This file exceeds the 500 MB maximum size limit.',
      400
    );
  }
}

function parseContentLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (!header) return null;
  const parsed = Number.parseInt(header, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = parseContentLength(response);
  if (declared !== null && declared > maxBytes) {
    throw new MediaDownloaderError('FILE_TOO_LARGE', 'This file exceeds the 500 MB maximum size limit.', 400);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new MediaDownloaderError('FILE_TOO_LARGE', 'This file exceeds the 500 MB maximum size limit.', 400);
    }
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MediaDownloaderError('FILE_TOO_LARGE', 'This file exceeds the 500 MB maximum size limit.', 400);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function classifyThumbnailFormat(
  rawMime: string | undefined,
  pathname: string
): { mime: 'image/webp' | 'image/jpeg'; ext: 'webp' | 'jpeg' } | null {
  const lowerPath = pathname.toLowerCase();
  if (rawMime === 'image/webp' || lowerPath.endsWith('.webp')) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (
    rawMime === 'image/jpeg' ||
    rawMime === 'image/jpg' ||
    lowerPath.endsWith('.jpg') ||
    lowerPath.endsWith('.jpeg')
  ) {
    return { mime: 'image/jpeg', ext: 'jpeg' };
  }
  return null;
}

async function tryUploadVideoThumbnail(
  thumbnailUrl: string | null | undefined,
  userId: string,
  mediaId: string,
  storage: IStorageService,
  fetchFn: typeof fetch
): Promise<{ thumbnailKey: string | null; thumbnailUrl: string | null }> {
  if (!thumbnailUrl) return { thumbnailKey: null, thumbnailUrl: null };
  const safeCheck = validateSafeRemoteUrl(thumbnailUrl);
  if (!safeCheck.valid || !safeCheck.url) return { thumbnailKey: null, thumbnailUrl: null };
  try {
    const response = await fetchWithTimeoutToHeaders(
      safeCheck.url.toString(),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FBUploadProMediaBot/1.0)',
          Accept: 'image/webp,image/jpeg,image/*,*/*;q=0.8',
        },
      },
      MEDIA_FETCH_TIMEOUT_MS,
      fetchFn
    );
    if (!response.ok) return { thumbnailKey: null, thumbnailUrl: null };
    if (response.url && !validateSafeRemoteUrl(response.url).valid) {
      return { thumbnailKey: null, thumbnailUrl: null };
    }
    const rawMime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    const format = classifyThumbnailFormat(rawMime, safeCheck.url.pathname);
    if (!format) return { thumbnailKey: null, thumbnailUrl: null };
    const bytes = await readBoundedBytes(response, MAX_THUMBNAIL_BYTES);
    if (bytes.byteLength === 0) return { thumbnailKey: null, thumbnailUrl: null };
    const thumbnailKey = `users/${userId}/thumbnails/${mediaId}.${format.ext}`;
    const uploaded = await storage.putObject({
      key: thumbnailKey,
      body: bytes,
      contentType: format.mime,
    });
    return { thumbnailKey: uploaded.key, thumbnailUrl: uploaded.publicUrl };
  } catch {
    // Non-fatal: an optional thumbnail failure never fails the video.
    return { thumbnailKey: null, thumbnailUrl: null };
  }
}

async function streamToSink(
  response: Response,
  sink: MediaStreamSink,
  startByte: number,
  totalBytes: number | null,
  onProgress: ((progress: DownloadProgress) => void) | undefined
): Promise<{ key: string; byteLength: number; publicUrl: string }> {
  if (!response.body) {
    // A null body is always empty (null-body / 204 / HEAD responses):
    // there are no bytes to write, so this is the empty-stream case.
    // (The write path below is unreachable for a null body and was
    // removed rather than left as uncovered dead code.)
    throw new MediaDownloaderError(
      'UNSUPPORTED_MEDIA',
      'The remote media file was empty and could not be saved.',
      400
    );
  }

  const reader = response.body.getReader();
  let streamed = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        streamed += value.byteLength;
        if (startByte + streamed > DOWNLOAD_JOB_MAX_BYTES) {
          throw new MediaDownloaderError('FILE_TOO_LARGE', 'This file exceeds the 500 MB maximum size limit.', 400);
        }
        await sink.write(value);
        onProgress?.({ downloadedBytes: startByte + streamed, totalBytes });
      }
    }
  } catch (err) {
    await sink.abort().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (streamed === 0 && startByte === 0) {
    await sink.abort().catch(() => undefined);
    throw new MediaDownloaderError(
      'UNSUPPORTED_MEDIA',
      'The remote media file was empty and could not be saved.',
      400
    );
  }
  // A resume that yields zero new bytes with a checkpoint behind it
  // still completes the existing multipart upload (parts already
  // uploaded); a fresh zero-byte stream is the unsupported case above.
  try {
    return await sink.finish();
  } catch (err) {
    await sink.abort().catch(() => undefined);
    throw err;
  }
}

// Resumes a checkpointed stream: Range request, redirect safety
// re-check, and the 500 MB cap against remaining + already-stored
// bytes. A 200 means the source refuses Range — the caller restarts
// from byte 0 once (ResumeUnsupportedError).
async function fetchResumeResponse(
  normalizedStreamUrl: string,
  resumeBytes: number,
  fetchFn: typeof fetch
): Promise<{ response: Response; startByte: number }> {
  let response: Response;
  try {
    response = await fetchWithTimeoutToHeaders(
      normalizedStreamUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FBUploadProMediaBot/1.0)',
          Accept: '*/*',
          Range: `bytes=${resumeBytes}-`,
        },
        redirect: 'follow',
      },
      MEDIA_FETCH_TIMEOUT_MS,
      fetchFn
    );
  } catch {
    throw new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      'Could not connect to the remote media server. Please try again.',
      502
    );
  }
  if (response.url) {
    const redirectSafety = validateSafeRemoteUrl(response.url);
    if (!redirectSafety.valid) {
      throw new MediaDownloaderError(
        'UNSAFE_URL',
        redirectSafety.reason ?? 'Redirected to an unsafe network address.',
        400
      );
    }
  }
  if (response.status === 200) {
    throw new ResumeUnsupportedError();
  }
  if (!response.ok) {
    throw new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      `Remote server returned status ${response.status} while downloading media.`,
      502
    );
  }
  assertWithinCap(parseContentLength(response), resumeBytes);
  return { response, startByte: resumeBytes };
}

async function fetchStreamResponse(
  normalizedStreamUrl: string,
  resume: ResumeState | undefined,
  fetchFn: typeof fetch,
  prefetchedResponse: Response | undefined
): Promise<{ response: Response; startByte: number; resumeApplies: boolean }> {
  const resumeApplies =
    resume !== undefined &&
    resume.streamUrl === normalizedStreamUrl &&
    resume.bytes > 0;
  if (resumeApplies && resume) {
    const { response, startByte } = await fetchResumeResponse(
      normalizedStreamUrl,
      resume.bytes,
      fetchFn
    );
    return { response, startByte, resumeApplies };
  }
  const response = await fetchCandidateResponse(
    normalizedStreamUrl,
    fetchFn,
    prefetchedResponse
  );
  assertWithinCap(parseContentLength(response), 0);
  return { response, startByte: 0, resumeApplies };
}

function resolveMediaIdentity(
  response: Response,
  normalizedStreamUrl: string,
  candidate: StreamCandidateOptions['candidate'],
  index: number,
  userId: string,
  forcedMediaId: string | undefined
): {
  mimeType: AllowedMediaMime;
  mediaId: string;
  sanitizedFileName: string;
  storageKey: string;
  mediaType: 'video' | 'image';
} {
  const effectiveUrl = response.url || normalizedStreamUrl;
  const dispositionName = extractFilenameFromContentDisposition(
    response.headers.get('content-disposition')
  );
  const rawFileName =
    candidate.fileName ?? dispositionName ?? deriveFileNameFromUrl(effectiveUrl, index);
  const mimeType = resolveAllowedMimeType(
    response.headers.get('content-type'),
    effectiveUrl,
    rawFileName,
    candidate.mediaTypeHint
  );
  if (!mimeType) {
    throw new MediaDownloaderError(
      'UNSUPPORTED_MEDIA',
      'No supported video or image (MP4, MOV, WebM, JPEG, PNG, or WebP) was found at this link.',
      400
    );
  }
  const mediaId = forcedMediaId ?? crypto.randomUUID();
  const fallbackBase = index === 0 ? 'downloaded_media' : `downloaded_media_${index + 1}`;
  const sanitizedFileName = sanitizeFileNameWithExtension(rawFileName, mimeType, fallbackBase);
  const storageKey = `users/${userId}/media/${mediaId}/${sanitizedFileName}`;
  const mediaType: 'video' | 'image' = mimeType.startsWith('video/') ? 'video' : 'image';
  return { mimeType, mediaId, sanitizedFileName, storageKey, mediaType };
}

function resolveCaption(caption: string | null | undefined, sanitizedFileName: string): string {
  const trimmedCaption = caption?.trim() ?? '';
  return trimmedCaption.length > 0
    ? trimmedCaption.slice(0, MAX_CAPTION_LENGTH)
    : deriveDefaultCaptionFromFilename(sanitizedFileName);
}

export async function downloadAndStoreCandidate(
  options: StreamCandidateOptions
): Promise<DownloadedItem> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const normalizedStreamUrl = validateAndNormalizeStreamUrl(options.candidate.streamUrl);
  const { response, startByte, resumeApplies } = await fetchStreamResponse(
    normalizedStreamUrl,
    options.resume,
    fetchFn,
    options.prefetchedResponse
  );
  const { mimeType, mediaId, sanitizedFileName, storageKey, mediaType } =
    resolveMediaIdentity(
      response,
      normalizedStreamUrl,
      options.candidate,
      options.index,
      options.userId,
      options.forcedMediaId
    );

  const uploadRes = await streamToSink(
    response,
    options.createSink(storageKey, mimeType),
    startByte,
    (() => {
      const remaining = parseContentLength(response);
      if (remaining === null) return null;
      return resumeApplies ? startByte + remaining : remaining;
    })(),
    options.onProgress
  );

  const thumbResult =
    mediaType === 'image'
      ? { thumbnailKey: null, thumbnailUrl: uploadRes.publicUrl }
      : await tryUploadVideoThumbnail(
          options.candidate.thumbnailUrl,
          options.userId,
          mediaId,
          options.storage,
          fetchFn
        );

  return {
    mediaId,
    name: sanitizedFileName,
    fileSize: uploadRes.byteLength,
    mimeType,
    mediaType,
    storageKey: uploadRes.key,
    url: uploadRes.publicUrl,
    thumbnailKey: thumbResult.thumbnailKey,
    thumbnailUrl: thumbResult.thumbnailUrl,
    durationSeconds: options.candidate.durationSeconds ?? null,
    aspectRatio: options.candidate.aspectRatio ?? 'unknown',
    captionText: resolveCaption(options.candidate.caption, sanitizedFileName),
  };
}
