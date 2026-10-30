import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { parsePaginationParams } from '@/lib/server/pagination';
import {
  ListInstagramScheduleQueueResponseSchema,
  type InstagramScheduleQueueItem,
} from '@/lib/api/schemas/instagram-schedule';
import {
  isScheduledDestination,
  parseDestinationMetadata,
} from '@/lib/server/instagram-schedule';
import {
  authenticateInstagramSchedule,
  type InstagramScheduleDbClient,
} from '@/lib/server/instagram-schedule-auth';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Instagram Schedule queue list for one scheduled destination.
 * The Facebook queue list route hardcodes platform='facebook', so
 * Instagram has its own list here, on the same unified queue_items
 * table and the same wire shape (extended with the real kind and a
 * display format that does not collapse carousels to images).
 * Bounded: page/limit (default 30, max 50), status filter, optional
 * from/to window for Calendar View (max 93 days, max 200 rows).
 * Counts come from head/count queries, never from full row reads.
 */

interface QueueRow {
  id: string;
  destination_id: string;
  slot_id: string | null;
  media_item_id: string | null;
  kind: string | null;
  platform_format: string | null;
  link_url: string | null;
  scheduled_time: string | null;
  caption: string | null;
  first_comment: string | null;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  external_post_id: string | null;
  external_comment_id: string | null;
  created_at: string;
  updated_at: string;
  media_name?: string | null;
  media_type?: string | null;
  media_thumbnail_url?: string | null;
  media_url?: string | null;
  media_aspect_ratio?: string | null;
  media_duration_seconds?: number | null;
}

function displayFormatFor(
  kind: string | null,
  platformFormat: string | null
): 'image' | 'reel' | 'carousel' {
  if (kind === 'carousel') return 'carousel';
  if (platformFormat === 'reel' || kind === 'video') return 'reel';
  return 'image';
}

function postFormatFor(
  kind: string | null,
  platformFormat: string | null
): 'text' | 'image' | 'reel' | 'video' | 'story' {
  if (platformFormat === 'reel') return 'reel';
  if (kind === 'video') return 'video';
  if (kind === 'image') return 'image';
  if (kind === 'story') return 'story';
  if (kind === 'text') return 'text';
  return 'image';
}

function rowToItem(row: QueueRow, ownerId: string): InstagramScheduleQueueItem {
  const base = {
    id: row.id,
    userId: ownerId,
    pageId: row.destination_id,
    slotId: row.slot_id,
    mediaId: row.media_item_id,
    postFormat: postFormatFor(row.kind, row.platform_format),
    linkUrl: row.link_url ?? null,
    scheduledTime: row.scheduled_time,
    caption: row.caption ?? '',
    firstComment: row.first_comment,
    status: row.status as InstagramScheduleQueueItem['status'],
    retryCount: row.retry_count ?? 0,
    maxRetries: row.max_retries ?? 0,
    fbPostId: row.external_post_id,
    fbCommentId: row.external_comment_id,
    publishedAt: row.status === 'published' ? row.updated_at : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.kind ?? 'image',
    platformFormat: row.platform_format,
    displayFormat: displayFormatFor(row.kind, row.platform_format),
  };
  if (row.media_name) {
    return {
      ...base,
      media: {
        name: row.media_name,
        mediaType: row.media_type === 'video' ? 'video' : 'image',
        thumbnailUrl: row.media_thumbnail_url ?? null,
        url: row.media_url ?? '',
        aspectRatio: row.media_aspect_ratio ?? 'unknown',
        durationSeconds: row.media_duration_seconds ?? null,
      },
    };
  }
  return base;
}

export async function handleListInstagramScheduleQueue(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const { page, limit } = parsePaginationParams(url.searchParams);
  const status = url.searchParams.get('status') ?? 'all';
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  let from: Date | null = null;
  let to: Date | null = null;
  if (fromRaw && toRaw) {
    const fromDate = new Date(fromRaw);
    const toDate = new Date(toRaw);
    if (Number.isFinite(fromDate.getTime()) && Number.isFinite(toDate.getTime())) {
      const days = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
      if (days >= 0 && days <= 93) {
        from = fromDate;
        to = toDate;
      }
    }
  }
  const effectiveLimit = from && to ? Math.min(limit, 200) : limit;
  try {
    let rows: QueueRow[];
    let total: number;
    let counts: Record<string, number>;
    if (dbClient && 'query' in dbClient) {
      const sql = dbClient as DatabaseClient;
      const destRows = await sql.query<{ metadata: unknown }>(
        `SELECT metadata FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
        [destinationId, auth.workspaceId]
      );
      if (
        !destRows[0] ||
        !isScheduledDestination(parseDestinationMetadata(destRows[0].metadata))
      ) {
        return NextResponse.json(
          { error: 'Scheduled account not found.' },
          { status: 404 }
        );
      }
      const conditions = ['qi.destination_id = $1', 'qi.workspace_id = $2'];
      const params: unknown[] = [destinationId, auth.workspaceId];
      if (status !== 'all') {
        const p = `$${params.length + 1}`;
        params.push(status);
        conditions.push(`qi.status = ${p}`);
      }
      if (from && to) {
        const pFrom = `$${params.length + 1}`;
        const pTo = `$${params.length + 2}`;
        params.push(from.toISOString(), to.toISOString());
        conditions.push(`qi.scheduled_time >= ${pFrom} AND qi.scheduled_time < ${pTo}`);
      }
      const where = conditions.join(' AND ');
      const countRows = await sql.query<{ total?: unknown }>(
        `SELECT COUNT(*)::int AS total FROM queue_items qi WHERE ${where}`,
        params
      );
      total = typeof countRows[0]?.total === 'number' ? countRows[0].total : 0;
      const dataParams = [...params, effectiveLimit, (page - 1) * effectiveLimit];
      const limitParam = `$${dataParams.length - 1}`;
      const offsetParam = `$${dataParams.length}`;
      rows = await sql.query<QueueRow>(
        `SELECT qi.id, qi.destination_id, qi.slot_id, qi.media_item_id, qi.kind,
           qi.platform_format, qi.link_url, qi.scheduled_time, qi.caption,
           qi.first_comment, qi.status, qi.retry_count, qi.max_retries,
           qi.external_post_id, qi.external_comment_id, qi.created_at, qi.updated_at,
           mi.name AS media_name, mi.media_type AS media_type,
           mi.thumbnail_url AS media_thumbnail_url, mi.url AS media_url,
           mi.aspect_ratio AS media_aspect_ratio,
           mi.duration_seconds AS media_duration_seconds
         FROM queue_items qi
         LEFT JOIN media_items mi ON mi.id = qi.media_item_id
         WHERE ${where}
         ORDER BY qi.scheduled_time ASC NULLS LAST, qi.created_at ASC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        dataParams
      );
      const countStatuses = ['queued', 'published', 'failed', 'cancelled', 'publishing'];
      counts = {};
      for (const s of countStatuses) {
        const cRows = await sql.query<{ total?: unknown }>(
          `SELECT COUNT(*)::int AS total FROM queue_items WHERE destination_id = $1 AND workspace_id = $2 AND status = $3`,
          [destinationId, auth.workspaceId, s]
        );
        counts[s] = typeof cRows[0]?.total === 'number' ? cRows[0].total : 0;
      }
    } else {
      const supabase = (dbClient && 'from' in dbClient
        ? (dbClient as SupabaseClient)
        : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) {
        return NextResponse.json(
          { error: 'Database service unavailable' },
          { status: 500 }
        );
      }
      const { data: dest } = await supabase
        .from('destinations')
        .select('metadata')
        .eq('id', destinationId)
        .eq('workspace_id', auth.workspaceId)
        .eq('platform', 'instagram')
        .maybeSingle();
      if (
        !dest ||
        !isScheduledDestination(parseDestinationMetadata(dest.metadata))
      ) {
        return NextResponse.json(
          { error: 'Scheduled account not found.' },
          { status: 404 }
        );
      }
      let query = supabase
        .from('queue_items')
        .select(
          'id, destination_id, slot_id, media_item_id, kind, platform_format, link_url, scheduled_time, caption, first_comment, status, retry_count, max_retries, external_post_id, external_comment_id, created_at, updated_at',
          { count: 'exact' }
        )
        .eq('destination_id', destinationId)
        .eq('workspace_id', auth.workspaceId)
        .order('scheduled_time', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .range((page - 1) * effectiveLimit, page * effectiveLimit - 1);
      if (status !== 'all') query = query.eq('status', status);
      if (from && to) {
        query = query
          .gte('scheduled_time', from.toISOString())
          .lt('scheduled_time', to.toISOString());
      }
      const { data, count, error } = await query;
      if (error) throw new Error(error.message);
      total = count ?? 0;
      const mediaIds = [...new Set((data ?? []).map((r) => r.media_item_id).filter(Boolean))];
      let mediaById = new Map<string, QueueRow>();
      if (mediaIds.length > 0) {
        const { data: media } = await supabase
          .from('media_items')
          .select('id, name, media_type, thumbnail_url, url, aspect_ratio, duration_seconds')
          .in('id', mediaIds as string[]);
        mediaById = new Map(
          (media ?? []).map((m) => [
            m.id,
            {
              media_name: m.name,
              media_type: m.media_type,
              media_thumbnail_url: m.thumbnail_url,
              media_url: m.url,
              media_aspect_ratio: m.aspect_ratio,
              media_duration_seconds: m.duration_seconds,
            } as Partial<QueueRow>,
          ]) as unknown as Map<string, QueueRow>
        );
      }
      rows = (data ?? []).map((r) => ({
        ...(r as unknown as QueueRow),
        ...(r.media_item_id ? mediaById.get(r.media_item_id as string) ?? {} : {}),
      }));
      counts = {};
      for (const s of ['queued', 'published', 'failed', 'cancelled', 'publishing']) {
        const { count: c } = await supabase
          .from('queue_items')
          .select('id', { count: 'exact', head: true })
          .eq('destination_id', destinationId)
          .eq('workspace_id', auth.workspaceId)
          .eq('status', s);
        counts[s] = c ?? 0;
      }
    }
    const items = rows.map((row) => rowToItem(row, auth.session.userId));
    const payload = ListInstagramScheduleQueueResponseSchema.parse({
      items,
      total,
      limit: effectiveLimit,
      offset: (page - 1) * effectiveLimit,
      queuedCount: counts.queued ?? 0,
      publishedCount: counts.published ?? 0,
      failedCount: counts.failed ?? 0,
      cancelledCount: counts.cancelled ?? 0,
      publishingCount: counts.publishing ?? 0,
    });
    return NextResponse.json(payload);
  } catch (err) {
    logServerError('[instagram-schedule] queue list failed', err, {
      source: 'instagram-schedule-queue',
    });
    return NextResponse.json(
      { error: 'Failed to load the queue.' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleListInstagramScheduleQueue(request, subdomain, destinationId);
}
