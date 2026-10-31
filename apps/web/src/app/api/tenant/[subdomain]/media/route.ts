import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseMediaItemRow,
  canAccessTenant,
  getSessionSecret,
  MediaListQuerySchema,
  MediaListResponseSchema,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Sanitizes and escapes user search input for safe interpolation into PostgREST `.or()` filter strings.
 */
export function sanitizePostgrestSearchPattern(input: string): string {
  const escaped = input
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  return `"%${escaped}%"`;
}


/** Media row as the handlers consume it (spec 137 §3.7): the contracts
 * row minus workspace_id (not projected by these selects), plus the
 * width/height columns the contracts type does not model yet. */
type MediaItemRow = Omit<DatabaseMediaItemRow, 'workspace_id'> & {
  width: number | null;
  height: number | null;
};

export async function handleListMedia(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

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

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const parsedQuery = MediaListQuerySchema.safeParse({
    folderId: searchParams.get('folderId') || undefined,
    mediaType: searchParams.get('mediaType') || undefined,
    aspectRatio: searchParams.get('aspectRatio') || undefined,
    captionStatus: searchParams.get('captionStatus') || undefined,
    search: searchParams.get('search') || undefined,
    sortBy: searchParams.get('sortBy') || undefined,
    sortOrder: searchParams.get('sortOrder') || undefined,
    limit: searchParams.get('limit') || undefined,
    offset: searchParams.get('offset') || undefined,
    cursor: searchParams.get('cursor') || undefined,
    postFormat: searchParams.get('postFormat') || undefined,
  });

  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: 'INVALID_QUERY', details: parsedQuery.error.flatten() },
      { status: 400 }
    );
  }

  const {
    folderId,
    mediaType,
    aspectRatio,
    captionStatus,
    search,
    sortBy,
    sortOrder,
    limit,
    offset,
    cursor,
    postFormat,
  } = parsedQuery.data;

  let total = 0;
  let rows: MediaItemRow[] = [];

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const conditions: string[] = ['user_id = $1'];
    const params: unknown[] = [session.userId];

    if (folderId === 'unorganized') {
      conditions.push('folder_id IS NULL');
    } else if (folderId) {
      params.push(folderId);
      conditions.push(`folder_id = $${params.length}`);
    }

    if (mediaType) {
      params.push(mediaType);
      conditions.push(`media_type = $${params.length}`);
    }

    if (aspectRatio) {
      params.push(aspectRatio);
      conditions.push(`aspect_ratio = $${params.length}`);
    }

    if (captionStatus === 'has_caption') {
      conditions.push("caption_text IS NOT NULL AND BTRIM(caption_text) <> ''");
    } else if (captionStatus === 'empty_caption') {
      conditions.push("(caption_text IS NULL OR BTRIM(caption_text) = '')");
    }

    if (search) {
      params.push(`%${search}%`);
      const paramIndex = params.length;
      conditions.push(`(name ILIKE $${paramIndex} OR caption_text ILIKE $${paramIndex})`);
    }

    // Format compatibility filter
    if (postFormat === 'image') {
      conditions.push("media_type = 'image'");
    } else if (postFormat === 'reel') {
      conditions.push("media_type = 'video' AND (duration_seconds IS NULL OR duration_seconds <= 90)");
    } else if (postFormat === 'video') {
      conditions.push("media_type = 'video'");
    } else if (postFormat === 'story') {
      conditions.push(
        "((media_type = 'image' AND file_size <= 10485760) OR (media_type = 'video' AND (duration_seconds IS NULL OR duration_seconds <= 60)))"
      );
    }

    const whereClause = conditions.join(' AND ');

    // 1. Total count
    const countSql = `SELECT COUNT(*)::int AS total FROM media_items WHERE ${whereClause}`;
    const countRows = (await dbClient.query(countSql, params)) as Record<string, unknown>[];
    total = Number(countRows[0]?.total ?? 0);

    // Keyset cursor pagination condition
    if (cursor) {
      const [cursorCreatedAt, cursorId] = cursor.split('|');
      if (cursorCreatedAt && cursorId) {
        params.push(cursorCreatedAt, cursorId);
        conditions.push(
          `(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`
        );
      }
    }

    const cursorWhereClause = conditions.join(' AND ');

    const SORT_COLUMN_MAP: Record<'created_at' | 'name' | 'file_size', string> = {
      created_at: 'created_at',
      name: 'LOWER(name)',
      file_size: 'file_size',
    };
    const orderColumn = SORT_COLUMN_MAP[sortBy] ?? 'created_at';
    const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

    // 2. Fetch page items
    if (cursor) {
      const queryParams = [...params, limit];
      const itemsSql = `SELECT * FROM media_items WHERE ${cursorWhereClause} ORDER BY created_at DESC, id DESC LIMIT $${queryParams.length}`;
      rows = await dbClient.query<MediaItemRow>(itemsSql, queryParams);
    } else {
      const queryParams = [...params, limit, offset];
      const itemsSql = `SELECT * FROM media_items WHERE ${cursorWhereClause} ORDER BY ${orderColumn} ${orderDirection} LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
      rows = await dbClient.query<MediaItemRow>(itemsSql, queryParams);
    }
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    let queryBuilder = supabase
      .from('media_items')
      .select('*', { count: 'exact' })
      .eq('user_id', session.userId);

    if (folderId === 'unorganized') {
      queryBuilder = queryBuilder.is('folder_id', null);
    } else if (folderId) {
      queryBuilder = queryBuilder.eq('folder_id', folderId);
    }

    if (mediaType) {
      queryBuilder = queryBuilder.eq('media_type', mediaType);
    }

    if (aspectRatio) {
      queryBuilder = queryBuilder.eq('aspect_ratio', aspectRatio);
    }

    if (captionStatus === 'has_caption') {
      queryBuilder = queryBuilder.not('caption_text', 'is', null).neq('caption_text', '');
    } else if (captionStatus === 'empty_caption') {
      queryBuilder = queryBuilder.or('caption_text.is.null,caption_text.eq.');
    }

    if (search) {
      const pattern = sanitizePostgrestSearchPattern(search);
      queryBuilder = queryBuilder.or(`name.ilike.${pattern},caption_text.ilike.${pattern}`);
    }

    if (postFormat === 'image') {
      queryBuilder = queryBuilder.eq('media_type', 'image');
    } else if (postFormat === 'reel') {
      queryBuilder = queryBuilder.eq('media_type', 'video').or('duration_seconds.is.null,duration_seconds.lte.90');
    } else if (postFormat === 'video') {
      queryBuilder = queryBuilder.eq('media_type', 'video');
    } else if (postFormat === 'story') {
      queryBuilder = queryBuilder.or(
        'and(media_type.eq.image,file_size.lte.10485760),and(media_type.eq.video,or(duration_seconds.is.null,duration_seconds.lte.60))'
      );
    }

    if (cursor) {
      // Keyset cursor, parity with the legacy-SQL branch: the
      // (created_at, id) pair is the cursor, so rows sharing a
      // timestamp are neither skipped nor repeated. Cursor mode is
      // created_at-DESC-only on both branches (the legacy branch
      // also forces created_at DESC, id DESC here); sortBy/sortOrder
      // apply to offset paging only. A cursor without an id part
      // keeps the previous created_at-only behaviour.
      const [cursorCreatedAt, cursorId] = cursor.split('|');
      if (cursorCreatedAt && cursorId) {
        queryBuilder = queryBuilder.or(
          `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`
        );
      } else if (cursorCreatedAt) {
        queryBuilder = queryBuilder.lt('created_at', cursorCreatedAt);
      }
      queryBuilder = queryBuilder
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
    } else {
      let sortCol = 'created_at';
      if (sortBy === 'name') {
        sortCol = 'name';
      } else if (sortBy === 'file_size') {
        sortCol = 'file_size';
      }
      queryBuilder = queryBuilder.order(sortCol as string, { ascending: sortOrder === 'asc' });
      queryBuilder = queryBuilder.range(offset, offset + limit - 1);
    }

    const { data: mediaRows, count, error } = await queryBuilder;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    total = count ?? (mediaRows || []).length;
    rows = mediaRows || [];
  }

  const items = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    folderId: row.folder_id ?? null,
    name: row.name,
    fileSize: Number(row.file_size),
    mimeType: row.mime_type,
    mediaType: row.media_type,
    storageKey: row.storage_key,
    url: row.url,
    thumbnailKey: row.thumbnail_key ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    durationSeconds:
      row.duration_seconds !== null && row.duration_seconds !== undefined
        ? Number(row.duration_seconds)
        : null,
    aspectRatio: row.aspect_ratio ?? 'unknown',
    captionText: row.caption_text ?? null,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }));

  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = `${lastItem.createdAt}|${lastItem.id}`;
  }

  const responsePayload = MediaListResponseSchema.parse({
    items,
    total,
    limit,
    offset,
    nextCursor,
  });

  return NextResponse.json(responsePayload);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListMedia(request, subdomain);
}
