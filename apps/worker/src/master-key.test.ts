/**
 * Audit S3 — the worker resolves token keys under the web's
 * production fail-closed rules: a production dev-fallback key
 * (or a missing key outside dev/test) throws instead of
 * silently encrypting/decrypting real tokens with it.
 */
import { describe, expect, it } from 'vitest';
import { resolveWorkerMasterKey } from './master-key.js';

const DEV_FALLBACK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const REAL_KEY =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('resolveWorkerMasterKey (S3)', () => {
  it('throws for the dev fallback key in production', () => {
    expect(() =>
      resolveWorkerMasterKey({
        TOKEN_ENCRYPTION_KEY: DEV_FALLBACK,
        ENVIRONMENT: 'production',
      })
    ).toThrow(/forbidden in production/);
  });

  it('throws for a missing key in production', () => {
    expect(() =>
      resolveWorkerMasterKey({ ENVIRONMENT: 'production' })
    ).toThrow(/required in production/);
  });

  it('returns a real key in production, trimmed', () => {
    expect(
      resolveWorkerMasterKey({
        TOKEN_ENCRYPTION_KEY: `  ${REAL_KEY}  `,
        ENVIRONMENT: 'production',
      })
    ).toBe(REAL_KEY);
  });

  it('allows the dev fallback outside production (dev/test fall back, as on web)', () => {
    expect(
      resolveWorkerMasterKey({
        TOKEN_ENCRYPTION_KEY: DEV_FALLBACK,
        ENVIRONMENT: 'development',
      })
    ).toBe(DEV_FALLBACK);
    expect(
      resolveWorkerMasterKey({ ENVIRONMENT: 'test' })
    ).toBe(DEV_FALLBACK);
  });

  it('returns a configured key unchanged outside production', () => {
    expect(
      resolveWorkerMasterKey({ TOKEN_ENCRYPTION_KEY: REAL_KEY })
    ).toBe(REAL_KEY);
  });
});
