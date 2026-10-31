import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  CreateFolderRequestSchema,
  FolderListResponseSchema,
  FolderResponseSchema,
  getSessionSecret,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import {
  MEDIA_STORAGE_READ_ONLY_CODE,
  MEDIA_STORAGE_READ_ONLY_MESSAGE,
  isMediaStorageReadOnly,
} from '@/lib/billing/storage-quota';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleListFolders(
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

  if (isLegacyClient(dbClient)) {
    const folderRows = (await dbClient.query(
      `SELECT 
         f.id,
         f.user_id,
         f.parent_id,
         f.name,
         COALESCE(COUNT(DISTINCT m.id), 0)::int AS item_count,
         COALESCE(COUNT(DISTINCT sf.id), 0)::int AS subfolder_count,
         f.created_at,
         f.updated_at
       FROM media_folders f
       LEFT JOIN media_items m ON m.folder_id = f.id AND m.user_id = f.user_id
       LEFT JOIN media_folders sf ON sf.parent_id = f.id AND sf.user_id = f.user_id
       WHERE f.user_id = $1
       GROUP BY f.id, f.user_id, f.parent_id, f.name, f.created_at, f.updated_at
       ORDER BY f.name ASC`,
      [session.userId]
    )) as Record<string, unknown>[];

    const unorganizedRows = (await dbClient.query(
      `SELECT COUNT(*)::int AS unorganized_count
       FROM media_items
       WHERE user_id = $1 AND folder_id IS NULL`,
      [session.userId]
    )) as Record<string, unknown>[];

    const unorganizedCount = Number(unorganizedRows[0]?.unorganized_count ?? 0);

    const folders = folderRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      parentId: row.parent_id ?? null,
      name: row.name,
      itemCount: Number(row.item_count ?? 0),
      subfolderCount: Number(row.subfolder_count ?? 0),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    }));

    const responsePayload = FolderListResponseSchema.parse({
      folders,
      unorganizedCount,
    });

    return NextResponse.json(responsePayload);
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  // Paged, never truncated: PostgREST silently caps an unpaged
  // select at 1,000 rows, so both the folder list and the item
  // tally below are fetched in 1,000-row pages (facets pattern).
  // The legacy-SQL branch above is already a single grouped query
  // with no such cap.
  const folderRows: Array<{
    id: string;
    user_id: string;
    parent_id: string | null;
    name: string;
    created_at: string;
    updated_at: string;
  }> = [];
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const pageRes = await supabase
        .from('media_folders')
        .select('id, user_id, parent_id, name, created_at, updated_at')
        .eq('user_id', session.userId)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (pageRes.error) {
        return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to list folders' }, { status: 500 });
      }
      const page = (pageRes.data || []) as typeof folderRows;
      folderRows.push(...page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }

  // Grouped counts in O(1) requests (spec 139): one folder_id per
  // media item owned by the user, tallied in JS — fetched in pages
  // so libraries past 1,000 items are counted in full instead of
  // silently undercounting at the PostgREST cap. This mirrors the
  // fallback pattern used for queue status counts (single select of
  // the grouping column + in-memory tally in pages/[pageId]).
  // Follow-up: for libraries with very large item counts, a grouped
  // RPC would avoid transferring one folder_id row per item; that
  // requires a migration and is out of scope for this PR.
  let unorganizedCount = 0;
  const itemCounts = new Map<string, number>();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const pageRes = await supabase
        .from('media_items')
        .select('folder_id')
        .eq('user_id', session.userId)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (pageRes.error) {
        return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Failed to list folders' }, { status: 500 });
      }
      const page = (pageRes.data || []) as Array<{ folder_id: string | null }>;
      for (const row of page) {
        if (row.folder_id == null) {
          unorganizedCount++;
        } else {
          itemCounts.set(row.folder_id, (itemCounts.get(row.folder_id) || 0) + 1);
        }
      }
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }

  const subfolderCounts = new Map<string, number>();
  for (const folder of folderRows) {
    if (folder.parent_id) {
      subfolderCounts.set(folder.parent_id, (subfolderCounts.get(folder.parent_id) || 0) + 1);
    }
  }

  const folders = folderRows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    parentId: row.parent_id ?? null,
    name: row.name,
    itemCount: itemCounts.get(row.id) || 0,
    subfolderCount: subfolderCounts.get(row.id) || 0,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }));

  const responsePayload = FolderListResponseSchema.parse({
    folders,
    unorganizedCount,
  });

  return NextResponse.json(responsePayload);
}

export async function handleCreateFolder(
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
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }

  const parsed = CreateFolderRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Read-only library (storage over the plan limit): no new folders.
  // Delete stays allowed as the way back under the limit.
  try {
    const quotaClient = isLegacyClient(dbClient) ? dbClient : getRouteSupabase(dbClient);
    if (await isMediaStorageReadOnly(quotaClient, session.userId)) {
      return NextResponse.json(
        { error: MEDIA_STORAGE_READ_ONLY_CODE, message: MEDIA_STORAGE_READ_ONLY_MESSAGE },
        { status: 409 }
      );
    }
  } catch (err) {
    // Gate failure is logged loudly but never masks the handler's own
    // error mapping (e.g. a duplicate-name 23505 must still surface
    // as FOLDER_NAME_ALREADY_EXISTS, not a generic 500): the handler's
    // own DB calls surface any real outage, and these organization
    // writes consume no storage — the storage-consuming upload paths
    // keep their own fail-closed gates.
    logServerError('[media] storage read-only check failed', err, { source: 'media' });
  }

  const parentId = parsed.data.parentId ?? null;

  if (isLegacyClient(dbClient)) {
    try {
      if (parentId !== null) {
        const parentRows = (await dbClient.query(
          `SELECT id FROM media_folders WHERE id = $1 AND user_id = $2`,
          [parentId, session.userId]
        )) as Record<string, unknown>[];

        if (!parentRows || parentRows.length === 0) {
          return NextResponse.json(
            {
              error: 'PARENT_FOLDER_NOT_FOUND',
              message: 'Parent folder not found',
            },
            { status: 404 }
          );
        }
      }

      const rows = (await dbClient.query(
        `INSERT INTO media_folders (user_id, parent_id, name, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         RETURNING id, user_id, parent_id, name, created_at, updated_at`,
        [session.userId, parentId, parsed.data.name]
      )) as Record<string, unknown>[];

      const row = rows[0];
      const responsePayload = FolderResponseSchema.parse({
        id: row.id,
        userId: row.user_id,
        parentId: row.parent_id ?? parentId,
        name: row.name,
        itemCount: 0,
        subfolderCount: 0,
        createdAt: new Date(row.created_at as string).toISOString(),
        updatedAt: new Date(row.updated_at as string).toISOString(),
      });

      return NextResponse.json(responsePayload, { status: 201 });
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === '23505'
      ) {
        return NextResponse.json(
          {
            error: 'FOLDER_NAME_ALREADY_EXISTS',
            message: 'A folder with this name already exists in this location',
          },
          { status: 409 }
        );
      }
      logServerError('[media/folders] Failed to create folder', err, {
        source: 'media-folders',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to create folder' },
        { status: 500 }
      );
    }
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  try {
    if (parentId !== null) {
      const { data: parentFolder } = await supabase
        .from('media_folders')
        .select('id')
        .eq('id', parentId)
        .eq('user_id', session.userId)
        .maybeSingle();

      if (!parentFolder) {
        return NextResponse.json(
          {
            error: 'PARENT_FOLDER_NOT_FOUND',
            message: 'Parent folder not found',
          },
          { status: 404 }
        );
      }
    }

    const { data: insertedFolder, error: insertErr } = await supabase
      .from('media_folders')
      .insert({
        user_id: session.userId,
        parent_id: parentId,
        name: parsed.data.name,
      })
      .select('id, user_id, parent_id, name, created_at, updated_at')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        return NextResponse.json(
          {
            error: 'FOLDER_NAME_ALREADY_EXISTS',
            message: 'A folder with this name already exists in this location',
          },
          { status: 409 }
        );
      }
      logServerError('[media/folders] Folder insert failed', insertErr, {
        source: 'media-folders',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to create folder' },
        { status: 500 }
      );
    }

    const responsePayload = FolderResponseSchema.parse({
      id: insertedFolder.id,
      userId: insertedFolder.user_id,
      parentId: insertedFolder.parent_id ?? parentId,
      name: insertedFolder.name,
      itemCount: 0,
      subfolderCount: 0,
      createdAt: new Date(insertedFolder.created_at).toISOString(),
      updatedAt: new Date(insertedFolder.updated_at).toISOString(),
    });

    return NextResponse.json(responsePayload, { status: 201 });
  } catch (err) {
    logServerError('Failed to create folder in Supabase:', err, {
      source: 'media-folders',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to create folder' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListFolders(request, subdomain);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleCreateFolder(request, subdomain);
}
