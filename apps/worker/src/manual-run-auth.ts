/**
 * Spec 163 — bearer-token check for the manual insights-followers run.
 *
 * The token is a Worker secret (`INSIGHTS_MANUAL_RUN_TOKEN`) and must
 * never be compared with a plain `===`: a timing leak would let an
 * attacker guess it byte by byte. Both sides are SHA-256 digested and
 * the fixed-length digests are compared in constant time, so the
 * comparison leaks neither the value nor its length. If the WebCrypto
 * subtle API is unavailable the check fails closed — it never falls
 * back to a plain comparison.
 *
 * Pure function, no I/O, no logging — the token value never appears
 * in a log line from here.
 */

/** SHA-256 digest of a UTF-8 string, or null when subtle is unavailable. */
async function sha256(value: string): Promise<Uint8Array | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const data = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return new Uint8Array(data);
}

/** Constant-time equality over equal-length byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Returns true only when `header` is exactly `Bearer <token>` and the
 * token matches `expected`. Any missing, malformed, or mismatched
 * input returns false — including when `expected` itself is unset or
 * empty, so an unconfigured secret can never authenticate a call.
 */
export async function verifyBearerToken(
  header: string | null,
  expected: string | undefined
): Promise<boolean> {
  if (!expected) return false;
  if (!header) return false;
  const space = header.indexOf(' ');
  if (space <= 0) return false;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return false;
  const presented = header.slice(space + 1);
  if (!presented || presented.includes(' ')) return false;
  const [presentedDigest, expectedDigest] = await Promise.all([
    sha256(presented),
    sha256(expected),
  ]);
  if (!presentedDigest || !expectedDigest) return false;
  return constantTimeEqual(presentedDigest, expectedDigest);
}
