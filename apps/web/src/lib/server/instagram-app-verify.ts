/**
 * Instagram app verification for BYOC Unified Login (server-only).
 *
 * Before a workspace's Meta App ID, App Secret and Configuration ID are
 * saved, the App ID + Secret pair is proven against Meta: the app access
 * token `{app-id}|{app-secret}` reads the app node itself
 * (`GET /{app-id}?fields=name` on graph.facebook.com). A success both
 * verifies the pair and yields the display name the connected view
 * shows. The Configuration ID is not part of this proof — Meta only
 * proves it at dialog time, when the configuration's redirect list is
 * checked against the redirect_uri the app sends.
 *
 * This is a new module, not a reuse of the Facebook verifier: the
 * endpoint is the same Graph app node because a Unified Login app IS a
 * Meta app, but the logging, the caller contract and the failure
 * handling belong to the Instagram Unified Login flow.
 *
 * The secret is never logged: logs carry only the app ID, the HTTP
 * status and Meta's error code — never the URL, the token or the secret.
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

export type InstagramAppVerification =
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
  if (!body || typeof body !== 'object') return null;
  const code = (body as GraphErrorBody).error?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null;
}

/**
 * Proves a Meta App ID + Secret pair against the Graph API and returns
 * the app's display name. The two failure kinds are kept strictly apart,
 * because the route answers them differently:
 * - 'rejected': Meta answered 4xx — the pair itself is wrong, and
 *   saving it would only fail later at account-connect time.
 * - 'unreachable': Meta answered 5xx, the body was unusable, or the
 *   fetch threw (including a timeout) — the pair may be fine, it
 *   simply could not be proven right now.
 */
export async function verifyInstagramApp(
  appId: string,
  appSecret: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<InstagramAppVerification> {
  const params = new URLSearchParams({
    fields: 'name',
    access_token: `${appId}|${appSecret}`,
  });
  const url = `${GRAPH_BASE_URL}/${encodeURIComponent(appId)}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {}, GRAPH_API_TIMEOUT_MS, fetchFn);
  } catch (err) {
    console.error('[Instagram App Verify] Graph fetch failed:', {
      appId,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { ok: false, kind: 'unreachable' };
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await readBoundedJson(response, MAX_RESPONSE_BYTES);
    console.error('[Instagram App Verify] Graph rejected the app credentials:', {
      appId,
      status: response.status,
      graphCode: graphErrorCode(body),
    });
    return { ok: false, kind: 'rejected' };
  }

  if (response.status >= 500) {
    console.error('[Instagram App Verify] Graph answered with a server error:', {
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

  console.error('[Instagram App Verify] Graph answered without an app name:', {
    appId,
    status: response.status,
  });
  return { ok: false, kind: 'unreachable' };
}
