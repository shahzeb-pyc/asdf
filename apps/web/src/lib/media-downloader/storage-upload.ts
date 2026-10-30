import { randomUUID } from 'node:crypto';
import {
  MAX_MEDIA_DOWNLOAD_BYTES,
  deriveDefaultCaptionFromFilename,
  validateSafeRemoteUrl,
  type IStorageService,
  type RemoteMediaCandidate,
} from '@fbuploadpro/contracts';
import {
  deriveFileNameFromUrl,
  DownloadAbortedError,
  extractFilenameFromContentDisposition,
  fetchCandidateResponse,
  MediaDownloaderError,
  resolveAllowedMimeType,
  sanitizeFileNameWithExtension,
  validateAndNormalizeStreamUrl,
} from '@fbuploadpro/downloader-engine';
import type { UploadedDownloadedMediaItem } from './index';
import {
  MEDIA_FETCH_TIMEOUT_MS,
  fetchWithTimeoutToHeaders,
} from '@fbuploadpro/downloader-engine';

const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_CAPTION_LENGTH = 5000;

/**
 * Thrown when a stream is abandoned because the caller cancelled it
 * (the worker's cancel watcher). Distinct from MediaDownloaderError so
 * the worker can tell "user cancelled" apart from "download failed"
 * without parsing messages: a cancelled job keeps its `cancelled`
 * status instead of being re-marked failed.
 */
// Single definition lives in @fbuploadpro/downloader-engine; re-exported
// here so the existing `from './storage-upload'` import site keeps working.
export { DownloadAbortedError } from '@fbuploadpro/downloader-engine';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

/**
 * Destination for streamed media bytes (spec 149). The engine never
 * buffers a whole file: chunks flow from the remote response through
 * the sink as they arrive, so a 500 MB file costs one chunk of memory,
 * not 500 MB. The VPS worker supplies an S3 multipart sink; thumbnails
 * (≤10 MB) still use the bounded buffered read below.
 */
export interface MediaStreamSink {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ key: string; byteLength: number; publicUrl: string }>;
  abort(): Promise<void>;
}

export interface StreamDownloadOptions {
  onProgress?: ((progress: DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
  createSink: (key: string, contentType: string) => MediaStreamSink;
}

function assertContentLengthWithinLimit(response: Response, maxBytes: number): void {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) {
    return;
  }
  const declaredSize = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isNaN(declaredSize) && declaredSize > maxBytes) {
    throw new MediaDownloaderError(
      'FILE_TOO_LARGE',
      'This file exceeds the 500 MB maximum size limit.',
      400
    );
  }
}

function concatUint8Chunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  assertContentLengthWithinLimit(response, maxBytes);

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new MediaDownloaderError(
        'FILE_TOO_LARGE',
        'This file exceeds the 500 MB maximum size limit.',
        400
      );
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let exceededLimit = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          exceededLimit = true;
          break;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (exceededLimit) {
    void reader.cancel();
    throw new MediaDownloaderError(
      'FILE_TOO_LARGE',
      'This file exceeds the 500 MB maximum size limit.',
      400
    );
  }

  return concatUint8Chunks(chunks, totalBytes);
}

/**
 * Streams a remote response body through a sink, chunk by chunk. The
 * 500 MB cap is enforced twice: up front when the server declares a
 * content-length over the cap, and mid-stream the moment the running
 * total crosses it — in both cases the partial upload is aborted, so
 * no oversized or partial object survives. Cancellation is checked
 * per chunk; the sink is always aborted on the way out of a failure.
 */
async function streamResponseToSink(
  response: Response,
  sink: MediaStreamSink,
  options: StreamDownloadOptions
): Promise<{ key: string; byteLength: number; publicUrl: string }> {
  assertContentLengthWithinLimit(response, MAX_MEDIA_DOWNLOAD_BYTES);

  const totalHeader = response.headers.get('content-length');
  const parsedTotal = totalHeader ? Number.parseInt(totalHeader, 10) : Number.NaN;
  const totalBytes = Number.isNaN(parsedTotal) ? null : parsedTotal;

  if (!response.body) {
    // A body-less response has no stream to forward; it can only be a
    // tiny (or empty) payload, so the bounded read is safe here.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new MediaDownloaderError(
        'UNSUPPORTED_MEDIA',
        'The remote media file was empty and could not be saved.',
        400
      );
    }
    if (buffer.byteLength > MAX_MEDIA_DOWNLOAD_BYTES) {
      throw new MediaDownloaderError(
        'FILE_TOO_LARGE',
        'This file exceeds the 500 MB maximum size limit.',
        400
      );
    }
    const bytes = new Uint8Array(buffer);
    try {
      await sink.write(bytes);
      options.onProgress?.({ downloadedBytes: bytes.byteLength, totalBytes });
      return await sink.finish();
    } catch (err) {
      await sink.abort().catch(() => undefined);
      throw err;
    }
  }

  const reader = response.body.getReader();
  let downloadedBytes = 0;
  try {
    while (true) {
      if (options.signal?.aborted) {
        throw new DownloadAbortedError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      downloadedBytes += value.byteLength;
      if (downloadedBytes > MAX_MEDIA_DOWNLOAD_BYTES) {
        throw new MediaDownloaderError(
          'FILE_TOO_LARGE',
          'This file exceeds the 500 MB maximum size limit.',
          400
        );
      }
      await sink.write(value);
      options.onProgress?.({ downloadedBytes, totalBytes });
    }
  } catch (err) {
    await sink.abort().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (downloadedBytes === 0) {
    await sink.abort().catch(() => undefined);
    throw new MediaDownloaderError(
      'UNSUPPORTED_MEDIA',
      'The remote media file was empty and could not be saved.',
      400
    );
  }

  try {
    return await sink.finish();
  } catch (err) {
    await sink.abort().catch(() => undefined);
    throw err;
  }
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
  if (!thumbnailUrl) {
    return { thumbnailKey: null, thumbnailUrl: null };
  }

  const safeCheck = validateSafeRemoteUrl(thumbnailUrl);
  if (!safeCheck.valid || !safeCheck.url) {
    return { thumbnailKey: null, thumbnailUrl: null };
  }

  try {
    // Headers-only timeout: the thumbnail body is read as a stream
    // below, so a whole-request signal would abort it mid-read.
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
    if (!response.ok) {
      return { thumbnailKey: null, thumbnailUrl: null };
    }
    if (response.url && !validateSafeRemoteUrl(response.url).valid) {
      return { thumbnailKey: null, thumbnailUrl: null };
    }

    const rawMime = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase();
    const format = classifyThumbnailFormat(rawMime, safeCheck.url.pathname);
    if (!format) {
      return { thumbnailKey: null, thumbnailUrl: null };
    }

    const bytes = await readResponseBytesWithLimit(response, MAX_THUMBNAIL_BYTES);
    if (bytes.byteLength === 0) {
      return { thumbnailKey: null, thumbnailUrl: null };
    }

    const thumbnailKey = `users/${userId}/thumbnails/${mediaId}.${format.ext}`;
    const uploaded = await storage.putObject({
      key: thumbnailKey,
      body: bytes,
      contentType: format.mime,
    });

    return {
      thumbnailKey: uploaded.key,
      thumbnailUrl: uploaded.publicUrl,
    };
  } catch {
    // Non-fatal: if optional video thumbnail download fails, proceed with the saved video
    return { thumbnailKey: null, thumbnailUrl: null };
  }
}

export async function downloadAndStoreSingleCandidate(
  candidate: RemoteMediaCandidate,
  index: number,
  userId: string,
  storage: IStorageService,
  fetchFn: typeof fetch,
  prefetchedResponse?: Response,
  streamOptions?: StreamDownloadOptions
): Promise<UploadedDownloadedMediaItem> {
  if (streamOptions?.signal?.aborted) {
    throw new DownloadAbortedError();
  }
  if (!streamOptions) {
    // The media-bytes path streams by design (spec 149): a caller that
    // cannot supply a sink has no way to receive the bytes. Thumbnails
    // still use `storage.putObject` directly (bounded, ≤10 MB).
    throw new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      'Streaming upload is required to save this media.',
      502
    );
  }

  const normalizedStreamUrl = validateAndNormalizeStreamUrl(candidate.streamUrl);
  const response = await fetchCandidateResponse(
    normalizedStreamUrl,
    fetchFn,
    prefetchedResponse
  );

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

  const mediaId = randomUUID();
  const fallbackBase = index === 0 ? 'downloaded_media' : `downloaded_media_${index + 1}`;
  const sanitizedFileName = sanitizeFileNameWithExtension(rawFileName, mimeType, fallbackBase);
  const storageKey = `users/${userId}/media/${mediaId}/${sanitizedFileName}`;

  const uploadRes = await streamResponseToSink(
    response,
    streamOptions.createSink(storageKey, mimeType),
    streamOptions
  );

  const mediaType: 'video' | 'image' = mimeType.startsWith('video/') ? 'video' : 'image';
  const thumbResult =
    mediaType === 'image'
      ? { thumbnailKey: null, thumbnailUrl: uploadRes.publicUrl }
      : await tryUploadVideoThumbnail(
          candidate.thumbnailUrl,
          userId,
          mediaId,
          storage,
          fetchFn
        );

  const trimmedCaption = candidate.caption?.trim() ?? '';
  const captionText =
    trimmedCaption.length > 0
      ? trimmedCaption.slice(0, MAX_CAPTION_LENGTH)
      : deriveDefaultCaptionFromFilename(sanitizedFileName);

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
    durationSeconds: candidate.durationSeconds ?? null,
    aspectRatio: candidate.aspectRatio ?? 'unknown',
    captionText,
  };
}
