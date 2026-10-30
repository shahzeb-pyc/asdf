/**
 * Destination queue persistence (spec 134 PR-134-3).
 *
 * The read/write side of the unified destination queue surfaces: the
 * queue list + item actions and the destination posting-slots writes.
 * Everything here touches ONLY the spec 120 unified tables
 * (`destinations`, `posting_slots`, `queue_items`) and always scoped
 * by workspace (and destination), so a caller authenticated for one
 * tenant can never read or mutate another tenant's rows — RLS on the
 * tables is the second line of defence; these queries are the first.
 *
 * Dual-client like the rest of the tenant API: the legacy
 * `DatabaseClient` (SQL) path exists for the test harness and the
 * Supabase path is what production runs. Updates use the legacy
 * handlers' full-row shape (the route computes the complete new state;
 * one fixed UPDATE writes it), which keeps both client paths — and
 * their failure modes — identical.
 */
import type { DatabaseClient, Platform } from '@fbuploadpro/contracts';
import type { UnifiedQueueItem } from '@/lib/api/schemas/unified-queue';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';
import type { ConnectDbClient } from '@/lib/connect/persist';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The destination row plus the live metering columns the D5 limit
 *  state and the retry gate read. Workspace-scoped, like the enqueue
 *  fetch — a foreign destination reads as not found. */
export interface DestinationQueueContext {
  id: string;
  platform: Platform;
  timezone: string;
  status: string;
  rateUsagePct: number;
  nextAllowedPublishAt: string | null;
  /** Raw `destinations.metadata` (carries the claim_limits override). */
  metadata: Record<string, unknown> | null;
}

type DestinationContextRaw = {
  id: string;
  platform: string;
  timezone?: string | null;
  status: string;
  rate_usage_pct?: number | string | null;
  next_allowed_publish_at?: string | null;
  metadata?: Record<string, unknown> | string | null;
};

function toMetadata(
  raw: Record<string, unknown> | string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    // jsonb arrives parsed from Supabase and as text from the SQL path;
    // an unparseable text value is no metadata, not an error.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  }
  return raw;
}

function toContext(row: DestinationContextRaw): DestinationQueueContext {
  return {
    id: row.id,
    platform: row.platform as Platform,
    timezone: row.timezone || 'UTC',
    status: row.status,
    rateUsagePct: Number(row.rate_usage_pct ?? 0),
    nextAllowedPublishAt: row.next_allowed_publish_at ?? null,
    metadata: toMetadata(row.metadata),
  };
}

export async function fetchDestinationQueueContext(
  client: ConnectDbClient,
  workspaceId: string,
  destinationId: string
): Promise<DestinationQueueContext | null> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, platform, timezone, status, rate_usage_pct,
              next_allowed_publish_at, metadata
       FROM destinations
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
      [destinationId, workspaceId]
    )) as DestinationContextRaw[];
    return rows?.[0] ? toContext(rows[0]) : null;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('destinations')
    .select(
      'id, platform, timezone, status, rate_usage_pct, next_allowed_publish_at, metadata'
    )
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  return toContext(data as DestinationContextRaw);
}

// ---------------------------------------------------------------------------
// Queue items
// ---------------------------------------------------------------------------

export interface DestinationQueueItemRow {
  id: string;
  workspace_id: string;
  destination_id: string;
  platform: string;
  kind: string;
  platform_format: string | null;
  caption: string;
  title: string | null;
  first_comment: string | null;
  media_item_id: string | null;
  media_url: string | null;
  media_storage_key: string | null;
  link_url: string | null;
  platform_options: Record<string, unknown> | string;
  scheduled_time: string;
  slot_id: string | null;
  status: string;
  claimed_at: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  external_post_id: string | null;
  created_at: string;
  updated_at: string;
}

const QUEUE_ITEM_COLUMNS =
  'id, workspace_id, destination_id, platform, kind, platform_format, caption, title, first_comment, media_item_id, media_url, media_storage_key, link_url, platform_options, scheduled_time, slot_id, status, claimed_at, retry_count, max_retries, error_message, external_post_id, created_at, updated_at';

function normalizeQueueItemRow(row: DestinationQueueItemRow): DestinationQueueItemRow {
  return {
    ...row,
    platform_options:
      typeof row.platform_options === 'string'
        ? (JSON.parse(row.platform_options) as Record<string, unknown>)
        : (row.platform_options ?? {}),
  };
}

/** One queue item, only when it belongs to the workspace + destination. */
export async function fetchDestinationQueueItem(
  client: ConnectDbClient,
  workspaceId: string,
  destinationId: string,
  itemId: string
): Promise<DestinationQueueItemRow | null> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT ${QUEUE_ITEM_COLUMNS}
       FROM queue_items
       WHERE workspace_id = $1 AND destination_id = $2 AND id = $3
       LIMIT 1`,
      [workspaceId, destinationId, itemId]
    )) as DestinationQueueItemRow[];
    return rows?.[0] ? normalizeQueueItemRow(rows[0]) : null;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('queue_items')
    .select(QUEUE_ITEM_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('destination_id', destinationId)
    .eq('id', itemId)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeQueueItemRow(data as DestinationQueueItemRow);
}

/** The complete editable state of a queue item — the PATCH / publish-now
 *  / retry handlers compute it in full, exactly like the legacy item
 *  handlers, and this writes it in one fixed-shape update. */
export interface DestinationQueueItemState {
  caption: string;
  title: string | null;
  firstComment: string | null;
  linkUrl: string | null;
  kind: string;
  platformFormat: string | null;
  platformOptions: Record<string, unknown>;
  /** Null for publisher-driven (Facebook) items: no stored time. */
  scheduledTime: string | null;
  slotId: string | null;
  status: string;
  /** Null clears a stale claim marker when an item is requeued. */
  claimedAt: string | null;
  /**
   * R12: the full-state write carries the retry budget too, so a
   * re-queue can reset it. Callers pass the stored count to
   * preserve it, or 0 when the item re-enters the queue after a
   * failure (retry, publish-now of a failed item, failed→queued
   * requeue) — a retried post gets a fresh budget of maxRetries,
   * instead of failing again against an exhausted count.
   */
  retryCount: number;
}

export async function updateDestinationQueueItem(
  client: ConnectDbClient,
  workspaceId: string,
  destinationId: string,
  itemId: string,
  state: DestinationQueueItemState
): Promise<DestinationQueueItemRow | null> {
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `UPDATE queue_items
       SET caption = $1,
           title = $2,
           first_comment = $3,
           link_url = $4,
           kind = $5,
           platform_format = $6,
           platform_options = $7,
           scheduled_time = $8,
           slot_id = $9,
           status = $10,
           claimed_at = $11,
           retry_count = $12,
           updated_at = now()
       WHERE id = $13 AND workspace_id = $14 AND destination_id = $15
       RETURNING ${QUEUE_ITEM_COLUMNS}`,
      [
        state.caption,
        state.title,
        state.firstComment,
        state.linkUrl,
        state.kind,
        state.platformFormat,
        JSON.stringify(state.platformOptions),
        state.scheduledTime,
        state.slotId,
        state.status,
        state.claimedAt,
        state.retryCount,
        itemId,
        workspaceId,
        destinationId,
      ]
    )) as DestinationQueueItemRow[];
    return rows?.[0] ? normalizeQueueItemRow(rows[0]) : null;
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('queue_items')
    .update({
      caption: state.caption,
      title: state.title,
      first_comment: state.firstComment,
      link_url: state.linkUrl,
      kind: state.kind,
      platform_format: state.platformFormat,
      platform_options: state.platformOptions,
      scheduled_time: state.scheduledTime,
      slot_id: state.slotId,
      status: state.status,
      claimed_at: state.claimedAt,
      retry_count: state.retryCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .eq('destination_id', destinationId)
    .select(QUEUE_ITEM_COLUMNS)
    .single();
  if (error || !data) return null;
  return normalizeQueueItemRow(data as DestinationQueueItemRow);
}

/** Maps a stored row to the client view (lib/api/schemas/unified-queue).
 *  `publishedAt` reads the row's last update: a published row's only
 *  post-publish write is the settle that published it, so its
 *  `updated_at` is the publish moment. */
export function toUnifiedQueueItemView(
  row: DestinationQueueItemRow,
  mediaById: Map<string, DestinationQueueMediaRow>
): UnifiedQueueItem {
  const mediaRow = row.media_item_id ? mediaById.get(row.media_item_id) : undefined;
  const media: UnifiedQueueItem['media'] = mediaRow
    ? {
        name: mediaRow.name,
        mediaType: mediaRow.media_type === 'video' ? 'video' : 'image',
        url: mediaRow.url,
        thumbnailUrl: mediaRow.thumbnail_url ?? null,
        durationSeconds:
          mediaRow.duration_seconds != null
            ? Number(mediaRow.duration_seconds)
            : null,
      }
    : row.media_url
      ? {
          name: '',
          mediaType: row.kind === 'video' ? 'video' : 'image',
          url: row.media_url,
          thumbnailUrl: null,
          durationSeconds: null,
        }
      : null;
  return {
    id: row.id,
    destinationId: row.destination_id,
    platform: row.platform as UnifiedQueueItem['platform'],
    kind: row.kind as UnifiedQueueItem['kind'],
    platformFormat: row.platform_format ?? null,
    caption: row.caption ?? '',
    title: row.title ?? null,
    firstComment: row.first_comment ?? null,
    linkUrl: row.link_url ?? null,
    mediaItemId: row.media_item_id ?? null,
    mediaUrl: row.media_url ?? null,
    media,
    platformOptions:
      typeof row.platform_options === 'object' ? row.platform_options : {},
    scheduledTime: row.scheduled_time ? new Date(row.scheduled_time).toISOString() : null,
    slotId: row.slot_id ?? null,
    status: row.status as UnifiedQueueItem['status'],
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    errorDetail: row.error_message ?? null,
    externalPostId: row.external_post_id ?? null,
    publishedAt:
      row.status === 'published'
        ? new Date(row.updated_at).toISOString()
        : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface DestinationQueueMediaRow {
  id: string;
  name: string;
  media_type: string;
  url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
}

/** Library details for the items' primary media (the panel's thumbnails
 *  + names). Per-user, like every media read — the item's denormalised
 *  `media_url` is the fallback when the library row is gone. */
export async function fetchDestinationQueueMedia(
  client: ConnectDbClient,
  userId: string,
  mediaIds: string[]
): Promise<DestinationQueueMediaRow[]> {
  if (mediaIds.length === 0) return [];
  if (isLegacyClient(client)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, name, media_type, url, thumbnail_url, duration_seconds
       FROM media_items
       WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, mediaIds]
    )) as DestinationQueueMediaRow[];
    return rows ?? [];
  }

  const supabase = getRouteSupabase(client as SupabaseClient);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('media_items')
    .select('id, name, media_type, url, thumbnail_url, duration_seconds')
    .eq('user_id', userId)
    .in('id', mediaIds);
  if (error || !data) return [];
  return data as DestinationQueueMediaRow[];
}
