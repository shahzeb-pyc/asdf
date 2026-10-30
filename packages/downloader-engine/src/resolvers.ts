import {
  normalizeCloudDriveUrl,
  parseHtmlMediaCandidates,
  parseJsonPayloadCandidates,
  resolveGoogleDriveDirectUrl,
  validateSafeRemoteUrl,
  type DownloaderSourcePlatform,
  type RemoteMediaCandidate,
} from '@fbuploadpro/contracts';
/**
 * Built-in resolvers — the canonical location, imported by the web
 * orchestrator and the Cloudflare download consumer alike. Resolve
 * bodies are read through a 10 MB bounded reader, never unbounded
 * response.text()/.json() (spec 149 backend revision §3.4); the
 * timeout helper is the local ./http.js, so no web '@/lib/http' alias
 * and no Node API is needed.
 */
import {
  DOWNLOAD_RESOLVE_BODY_MAX_BYTES,
} from '@fbuploadpro/contracts';
import {
  extractFilenameFromContentDisposition,
  resolveAllowedMimeType,
} from './mime.js';
import { tryResolveFromFxTwitter } from './extractors.js';
import {
  MEDIA_FETCH_TIMEOUT_MS,
  fetchWithTimeoutToHeaders,
  readBoundedJson,
  readBoundedText,
} from './http.js';
// Single error definition lives in ./errors.js (imported for internal
// use here; import sites take the error types from './errors.js' or
// the package root, never from this module).
import { MediaDownloaderError } from './errors.js';

export function validateAndNormalizeStreamUrl(rawStreamUrl: string): string {
  const safeCheck = validateSafeRemoteUrl(rawStreamUrl);
  if (!safeCheck.valid || !safeCheck.url) {
    throw new MediaDownloaderError(
      'UNSAFE_URL',
      safeCheck.reason ?? 'The resolved media stream address is not allowed.',
      400
    );
  }

  const normalizedStreamUrl = normalizeCloudDriveUrl(safeCheck.url);
  const normalizedCheck = validateSafeRemoteUrl(normalizedStreamUrl);
  if (!normalizedCheck.valid) {
    throw new MediaDownloaderError(
      'UNSAFE_URL',
      normalizedCheck.reason ?? 'The resolved media stream address is not allowed.',
      400
    );
  }

  return normalizedStreamUrl;
}

export async function fetchCandidateResponse(
  normalizedStreamUrl: string,
  fetchFn: typeof fetch,
  prefetchedResponse?: Response
): Promise<Response> {
  let response: Response;
  if (prefetchedResponse) {
    response = prefetchedResponse;
  } else {
    try {
      // Streaming download: this response's body is consumed as a
      // stream by the caller (readResponseBytesWithLimit), so the
      // timeout must bound only the time to response headers — a
      // whole-request AbortSignal.timeout would abort large bodies
      // mid-stream. fetchWithTimeoutToHeaders clears its timer once
      // headers arrive, keeping the stream intact.
      response = await fetchWithTimeoutToHeaders(
        normalizedStreamUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FBUploadProMediaBot/1.0)',
            Accept: '*/*',
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

  if (!response.ok) {
    throw new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      `Remote server returned status ${response.status} while downloading media.`,
      502
    );
  }

  return response;
}

async function parseOkInitialResponse(
  initialResponse: Response,
  normalizedUrl: string,
  sourceUrl: URL,
  platform: DownloaderSourcePlatform,
  fetchFn: typeof fetch
): Promise<{
  candidates: RemoteMediaCandidate[];
  prefetchedBinaryResponse?: Response;
}> {
  const contentType = initialResponse.headers.get('content-type') ?? '';
  const lowerContentType = contentType.toLowerCase();
  const effectiveUrl = initialResponse.url || normalizedUrl;
  const dispositionFileName = extractFilenameFromContentDisposition(
    initialResponse.headers.get('content-disposition')
  );
  const directMime = resolveAllowedMimeType(contentType, effectiveUrl, dispositionFileName);

  if (directMime) {
    return {
      prefetchedBinaryResponse: initialResponse,
      candidates: [
        {
          streamUrl: effectiveUrl,
          fileName: dispositionFileName,
        },
      ],
    };
  }

  if (lowerContentType.includes('application/json') || lowerContentType.includes('text/json')) {
    const jsonData = await readBoundedJson(initialResponse, DOWNLOAD_RESOLVE_BODY_MAX_BYTES);
    if (jsonData === null) {
      // Over-cap or unparseable JSON: cannot resolve, never buffered whole.
      return { candidates: [] };
    }
    return { candidates: parseJsonPayloadCandidates(jsonData) };
  }

  const htmlText = await readBoundedText(initialResponse, DOWNLOAD_RESOLVE_BODY_MAX_BYTES);
  if (htmlText === null) {
    // Page too large to resolve (§3.4): treat as unresolvable, not as a crash.
    return { candidates: [] };
  }
  const parsedHtml = parseHtmlMediaCandidates(htmlText, effectiveUrl);
  if (parsedHtml.candidates.length === 0 && platform === 'x') {
    return { candidates: await tryResolveFromFxTwitter(sourceUrl, fetchFn) };
  }
  if (parsedHtml.candidates.length === 0 && platform === 'google_drive') {
    const directUrl = resolveGoogleDriveDirectUrl(sourceUrl.toString(), htmlText);
    if (directUrl) {
      return {
        candidates: [
          {
            streamUrl: directUrl,
            mediaTypeHint: 'video',
          },
        ],
      };
    }
  }
  return { candidates: parsedHtml.candidates };
}

export async function resolveCandidatesBuiltIn(
  sourceUrl: URL,
  platform: DownloaderSourcePlatform,
  fetchFn: typeof fetch
): Promise<{
  candidates: RemoteMediaCandidate[];
  prefetchedBinaryResponse?: Response;
}> {
  const normalizedUrl = validateAndNormalizeStreamUrl(sourceUrl.toString());

  let initialResponse: Response;
  try {
    // Headers-only timeout: a direct-media response here is kept as
    // a prefetched stream and read later, so a whole-request signal
    // would abort its body mid-stream (see fetchCandidateResponse).
    initialResponse = await fetchWithTimeoutToHeaders(
      normalizedUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FBUploadProMediaBot/1.0)',
          Accept: '*/*',
        },
        redirect: 'follow',
      },
      MEDIA_FETCH_TIMEOUT_MS,
      fetchFn
    );
  } catch {
    throw new MediaDownloaderError(
      'DOWNLOAD_FAILED',
      'Could not reach the provided link. Please verify the link and try again.',
      502
    );
  }

  if (initialResponse.url) {
    const redirectSafety = validateSafeRemoteUrl(initialResponse.url);
    if (!redirectSafety.valid) {
      throw new MediaDownloaderError(
        'UNSAFE_URL',
        redirectSafety.reason ?? 'Redirected to a restricted network address.',
        400
      );
    }
  }

  if (!initialResponse.ok) {
    const fallbackCandidates =
      platform === 'x' ? await tryResolveFromFxTwitter(sourceUrl, fetchFn) : [];
    if (fallbackCandidates.length === 0) {
      throw new MediaDownloaderError(
        'DOWNLOAD_FAILED',
        `Could not retrieve content from this link (status ${initialResponse.status}).`,
        502
      );
    }
    return { candidates: fallbackCandidates };
  }

  return parseOkInitialResponse(initialResponse, normalizedUrl, sourceUrl, platform, fetchFn);
}
