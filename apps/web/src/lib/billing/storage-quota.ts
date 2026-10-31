import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import { totalUnits } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import { getActivePeriod } from './entitlement';
import {
  STORAGE_BYTES_PER_UNIT,
  formatStorageGb,
  isMediaStorageOver,
  type StorageQuotaState,
} from './storage-display';
// Pure display/state helpers live in storage-display.ts (client-safe:
// no server-analytics/posthog-node there) and are re-exported here so
// existing server-side importers keep working unchanged.
export {
  STORAGE_BYTES_PER_UNIT,
  STORAGE_NEAR_THRESHOLD,
  deriveMediaStorageState,
  formatStorageGb,
  formatStorageGbOneDecimal,
  isMediaStorageOver,
  MEDIA_STORAGE_READ_ONLY_CODE,
  MEDIA_STORAGE_READ_ONLY_MESSAGE,
  toMediaStorageDisplay,
  type MediaStorageDisplay,
  type MediaStorageState,
  type StorageQuotaState,
} from './storage-display';

/**
 * Media Library storage quota, derived from the paid plan — not from
 * the legacy `user_storage_quotas` table, which no code reads and
 * whose fixed 5 GB row would drift from the plan the moment a user
 * buys more units.
 *
 * - Quota = 5 GB per paid page/account in the user's ACTIVE period,
 *   across all platforms (Facebook pages + every other platform's
 *   accounts). No active period → quota 0, so a Free user (or an
 *   expired period) cannot upload through the media routes at all —
 *   this backstops the Free-plan dialog for direct API uploads.
 * - Usage = the sum of `media_items.file_size` over the user's live
 *   rows only. Sizes are stored at confirm time from R2 HeadObject
 *   (verified bytes, never client-declared), so deleting a file
 *   frees its quota immediately and no counter table can drift.
 *   Thumbnails are small derivatives and are not counted.
 * - Enforcement points are upload start (declared size, advisory —
 *   a presigned PUT carries no size bound, so a client can lie) and
 *   confirm (verified size, the real gate: nothing lands without it).
 *   A multipart upload that completes over quota but fails confirm
 *   leaves orphaned R2 bytes but no library row and no quota used.
 *
 * 5 GB here is 5 GiB (5,368,709,120 bytes), matching the legacy
 * quota table's default, so "5 GB" means the same bytes everywhere.
 */
export type StorageQuotaCheck =
  | { allowed: true }
  | { allowed: false; message: string; noQuota: boolean };

export function checkStorageQuota(
  state: StorageQuotaState,
  incomingBytes: number
): StorageQuotaCheck {
  if (state.quotaBytes <= 0) {
    return {
      allowed: false,
      message: 'Your plan includes no Media Library storage. Upgrade to a paid plan to upload files.',
      noQuota: true,
    };
  }
  if (state.usedBytes + incomingBytes > state.quotaBytes) {
    return {
      allowed: false,
      message: `This upload would exceed your Media Library storage limit of ${formatStorageGb(state.quotaBytes)}. Delete some files to free space, or add more pages or accounts to your plan.`,
      noQuota: false,
    };
  }
  return { allowed: true };
}

function isSupabaseClient(
  client: SupabaseClient | DatabaseClient
): client is SupabaseClient {
  return 'from' in client && typeof (client as SupabaseClient).from === 'function';
}

function numberField(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function supabaseQuotaState(
  client: SupabaseClient,
  userId: string
): Promise<StorageQuotaState> {
  const period = await getActivePeriod(client, userId, new Date());
  const quotaBytes = period ? totalUnits(period.counts) * STORAGE_BYTES_PER_UNIT : 0;
  // Paged, never unbounded: PostgREST silently truncates at 1,000
  // rows, which would under-report usage and fail the quota open.
  let usedBytes = 0;
  let from = 0;
  const PAGE_SIZE = 1000;
  for (;;) {
    const { data, error } = await client
      .from('media_items')
      .select('file_size')
      .eq('user_id', userId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      logServerError('[billing] media usage query failed', error, { source: 'billing' });
      throw new Error('Media usage could not be checked');
    }
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      usedBytes += numberField((row as { file_size?: unknown }).file_size);
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { quotaBytes, usedBytes };
}

async function sqlQuotaState(
  client: DatabaseClient,
  userId: string
): Promise<StorageQuotaState> {
  const periodRows = await client.query<{
    facebook_count: unknown;
    instagram_count: unknown;
    threads_count: unknown;
    x_count: unknown;
    tiktok_count: unknown;
    youtube_count: unknown;
  }>(
    `SELECT facebook_count, instagram_count, threads_count, x_count, tiktok_count, youtube_count
       FROM subscription_periods
      WHERE user_id = $1
        AND superseded_at IS NULL
        AND starts_at <= now()
        AND ends_at > now()
      ORDER BY ends_at DESC
      LIMIT 1`,
    [userId]
  );
  const row = periodRows[0];
  const units = row
    ? totalUnits({
        facebook: numberField(row.facebook_count),
        instagram: numberField(row.instagram_count),
        threads: numberField(row.threads_count),
        x: numberField(row.x_count),
        tiktok: numberField(row.tiktok_count),
        youtube: numberField(row.youtube_count),
      })
    : 0;
  const usageRows = await client.query<{ total: unknown }>(
    `SELECT COALESCE(SUM(file_size), 0) AS total FROM media_items WHERE user_id = $1`,
    [userId]
  );
  return {
    quotaBytes: units * STORAGE_BYTES_PER_UNIT,
    usedBytes: numberField(usageRows[0]?.total),
  };
}

export async function getStorageQuotaState(
  client: SupabaseClient | DatabaseClient,
  userId: string
): Promise<StorageQuotaState> {
  return isSupabaseClient(client)
    ? supabaseQuotaState(client, userId)
    : sqlQuotaState(client, userId);
}

/**
 * Read-only gate for non-delete media writes (folder create/rename,
 * media update, batch move/caption). Returns false when no client
 * resolves (test harnesses without a database — the upload gates
 * use the same skip); throws on a query failure so callers can log it
 * loudly and let the handler's own DB calls surface any real outage
 * (a gate failure must never mask the handler's own error mapping,
 * e.g. duplicate-name 23505). Uploads are NOT gated here — they
 * already carry their own fail-closed quota check (used + incoming
 * size vs quota) at initiate/single/confirm.
 *
 * Admins are never gated (audit fix 2026-11-01): an admin's quota
 * is 0 by definition (admins hold no paid period), so without the
 * exemption every admin upload and folder write would 403. A
 * missing client is logged loudly (audit fix 2026-11-01): a gate
 * that silently skips is a fail-open, even in a test harness.
 */
export async function isMediaStorageReadOnly(
  client: SupabaseClient | DatabaseClient | null | undefined,
  userId: string,
  isAdmin: boolean = false
): Promise<boolean> {
  if (isAdmin) return false;
  if (!client) {
    logServerError('[billing] media storage gate skipped: no billing client', null, {
      source: 'billing',
      userId,
    });
    return false;
  }
  const state = await getStorageQuotaState(client, userId);
  return isMediaStorageOver(state);
}
