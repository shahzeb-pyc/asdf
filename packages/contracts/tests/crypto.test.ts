import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  getTokenEncryptionKey,
  resolveTokenKeyRing,
} from '../src/crypto/token';
import { DomainError } from '../src/errors/domain-error';

describe('Web Crypto AES-256-GCM Token Encryption', () => {
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const sampleToken = 'EAABsbCS1iHgBA...mock_long_lived_user_access_token_60_days...';

  it('should encrypt and decrypt a token successfully (round-trip)', async () => {
    const encrypted = await encryptToken(sampleToken, validKey);
    expect(encrypted).toBeTypeOf('string');
    expect(encrypted).toContain(':');

    const decrypted = await decryptToken(encrypted, validKey);
    expect(decrypted).toBe(sampleToken);
  });

  it('should generate distinct ciphertexts for identical plaintext due to random 12-byte IV', async () => {
    const enc1 = await encryptToken(sampleToken, validKey);
    const enc2 = await encryptToken(sampleToken, validKey);

    expect(enc1).not.toBe(enc2);
    expect(await decryptToken(enc1, validKey)).toBe(sampleToken);
    expect(await decryptToken(enc2, validKey)).toBe(sampleToken);
  });

  it('should reject tampered ciphertext with authentication tag failure', async () => {
    const encrypted = await encryptToken(sampleToken, validKey);
    const [ivHex, cipherHex] = encrypted.split(':');
    if (!cipherHex) throw new Error('Invalid test setup');

    // Flip last character
    const tamperedCipher =
      cipherHex.slice(0, -1) + (cipherHex.slice(-1) === 'a' ? 'b' : 'a');
    const tamperedPayload = `${ivHex}:${tamperedCipher}`;

    await expect(decryptToken(tamperedPayload, validKey)).rejects.toThrow();
  });

  it('should fail decryption when using an incorrect secret key', async () => {
    const wrongKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const encrypted = await encryptToken(sampleToken, validKey);

    await expect(decryptToken(encrypted, wrongKey)).rejects.toThrow();
  });

  it('should reject malformed payload strings lacking iv:ciphertext delimiter', async () => {
    await expect(decryptToken('invalidpayloadwithoutcolon', validKey)).rejects.toThrow(
      /format/i
    );
  });

  it('should safely return null when decryptToken is called with an empty string and allowEmpty: true (ISSUE-49)', async () => {
    const result = await decryptToken('', validKey, { allowEmpty: true });
    expect(result).toBeNull();
  });

  it('should reject empty token string when allowEmpty is not set', async () => {
    await expect(decryptToken('', validKey)).rejects.toThrow(/empty/i);
  });

  it('should reject invalid key lengths not meeting 256-bit requirement', async () => {
    await expect(encryptToken(sampleToken, 'short-key')).rejects.toThrow(/key/i);
    await expect(decryptToken('iv:cipher', 'short-key')).rejects.toThrow(/key/i);
  });

  it('should never leak raw plaintext token in thrown errors', async () => {
    const sensitiveSecret = 'SUPER_SECRET_PLAINTEXT_TOKEN_VALUE_NEVER_LEAK';
    const wrongKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const encrypted = await encryptToken(sensitiveSecret, validKey);

    try {
      await decryptToken(encrypted, wrongKey);
      expect.unreachable('Should have failed decryption');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(sensitiveSecret);
    }
  });

  describe('getTokenEncryptionKey', () => {
    it('returns TOKEN_ENCRYPTION_KEY when provided in env', () => {
      const key = getTokenEncryptionKey({
        TOKEN_ENCRYPTION_KEY: 'token-key-1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      });
      expect(key).toBe('token-key-1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab');
    });

    it('ignores FB_ENCRYPTION_MASTER_KEY (fallback removed — TOKEN_ENCRYPTION_KEY is canonical)', () => {
      // With only the legacy key set and no NODE_ENV, the key is treated as absent
      expect(() => {
        getTokenEncryptionKey({
          FB_ENCRYPTION_MASTER_KEY: 'master-key-1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        });
      }).toThrow(DomainError);
    });

    it('falls back to dev key in test env even when only FB_ENCRYPTION_MASTER_KEY is set', () => {
      const key = getTokenEncryptionKey({
        NODE_ENV: 'test',
        FB_ENCRYPTION_MASTER_KEY: 'fallback-master-key-1234567890abcdef1234567890abcdef1234567890abcdef12',
      });
      expect(key).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    });

    it('falls back to dev key only in development/test environments when key is absent', () => {
      const testKey = getTokenEncryptionKey({ NODE_ENV: 'test' });
      expect(testKey).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

      const devKey = getTokenEncryptionKey({ NODE_ENV: 'development' });
      expect(devKey).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    });

    it('throws DomainError when NODE_ENV is undefined and key is absent (ISSUE-39)', () => {
      expect(() => {
        getTokenEncryptionKey({});
      }).toThrow(DomainError);

      expect(() => {
        getTokenEncryptionKey({});
      }).toThrow(/required/i);
    });

    it('throws DomainError in staging environment when key is absent (ISSUE-39)', () => {
      expect(() => {
        getTokenEncryptionKey({ NODE_ENV: 'staging' });
      }).toThrow(DomainError);
    });

    it('throws DomainError in production environment when key is absent', () => {
      expect(() => {
        getTokenEncryptionKey({ NODE_ENV: 'production' });
      }).toThrow(DomainError);

      expect(() => {
        getTokenEncryptionKey({ NODE_ENV: 'production' });
      }).toThrow(/TOKEN_ENCRYPTION_KEY is required/i);
    });

    it('allows valid key in production environment', () => {
      const prodKey = 'prod-key-1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
      const key = getTokenEncryptionKey({
        NODE_ENV: 'production',
        TOKEN_ENCRYPTION_KEY: prodKey,
      });
      expect(key).toBe(prodKey);
    });

    it('throws DomainError in production environment when key is set to DEV_FALLBACK_ENCRYPTION_KEY', () => {
      expect(() => {
        getTokenEncryptionKey({
          NODE_ENV: 'production',
          TOKEN_ENCRYPTION_KEY: validKey,
        });
      }).toThrow(/DEV_FALLBACK_ENCRYPTION_KEY is forbidden in production/i);
    });
  });

  // Audit S5 — key versioning: new payloads carry their key id,
  // legacy bare payloads keep decrypting, and a version with no
  // available key fails loudly naming the id.
  describe('token key versioning (S5)', () => {
    const oldKey =
      '1111111111111111111111111111111111111111111111111111111111111111';
    const newKey =
      '2222222222222222222222222222222222222222222222222222222222222222';
    const sample = 'EAAB-versioned-token';

    it('stamps new payloads with v1 and decrypts them with the same key', async () => {
      const encrypted = await encryptToken(sample, oldKey);
      expect(encrypted.startsWith('v1:')).toBe(true);
      expect(await decryptToken(encrypted, oldKey)).toBe(sample);
    });

    it('decrypts a custom key id via keysById (the rotation fallback)', async () => {
      const encrypted = await encryptToken(sample, oldKey, { keyId: 'v2' });
      expect(encrypted.startsWith('v2:')).toBe(true);
      // Without the retired key it must fail loudly, naming the id…
      await expect(decryptToken(encrypted, newKey)).rejects.toThrow(/key id v2/);
      // …and with it, it decrypts under the old key.
      expect(
        await decryptToken(encrypted, newKey, { keysById: { v2: oldKey } })
      ).toBe(sample);
    });

    it('still decrypts legacy bare iv:cipher payloads', async () => {
      const versioned = await encryptToken(sample, oldKey);
      const legacy = versioned.replace(/^v1:/, '');
      expect(await decryptToken(legacy, oldKey)).toBe(sample);
    });

    it('resolves the key ring from env, and rejects a malformed previous-keys map', () => {
      const ring = resolveTokenKeyRing({
        NODE_ENV: 'test',
        TOKEN_ENCRYPTION_KEY: newKey,
        TOKEN_ENCRYPTION_KEY_ID: 'v2',
        TOKEN_ENCRYPTION_KEYS_PREVIOUS: JSON.stringify({ v1: oldKey }),
      });
      expect(ring.keyId).toBe('v2');
      expect(ring.key).toBe(newKey);
      expect(ring.previousKeys).toEqual({ v1: oldKey });
      expect(() =>
        resolveTokenKeyRing({
          NODE_ENV: 'test',
          TOKEN_ENCRYPTION_KEY: newKey,
          TOKEN_ENCRYPTION_KEYS_PREVIOUS: 'not-json',
        })
      ).toThrow(/malformed/);
    });
  });
});
