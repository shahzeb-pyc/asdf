/**
 * Facebook app verification for BYOC connect (server-only).
 *
 * Before a workspace's Facebook App ID and Secret are saved, the pair
 * is proven against Meta: the app access token `{app-id}|{app-secret}`
 * reads the app node itself (`GET /{app-id}?fields=name`). A success
 * both verifies the pair and yields the display name the connected
 * view shows. This is the test step the credentials status was
 * designed around but never had — previously a save only ever wrote
 * 'unverified' and nothing ever flipped it.
 *
 * Conventions followed, not invented: the Graph base URL and version
 * match the existing Facebook server code (`v26.0`, see
 * lib/server/facebook-reel.ts and lib/insights/page-insights.ts), and
 * the fetch goes through the shared timeout helper every external
 * server fetch must use (spec 139 A4) with the Graph budget.
 *
 * The secret is never logged: the request URL carries the app token,
 * so logs carry only the app ID, the HTTP status, and Meta's error
 * code — never the URL, the token, or the secret.
 */

import {
  fetchWithTimeout,
  GRAPH_API_TIMEOUT_MS,
  readBoundedJson,
} from '@/lib/http/fetch-with-timeout';

/** Graph API base, matching the existing Facebook server code. */
const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';

/** The app-node read is tiny; anything larger is not a valid answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type FacebookAppVerification =
  | { ok: true; appName: string }
  | { ok: false; kind: 'rejected' | 'unreachable' };

interface GraphErrorBody {
  error?: {
    code?: unknown;
    type?: unknown;
    message?: unknown;
  };
}

function graphErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as GraphErrorBody).error?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null;
}

/**
 * Proves a Facebook App ID + Secret pair against the Graph API and
 * returns the app's display name. The two failure kinds are kept
 * strictly apart, because the route answers them differently:
 * - 'rejected': Meta answered 4xx — the pair itself is wrong, and
 *   saving it would only fail later at account-connect time.
 * - 'unreachable': Meta answered 5xx, the body was unusable, or the
 *   fetch threw (including a timeout) — the pair may be fine, it
 *   simply could not be proven right now.
 */
export async function verifyFacebookApp(
  appId: string,
  appSecret: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<FacebookAppVerification> {
  const params = new URLSearchParams({
    fields: 'name',
    access_token: `${appId}|${appSecret}`,
  });
  const url = `${GRAPH_BASE_URL}/${encodeURIComponent(appId)}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {}, GRAPH_API_TIMEOUT_MS, fetchFn);
  } catch (err) {
    // Timeout, DNS, or any other transport failure: the pair was
    // never judged, so this is unreachable, never a rejection.
    console.error('[Facebook App Verify] Graph fetch failed:', {
      appId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { ok: false, kind: 'unreachable' };
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
    console.error('[Facebook App Verify] Graph rejected the app credentials:', {
      appId,
      status: response.status,
      graphCode: graphErrorCode(body),
    });
    return { ok: false, kind: 'rejected' };
  }

  if (response.status >= 500) {
    console.error('[Facebook App Verify] Graph answered with a server error:', {
      appId,
      status: response.status,
    });
    return { ok: false, kind: 'unreachable' };
  }

  const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
  const appName = (body as { name?: unknown } | null)?.name;
  if (typeof appName === 'string' && appName.length > 0) {
    return { ok: true, appName };
  }

  // A 2xx without a usable name proves nothing about the pair and
  // yields no name to save — inconclusive, not a rejection.
  console.error('[Facebook App Verify] Graph answered without an app name:', {
    appId,
    status: response.status,
  });
  return { ok: false, kind: 'unreachable' };
}
