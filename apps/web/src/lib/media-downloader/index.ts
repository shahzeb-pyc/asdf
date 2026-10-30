import {
  detectSourcePlatform,
  validateSafeRemoteUrl,
  type DownloaderSourcePlatform,
  type IStorageService,
} from '@fbuploadpro/contracts';
import {
  MediaDownloaderError,
  resolveCandidatesBuiltIn,
  tryResolveViaExternalExtractor,
} from '@fbuploadpro/downloader-engine';
import { downloadAndStoreSingleCandidate } from './storage-upload';
import type { AllowedMediaMime } from '@fbuploadpro/downloader-engine';

export type { RemoteMediaCandidate } from '@fbuploadpro/contracts';

export { normalizeCloudDriveUrl } from '@fbuploadpro/contracts';

export {
  resolveAllowedMimeType,
  type AllowedMediaMime,
  MediaDownloaderError,
  type DownloaderErrorCode,
} from '@fbuploadpro/downloader-engine';

export {
  DownloadAbortedError,
  type DownloadProgress,
  type MediaStreamSink,
  type StreamDownloadOptions,
} from './storage-upload';

export interface UploadedDownloadedMediaItem {
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

export interface ResolveAndUploadMediaParams {
  sourceUrl: string;
  userId: string;
  storage: IStorageService;
  fetchImpl?: typeof fetch | undefined;
  extractorApiUrl?: string | null | undefined;
  /**
   * Live byte progress for the caller (the worker maps it onto the job
   * row). For multi-item links this reports the item currently
   * streaming; single-item links — the overwhelmingly common case —
   * report exact progress.
   */
  onProgress?: ((progress: import('./storage-upload').DownloadProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Sink for the streamed media bytes (spec 149: never buffered whole). */
  createSink: (
    key: string,
    contentType: string
  ) => import('./storage-upload').MediaStreamSink;
}

export interface ResolveAndUploadMediaResult {
  sourceUrl: string;
  platform: DownloaderSourcePlatform;
  items: UploadedDownloadedMediaItem[];
}

export async function resolveAndUploadMediaFromUrl(
  params: ResolveAndUploadMediaParams
): Promise<ResolveAndUploadMediaResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const sourceValidation = validateSafeRemoteUrl(params.sourceUrl);
  if (!sourceValidation.valid || !sourceValidation.url) {
    throw new MediaDownloaderError(
      'UNSAFE_URL',
      sourceValidation.reason ?? 'Please enter a valid public http:// or https:// link.',
      400
    );
  }

  const canonicalSourceUrl = sourceValidation.url.toString();
  const platform = detectSourcePlatform(canonicalSourceUrl);
  const configuredExtractorUrl =
    params.extractorApiUrl === undefined
      ? (process.env.DOWNLOADER_EXTRACTOR_API_URL ?? null)
      : params.extractorApiUrl;

  let candidates = await tryResolveViaExternalExtractor(
    configuredExtractorUrl,
    canonicalSourceUrl,
    fetchFn
  );
  let prefetchedBinaryResponse: Response | undefined;

  if (candidates.length === 0) {
    const builtIn = await resolveCandidatesBuiltIn(sourceValidation.url, platform, fetchFn);
    candidates = builtIn.candidates;
    prefetchedBinaryResponse = builtIn.prefetchedBinaryResponse;
  }

  if (candidates.length === 0) {
    throw new MediaDownloaderError(
      'UNSUPPORTED_MEDIA',
      'No downloadable video or image was found at this link.',
      400
    );
  }

  const results = await Promise.allSettled(
    candidates.map((candidate, idx) =>
      downloadAndStoreSingleCandidate(
        candidate,
        idx,
        params.userId,
        params.storage,
        fetchFn,
        idx === 0 ? prefetchedBinaryResponse : undefined,
        {
          onProgress: params.onProgress,
          signal: params.signal,
          createSink: params.createSink,
        }
      )
    )
  );

  const successfulItems: UploadedDownloadedMediaItem[] = [];
  let firstError: unknown = null;

  for (const res of results) {
    if (res.status === 'fulfilled') {
      successfulItems.push(res.value);
    } else if (!firstError) {
      firstError = res.reason;
    }
  }

  if (firstError || successfulItems.length === 0) {
    await Promise.all(
      successfulItems.map(async (item) => {
        try {
          await params.storage.deleteObject(item.storageKey);
          if (item.thumbnailKey) {
            await params.storage.deleteObject(item.thumbnailKey);
          }
        } catch (_e) {
          // ignore cleanup errors
        }
      })
    );
    throw firstError ?? new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      'Failed to download media assets from this link.',
      502
    );
  }

  return {
    sourceUrl: canonicalSourceUrl,
    platform,
    items: successfulItems,
  };
}
