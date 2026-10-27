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
import type { ConnectDbClient } from '@/lib/connect/persist';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DestinationForEnqueue {
  id: string;
  platform: Platform;
  timezone: string;
  status: string;
}

export interface OwnedMediaRow {
  id: string;
  media_type: string;
  url: string;
  storage_key: string | null;
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
}

type DestinationRowRaw = {
  id: string;
  platform: string;
  timezone?: string | null;
  status: string;
};

function toDestination(row: DestinationRowRaw): DestinationForEnqueue {
  return {
    id: row.id,
    platform: row.platform as Platform,
    timezone: row.timezone || 'UTC',
    status: row.status,
  };
}

/** The destination row, only when it belongs to the caller's workspace. */
export async function fetchDestinationForEnqueue(
  client: ConnectDbClient,
  workspaceId: string,
  destinationId: string
): Promise<DestinationForEnqueue | null> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, platform, timezone, status
       FROM destinations
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [destinationId, workspaceId]
    )) as DestinationRowRaw[];
    return rows?.[0] ? toDestination(rows[0]) : null;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, platform, timezone, status')
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  return toDestination(data as DestinationRowRaw);
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
      `SELECT id, media_type, url, storage_key
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
    .select('id, media_type, url, storage_key')
    .eq('user_id', userId)
    .in('id', mediaIds);
  if (error || !data) return [];
  return data as OwnedMediaRow[];
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
  const { data, error } = await supabase
    .from('queue_items')
    .insert({
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
    })
    .select(RETURNING_COLUMNS)
    .single();
  if (error || !data) return null;
  return data as InsertedQueueItemRow;
}
