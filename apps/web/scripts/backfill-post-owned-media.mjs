#!/usr/bin/env node
/**
 * Backfill post-owned media for existing Facebook queue items.
 *
 * Media/posting separation: a queued post must never depend on a
 * Media Library file. New posts already get a post-owned R2 copy at
 * queue time; this script gives the SAME protection to posts that
 * were queued before the separation shipped.
 *
 * WHAT IT DOES (per row, Facebook platform only, statuses
 * 'queued' and 'failed' — the live, unpublished queue):
 *   - copy: linked to a library file with bytes to copy — copy the
 *     bytes to a post-owned key
 *     `users/<userId>/post-media/<uuid>/<basename>`, then update
 *     the row (media_url, media_storage_key, media_item_id = NULL).
 *   - unlink-only: bytes already post-owned, link still set — null
 *     the link, no copy.
 *   - skip: already unlinked — nothing to do.
 *   - unrecoverable: linked but no storage key survives, no owner
 *     user id can be resolved, or the source bytes are already gone
 *     — left UNTOUCHED and reported. Bytes cannot be recovered, so
 *     the row is never silently "fixed".
 *
 * WHAT IT NEVER DOES:
 *   - It never deletes library bytes or library rows. The library
 *     file stays exactly as it is; only the queue row's link to it
 *     is removed.
 *   - It never touches Instagram/Threads queue items (their
 *     composers still use library links by design), published
 *     items, or any other table.
 *   - It never touches thumbnails: queue rows carry no thumbnail
 *     key, so there is nothing to copy.
 *
 * IDEMPOTENCY: re-running is safe. Rows already post-owned or
 * unlinked are skipped; a copy made for a row whose update then
 * affects 0 rows (concurrent change) is deleted best-effort, so a
 * re-run never orphans bytes. The update is guarded on the row's
 * current media_item_id, so a concurrent edit/delete cannot be
 * clobbered.
 *
 * MANUAL, OWNER-TAP ONLY: this script is SHIPPED UNAPPLIED. Run it
 * only on the owner's word, and always run --dry-run first:
 *
 *   node scripts/backfill-post-owned-media.mjs --dry-run
 *   node scripts/backfill-post-owned-media.mjs --apply
 *
 * Without --apply the script only reports what it WOULD do and
 * writes nothing (no S3 copies, no row updates).
 *
 * Environment (same names the web app uses):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service key: the
 *   script updates rows across workspaces),
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_PUBLIC_URL
 *
 * Exit code: 0 when every actionable row was processed (rows
 * reported unrecoverable do NOT fail the run — they are a data
 * condition, listed in the report, not a script failure); 1 on a
 * copy/update error, which leaves that row untouched for a re-run.
 *
 * The pure rules below mirror the app's TypeScript source of
 * truth (apps/web/src/lib/publishing/post-owned-media.ts:
 * storageKeyBasename, postOwnedCopyKey, classifyBackfillRow) — if
 * those change, this script must be updated to match.
 */

import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 500;
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
  return value;
}

function storageKeyBasename(key) {
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

function postOwnedCopyKey(userId, sourceKey) {
  return `users/${userId}/post-media/${randomUUID()}/${storageKeyBasename(sourceKey)}`;
}

/** Mirror of classifyBackfillRow (post-owned-media.ts). */
function classifyBackfillRow(row) {
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

/** Owner of a row: the linked library row's user, else the user id
 * embedded in the storage key itself (`users/<id>/...`). */
function resolveUserId(row, mediaUserById) {
  if (row.media_item_id && mediaUserById.has(row.media_item_id)) {
    return mediaUserById.get(row.media_item_id);
  }
  const match = /^users\/([^/]+)\//.exec(row.media_storage_key ?? '');
  return match ? match[1] : null;
}

async function main() {
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const supabaseKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const bucket = requiredEnv('R2_BUCKET_NAME');
  const publicBase = requiredEnv('R2_PUBLIC_URL').replace(/\/+$/, '');

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  const publicUrl = (key) => `${publicBase}/${key.replace(/^\/+/, '')}`;

  console.log(
    `Post-owned media backfill — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLYING'} — ` +
      `Facebook queue items, statuses queued/failed.`
  );

  const report = {
    examined: 0,
    copied: 0,
    unlinkedOnly: 0,
    skipped: 0,
    unrecoverable: [],
    failed: [],
    changedConcurrently: [],
  };

  let page = 0;
  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data: rows, error } = await supabase
      .from('queue_items')
      .select('id, media_item_id, media_url, media_storage_key')
      .eq('platform', 'facebook')
      .in('status', ['queued', 'failed'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to);
    if (error) {
      console.error('Failed to page queue_items:', error.message);
      process.exit(1);
    }
    if (!rows || rows.length === 0) break;

    // Batch-resolve library owners for this page's linked rows.
    const mediaIds = [
      ...new Set(rows.map((r) => r.media_item_id).filter(Boolean)),
    ];
    const mediaUserById = new Map();
    if (mediaIds.length > 0) {
      const { data: mediaRows, error: mediaError } = await supabase
        .from('media_items')
        .select('id, user_id')
        .in('id', mediaIds);
      if (mediaError) {
        console.error('Failed to resolve media owners:', mediaError.message);
        process.exit(1);
      }
      for (const m of mediaRows ?? []) mediaUserById.set(m.id, m.user_id);
    }

    for (const row of rows) {
      report.examined += 1;
      const action = classifyBackfillRow(row);
      if (action === 'skip') {
        report.skipped += 1;
        continue;
      }
      if (action === 'unrecoverable') {
        report.unrecoverable.push({
          id: row.id,
          reason: 'linked but no storage key survives',
        });
        continue;
      }
      const userId = resolveUserId(row, mediaUserById);
      if (!userId) {
        report.unrecoverable.push({
          id: row.id,
          reason: 'no owner user id resolvable (no library row, no users/ prefix)',
        });
        continue;
      }
      if (action === 'unlink-only') {
        if (DRY_RUN) {
          report.unlinkedOnly += 1;
          continue;
        }
        const { data: updated, error: updateError } = await supabase
          .from('queue_items')
          .update({ media_item_id: null })
          .eq('id', row.id)
          .eq('media_item_id', row.media_item_id)
          .select('id');
        if (updateError) {
          report.failed.push({ id: row.id, error: updateError.message });
          continue;
        }
        if (!updated || updated.length === 0) {
          report.changedConcurrently.push(row.id);
          continue;
        }
        report.unlinkedOnly += 1;
        continue;
      }

      // action === 'copy'
      const destinationKey = postOwnedCopyKey(userId, row.media_storage_key);
      if (DRY_RUN) {
        report.copied += 1;
        continue;
      }
      const encodedSource = row.media_storage_key
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${encodedSource}`,
            Key: destinationKey,
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NoSuchKey') || message.includes('Not Found')) {
          report.unrecoverable.push({
            id: row.id,
            reason: 'source bytes already gone from storage',
          });
        } else {
          report.failed.push({ id: row.id, error: message });
        }
        continue;
      }
      const { data: updated, error: updateError } = await supabase
        .from('queue_items')
        .update({
          media_url: publicUrl(destinationKey),
          media_storage_key: destinationKey,
          media_item_id: null,
        })
        .eq('id', row.id)
        .eq('media_item_id', row.media_item_id)
        .select('id');
      if (updateError) {
        report.failed.push({ id: row.id, error: updateError.message });
        continue;
      }
      if (!updated || updated.length === 0) {
        // Row changed concurrently: remove the just-made copy so
        // the re-run (or the new row state) never orphans bytes.
        try {
          await s3.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: destinationKey })
          );
        } catch {
          // Best-effort only; the key is reported for manual cleanup.
          console.error(
            `Copy ${destinationKey} for concurrently-changed row ${row.id} could not be cleaned up; delete it manually if the row no longer needs it.`
          );
        }
        report.changedConcurrently.push(row.id);
        continue;
      }
      report.copied += 1;
    }

    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.unrecoverable.length > 0) {
    console.log(
      '\nUNRECOVERABLE rows were left untouched (see report above). ' +
        'Their library bytes are gone and cannot be restored by this script; ' +
        'those posts need their media re-attached by hand.'
    );
  }
  if (report.failed.length > 0) {
    console.log(
      '\nFAILED rows were left untouched (see report above). Fix the ' +
        'cause and re-run; the script is idempotent.'
    );
    process.exit(1);
  }
  if (DRY_RUN) {
    console.log(
      '\nDry run complete — nothing was written. Re-run with --apply ' +
        'to perform the copies and updates above.'
    );
  } else {
    console.log('\nBackfill complete.');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
