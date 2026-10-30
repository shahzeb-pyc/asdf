import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  CheckDuplicatesRequestSchema,
  CheckDuplicatesResponseSchema,
  getSessionSecret,
  MediaItemResponseSchema,
  verifySessionToken,
  type DatabaseClient,
  type DatabaseMediaItemRow,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';


/** Media row as the handlers consume it (spec 137 §3.7): the contracts
 * row minus workspace_id (not projected by these selects), plus the
 * width/height columns the contracts type does not model yet. */
type MediaItemRow = Omit<DatabaseMediaItemRow, 'workspace_id'> & {
  width: number | null;
  height: number | null;
};

function formatMediaRow(row: MediaItemRow) {
  return MediaItemResponseSchema.parse({
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
  });
}

/** The parsed media-item view formatMediaRow produces (spec 137 §3.7). */
type MediaItemView = ReturnType<typeof formatMediaRow>;

function findDuplicatesInRows(
  entries: Array<{ clientKey: string; name: string; fileSize: number; folderId?: string | null | undefined }>,
  rows: MediaItemRow[],
  globalFolderId?: string | null
): Array<{ clientKey: string; existingItem: MediaItemView }> {
  const duplicates: Array<{ clientKey: string; existingItem: MediaItemView }> = [];
  for (const entry of entries) {
    const targetFolder = entry.folderId !== undefined ? entry.folderId : (globalFolderId ?? null);
    const match = rows.find(
      (r) =>
        r.name.toLowerCase() === entry.name.toLowerCase() &&
        Number(r.file_size) === entry.fileSize &&
        ((r.folder_id as string | null | undefined) ?? null) === targetFolder
    );
    if (match) {
      duplicates.push({
        clientKey: entry.clientKey,
        existingItem: formatMediaRow(match),
      });
    }
  }
  return duplicates;
}

async function queryLegacyDuplicates(
  dbClient: DatabaseClient,
  userId: string,
  folderId: string | null | undefined,
  entries: Array<{ clientKey: string; name: string; fileSize: number; folderId?: string | null | undefined }>
): Promise<MediaItemRow[]> {
  const fileSizes = entries.map((e) => e.fileSize);
  const names = entries.map((e) => e.name.toLowerCase());
  const folderIds = Array.from(
    new Set(
      entries.map((e) => (e.folderId !== undefined ? e.folderId : (folderId ?? null)))
    )
  );

  const hasNullFolder = folderIds.includes(null);
  const nonNullFolders = folderIds.filter((id): id is string => id !== null);
  let folderCondition: string;
  if (hasNullFolder) {
    folderCondition = nonNullFolders.length > 0
      ? '(folder_id IS NULL OR folder_id = ANY($2::uuid[]))'
      : 'folder_id IS NULL';
  } else {
    folderCondition = 'folder_id = ANY($2::uuid[])';
  }

  const query = `
    SELECT id, user_id, folder_id, name, file_size, mime_type, media_type,
           storage_key, url, thumbnail_key, thumbnail_url, duration_seconds,
           aspect_ratio, caption_text, width, height, created_at, updated_at
    FROM media_items
    WHERE user_id = $1
      AND ${folderCondition}
      AND LOWER(name) = ANY($3::text[])
      AND file_size = ANY($4::bigint[])
  `;
  return dbClient.query<MediaItemRow>(query, [
    userId,
    nonNullFolders,
    names,
    fileSizes,
  ]);
}

async function querySupabaseDuplicates(
  supabase: SupabaseClient,
  userId: string,
  folderId: string | null | undefined,
  entries: Array<{ clientKey: string; name: string; fileSize: number; folderId?: string | null | undefined }>
): Promise<{ rows?: MediaItemRow[]; error?: string }> {
  const folderIds = Array.from(
    new Set(
      entries.map((e) => (e.folderId !== undefined ? e.folderId : (folderId ?? null)))
    )
  );
  const hasNullFolder = folderIds.includes(null);
  const nonNullFolders = folderIds.filter((id): id is string => id !== null);

  const fileSizes = entries.map((e) => e.fileSize);
  // Paged, never truncated: PostgREST silently caps an unpaged
  // select at 1,000 rows, so past 1,000 same-size rows in these
  // folders the name match in JS below would silently miss the
  // duplicate. Pages are ordered by id so paging is stable.
  const rows: MediaItemRow[] = [];
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      let pageBuilder = supabase
        .from('media_items')
        .select(
          'id, user_id, folder_id, name, file_size, mime_type, media_type, storage_key, url, thumbnail_key, thumbnail_url, duration_seconds, aspect_ratio, caption_text, width, height, created_at, updated_at'
        )
        .eq('user_id', userId);

      if (hasNullFolder && nonNullFolders.length > 0) {
        pageBuilder = pageBuilder.or(`folder_id.is.null,folder_id.in.(${nonNullFolders.join(',')})`);
      } else if (hasNullFolder) {
        pageBuilder = pageBuilder.is('folder_id', null);
      } else if (nonNullFolders.length > 0) {
        pageBuilder = pageBuilder.in('folder_id', nonNullFolders);
      }

      pageBuilder = pageBuilder.in('file_size', fileSizes);

      const { data: pageRows, error } = await pageBuilder
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) {
        return { error: error.message };
      }
      const page = (pageRows || []) as MediaItemRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }
  return { rows };
}

export async function handleCheckDuplicates(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parsed = CheckDuplicatesRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { folderId, entries } = parsed.data;

  if (isLegacyClient(dbClient)) {
    const rows = await queryLegacyDuplicates(dbClient, session.userId, folderId, entries);
    const duplicates = findDuplicatesInRows(entries, rows, folderId);
    return NextResponse.json(CheckDuplicatesResponseSchema.parse({ duplicates }));
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { rows, error } = await querySupabaseDuplicates(supabase, session.userId, folderId, entries);
  if (error) {
    // Spec 139 C1: the raw PostgREST error stays server-side; the
    // client gets the route family's generic error shape.
    logServerError('[media/check-duplicates] Duplicate check query failed', error, {
      source: 'media-check-duplicates',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to check duplicates' }, { status: 500 });
  }

  const duplicates = findDuplicatesInRows(entries, rows || [], folderId);
  return NextResponse.json(CheckDuplicatesResponseSchema.parse({ duplicates }));
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleCheckDuplicates(request, subdomain);
}
