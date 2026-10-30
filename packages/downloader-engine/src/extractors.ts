/**
 * External-extractor and FxTwitter resolution — the canonical location,
 * imported by the web orchestrator and the Cloudflare download consumer
 * alike. JSON bodies are read through a 10 MB bounded reader, never
 * unbounded response.json() (spec 149 backend revision §3.4); the
 * timeout helper is the local ./http.js, so no web '@/lib/http' alias
 * and no Node API is needed.
 */
import {
  DOWNLOAD_RESOLVE_BODY_MAX_BYTES,
  parseJsonPayloadCandidates,
  type RemoteMediaCandidate,
} from '@fbuploadpro/contracts';
import {
  MEDIA_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  readBoundedJson,
} from './http.js';

export async function tryResolveFromFxTwitter(
  sourceUrl: URL,
  fetchFn: typeof fetch
): Promise<RemoteMediaCandidate[]> {
  const statusMatch = /\/status(?:es)?\/(\d+)/.exec(sourceUrl.pathname);
  if (!statusMatch?.[1]) {
    return [];
  }
  try {
    const fxRes = await fetchWithTimeout(
      `https://api.fxtwitter.com/status/${statusMatch[1]}`,
      { headers: { Accept: 'application/json' } },
      MEDIA_FETCH_TIMEOUT_MS,
      fetchFn
    );
    if (!fxRes.ok) {
      return [];
    }
    const fxJson = await readBoundedJson(fxRes, DOWNLOAD_RESOLVE_BODY_MAX_BYTES);
    if (fxJson === null) return [];
    return parseJsonPayloadCandidates(fxJson);
  } catch {
    // Fallback quietly when FxTwitter API is unreachable
    return [];
  }
}

export async function tryResolveViaExternalExtractor(
  configuredExtractorUrl: string | null,
  canonicalSourceUrl: string,
  fetchFn: typeof fetch
): Promise<RemoteMediaCandidate[]> {
  if (!configuredExtractorUrl || configuredExtractorUrl.trim().length === 0) {
    return [];
  }
  try {
    const extRes = await fetchWithTimeout(
      configuredExtractorUrl.trim(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ url: canonicalSourceUrl }),
      },
      MEDIA_FETCH_TIMEOUT_MS,
      fetchFn
    );
    if (!extRes.ok) {
      return [];
    }
    const extJson = await readBoundedJson(extRes, DOWNLOAD_RESOLVE_BODY_MAX_BYTES);
    if (extJson === null) return [];
    return parseJsonPayloadCandidates(extJson);
  } catch {
    // Fall back to built-in serverless resolver if external extractor is unreachable
    return [];
  }
}
