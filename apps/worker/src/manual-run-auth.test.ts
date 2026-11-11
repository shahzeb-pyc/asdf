/**
 * Spec 163 — bearer-token check for the manual insights-followers run.
 *
 * The token is a dummy test string here, never a real secret. The real
 * token lives only in Doppler `prd` → GitHub sync → Worker secret.
 */
import { describe, expect, it } from 'vitest';
import { verifyBearerToken } from './manual-run-auth.js';

const EXPECTED = 'test-manual-run-token-abc123';

describe('verifyBearerToken', () => {
  it('accepts the exact token', async () => {
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED}`, EXPECTED)
    ).resolves.toBe(true);
  });

  it('accepts a lowercase bearer scheme', async () => {
    await expect(
      verifyBearerToken(`bearer ${EXPECTED}`, EXPECTED)
    ).resolves.toBe(true);
  });

  it('rejects a wrong token', async () => {
    await expect(
      verifyBearerToken('Bearer wrong-token', EXPECTED)
    ).resolves.toBe(false);
  });

  it('rejects a token that differs by one character', async () => {
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED.slice(0, -1)}X`, EXPECTED)
    ).resolves.toBe(false);
  });

  it('rejects a shorter token', async () => {
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED.slice(0, 5)}`, EXPECTED)
    ).resolves.toBe(false);
  });

  it('rejects a missing header', async () => {
    await expect(verifyBearerToken(null, EXPECTED)).resolves.toBe(false);
  });

  it('rejects a malformed header (no scheme, no space, extra parts)', async () => {
    await expect(verifyBearerToken(EXPECTED, EXPECTED)).resolves.toBe(
      false
    );
    await expect(verifyBearerToken('Bearer', EXPECTED)).resolves.toBe(
      false
    );
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED} extra`, EXPECTED)
    ).resolves.toBe(false);
    await expect(verifyBearerToken('Basic abc', EXPECTED)).resolves.toBe(
      false
    );
  });

  it('rejects everything when the expected secret is unset or empty', async () => {
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED}`, undefined)
    ).resolves.toBe(false);
    await expect(
      verifyBearerToken(`Bearer ${EXPECTED}`, '')
    ).resolves.toBe(false);
  });
});
