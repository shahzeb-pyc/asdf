import { z } from 'zod';
import { UnauthorizedError, ValidationError } from '../errors/domain-error.js';

export const OAuthStatePayloadSchema = z.object({
  tenantSubdomain: z.string().min(1).max(50),
  userId: z.string().uuid(),
  nonce: z.string().min(16),
  iat: z.number().int(),
  exp: z.number().int(),
  isMagic: z.boolean().optional(),
  // Audit N5: hint caps unified at 255 in both flows (magic body
  // and direct initiate both bound before signing).
  expectedFbAccountId: z.string().min(1).max(255).optional(),
  expectedInstagramAccountId: z.string().min(1).max(255).optional(),
  expectedDisplayName: z.string().min(1).max(255).optional(),
  redirectUri: z.string().url().optional(),
});

export type OAuthStatePayload = z.infer<typeof OAuthStatePayloadSchema>;

export const MagicLinkTokenPayloadSchema = z.object({
  tenantSubdomain: z.string().min(1).max(50),
  userId: z.string().uuid(),
  nonce: z.string().min(16),
  iat: z.number().int(),
  exp: z.number().int(),
  expectedFbAccountId: z.string().min(1).max(255).optional(),
  expectedInstagramAccountId: z.string().min(1).max(255).optional(),
  /**
   * Platform-agnostic expected-account hint (Threads magic links
   * carry the Threads-scoped external account id here; Facebook
   * keeps using expectedFbAccountId above). Optional and additive:
   * older tokens without it still verify.
   * Capped at 255 like the other hints per Facebook audit N5.
   */
  expectedExternalAccountId: z.string().min(1).max(255).optional(),
  expectedDisplayName: z.string().min(1).max(255).optional(),
});

export type MagicLinkTokenPayload = z.infer<typeof MagicLinkTokenPayloadSchema>;

export const FacebookOAuthCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
  error_reason: z.string().optional(),
  error_description: z.string().optional(),
});

export type FacebookOAuthCallbackQuery = z.infer<
  typeof FacebookOAuthCallbackQuerySchema
>;

export const FacebookTokenExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('bearer'),
  expires_in: z.number().int().optional(),
});

export type FacebookTokenExchangeResponse = z.infer<
  typeof FacebookTokenExchangeResponseSchema
>;

export const FacebookUserProfileResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gender: z.string().max(50).nullable().optional(),
  link: z.string().url().nullable().optional(),
  picture: z
    .object({
      data: z
        .object({
          url: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type FacebookUserProfileResponse = z.infer<
  typeof FacebookUserProfileResponseSchema
>;

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

function bufferToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  let hexString = '';
  for (const byte of byteArray) {
    hexString += byte.toString(16).padStart(2, '0');
  }
  return hexString;
}

async function signSignedEnvelope(
  payloadObj: Record<string, unknown>,
  secret: string
): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payloadObj));
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(encodedPayload)
  );

  const signatureHex = bufferToHex(signatureBuffer);
  return `${encodedPayload}.${signatureHex}`;
}

function hexToBytes(hex: string, tokenType: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new UnauthorizedError(`Invalid ${tokenType} signature format`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new UnauthorizedError(`Invalid ${tokenType} signature format`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

async function verifySignedEnvelope(
  token: string,
  secret: string,
  tokenType: string
): Promise<unknown> {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new ValidationError(`Invalid ${tokenType} format`);
  }

  const [encodedPayload, providedSignature] = token.split('.');
  if (!encodedPayload || !providedSignature) {
    throw new ValidationError(`Invalid ${tokenType} format`);
  }

  const signatureBytes = hexToBytes(providedSignature, tokenType);

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  let isValid = false;
  try {
    isValid = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      signatureBytes as unknown as BufferSource,
      encoder.encode(encodedPayload)
    );
  } catch {
    isValid = false;
  }

  if (!isValid) {
    throw new UnauthorizedError(`${tokenType} signature verification failed`);
  }

  try {
    const jsonStr = base64UrlDecode(encodedPayload);
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new ValidationError(
      `Failed to decode ${tokenType} payload`,
      err instanceof Error ? err : undefined
    );
  }
}

export async function signOAuthState(
  payload: OAuthStatePayload,
  secret: string
): Promise<string> {
  const validatedPayload = OAuthStatePayloadSchema.parse(payload);
  return await signSignedEnvelope(validatedPayload as unknown as Record<string, unknown>, secret);
}

export async function verifyOAuthState(
  token: string,
  secret: string
): Promise<OAuthStatePayload> {
  const parsed = await verifySignedEnvelope(token, secret, 'OAuth state');
  const payload = OAuthStatePayloadSchema.parse(parsed);

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds) {
    throw new UnauthorizedError('OAuth state has expired');
  }

  return payload;
}

/**
 * Audit BG13 — signature-verified state peek WITHOUT the expiry
 * check, for error routing ONLY. When a callback arrives with an
 * expired (but genuinely signed) state, verifyOAuthState throws
 * before the payload is readable, so the old code could not tell
 * a magic flow from a direct flow and misrouted magic users to
 * the tenant accounts page (whose login gate then swallowed the
 * error). Peeking recovers the explicit `isMagic` signal from
 * the signed state so the error can go to the magic error page.
 * This NEVER authorizes anything: a peeked payload must not be
 * used to continue a flow, only to choose its error page.
 * Returns null for tampered/unparseable states (no signal).
 */
export async function peekOAuthStatePayload(
  token: string,
  secret: string
): Promise<OAuthStatePayload | null> {
  try {
    const parsed = await verifySignedEnvelope(token, secret, 'OAuth state');
    return OAuthStatePayloadSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function signMagicLinkToken(
  payload: MagicLinkTokenPayload,
  secret: string
): Promise<string> {
  const validatedPayload = MagicLinkTokenPayloadSchema.parse(payload);
  return await signSignedEnvelope(validatedPayload as unknown as Record<string, unknown>, secret);
}

export async function verifyMagicLinkToken(
  token: string,
  secret: string
): Promise<MagicLinkTokenPayload> {
  const parsed = await verifySignedEnvelope(token, secret, 'magic link token');
  const payload = MagicLinkTokenPayloadSchema.parse(parsed);

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds) {
    throw new UnauthorizedError('Magic link has expired');
  }

  return payload;
}

