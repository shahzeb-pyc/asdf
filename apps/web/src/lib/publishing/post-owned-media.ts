/**
 * Post-owned media (media/posting separation).
 *
 * A queued post must never depend on a Media Library file: the
 * library file's bytes are the post's bytes today, so deleting the
 * file deletes the post's media. This module is the single place
 * that draws the boundary:
 *
 *   - Library copies at queue time land under
 *     `users/<userId>/post-media/<uuid>/<basename>`.
 *   - Composer device uploads land under
 *     `users/<userId>/post-staging/<uuid>/<basename>` and are
 *     adopted as-is at queue time (already post-owned, never a
 *     library row, never listed in the library).
 *
 * Both prefixes are post-owned: the queue row stores the post-owned
 * url/key and media_item_id NULL, and the worker publishes from the
 * url alone — nothing on the publish path resolves through a library
 * row. Deleting a library file therefore deletes only that file.
 */
import { randomUUID } from 'node:crypto';
import type { IStorageService } from '@fbuploadpro/contracts';

/** Age after which an unclaimed staged upload is swept (24 hours). */
export const STAGED_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Bounds for one lazy sweep run: never an unbounded scan/delete. */
export const STAGED_SWEEP_MAX_LIST = 1000;
export const STAGED_SWEEP_MAX_DELETE = 50;

export function postMediaKeyPrefix(userId: string): string {
  return `users/${userId}/post-media/`;
}

export function postStagingKeyPrefix(userId: string): string {
  return `users/${userId}/post-staging/`;
}

/** True when the key lives under the user's own post-owned prefixes. */
export function isPostOwnedStorageKey(userId: string, key: string): boolean {
  return (
    key.startsWith(postMediaKeyPrefix(userId)) ||
    key.startsWith(postStagingKeyPrefix(userId))
  );
}

/** True when the key is one of the user's composer staged uploads. */
export function isPostStagingStorageKey(userId: string, key: string): boolean {
  return key.startsWith(postStagingKeyPrefix(userId));
}

/**
 * Basename of a storage key, sanitised the same way the upload
 * routes sanitise filenames (no directories, no unsafe characters),
 * so a library filename can never escape the post-owned prefix.
 */
export function storageKeyBasename(key: string): string {
  const raw = key.split('/').pop() ?? 'file';
  const sanitized = raw
    .normalize('NFKC')
    .replaceAll(/[/\\]/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^_+/, '');
  return sanitized && sanitized !== '.' && !sanitized.startsWith('.')
    ? sanitized
    : 'file';
}

/** The post-owned key a library file's bytes are copied to. */
export function postOwnedCopyKey(userId: string, sourceKey: string): string {
  return `${postMediaKeyPrefix(userId)}${randomUUID()}/${storageKeyBasename(sourceKey)}`;
}

/**
 * Copy one library file's bytes to a fresh post-owned key. The copy
 * runs inside the object store (no bytes through the app server).
 * Throws on failure — the caller must fail loud with no row written.
 */
export async function copyLibraryMediaToPostOwned(
  storage: IStorageService,
  userId: string,
  sourceKey: string
): Promise<{ storageKey: string; url: string }> {
  const destinationKey = postOwnedCopyKey(userId, sourceKey);
  await storage.copyObject({ sourceKey, destinationKey });
  return { storageKey: destinationKey, url: storage.getPublicUrl(destinationKey) };
}

export interface StagedSweepReport {
  examined: number;
  deleted: string[];
  failed: string[];
  /** Keys skipped (referenced, too fresh, or of unknown age). */
  skipped: number;
  error: string | null;
}

/**
 * Delete the user's staged uploads that no queue item references
 * anymore and that are older than the retention window. Bounded
 * (one list page, capped deletes) and never throwing: a sweep
 * failure is logged loudly by the caller and must never fail the
 * enqueue it rides along with. Keys of unknown age are skipped, not
 * deleted — age is the only thing that proves abandonment.
 */
export async function sweepUnclaimedStagedUploads(
  storage: IStorageService,
  userId: string,
  referencedKeys: ReadonlySet<string>,
  now: Date = new Date()
): Promise<StagedSweepReport> {
  const report: StagedSweepReport = {
    examined: 0,
    deleted: [],
    failed: [],
    skipped: 0,
    error: null,
  };
  try {
    const listed = await storage.listObjects({
      prefix: postStagingKeyPrefix(userId),
      maxKeys: STAGED_SWEEP_MAX_LIST,
    });
    report.examined = listed.length;
    for (const entry of listed) {
      if (report.deleted.length >= STAGED_SWEEP_MAX_DELETE) {
        report.skipped += 1;
        continue;
      }
      if (referencedKeys.has(entry.key)) {
        report.skipped += 1;
        continue;
      }
      if (
        entry.lastModified === null ||
        now.getTime() - entry.lastModified.getTime() < STAGED_UPLOAD_RETENTION_MS
      ) {
        report.skipped += 1;
        continue;
      }
      try {
        await storage.deleteObject(entry.key);
        report.deleted.push(entry.key);
      } catch (err) {
        report.failed.push(entry.key);
        console.error(`Staged sweep: failed to delete ${entry.key}:`, err);
      }
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error('Staged sweep failed:', err);
  }
  return report;
}

/**
 * Best-effort delete of one post's bytes when its queue item is
 * deleted. Only ever deletes post-owned keys (post-media/ or
 * post-staging/ under the user's prefix) — a library key is never
 * touched here, so a queue delete can never delete library bytes.
 * Never throws: a failed cleanup is logged, never fatal to the
 * delete it rides along with.
 */
export async function deletePostOwnedBytesBestEffort(
  storage: IStorageService,
  userId: string,
  key: string | null | undefined
): Promise<void> {
  if (!key || !isPostOwnedStorageKey(userId, key)) return;
  try {
    await storage.deleteObject(key);
  } catch (err) {
    console.error(`Failed to delete post-owned bytes ${key}:`, err);
  }
}

/** Backfill triage for one existing queue row. */
export type BackfillRowAction =
  | 'copy'
  | 'unlink-only'
  | 'skip'
  | 'unrecoverable';

/**
 * Classify one queued row for the post-owned backfill:
 *   - 'copy': linked to a library file with bytes to copy — copy
 *     them to a post-owned key, then null the link.
 *   - 'unlink-only': already post-owned bytes, link still set —
 *     null the link, no copy.
 *   - 'skip': already unlinked — nothing to do.
 *   - 'unrecoverable': linked but no storage key survives to copy
 *     from (library bytes already gone) — left untouched and
 *     reported; bytes cannot be recovered.
 */
export function classifyBackfillRow(row: {
  media_item_id: string | null;
  media_storage_key: string | null;
}): BackfillRowAction {
  if (row.media_item_id === null) return 'skip';
  if (row.media_storage_key === null || row.media_storage_key.length === 0) {
    return 'unrecoverable';
  }
  if (
    row.media_storage_key.includes('/post-media/') ||
    row.media_storage_key.includes('/post-staging/')
  ) {
    return 'unlink-only';
  }
  return 'copy';
}
