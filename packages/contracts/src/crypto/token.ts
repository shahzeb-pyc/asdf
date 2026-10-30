import {
  DomainError,
  DomainErrorCode,
  UnauthorizedError,
  ValidationError,
} from '../errors/domain-error.js';

const DEV_FALLBACK_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Resolves the 256-bit symmetric encryption key used for securing tokens and secrets at rest.
 * Reads TOKEN_ENCRYPTION_KEY (the single canonical key).
 *
 * @param env - Optional environment dictionary; defaults to process.env if available.
 * @returns 256-bit encryption key string (64 hex characters or 32 bytes).
 * @throws DomainError if key is missing in production (NODE_ENV === 'production').
 */
export function getTokenEncryptionKey(env?: Record<string, string | undefined>): string {
  const globalEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const envObj = env ?? globalEnv ?? {};
  const nodeEnv = envObj.NODE_ENV;
  const key = envObj.TOKEN_ENCRYPTION_KEY;

  if (key && key.trim().length > 0) {
    const trimmed = key.trim();
    if (nodeEnv === 'production' && trimmed === DEV_FALLBACK_ENCRYPTION_KEY) {
      throw new DomainError(
        DomainErrorCode.INTERNAL_ERROR,
        'DEV_FALLBACK_ENCRYPTION_KEY is forbidden in production environment'
      );
    }
    return trimmed;
  }

  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';
  if (!isDevOrTest) {
    throw new DomainError(
      DomainErrorCode.INTERNAL_ERROR,
      'TOKEN_ENCRYPTION_KEY is required in production environment'
    );
  }

  return DEV_FALLBACK_ENCRYPTION_KEY;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new ValidationError('Invalid hex string format');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ValidationError('Invalid hex character');
    }
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function parseSecretKey(secretHexOrKey: string): Uint8Array {
  if (typeof secretHexOrKey !== 'string') {
    throw new ValidationError('Secret key must be a string');
  }
  // If 64 hex chars, parse as 32-byte hex
  if (secretHexOrKey.length === 64 && /^[0-9a-fA-F]+$/.test(secretHexOrKey)) {
    return hexToBytes(secretHexOrKey);
  }
  // Otherwise if utf-8 string, must be 32 bytes
  const bytes = new TextEncoder().encode(secretHexOrKey);
  if (bytes.length !== 32) {
    throw new ValidationError(
      `Secret key must be exactly 256 bits (32 bytes or 64 hex characters), got ${bytes.length} bytes`
    );
  }
  return bytes;
}

/**
 * Audit S5 — token-key versioning.
 *
 * Every newly encrypted payload is stamped with the key id that
 * encrypted it: `v1:{iv_hex}:{ciphertext_hex}`. Bare legacy
 * payloads (`{iv_hex}:{ciphertext_hex}`, no version) keep
 * decrypting with the single supplied key, unchanged.
 *
 * Rotation path (documented, NOT fully built in this pass):
 *   1. Generate a new 256-bit key; set TOKEN_ENCRYPTION_KEY to
 *      it and TOKEN_ENCRYPTION_KEY_ID to its id (e.g. 'v2').
 *   2. Set TOKEN_ENCRYPTION_KEYS_PREVIOUS to a JSON map of the
 *      retired ids to their keys, e.g. '{"v1":"<old hex>"}'.
 *   3. Callers resolve the ring with resolveTokenKeyRing(env)
 *      and pass `keyId` to encryptToken and `keysById` to
 *      decryptToken, so old-version payloads keep decrypting
 *      with their own key instead of failing.
 *   4. (Remaining step, explicitly not done here) A
 *      re-encryption job that decrypts every stored payload
 *      with its version's key and re-encrypts it under the
 *      current key, after which the previous keys can be
 *      retired. Until that job exists, rotating without the
 *      previous-keys map orphans old payloads — decryptToken
 *      fails LOUDLY naming the missing key id, never silently.
 * Call-site wiring for keysById/keyId and the re-encryption
 * job are the remaining rotation steps; what this pass does
 * guarantee is that new payloads carry their version, legacy
 * payloads keep working, and an unavailable version is a loud
 * error, not a silent wrong-key failure.
 */
export const CURRENT_TOKEN_KEY_ID = 'v1';

const TOKEN_KEY_ID_PATTERN = /^v[0-9]+$/;

/**
 * Resolves the token key ring from env: the current key id
 * (TOKEN_ENCRYPTION_KEY_ID, default 'v1'), the current key
 * (via the production fail-closed getTokenEncryptionKey), and
 * the retired keys (TOKEN_ENCRYPTION_KEYS_PREVIOUS as a JSON
 * id→key map, {} when unset). Throws on a malformed map.
 */
export function resolveTokenKeyRing(env?: Record<string, string | undefined>): {
  keyId: string;
  key: string;
  previousKeys: Record<string, string>;
} {
  const globalEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const envObj = env ?? globalEnv ?? {};
  const keyId = envObj.TOKEN_ENCRYPTION_KEY_ID?.trim() || CURRENT_TOKEN_KEY_ID;
  const rawPrevious = envObj.TOKEN_ENCRYPTION_KEYS_PREVIOUS?.trim();
  let previousKeys: Record<string, string> = {};
  if (rawPrevious) {
    try {
      const parsed: unknown = JSON.parse(rawPrevious);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`key for id ${id} is not a non-empty string`);
        }
      }
      previousKeys = parsed as Record<string, string>;
    } catch (err) {
      throw new DomainError(
        DomainErrorCode.INTERNAL_ERROR,
        `TOKEN_ENCRYPTION_KEYS_PREVIOUS is malformed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { keyId, key: getTokenEncryptionKey(envObj), previousKeys };
}

/**
 * Encrypts a sensitive plaintext string (such as an OAuth access token)
 * using AES-256-GCM with a random 12-byte IV.
 *
 * @param plaintext - The raw token string to encrypt.
 * @param secretHexOrKey - 256-bit encryption key (32 bytes or 64 hex characters).
 * @param options.keyId - Key id stamped on the payload (default 'v1').
 * @returns Serialized encrypted string '{key_id}:{iv_hex}:{ciphertext_hex}'.
 */
export async function encryptToken(
  plaintext: string,
  secretHexOrKey: string,
  options?: { keyId?: string }
): Promise<string> {
  const keyBytes = parseSecretKey(secretHexOrKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encodedData = new TextEncoder().encode(plaintext);
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    cryptoKey,
    encodedData as unknown as BufferSource
  );

  const ivHex = bytesToHex(iv);
  const cipherHex = bytesToHex(new Uint8Array(encryptedBuffer));

  // Audit S5: stamp the key id so a future rotation can tell
  // which key encrypted this payload.
  const keyId = options?.keyId?.trim() || CURRENT_TOKEN_KEY_ID;
  return `${keyId}:${ivHex}:${cipherHex}`;
}

/**
 * Decrypts an AES-256-GCM encrypted token string.
 *
 * @param encryptedPayload - Serialized string
 *   '{key_id}:{iv_hex}:{ciphertext_hex}' (new, audit S5) or the
 *   legacy bare '{iv_hex}:{ciphertext_hex}'.
 * @param secretHexOrKey - 256-bit encryption key matching the key used to encrypt
 *   (for a versioned payload stamped with the current id, this key).
 * @param options.keysById - Retired keys by id for versioned payloads
 *   encrypted under an older key (see resolveTokenKeyRing).
 * @returns Decrypted raw token string, or null if encryptedPayload is empty (e.g. soft-deleted resources).
 * @throws UnauthorizedError if authentication tag fails, or if a versioned
 *   payload's key id has no available key (fail loud, naming the id).
 * @throws ValidationError if payload format is invalid.
 */
export async function decryptToken(
  encryptedPayload: string,
  secretHexOrKey: string,
  options: { allowEmpty: true; keysById?: Record<string, string> }
): Promise<string | null>;
export async function decryptToken(
  encryptedPayload: string,
  secretHexOrKey: string,
  options?: { allowEmpty?: boolean; keysById?: Record<string, string> }
): Promise<string>;
export async function decryptToken(
  encryptedPayload: string,
  secretHexOrKey: string,
  options?: { allowEmpty?: boolean; keysById?: Record<string, string> }
): Promise<string | null> {
  if (typeof encryptedPayload === 'string' && encryptedPayload.trim() === '') {
    if (options?.allowEmpty) {
      return null;
    }
    throw new ValidationError('Encrypted token payload is empty');
  }

  if (typeof encryptedPayload !== 'string' || !encryptedPayload.includes(':')) {
    throw new ValidationError('Invalid encrypted token payload format');
  }

  const parts = encryptedPayload.split(':');
  // Audit S5: versioned payloads resolve their key by id; the
  // current id falls back to the supplied key so existing
  // callers keep working with no rewiring. A version with no
  // available key fails loudly, naming the id, instead of
  // attempting a wrong-key decrypt.
  let ivHex: string;
  let cipherHex: string;
  let keyForPayload = secretHexOrKey;
  if (parts.length === 3 && TOKEN_KEY_ID_PATTERN.test(parts[0])) {
    const keyId = parts[0];
    if (keyId !== CURRENT_TOKEN_KEY_ID) {
      const retired = options?.keysById?.[keyId];
      if (!retired) {
        throw new UnauthorizedError(
          `Cannot decrypt token: no key available for key id ${keyId} (rotation requires TOKEN_ENCRYPTION_KEYS_PREVIOUS to include it)`
        );
      }
      keyForPayload = retired;
    }
    [, ivHex, cipherHex] = parts;
  } else if (parts.length === 2 && parts[0] && parts[1]) {
    [ivHex, cipherHex] = parts;
  } else {
    throw new ValidationError('Invalid encrypted token payload format');
  }

  const keyBytes = parseSecretKey(keyForPayload);
  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);

  if (iv.length !== 12) {
    throw new ValidationError('Invalid IV length: expected 12 bytes');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      cryptoKey,
      cipherBytes as unknown as BufferSource
    );

    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    // SubtleCrypto rejects with OperationError when AES-GCM authentication tag verification fails
    throw new UnauthorizedError(
      'Failed to decrypt token: authentication tag mismatch or invalid key',
      err instanceof Error ? err : undefined
    );
  }
}
