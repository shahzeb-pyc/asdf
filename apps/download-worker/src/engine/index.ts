import {
  detectSourcePlatform,
  validateSafeRemoteUrl,
  type DownloaderSourcePlatform,
  type RemoteMediaCandidate,
} from '@fbuploadpro/contracts';
import {
  MediaDownloaderError,
  resolveCandidatesBuiltIn,
  tryResolveViaExternalExtractor,
} from '@fbuploadpro/downloader-engine';

export type { RemoteMediaCandidate } from '@fbuploadpro/contracts';
export { normalizeCloudDriveUrl } from '@fbuploadpro/contracts';
export {
  DownloadAbortedError,
  JobCancelledError,
  MediaDownloaderError,
  resolveAllowedMimeType,
  ResumeUnsupportedError,
  validateAndNormalizeStreamUrl,
  type AllowedMediaMime,
  type DownloaderErrorCode,
} from '@fbuploadpro/downloader-engine';
export {
  type DownloadProgress,
  type DownloadedItem,
  type MediaStreamSink,
  type ResumeState,
  type StreamCandidateOptions,
  downloadAndStoreCandidate,
} from './stream.js';
export { downloadAndStoreCandidate as downloadAndStoreSingleCandidate } from './stream.js';

export interface ResolveCandidatesResult {
  sourceUrl: string;
  platform: DownloaderSourcePlatform;
  candidates: RemoteMediaCandidate[];
  prefetchedBinaryResponse?: Response | undefined;
}

/**
 * Resolve a pasted link to downloadable candidates, SEQUENTIALLY
 * (spec §3.2): external extractor first when configured, built-in
 * resolvers otherwise. The extractor URL is passed explicitly —
 * never read from process.env — and must already have been validated
 * as https + public by the Worker entry point (§3.1).
 */
export async function resolveCandidates(
  sourceUrl: string,
  fetchFn: typeof fetch,
  extractorApiUrl: string | null
): Promise<ResolveCandidatesResult> {
  const sourceValidation = validateSafeRemoteUrl(sourceUrl);
  if (!sourceValidation.valid || !sourceValidation.url) {
    throw new MediaDownloaderError(
      'UNSAFE_URL',
      sourceValidation.reason ?? 'Please enter a valid public http:// or https:// link.',
      400
    );
  }
  const canonicalSourceUrl = sourceValidation.url.toString();
  const platform = detectSourcePlatform(canonicalSourceUrl);

  let candidates = await tryResolveViaExternalExtractor(
    extractorApiUrl,
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

  return {
    sourceUrl: canonicalSourceUrl,
    platform,
    candidates,
    prefetchedBinaryResponse,
  };
}
