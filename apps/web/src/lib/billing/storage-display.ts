/**
 * Media Library storage display — pure, client-safe, no server imports.
 *
 * This module is the single source of truth for the storage limit
 * states; the server-side enforcement in storage-quota.ts imports and
 * re-exports it, and the browser meter imports it directly. It must
 * NEVER import server-only code (server-analytics/posthog-node pulls
 * node:fs into the browser bundle and breaks the media page build).
 */

export const STORAGE_BYTES_PER_UNIT = 5368709120;

/**
 * Near-limit warning threshold: at or above 80% of allowed storage the
 * library shows a "reaching storage limit" warning. Uploads still work
 * until the limit itself is reached.
 */
export const STORAGE_NEAR_THRESHOLD = 0.8;

export interface StorageQuotaState {
  quotaBytes: number;
  usedBytes: number;
}

/**
 * Display states for the Media Library storage meter — derived from
 * the SAME quota/usage computation as upload enforcement (one helper,
 * one truth), never from a stored flag, so a downgrade (renewal buying
 * fewer units than before) engages read-only with no upload happening.
 * - null: no active period, so no limit to display. The Free-plan
 *   dialog already blocks the library in that case; the meter renders
 *   nothing rather than crashing on a missing period.
 * - normal: under the near threshold.
 * - near: used >= 80% of allowed, still under — warning only.
 * - full: used == allowed — uploads blocked by enforcement, and the
 *   meter says so plainly.
 * - over: used > allowed (downgrade case) — the library is read-only:
 *   uploads, new folders, and other writes are blocked server-side,
 *   while browsing, preview, and DELETE stay allowed (delete is the
 *   way back under the limit and is never blocked).
 */
export type MediaStorageState = 'normal' | 'near' | 'full' | 'over';

export function deriveMediaStorageState(
  usedBytes: number,
  quotaBytes: number
): MediaStorageState | null {
  if (quotaBytes <= 0) return null;
  if (usedBytes > quotaBytes) return 'over';
  if (usedBytes >= quotaBytes) return 'full';
  if (usedBytes >= STORAGE_NEAR_THRESHOLD * quotaBytes) return 'near';
  return 'normal';
}

export interface MediaStorageDisplay {
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  overBytes: number;
  state: MediaStorageState | null;
}

export function toMediaStorageDisplay(state: StorageQuotaState): MediaStorageDisplay {
  return {
    quotaBytes: state.quotaBytes,
    usedBytes: state.usedBytes,
    remainingBytes: Math.max(0, state.quotaBytes - state.usedBytes),
    overBytes: Math.max(0, state.usedBytes - state.quotaBytes),
    state: deriveMediaStorageState(state.usedBytes, state.quotaBytes),
  };
}

/** True exactly when the library must be read-only (used > allowed). */
export function isMediaStorageOver(state: StorageQuotaState): boolean {
  return state.usedBytes > state.quotaBytes;
}

export const MEDIA_STORAGE_READ_ONLY_CODE = 'MEDIA_STORAGE_READ_ONLY';
export const MEDIA_STORAGE_READ_ONLY_MESSAGE =
  'Your Media Library is read-only because it is over its storage limit. Delete some files to use it again.';

/** Whole-GB for enforcement messages ("5 GB", "40 GB"). */
export function formatStorageGb(bytes: number): string {
  return `${Math.round(bytes / 1073741824)} GB`;
}

/** One-decimal GB for the library meter ("25 GB", "12.5 GB"). */
export function formatStorageGbOneDecimal(bytes: number): string {
  const gb = bytes / 1073741824;
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
}
