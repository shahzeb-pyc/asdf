/**
 * Signed, short-lived connect-flow state (Spec 123, Part C).
 *
 * Mirrors the signed-envelope pattern of the Facebook flow in
 * @fbuploadpro/contracts (signOAuthState / verifyOAuthState): an
 * HMAC-SHA256 signature over a base64url JSON payload. The contracts state
 * schema is Facebook-shaped (no platform / workspaceId), so the connect
 * framework carries its own payload here instead of editing contracts.
 *
 * Three payloads share the envelope:
 *  - ConnectStatePayload: travels in the authorize URL `state` parameter.
 *  - PkceCookiePayload: httpOnly cookie holding the PKCE verifier, matched
 *    to the flow by nonce (the verifier never travels in the URL).
 *  - PendingDestinationsPayload: httpOnly cookie set at callback time,
 *    holding the discovered destinations until the user confirms the pick.
 */
import type { Platform } from '@fbuploadpro/contracts';
import type { DiscoveredDestination } from './registry';

export const CONNECT_STATE_TTL_SECONDS = 600; // 10 minutes
export const CONNECT_PENDING_TTL_SECONDS = 900; // 15 minutes

export const PKCE_COOKIE_NAME = 'fbup_connect_pkce';
export const PENDING_COOKIE_NAME = 'fbup_connect_pending';

export interface ConnectStatePayload {
  workspaceId: string;
  tenantSubdomain: string;
  userId: string;
  platform: Platform;
  nonce: string;
  iat: number;
  exp: number;
  /**
   * Optional expected-account hint, carried only when the flow was
   * started as a reconnect (or a magic link) for a specific account.
   * The callback compares the signed-in account against it and
   * reports a mismatch instead of silently succeeding. Additive:
   * flows that do not send these fields behave exactly as before.
   */
  expectedExternalAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  /** True when this flow started from a magic link (no session). */
  isMagic?: boolean | undefined;
}

export interface PkceCookiePayload {
  nonce: string;
  platform: Platform;
  codeVerifier: string;
  exp: number;
}

export interface PendingDestinationsPayload {
  accountId: string;
  workspaceId: string;
  tenantSubdomain: string;
  platform: Platform;
  destinations: DiscoveredDestination[];
  exp: number;
  /**
   * Connect outcome, computed by the callback from the signed
   * connect state: whether this account already existed before
   * this flow, and whether the signed-in account differs from the
   * expected reconnect target. The complete route turns these into
   * the landing page's notice params. Additive: flows that do not
   * set them land exactly as before.
   */
  alreadyExisted?: boolean | undefined;
  expectedExternalAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  isMagic?: boolean | undefined;
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCodePoint(b);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/={1,2}$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return new TextDecoder().decode(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCodePoint(b);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/={1,2}$/, '');
}

function bufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  let hexString = '';
  for (const byte of byteArray) {
    hexString += byte.toString(16).padStart(2, '0');
  }
  return hexString;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid connect signature format');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function importHmacKey(secret: string, usage: 'sign' | 'verify') {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

export async function signConnectEnvelope(
  payloadObj: Record<string, unknown>,
  secret: string
): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payloadObj));
  const encoder = new TextEncoder();
  const key = await importHmacKey(secret, 'sign');
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(encodedPayload)
  );
  return `${encodedPayload}.${bufferToHex(signatureBuffer)}`;
}

export async function verifyConnectEnvelope<T>(
  token: string,
  secret: string
): Promise<T> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Invalid connect token format');
  }
  const [encodedPayload, providedSignature] = token.split('.');
  if (!encodedPayload || !providedSignature) {
    throw new Error('Invalid connect token format');
  }

  const signatureBytes = hexToBytes(providedSignature);
  const encoder = new TextEncoder();
  const key = await importHmacKey(secret, 'verify');

  let isValid = false;
  try {
    isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes as unknown as BufferSource,
      encoder.encode(encodedPayload)
    );
  } catch {
    isValid = false;
  }
  if (!isValid) {
    throw new Error('Connect token signature verification failed');
  }

  const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as T & {
    exp?: number;
  };
  if (typeof parsed.exp === 'number') {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (parsed.exp < nowSeconds) {
      throw new Error('Connect token has expired');
    }
  }
  return parsed;
}

export async function signConnectState(
  payload: ConnectStatePayload,
  secret: string
): Promise<string> {
  return signConnectEnvelope(
    payload as unknown as Record<string, unknown>,
    secret
  );
}

export async function verifyConnectState(
  token: string,
  secret: string
): Promise<ConnectStatePayload> {
  const payload = await verifyConnectEnvelope<ConnectStatePayload>(
    token,
    secret
  );
  if (
    !payload.workspaceId ||
    !payload.tenantSubdomain ||
    !payload.userId ||
    !payload.platform ||
    !payload.nonce
  ) {
    throw new Error('Connect state payload is incomplete');
  }
  return payload;
}

export function createConnectStatePayload(input: {
  workspaceId: string;
  tenantSubdomain: string;
  userId: string;
  platform: Platform;
  expectedExternalAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  isMagic?: boolean | undefined;
}): ConnectStatePayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...input,
    nonce: crypto.randomUUID().replaceAll('-', ''),
    iat: now,
    exp: now + CONNECT_STATE_TTL_SECONDS,
  };
}

/** RFC 7636 PKCE pair: verifier stays server-side (cookie), challenge goes in the authorize URL. */
export async function generatePkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = bytesToBase64Url(randomBytes);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export async function signPkceCookie(
  payload: PkceCookiePayload,
  secret: string
): Promise<string> {
  return signConnectState(payload as unknown as ConnectStatePayload, secret);
}

export async function verifyPkceCookie(
  token: string,
  secret: string
): Promise<PkceCookiePayload> {
  const payload = await verifyConnectEnvelope<PkceCookiePayload>(token, secret);
  if (!payload.nonce || !payload.platform || !payload.codeVerifier) {
    throw new Error('PKCE cookie payload is incomplete');
  }
  return payload;
}

export async function signPendingDestinations(
  payload: PendingDestinationsPayload,
  secret: string
): Promise<string> {
  return signPkceCookie(payload as unknown as PkceCookiePayload, secret);
}

export async function verifyPendingDestinations(
  token: string,
  secret: string
): Promise<PendingDestinationsPayload> {
  const payload = await verifyConnectEnvelope<PendingDestinationsPayload>(
    token,
    secret
  );
  if (!payload.accountId || !payload.workspaceId || !payload.platform) {
    throw new Error('Pending destinations payload is incomplete');
  }
  if (!Array.isArray(payload.destinations)) {
    throw new TypeError('Pending destinations payload is incomplete');
  }
  return payload;
}

export function buildConnectCallbackUrl(
  requestUrl: string | URL,
  platform: Platform
): string {
  const url =
    typeof requestUrl === 'string' ? new URL(requestUrl) : new URL(requestUrl.toString());
  return `${url.origin}/api/connect/${platform}/callback`;
}
