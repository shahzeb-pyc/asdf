/**
 * Instagram API with Unified Login — server-side exchange and reads.
 *
 * A Unified Login connect returns a Business Integration System User
 * (BISU) token: it belongs to the client's business portfolio, not the
 * person who logged in, and it covers every Instagram account the
 * client shared for that portfolio. Under a BISU token, /me is the
 * system user, NOT an Instagram account — account IDs come from
 * /me/assigned_instagram_accounts and the business ID from
 * /me?fields=client_business_id, both on graph.facebook.com.
 *
 * Exchange finding, recorded honestly: the Unified Login docs snippet
 * lists only client_id, client_secret and code, but the classic
 * Facebook manual flow requires redirect_uri to match the dialog's
 * redirect_uri, and including it is the safe standard. This module
 * sends it; the owner's live test connect must still confirm it, and
 * if Meta rejects the exchange with redirect_uri present, the fix is
 * to drop that one parameter, not to redesign the flow.
 *
 * The Configuration ID is a dialog parameter only: it is never sent at
 * exchange, and it is not a secret.
 */

import {
  INSTAGRAM_UNIFIED_DIALOG_URL,
  INSTAGRAM_UNIFIED_GRAPH_BASE_URL,
} from '@fbuploadpro/contracts';
import {
  fetchWithTimeout,
  GRAPH_API_TIMEOUT_MS,
  readBoundedJson,
} from '@/lib/http/fetch-with-timeout';
import { findMissingInstagramScopes } from '@/lib/instagram-permissions';

const MAX_RESPONSE_BYTES = 256 * 1024;

/** The Facebook Login for Business dialog URL for a Unified Login connect. */
export function buildInstagramUnifiedDialogUrl(input: {
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(INSTAGRAM_UNIFIED_DIALOG_URL);
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('config_id', input.configId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  // popup: the dialog opens in a popup window. prompt=login: both the
  // Instagram and Facebook login options are always shown. Meta
  // documents NO parameter that restricts the dialog to Instagram
  // login only — the pre-dialog copy must tell the client to choose
  // Instagram, and no comment or copy here may claim otherwise.
  url.searchParams.set('display', 'popup');
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('state', input.state);
  return url.toString();
}

export interface UnifiedAssignedInstagramAccount {
  id: string;
  username: string;
}

export interface UnifiedExchangeResult {
  accessToken: string;
  clientBusinessId: string;
  accounts: UnifiedAssignedInstagramAccount[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Exchanges a Unified Login code for a BISU token, then reads the
 * client business ID and every shared Instagram account. Throws on any
 * failure — the callback turns a throw into a step error, never into
 * a saved account. No token, no business ID and no account list are
 * ever logged.
 */
export async function exchangeInstagramUnifiedCode(input: {
  code: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
  fetchFn?: typeof fetch;
}): Promise<UnifiedExchangeResult> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const exchangeUrl = new URL(`${INSTAGRAM_UNIFIED_GRAPH_BASE_URL}/oauth/access_token`);
  exchangeUrl.searchParams.set('client_id', input.appId);
  exchangeUrl.searchParams.set('client_secret', input.appSecret);
  exchangeUrl.searchParams.set('code', input.code);
  exchangeUrl.searchParams.set('redirect_uri', input.redirectUri);
  const exchangeRes = await fetchWithTimeout(
    exchangeUrl.toString(),
    {},
    GRAPH_API_TIMEOUT_MS,
    fetchFn
  );
  if (!exchangeRes.ok) {
    throw new Error(
      `Unified Login code exchange failed with status ${exchangeRes.status}`
    );
  }
  const exchangeBody = await readBoundedJson(exchangeRes, MAX_RESPONSE_BYTES);
  const accessToken = isRecord(exchangeBody)
    ? stringField(exchangeBody, 'access_token')
    : null;
  if (!accessToken) {
    throw new Error('Unified Login code exchange returned no access token');
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const meRes = await fetchWithTimeout(
    `${INSTAGRAM_UNIFIED_GRAPH_BASE_URL}/me?fields=client_business_id`,
    { headers: authHeaders },
    GRAPH_API_TIMEOUT_MS,
    fetchFn
  );
  if (!meRes.ok) {
    throw new Error(`Unified Login business ID read failed with status ${meRes.status}`);
  }
  const meBody = await readBoundedJson(meRes, MAX_RESPONSE_BYTES);
  const clientBusinessId = isRecord(meBody)
    ? stringField(meBody, 'client_business_id')
    : null;
  if (!clientBusinessId) {
    throw new Error('Unified Login business ID read returned no client business ID');
  }

  const assignedRes = await fetchWithTimeout(
    `${INSTAGRAM_UNIFIED_GRAPH_BASE_URL}/me/assigned_instagram_accounts?fields=id,username`,
    { headers: authHeaders },
    GRAPH_API_TIMEOUT_MS,
    fetchFn
  );
  if (!assignedRes.ok) {
    throw new Error(
      `Unified Login assigned accounts read failed with status ${assignedRes.status}`
    );
  }
  const assignedBody = await readBoundedJson(assignedRes, MAX_RESPONSE_BYTES);
  const data = isRecord(assignedBody) ? assignedBody.data : null;
  if (!Array.isArray(data)) {
    throw new Error('Unified Login assigned accounts read returned no account list');
  }
  const accounts: UnifiedAssignedInstagramAccount[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = stringField(entry, 'id');
    const username = stringField(entry, 'username');
    if (id && username) accounts.push({ id, username });
  }
  return { accessToken, clientBusinessId, accounts };
}

export type InstagramUnifiedProbeOutcome =
  | { kind: 'granted' }
  | { kind: 'missing'; missing: string[] }
  | { kind: 'unknown' };

/**
 * Belt-and-braces scope probe (Facebook PR 113 precedent): compares the BISU
 * token's /me/permissions list against the four hard-required names.
 * A proven decline/missing name is 'missing'; a failed or unusable
 * probe is 'unknown' and the caller must fail OPEN (connect as today,
 * log loudly), never treat unknown as granted and never treat unknown
 * as a rejection.
 */
export async function probeInstagramUnifiedPermissions(input: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<InstagramUnifiedProbeOutcome> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchWithTimeout(
      `${INSTAGRAM_UNIFIED_GRAPH_BASE_URL}/me/permissions`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      GRAPH_API_TIMEOUT_MS,
      fetchFn
    );
    if (!res.ok) return { kind: 'unknown' };
    const body = await readBoundedJson(res, MAX_RESPONSE_BYTES);
    const data = isRecord(body) ? body.data : null;
    if (!Array.isArray(data)) return { kind: 'unknown' };
    const missing = findMissingInstagramScopes(
      data.filter((entry): entry is { permission?: unknown; status?: unknown } =>
        isRecord(entry)
      )
    );
    if (missing.length > 0) return { kind: 'missing', missing };
    return { kind: 'granted' };
  } catch (err) {
    console.error('[Instagram Unified] Permissions probe failed — treating scope outcome as unknown:', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { kind: 'unknown' };
  }
}
