/**
 * Destination enqueue persistence (spec 119/132 enabling backend).
 *
 * The unified counterpart of the legacy page-queue writes: everything
 * here reads/writes ONLY the spec 120 unified tables (`destinations`,
 * `posting_slots`, `queue_items`) and always scoped by workspace, so
 * a caller authenticated for one tenant can never touch another
 * tenant's destinations, slots, or queue rows (RLS on the tables is
 * the second line of defence; these queries are the first).
 *
 * Dual-client like the rest of the tenant API: the legacy
 * `DatabaseClient` (SQL) path exists for the test harness and the
 * Supabase path is what production runs.
 */
import type { DatabaseClient, Platform } from '@fbuploadpro/contracts';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';
import { postStagingKeyPrefix } from '@/lib/publishing/post-owned-media';
import type { ConnectDbClient } from '@/lib/connect/persist';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DestinationForEnqueue {
  id: string;
  platform: Platform;
  timezone: string;
  status: string;
  /** Provider-side id (Facebook page id, or the platform account id). */
  externalDestinationId: string | null;
  /** Raw destinations.metadata (carries fb_status: 'paused'/'checkpoint'). */
  metadata: Record<string, unknown> | null;
  /** Owning social_accounts row, for the expired-account queue gate (BG1). */
  accountId: string;
  accountStatus: string | null;
  accountTokenExpiresAt: string | null;
}

export interface OwnedMediaRow {
  id: string;
  media_type: string;
  url: string;
  storage_key: string | null;
  /** K6: media facts for enqueue format validation (repo-defined
   * limits only — see validatePostFormatEligibility). Null when the
   * library row carries no value; unknown facts never fail a post. */
  file_size?: number | null;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
}

export interface DestinationSlotRow {
  id: string;
  kind: string[];
  time_of_day: string;
  is_active: boolean;
}

export interface InsertedQueueItemRow {
  id: string;
  workspace_id: string;
  destination_id: string;
  platform: string;
  kind: string;
  platform_format: string | null;
  status: string;
  scheduled_time: string | null;
  slot_id: string | null;
  queue_seq?: number | null;
  created_at: string;
}

export interface NewDestinationQueueItem {
  workspaceId: string;
  destinationId: string;
  platform: Platform;
  kind: string;
  platformFormat: string | null;
  caption: string;
  title: string | null;
  firstComment: string | null;
  mediaItemId: string | null;
  mediaUrl: string | null;
  mediaStorageKey: string | null;
  linkUrl: string | null;
  platformOptions: Record<string, unknown>;
  /** Null for publisher-driven (Facebook) queue items: no stored time. */
  scheduledTime: string | null;
  slotId: string | null;
  /**
   * The client idempotency key that produced this row (new migration
   * 20261029120100, NOT yet applied to prod). Stored so a retry can
   * find the row even when the idempotency result store failed —
   * that is what heals the swallowed-store duplicate. Null when the
   * caller sent no key, or when the column does not exist yet.
   */
  idempotencyKey?: string | null | undefined;
}

type DestinationRowRaw = {
  id: string;
  platform: string;
  timezone?: string | null;
  status: string;
  external_destination_id?: string | null;
  metadata?: Record<string, unknown> | string | null;
  account_id?: string | null;
  account_status?: string | null;
  account_token_expires_at?: string | null;
};

function toDestination(row: DestinationRowRaw): DestinationForEnqueue {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata && typeof row.metadata === 'object') {
    metadata = row.metadata;
  } else if (typeof row.metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      metadata = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    platform: row.platform as Platform,
    timezone: row.timezone || 'UTC',
    status: row.status,
    externalDestinationId:
      typeof row.external_destination_id === 'string' ? row.external_destination_id : null,
    metadata,
    accountId: row.account_id ?? '',
    accountStatus: row.account_status ?? null,
    accountTokenExpiresAt: row.account_token_expires_at ?? null,
  };
}

/**
 * Whether the destination's owning account is expired, for the BG1
 * queue gate: the stored status, or a token expiry date that has
 * already passed. A missing account row (accountId empty) is treated
 * as expired rather than trusted — the destination cannot be
 * published through an account the route cannot see.
 *
 * 'revoked' counts here too (launch prep, P0-2): the user removed
 * the app on the platform's side, so the account can no longer
 * publish — the route reports it distinctly (ACCOUNT_REVOKED)
 * rather than as an expiry, but the gate itself is the same
 * must-not-accept-new-queueing rule.
 */
export function isAccountExpiredForEnqueue(
  destination: DestinationForEnqueue,
  now: Date = new Date()
): boolean {
  if (!destination.accountId) return true;
  if (destination.accountStatus === 'expired') return true;
  if (destination.accountStatus === 'revoked') return true;
  if (
    destination.accountStatus === 'active' &&
    destination.accountTokenExpiresAt
  ) {
    const expiresMs = new Date(destination.accountTokenExpiresAt).getTime();
    if (!Number.isNaN(expiresMs) && expiresMs <= now.getTime()) return true;
  }
  return false;
}

/**
 * Map a DB destination status + metadata to the wire page status the
 * composer sees (mirrors DESTINATION_STATUS_TO_WIRE_SQL in
 * lib/server/facebook-wire.ts): 'paused' is disconnected + marker,
 * 'page_checkpoint' is error + checkpoint marker, plain 'error' is
 * an expired token.
 */
export function destinationWireStatus(
  destination: DestinationForEnqueue
): 'active' | 'paused' | 'fb_rate_limited' | 'page_checkpoint' | 'invalid_token' | 'disconnected' {
  const fbStatus = destination.metadata?.fb_status;
  if (destination.status === 'disconnected' && fbStatus === 'paused') return 'paused';
  if (destination.status === 'error' && fbStatus === 'checkpoint') return 'page_checkpoint';
  if (destination.status === 'active') return 'active';
  if (destination.status === 'rate_limited') return 'fb_rate_limited';
  if (destination.status === 'error') return 'invalid_token';
  return 'disconnected';
}

/** The destination row, only when it belongs to the caller's workspace. */
export async function fetchDestinationForEnqueue(
  client: ConnectDbClient,
  workspaceId: string,
  destinationId: string
): Promise<DestinationForEnqueue | null> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT d.id, d.platform, d.timezone, d.status, d.external_destination_id, d.metadata,
              d.account_id, sa.status AS account_status,
              sa.token_expires_at AS account_token_expires_at
       FROM destinations d
       LEFT JOIN social_accounts sa ON sa.id = d.account_id
       WHERE d.id = $1 AND d.workspace_id = $2
       LIMIT 1`,
      [destinationId, workspaceId]
    )) as DestinationRowRaw[];
    return rows?.[0] ? toDestination(rows[0]) : null;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, platform, timezone, status, external_destination_id, metadata, account_id')
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  // The account row is fetched separately: PostgREST cannot join
  // social_accounts into this shape, and the queue gate must see the
  // account's stored status and token expiry, not just the page's.
  const accountId = (data as DestinationRowRaw).account_id ?? null;
  let accountStatus: string | null = null;
  let accountTokenExpiresAt: string | null = null;
  if (accountId) {
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('status, token_expires_at')
      .eq('id', accountId)
      .maybeSingle();
    if (!accountError && account) {
      accountStatus = (account as { status?: string | null }).status ?? null;
      accountTokenExpiresAt =
        (account as { token_expires_at?: string | null }).token_expires_at ??
        null;
    }
  }
  return toDestination({
    ...(data as DestinationRowRaw),
    account_status: accountStatus,
    account_token_expires_at: accountTokenExpiresAt,
  });
}

/**
 * Every requested media row that belongs to the caller. The media
 * library is per-user (spec 1418 global library), so ownership is the
 * session user — the same check the legacy enqueue performs.
 */
export async function fetchOwnedMedia(
  client: ConnectDbClient,
  userId: string,
  mediaIds: string[]
): Promise<OwnedMediaRow[]> {
  if (mediaIds.length === 0) return [];
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, media_type, url, storage_key, file_size, duration_seconds, aspect_ratio
       FROM media_items
       WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, mediaIds]
    )) as OwnedMediaRow[];
    return rows ?? [];
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('media_items')
    .select('id, media_type, url, storage_key, file_size, duration_seconds, aspect_ratio')
    .eq('user_id', userId)
    .in('id', mediaIds);
  if (error || !data) return [];
  return data as OwnedMediaRow[];
}

/**
 * Queue statuses whose rows can still publish, and whose staged
 * keys the lazy sweep must therefore keep. Published and cancelled
 * rows are terminal — their staged bytes will never be published
 * from, so their keys are not kept.
 */
export const LIVE_QUEUE_STATUSES_FOR_SWEEP = ['queued', 'failed', 'publishing'] as const;

/** One keep-set page: PostgREST's default cap, and the SQL page size. */
const REFERENCED_STAGED_KEYS_PAGE = 1000;

/** The nil UUID: every real queue id sorts after it, so keyset paging starts here. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The post-staging keys currently referenced by any still-live
 * queue item in the workspace (the lazy staged-upload sweep's keep
 * set). Scoped by the staging prefix itself, so the scan stays
 * small: only staged keys can ever match, never library or
 * post-media keys.
 *
 * Complete, not capped: the keep set pages through every live row
 * (keyset on id) instead of taking an arbitrary first 1,000. A
 * capped slice used to drop a still-queued staged post scheduled
 * far out once the workspace passed 1,000 staged-key rows, and the
 * sweep then deleted bytes its later publish needed.
 */
export async function fetchReferencedStagedKeys(
  client: ConnectDbClient,
  workspaceId: string,
  userId: string
): Promise<Set<string>> {
  const prefix = postStagingKeyPrefix(userId);
  if (isLegacyClient(client)) {
    const keys = new Set<string>();
    let lastId = NIL_UUID;
    for (;;) {
      const rows = (await (client as DatabaseClient).query(
        `SELECT id, media_storage_key
         FROM queue_items
         WHERE workspace_id = $1 AND media_storage_key LIKE $2
           AND status = ANY($3::text[]) AND id > $4
         ORDER BY id ASC
         LIMIT ${REFERENCED_STAGED_KEYS_PAGE}`,
        [workspaceId, `${prefix}%`, [...LIVE_QUEUE_STATUSES_FOR_SWEEP], lastId]
      )) as Array<{ id: string; media_storage_key?: string | null }>;
      for (const r of rows) {
        if (typeof r.media_storage_key === 'string' && r.media_storage_key.length > 0) {
          keys.add(r.media_storage_key);
        }
      }
      if (rows.length < REFERENCED_STAGED_KEYS_PAGE) break;
      lastId = rows[rows.length - 1].id;
    }
    return keys;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  // Fail closed, like the legacy branch (whose query throws on a
  // DB error): an empty set here would be indistinguishable from
  // "nothing referenced", and the sweep would then delete every
  // old staged key — including live queued posts. The caller
  // catches a throw and skips the sweep instead.
  if (!supabase) {
    throw new Error(
      'Cannot fetch referenced staged keys: no Supabase client available'
    );
  }
  const keys = new Set<string>();
  let lastId = NIL_UUID;
  for (;;) {
    const { data, error } = await supabase
      .from('queue_items')
      .select('id, media_storage_key')
      .eq('workspace_id', workspaceId)
      .like('media_storage_key', `${prefix}%`)
      .in('status', [...LIVE_QUEUE_STATUSES_FOR_SWEEP])
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(REFERENCED_STAGED_KEYS_PAGE);
    if (error) {
      throw new Error(`Failed to fetch referenced staged keys: ${error.message}`);
    }
    const page = data as Array<{ id: string; media_storage_key?: string | null }>;
    for (const r of page) {
      if (typeof r.media_storage_key === 'string' && r.media_storage_key.length > 0) {
        keys.add(r.media_storage_key);
      }
    }
    if (page.length < REFERENCED_STAGED_KEYS_PAGE) break;
    lastId = page[page.length - 1].id;
  }
  return keys;
}

/** All of a destination's unified posting slots, earliest first. */
export async function fetchDestinationSlots(
  client: ConnectDbClient,
  destinationId: string
): Promise<DestinationSlotRow[]> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, kind, time_of_day, is_active
       FROM posting_slots
       WHERE destination_id = $1
       ORDER BY time_of_day ASC`,
      [destinationId]
    )) as DestinationSlotRow[];
    return rows ?? [];
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('posting_slots')
    .select('id, kind, time_of_day, is_active')
    .eq('destination_id', destinationId)
    .order('time_of_day', { ascending: true });
  if (error || !data) return [];
  return data as DestinationSlotRow[];
}

/** Scheduled times of the destination's still-queued items (slot vacancy input). */
export async function fetchDestinationQueuedTimes(
  client: ConnectDbClient,
  destinationId: string
): Promise<Date[]> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT scheduled_time
       FROM queue_items
       WHERE destination_id = $1 AND status = 'queued'`,
      [destinationId]
    )) as Array<{ scheduled_time: string | Date }>;
    return (rows ?? []).map((r) => new Date(r.scheduled_time));
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('queue_items')
    .select('scheduled_time')
    .eq('destination_id', destinationId)
    .eq('status', 'queued');
  if (error || !data) return [];
  return (data as Array<{ scheduled_time: string }>).map(
    (r) => new Date(r.scheduled_time)
  );
}

const RETURNING_COLUMNS =
  'id, workspace_id, destination_id, platform, kind, platform_format, status, scheduled_time, slot_id, queue_seq, created_at';

/**
 * Inserts one unified queue item in the claimable 'queued' state.
 * queue_seq is the ONE queue ordering: the next sequence number for
 * the destination (ties, only possible under concurrent Supabase
 * inserts, break on created_at in every ordering query).
 */
export async function insertDestinationQueueItem(
  client: ConnectDbClient,
  item: NewDestinationQueueItem
): Promise<InsertedQueueItemRow | null> {
  if (isLegacyClient(client)) {
    try {
      const rows = (await (client as DatabaseClient).query(
        `INSERT INTO queue_items (
           workspace_id, destination_id, platform, kind, platform_format,
           caption, title, first_comment, media_item_id, media_url,
           media_storage_key, link_url, platform_options, scheduled_time,
           slot_id, queue_seq, status, retry_count, max_retries, idempotency_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM queue_items WHERE destination_id = $2),
           'queued', 0, 3, $16)
         RETURNING ${RETURNING_COLUMNS}`,
        [
          item.workspaceId,
          item.destinationId,
          item.platform,
          item.kind,
          item.platformFormat,
          item.caption,
          item.title,
          item.firstComment,
          item.mediaItemId,
          item.mediaUrl,
          item.mediaStorageKey,
          item.linkUrl,
          JSON.stringify(item.platformOptions),
          item.scheduledTime,
          item.slotId,
          item.idempotencyKey ?? null,
        ]
      )) as InsertedQueueItemRow[];
      return rows?.[0] ?? null;
    } catch (err) {
      // Pre-migration databases have no idempotency_key column: fall
      // back to the old insert shape rather than failing the post.
      // Any other failure is a real failure, not a missing column.
      if (!String(err instanceof Error ? err.message : err).includes('idempotency_key')) {
        return null;
      }
      const rows = (await (client as DatabaseClient).query(
        `INSERT INTO queue_items (
           workspace_id, destination_id, platform, kind, platform_format,
           caption, title, first_comment, media_item_id, media_url,
           media_storage_key, link_url, platform_options, scheduled_time,
           slot_id, queue_seq, status, retry_count, max_retries
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
           (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM queue_items WHERE destination_id = $2),
           'queued', 0, 3)
         RETURNING ${RETURNING_COLUMNS}`,
        [
          item.workspaceId,
          item.destinationId,
          item.platform,
          item.kind,
          item.platformFormat,
          item.caption,
          item.title,
          item.firstComment,
          item.mediaItemId,
          item.mediaUrl,
          item.mediaStorageKey,
          item.linkUrl,
          JSON.stringify(item.platformOptions),
          item.scheduledTime,
          item.slotId,
        ]
      )) as InsertedQueueItemRow[];
      return rows?.[0] ?? null;
    }
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data: seqRows } = await supabase
    .from('queue_items')
    .select('queue_seq')
    .eq('destination_id', item.destinationId)
    .order('queue_seq', { ascending: false, nullsFirst: false })
    .limit(1);
  const nextSeq =
    (seqRows as Array<{ queue_seq?: number | null }> | null)?.[0]?.queue_seq != null
      ? Number((seqRows as Array<{ queue_seq?: number | null }>)[0]!.queue_seq) + 1
      : 1;
  const baseRow = {
    workspace_id: item.workspaceId,
    destination_id: item.destinationId,
    platform: item.platform,
    kind: item.kind,
    platform_format: item.platformFormat,
    caption: item.caption,
    title: item.title,
    first_comment: item.firstComment,
    media_item_id: item.mediaItemId,
    media_url: item.mediaUrl,
    media_storage_key: item.mediaStorageKey,
    link_url: item.linkUrl,
    platform_options: item.platformOptions,
    scheduled_time: item.scheduledTime,
    slot_id: item.slotId,
    queue_seq: nextSeq,
    status: 'queued',
    retry_count: 0,
    max_retries: 3,
  };
  const firstAttempt = await supabase
    .from('queue_items')
    .insert({ ...baseRow, idempotency_key: item.idempotencyKey ?? null })
    .select(RETURNING_COLUMNS)
    .single();
  if (!firstAttempt.error && firstAttempt.data) {
    return firstAttempt.data as InsertedQueueItemRow;
  }
  const missingColumn =
    firstAttempt.error &&
    (firstAttempt.error.code === '42703' ||
      String(firstAttempt.error.message ?? '').includes('idempotency_key'));
  if (!missingColumn) return null;
  // Pre-migration: retry without the new column.
  const fallback = await supabase
    .from('queue_items')
    .insert(baseRow)
    .select(RETURNING_COLUMNS)
    .single();
  if (fallback.error || !fallback.data) return null;
  return fallback.data as InsertedQueueItemRow;
}

/**
 * True only for a missing idempotency_key column: Postgres 42703
 * (undefined column), PostgREST PGRST204 (schema-cache miss, which
 * is how a missing column surfaces through PostgREST), or any error
 * message naming the column. Nothing else counts — a failed heal
 * must NOT silently proceed to a fresh insert (that is exactly how
 * a retry duplicates), so every other error still throws.
 */
function isMissingIdempotencyColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = String(
    (error as { message?: unknown } | null)?.message ?? error ?? ''
  );
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    message.includes('idempotency_key')
  );
}

/**
 * Find a queue row previously inserted under one idempotency key —
 * the heal path for a result whose idempotency store failed. Returns
 * null when the idempotency_key column does not exist yet (migration
 * 20261029120100 not applied), so pre-migration deployments simply
 * skip the heal instead of 500ing every keyed enqueue. Every other
 * error still throws to the route, which fails loudly with 500
 * before executing — a failed heal never silently proceeds to a
 * fresh insert.
 */
export async function findQueueItemByIdempotencyKey(
  client: ConnectDbClient,
  workspaceId: string,
  idempotencyKey: string
): Promise<InsertedQueueItemRow | null> {
  if (isLegacyClient(client)) {
    try {
      const rows = (await (client as DatabaseClient).query(
        `SELECT ${RETURNING_COLUMNS}
         FROM queue_items
         WHERE workspace_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [workspaceId, idempotencyKey]
      )) as InsertedQueueItemRow[];
      return rows?.[0] ?? null;
    } catch (error) {
      if (isMissingIdempotencyColumn(error)) return null;
      throw error;
    }
  }
  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('queue_items')
    .select(RETURNING_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) {
    if (isMissingIdempotencyColumn(error)) return null;
    throw error;
  }
  if (!data) return null;
  return data as InsertedQueueItemRow;
}
