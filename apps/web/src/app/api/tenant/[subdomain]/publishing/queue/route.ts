import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  ListQueueItemsQuerySchema,
  ListQueueItemsResponseSchema,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  unifiedQueueRowToPostFormat,
  unifiedQueueStatusToWire,
  wireQueueStatusToUnified,
} from '@/lib/server/facebook-wire';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Queue list for the Facebook Page section, on the unified
 * `queue_items` table (Phase 7). The wire shape is unchanged.
 *
 * History: this route family used to also CREATE items (POST here +
 * the bulk route beside it). Create moved to the unified destination
 * enqueue (spec 119 enabling backend PR 756; composer retarget PR 759),
 * and no product caller posted here anymore — the POST handler and
 * the bulk route were deleted with the legacy schema drop rather
 * than repointed, so the atomic slot-claim RPC they depended on
 * could go with its table. Item actions (PATCH/DELETE/publish-now)
 * live in the [itemId] routes and ARE repointed — the page section
 * still drives them.
 */

interface QueueListRow {
  id: string;
  destination_id: string;
  slot_id: string | null;
  media_item_id: string | null;
  kind: string | null;
  platform_format: string | null;
  link_url: string | null;
  // Null for publisher-driven (Facebook) queued posts: no stored time.
  scheduled_time: string | null;
  caption: string | null;
  first_comment: string | null;
  status: string;
  retry_count: number | string | null;
  max_retries: number | string | null;
  external_post_id: string | null;
  external_comment_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  media_name?: string | null;
  media_type?: string | null;
  media_thumbnail_url?: string | null;
  media_url?: string | null;
  media_aspect_ratio?: string | null;
  media_duration_seconds?: number | string | null;
}

interface QueueListSupabaseRow extends Omit<QueueListRow, 'media_name' | 'media_type' | 'media_thumbnail_url' | 'media_url' | 'media_aspect_ratio' | 'media_duration_seconds'> {
  media: {
    name: string;
    media_type: string;
    thumbnail_url: string | null;
    url: string;
    aspect_ratio: string | null;
    duration_seconds: number | null;
  } | null;
}

function mapQueueRow(
  row: QueueListRow,
  userId: string,
  media: QueueListRow | QueueListSupabaseRow['media']
) {
  const mediaRecord = media as QueueListSupabaseRow['media'];
  const flat = row as QueueListRow;
  const mediaName = mediaRecord ? mediaRecord.name : flat.media_name;
  const mediaType = mediaRecord ? mediaRecord.media_type : flat.media_type;
  const mediaThumb = mediaRecord ? mediaRecord.thumbnail_url : flat.media_thumbnail_url;
  const mediaUrl = mediaRecord ? mediaRecord.url : flat.media_url;
  const mediaAspect = mediaRecord ? mediaRecord.aspect_ratio : flat.media_aspect_ratio;
  const mediaDuration = mediaRecord ? mediaRecord.duration_seconds : flat.media_duration_seconds;

  return {
    id: row.id,
    userId,
    pageId: row.destination_id,
    slotId: row.slot_id ?? null,
    mediaId: row.media_item_id ?? null,
    postFormat: unifiedQueueRowToPostFormat(row.kind, row.platform_format),
    linkUrl: row.link_url ?? null,
    scheduledTime: row.scheduled_time ? new Date(row.scheduled_time).toISOString() : null,
    caption: row.caption ?? '',
    firstComment: row.first_comment ?? null,
    status: unifiedQueueStatusToWire(row.status),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    fbPostId: row.external_post_id ?? null,
    fbCommentId: row.external_comment_id ?? null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    media: mediaName
      ? {
          name: mediaName,
          mediaType: mediaType ?? 'image',
          thumbnailUrl: mediaThumb ?? null,
          url: mediaUrl ?? '',
          aspectRatio: mediaAspect ?? 'unknown',
          durationSeconds: mediaDuration != null ? Number(mediaDuration) : null,
        }
      : undefined,
  };
}

interface StatusCounts {
  queuedCount: number;
  publishedCount: number;
  failedCount: number;
  skippedCount: number;
  cancelledCount: number;
  publishingCount: number;
}

const EMPTY_COUNTS: StatusCounts = {
  queuedCount: 0,
  publishedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  cancelledCount: 0,
  publishingCount: 0,
};

export async function handleListQueueItems(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  // 1. Session auth guard
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Query string validation
  const url = new URL(request.url);
  const rawQuery = {
    pageId: url.searchParams.get('pageId') || undefined,
    status: url.searchParams.get('status') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  };

  const parsedQuery = ListQueueItemsQuerySchema.safeParse(rawQuery);
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: 'INVALID_QUERY', details: parsedQuery.error.issues },
      { status: 400 }
    );
  }

  const { pageId, status, limit, offset } = parsedQuery.data;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // The wire status filter speaks the legacy vocabulary; the unified
  // table has no 'skipped' (backfilled to 'cancelled').
  const unifiedStatusFilter = status ? wireQueueStatusToUnified(status) : undefined;

  if (isLegacyClient(dbClient)) {
    const ownerRows = (await dbClient.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    )) as Record<string, unknown>[];
    const ownerId =
      typeof ownerRows?.[0]?.owner_id === 'string'
        ? (ownerRows[0].owner_id as string)
        : session.userId;

    // 4. Build query filters scoped to the workspace
    const conditions = ['qi.workspace_id = $1'];
    const params: unknown[] = [workspaceId];

    if (pageId) {
      params.push(pageId);
      conditions.push(`qi.destination_id = $${params.length}`);
    }

    if (unifiedStatusFilter) {
      params.push(unifiedStatusFilter);
      conditions.push(`qi.status = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');

    // 5. Total count
    const countSql = `SELECT COUNT(*) AS total FROM queue_items qi WHERE ${whereClause}`;
    const countRows = (await dbClient.query(countSql, params)) as Record<string, unknown>[];
    const total = countRows.length > 0 ? Number(countRows[0].total) : 0;

    // 6. Paginated list with joined media
    const listParams = [...params, limit, offset];
    const listSql = `
      SELECT
        qi.id,
        qi.destination_id,
        qi.slot_id,
        qi.media_item_id,
        qi.kind,
        qi.platform_format,
        qi.link_url,
        qi.scheduled_time,
        qi.caption,
        qi.first_comment,
        qi.status,
        qi.retry_count,
        qi.max_retries,
        qi.external_post_id,
        qi.external_comment_id,
        CASE WHEN qi.status = 'published' THEN qi.updated_at END AS published_at,
        qi.created_at,
        qi.updated_at,
        m.name AS media_name,
        m.media_type AS media_type,
        m.thumbnail_url AS media_thumbnail_url,
        m.url AS media_url,
        m.aspect_ratio AS media_aspect_ratio,
        m.duration_seconds AS media_duration_seconds
      FROM queue_items qi
      LEFT JOIN media_items m ON qi.media_item_id = m.id AND m.user_id = $${params.length + 3}
      WHERE ${whereClause}
      ORDER BY qi.queue_seq ASC NULLS LAST, qi.created_at ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const rows = await dbClient.query<QueueListRow>(listSql, [...listParams, ownerId]);

    const items = (rows || []).map((row) => mapQueueRow(row, ownerId, null));

    const counts: StatusCounts = { ...EMPTY_COUNTS };
    const statusCountSql = `
      SELECT qi.status, COUNT(*) as cnt
      FROM queue_items qi
      WHERE qi.workspace_id = $1
        ${pageId ? 'AND qi.destination_id = $2' : ''}
      GROUP BY qi.status
    `;
    const countParams = pageId ? [workspaceId, pageId] : [workspaceId];
    try {
      const statusRows = (await dbClient.query(statusCountSql, countParams)) as Record<string, unknown>[];
      for (const row of statusRows || []) {
        const cnt = Number(row.cnt ?? 0);
        if (row.status === 'queued') counts.queuedCount = cnt;
        else if (row.status === 'published') counts.publishedCount = cnt;
        else if (row.status === 'failed') counts.failedCount = cnt;
        else if (row.status === 'cancelled') counts.cancelledCount = cnt;
        else if (row.status === 'publishing') counts.publishingCount = cnt;
      }
    } catch (err) {
      // Non-fatal counter fallback — counts stay at zero, but the
      // failure is logged (spec 139 B19), not silent.
      logServerError('[publishing/queue] status-count query failed', err, {
        source: 'publishing-queue-list',
        subdomain,
      });
    }

    const responsePayload = ListQueueItemsResponseSchema.parse({
      items,
      total,
      limit,
      offset,
      ...counts,
    });

    return NextResponse.json(responsePayload, { status: 200 });
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  // R7: the destinations fetch gates the whole list. Its failure
  // used to fall through to `workspacePages || []` and answer
  // items:[] total:0 with HTTP 200 — indistinguishable from an
  // empty queue. Fail loud instead. The fetch is also paged in
  // 1,000-row chunks (PostgREST's default cap), so a workspace
  // with more than 1,000 destinations does not silently lose the
  // queue rows of the destinations past the cap.
  const workspaceRowPromise = supabase
    .from('workspaces')
    .select('owner_id')
    .eq('id', workspaceId)
    .maybeSingle();
  const allWorkspacePages: Array<{
    id: string;
    status: string;
    metadata: Record<string, unknown> | null;
  }> = [];
  const DESTINATIONS_CHUNK = 1000;
  let destinationsError: { message: string } | null = null;
  for (let from = 0; ; from += DESTINATIONS_CHUNK) {
    const { data, error } = await supabase
      .from('destinations')
      .select('id, status, metadata')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .range(from, from + DESTINATIONS_CHUNK - 1);
    if (error) {
      destinationsError = error;
      break;
    }
    const page = (data || []) as Array<{
      id: string;
      status: string;
      metadata: Record<string, unknown> | null;
    }>;
    allWorkspacePages.push(...page);
    if (page.length < DESTINATIONS_CHUNK) break;
  }
  if (destinationsError) {
    logServerError('[publishing/queue] destinations fetch failed', destinationsError, {
      source: 'publishing-queue-list',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to list queue items' }, { status: 500 });
  }
  const { data: workspaceRow } = await workspaceRowPromise;

  const ownerId = workspaceRow?.owner_id ?? session.userId;

  // Visible destinations: everything not disconnected, plus paused
  // pages (stored as disconnected + the fb_status marker).
  const workspacePageIds = allWorkspacePages
    .filter(
      (p) =>
        p.status !== 'disconnected' ||
        (p.metadata as Record<string, unknown> | null)?.fb_status === 'paused'
    )
    .map((p) => p.id);
  if (workspacePageIds.length === 0) {
    return NextResponse.json({ items: [], total: 0, limit, offset }, { status: 200 });
  }

  let queryBuilder = supabase
    .from('queue_items')
    .select(
      'id, destination_id, slot_id, media_item_id, kind, platform_format, link_url, scheduled_time, caption, first_comment, status, retry_count, max_retries, external_post_id, external_comment_id, created_at, updated_at, media:media_items(name, media_type, thumbnail_url, url, aspect_ratio, duration_seconds)',
      { count: 'exact' }
    )
    .eq('workspace_id', workspaceId)
    .in('destination_id', workspacePageIds);

  if (pageId) {
    queryBuilder = queryBuilder.eq('destination_id', pageId);
  }
  if (unifiedStatusFilter) {
    queryBuilder = queryBuilder.eq('status', unifiedStatusFilter);
  }

  // Queue order is queue_seq — the one ordering. (Legacy rows
  // without a sequence fall back to creation order.)
  queryBuilder = queryBuilder
    .order('queue_seq', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: rows, count: totalCount, error } = await queryBuilder;

  if (error) {
    return NextResponse.json({ error: 'Failed to list queue items' }, { status: 500 });
  }

  // supabase-js models the embedded media relation as an array; the
  // runtime value is the single joined object (or null), which is what
  // QueueListSupabaseRow describes — hence the bridge through unknown
  // for this one inference gap (spec 137 §3.7). published_at is derived:
  // the unified table has no published-at column; a published row's
  // updated_at is its settle time (the destination queue lib's rule).
  const typedRows = (rows || []) as unknown as QueueListSupabaseRow[];
  const items = typedRows.map((row) =>
    mapQueueRow(
      {
        ...row,
        published_at: row.status === 'published' ? row.updated_at : null,
      },
      ownerId,
      row.media
    )
  );

  // Bounded per-status counts (spec 139 A14): one head/count query per
  // status — a constant number of queries transferring zero rows. The
  // grouped counts RPC that used to serve this was dropped with the
  // legacy schema (Phase 7); 'skipped' has no unified equivalent and
  // stays zero.
  const counts: StatusCounts = { ...EMPTY_COUNTS };
  try {
    const QUEUE_LIST_COUNT_STATUSES = [
      'queued',
      'published',
      'failed',
      'cancelled',
      'publishing',
    ] as const;
    const perStatus = await Promise.all(
      QUEUE_LIST_COUNT_STATUSES.map(async (countStatus) => {
        let countQuery = supabase
          .from('queue_items')
          .select('id', { head: true, count: 'exact' })
          .eq('workspace_id', workspaceId);
        countQuery = pageId
          ? countQuery.eq('destination_id', pageId)
          : countQuery.in('destination_id', workspacePageIds);
        const { count, error: countError } = await countQuery.eq('status', countStatus);
        if (countError) throw countError;
        return [countStatus, count ?? 0] as const;
      })
    );
    const COUNT_FIELDS = {
      queued: 'queuedCount',
      published: 'publishedCount',
      failed: 'failedCount',
      cancelled: 'cancelledCount',
      publishing: 'publishingCount',
    } as const;
    for (const [countStatus, count] of perStatus) {
      counts[COUNT_FIELDS[countStatus]] = count;
    }
  } catch (err) {
    // Counts stay at zero, as before — logged (spec 139 B19).
    logServerError('[publishing/queue] Bounded status-count query failed', err, {
      source: 'publishing-queue-list',
      subdomain,
    });
  }

  const responsePayload = ListQueueItemsResponseSchema.parse({
    items,
    total: totalCount ?? 0,
    limit,
    offset,
    ...counts,
  });

  return NextResponse.json(responsePayload, { status: 200 });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListQueueItems(request, subdomain);
}
