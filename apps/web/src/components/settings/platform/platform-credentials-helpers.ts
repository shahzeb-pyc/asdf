/**
 * Platform credentials — surviving pure helpers (spec 135 PR-135-3,
 * spec §8.2).
 *
 * This module carries only what is pure and shared: the per-platform
 * config contract the Instagram/Threads views supply, the credential
 * status type, and the "Connected on" date formatting. Everything
 * else that used to live in `platform-credentials-shared.tsx` is
 * deleted with that file: the fetch helpers and their `FetchFn`
 * injection seam (the typed API client + React Query replace them)
 * and the hand-rolled validator (the connect form's zod schema
 * carries its messages now, §6.3). No wrapper or shim is kept.
 */

export type PlatformCredentialStatus = 'unverified' | 'valid' | 'invalid';

export interface PlatformCredentialsConfig {
  /** Platform slug used in the settings address, e.g. "instagram". */
  platform: string;
  /** Platform name shown to the user, e.g. "Instagram". */
  displayName: string;
  /** Label for the ID field, in the platform's own terms, e.g. "Instagram App ID". */
  appIdLabel: string;
  /** Label for the secret field, e.g. "Instagram App Secret". */
  appSecretLabel: string;
  /** Prefix for data-testid values, e.g. "instagram". */
  testIdPrefix: string;
  /** Helper text under the ID field saying where the user finds it. */
  appIdHelper: string;
}

/** Format the "Connected on" date the way these tabs have always shown it. */
export function formatPlatformConnectedDate(dateStr?: string | null): string {
  const fallback = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (!dateStr) return fallback;
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return fallback;
  }
}
