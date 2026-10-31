import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseMediaFolderRow,
  type DatabaseMediaItemRow,
  canAccessTenant,
  DeleteFolderResponseSchema,
  FolderResponseSchema,
  getSessionSecret,
  type IStorageService,
  UpdateFolderRequestSchema,
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
import { getStorageService } from '../../../../../../../lib/storage';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleUpdateFolder(
  request: NextRequest,
  subdomain: string,
  folderId: string,
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

  const parsed = UpdateFolderRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  if (parsed.data.name === undefined && parsed.data.parentId === undefined) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'At least one of name or parentId must be provided',
      },
      { status: 400 }
    );
  }

  // Read-only library (storage over the plan limit): no renames or
  // moves. Folder DELETE is a separate handler and stays allowed.
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

  if (isLegacyClient(dbClient)) {
    try {
      const existingRows = (await dbClient.query(
        `SELECT id, user_id, parent_id, name, created_at, updated_at
         FROM media_folders
         WHERE id = $1 AND user_id = $2`,
        [folderId, session.userId]
      )) as Record<string, unknown>[];

      if (!existingRows || existingRows.length === 0) {
        return NextResponse.json(
          { error: 'NOT_FOUND', message: 'Folder not found' },
          { status: 404 }
        );
      }

      if (parsed.data.parentId !== undefined) {
        if (parsed.data.parentId === folderId) {
          return NextResponse.json(
            {
              error: 'INVALID_FOLDER_HIERARCHY',
              message: 'A folder cannot be moved into itself',
            },
            { status: 400 }
          );
        }

        if (parsed.data.parentId !== null) {
          const parentRows = (await dbClient.query(
            `SELECT id FROM media_folders WHERE id = $1 AND user_id = $2`,
            [parsed.data.parentId, session.userId]
          )) as Record<string, unknown>[];

          if (!parentRows || parentRows.length === 0) {
            return NextResponse.json(
              {
                error: 'PARENT_FOLDER_NOT_FOUND',
                message: 'Target parent folder not found',
              },
              { status: 404 }
            );
          }

          const cycleRows = (await dbClient.query(
            `WITH RECURSIVE descendants AS (
               SELECT id FROM media_folders WHERE parent_id = $1 AND user_id = $2
               UNION ALL
               SELECT f.id FROM media_folders f INNER JOIN descendants d ON f.parent_id = d.id WHERE f.user_id = $2
             )
             SELECT id FROM descendants WHERE id = $3`,
            [folderId, session.userId, parsed.data.parentId]
          )) as Record<string, unknown>[];

          if (cycleRows && cycleRows.length > 0) {
            return NextResponse.json(
              {
                error: 'INVALID_FOLDER_HIERARCHY',
                message: 'A folder cannot be moved into one of its own subfolders',
              },
              { status: 400 }
            );
          }
        }
      }

      const updates: string[] = ['updated_at = now()'];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (parsed.data.name !== undefined) {
        updates.push(`name = $${paramIdx++}`);
        values.push(parsed.data.name);
      }
      if (parsed.data.parentId !== undefined) {
        updates.push(`parent_id = $${paramIdx++}`);
        values.push(parsed.data.parentId);
      }

      values.push(folderId, session.userId);

      const updateRows = (await dbClient.query(
        `UPDATE media_folders
         SET ${updates.join(', ')}
         WHERE id = $${paramIdx++} AND user_id = $${paramIdx++}
         RETURNING id, user_id, parent_id, name, created_at, updated_at`,
        values
      )) as Record<string, unknown>[];

      if (!updateRows || updateRows.length === 0) {
        return NextResponse.json(
          { error: 'NOT_FOUND', message: 'Folder not found' },
          { status: 404 }
        );
      }

      const row = updateRows[0];

      const countRows = (await dbClient.query(
        `SELECT COUNT(*)::int AS item_count
         FROM media_items
         WHERE folder_id = $1 AND user_id = $2`,
        [folderId, session.userId]
      )) as Record<string, unknown>[];

      const subfolderRows = (await dbClient.query(
        `SELECT COUNT(*)::int AS subfolder_count
         FROM media_folders
         WHERE parent_id = $1 AND user_id = $2`,
        [folderId, session.userId]
      )) as Record<string, unknown>[];

      const itemCount = Number(countRows[0]?.item_count ?? 0);
      const subfolderCount = Number(subfolderRows[0]?.subfolder_count ?? 0);

      const responsePayload = FolderResponseSchema.parse({
        id: row.id,
        userId: row.user_id,
        parentId: row.parent_id ?? null,
        name: row.name,
        itemCount,
        subfolderCount,
        createdAt: new Date(row.created_at as string).toISOString(),
        updatedAt: new Date(row.updated_at as string).toISOString(),
      });

      return NextResponse.json(responsePayload);
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
      logServerError('[media/folders] Failed to update folder', err, {
        source: 'media-folders',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to update folder' },
        { status: 500 }
      );
    }
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  try {
    const { data: existingFolder, error: existErr } = await supabase
      .from('media_folders')
      .select('id, user_id, parent_id, name, created_at, updated_at')
      .eq('id', folderId)
      .eq('user_id', session.userId)
      .maybeSingle();

    if (existErr || !existingFolder) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Folder not found' },
        { status: 404 }
      );
    }

    if (parsed.data.parentId !== undefined) {
      if (parsed.data.parentId === folderId) {
        return NextResponse.json(
          {
            error: 'INVALID_FOLDER_HIERARCHY',
            message: 'A folder cannot be moved into itself',
          },
          { status: 400 }
        );
      }

      if (parsed.data.parentId !== null) {
        const allFolders = await fetchAllUserFolders(supabase, session.userId);

        const folderMap = new Map((allFolders || []).map((f) => [f.id, f.parent_id]));
        if (!folderMap.has(parsed.data.parentId)) {
          return NextResponse.json(
            {
              error: 'PARENT_FOLDER_NOT_FOUND',
              message: 'Target parent folder not found',
            },
            { status: 404 }
          );
        }

        // Cycle check: verify parsed.data.parentId is not a descendant of folderId
        let curr: string | null | undefined = parsed.data.parentId;
        while (curr) {
          if (curr === folderId) {
            return NextResponse.json(
              {
                error: 'INVALID_FOLDER_HIERARCHY',
                message: 'A folder cannot be moved into one of its own subfolders',
              },
              { status: 400 }
            );
          }
          curr = folderMap.get(curr);
        }
      }
    }

    const updates: Partial<DatabaseMediaFolderRow> = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.parentId !== undefined) updates.parent_id = parsed.data.parentId;

    const { data: updatedFolder, error: updateErr } = await supabase
      .from('media_folders')
      .update(updates)
      .eq('id', folderId)
      .eq('user_id', session.userId)
      .select('id, user_id, parent_id, name, created_at, updated_at')
      .single();

    if (updateErr) {
      if (updateErr.code === '23505') {
        return NextResponse.json(
          {
            error: 'FOLDER_NAME_ALREADY_EXISTS',
            message: 'A folder with this name already exists in this location',
          },
          { status: 409 }
        );
      }
      logServerError('[media/folders] Folder update failed', updateErr, {
        source: 'media-folders',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to update folder' },
        { status: 500 }
      );
    }

    const [itemsCountRes, subfoldersCountRes] = await Promise.all([
      supabase
        .from('media_items')
        .select('*', { count: 'exact', head: true })
        .eq('folder_id', folderId)
        .eq('user_id', session.userId),
      supabase
        .from('media_folders')
        .select('*', { count: 'exact', head: true })
        .eq('parent_id', folderId)
        .eq('user_id', session.userId),
    ]);

    const responsePayload = FolderResponseSchema.parse({
      id: updatedFolder.id,
      userId: updatedFolder.user_id,
      parentId: updatedFolder.parent_id ?? null,
      name: updatedFolder.name,
      itemCount: itemsCountRes.count ?? 0,
      subfolderCount: subfoldersCountRes.count ?? 0,
      createdAt: new Date(updatedFolder.created_at).toISOString(),
      updatedAt: new Date(updatedFolder.updated_at).toISOString(),
    });

    return NextResponse.json(responsePayload);
  } catch (err) {
    logServerError('Failed to update folder in Supabase:', err, {
      source: 'media-folders',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to update folder' },
      { status: 500 }
    );
  }
}

async function deleteKeySubChunks(
  storage: { deleteObject: (key: string) => Promise<unknown> },
  chunk: string[]
): Promise<void> {
  const subBatchSize = 25;
  const subChunks: string[][] = [];
  for (let j = 0; j < chunk.length; j += subBatchSize) {
    subChunks.push(chunk.slice(j, j + subBatchSize));
  }
  await Promise.all(
    subChunks.map((subChunk) =>
      Promise.allSettled(
        subChunk.map((key) =>
          storage.deleteObject(key).catch((err) => {
            console.error(`Failed to delete storage key ${key}:`, err);
          })
        )
      )
    )
  );
}

async function deleteChunk(
  storage: { deleteObject: (key: string) => Promise<unknown>; deleteObjects?: (keys: string[]) => Promise<unknown> },
  chunk: string[]
): Promise<void> {
  if (typeof storage.deleteObjects === 'function') {
    try {
      await storage.deleteObjects(chunk);
      return;
    } catch (err) {
      console.warn('storage.deleteObjects failed, falling back to individual deletes:', err);
    }
  }
  await deleteKeySubChunks(storage, chunk);
}

async function batchDeleteStorageKeys(
  storage: { deleteObject: (key: string) => Promise<unknown>; deleteObjects?: (keys: string[]) => Promise<unknown> },
  keys: string[],
  batchSize = 1000
): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    chunks.push(keys.slice(i, i + batchSize));
  }
  await Promise.all(chunks.map((chunk) => deleteChunk(storage, chunk)));
}

/**
 * All folders owned by the user, paged — never truncated.
 * PostgREST silently caps an unpaged select at 1,000 rows, so a
 * user with more than 1,000 folders would otherwise get a partial
 * tree (PATCH cycle-check) or a partial delete (DELETE subtree).
 * A fetch error throws: proceeding with a partial tree would
 * delete the wrong set of folders, so failing loud beats deleting
 * half a tree (PATCH already converts this to a 500).
 */
async function fetchAllUserFolders(
  supabase: SupabaseClient,
  userId: string
): Promise<Array<{ id: string; parent_id: string | null }>> {
  const rows: Array<{ id: string; parent_id: string | null }> = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('media_folders')
      .select('id, parent_id')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data || []) as typeof rows;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

export async function handleDeleteFolder(
  request: NextRequest,
  subdomain: string,
  folderId: string,
  dbClient?: DatabaseClient | SupabaseClient,
  storageService?: IStorageService
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
    const storage = storageService ?? getStorageService();

    // 1. Verify target folder belongs to user
    const existingRows = (await dbClient.query(
      `SELECT id FROM media_folders WHERE id = $1 AND user_id = $2`,
      [folderId, session.userId]
    )) as Record<string, unknown>[];

    if (!existingRows || existingRows.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Folder not found' },
        { status: 404 }
      );
    }

    // 2. Collect target folder and all descendant subfolders recursively
    const treeRows = (await dbClient.query(
      `WITH RECURSIVE folder_tree AS (
         SELECT id FROM media_folders WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT f.id FROM media_folders f INNER JOIN folder_tree ft ON f.parent_id = ft.id WHERE f.user_id = $2
       )
       SELECT id FROM folder_tree`,
      [folderId, session.userId]
    )) as Record<string, unknown>[];

    const folderIds: string[] =
      treeRows && treeRows.length > 0
        ? treeRows.map((r) => String(r.id))
        : [folderId];

    // 3. Collect all media items inside the folder subtree
    const mediaRows = ((await dbClient.query(
      `SELECT id, storage_key, thumbnail_key
       FROM media_items
       WHERE user_id = $1 AND folder_id = ANY($2::uuid[])`,
      [session.userId, folderIds]
    )) as Record<string, unknown>[]) ?? [];

    // 4. Purge R2 objects for all contained media items in bounded batches of 50
    const keysToDelete = mediaRows
      .flatMap((item) => [item.storage_key, item.thumbnail_key])
      .filter((k): k is string => Boolean(k));

    await batchDeleteStorageKeys(storage, keysToDelete, 50);

    // 5. Delete media items and folder subtree in PostgreSQL
    await dbClient.query(
      `DELETE FROM media_items WHERE user_id = $1 AND folder_id = ANY($2::uuid[])`,
      [session.userId, folderIds]
    );

    await dbClient.query(
      `DELETE FROM media_folders WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [session.userId, folderIds]
    );

    const responsePayload = DeleteFolderResponseSchema.parse({
      success: true,
      deletedFolderId: folderId,
      deletedSubfoldersCount: Math.max(0, folderIds.length - 1),
      deletedItemsCount: mediaRows.length,
    });

    return NextResponse.json(responsePayload);
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const storage = storageService ?? getStorageService();

  const { data: existingFolder, error: existErr } = await supabase
    .from('media_folders')
    .select('id')
    .eq('id', folderId)
    .eq('user_id', session.userId)
    .maybeSingle();

  if (existErr || !existingFolder) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Folder not found' },
      { status: 404 }
    );
  }

  // Descendant tree, paged (see fetchAllUserFolders): an unpaged
  // fetch would silently truncate past 1,000 folders and delete
  // only part of the subtree.
  const allFolders = await fetchAllUserFolders(supabase, session.userId);

  // Compute all descendant folder IDs in memory
  const folderIds = [folderId];
  const queue = [folderId];
  const folderList = allFolders || [];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = folderList.filter((f) => f.parent_id === parent);
    for (const child of children) {
      folderIds.push(child.id);
      queue.push(child.id);
    }
  }

  // Media in the subtree, in folder chunks with paged fetches:
  // an unpaged .in('folder_id', folderIds) silently truncates past
  // 1,000 rows, deleting the DB rows while leaving their R2 objects
  // orphaned. Storage is purged per fetched page, then the chunk's
  // DB rows are deleted; folder rows are deleted in chunks last.
  // Chunking also keeps each .in() list short enough for PostgREST.
  // A page fetch error is NEVER treated as end-of-data: the handler
  // fails loud with a 500 before that chunk's DB delete, so no
  // success is reported and no rows are deleted for a chunk whose
  // storage purge is incomplete. Partial-chunk state on that path is
  // settled, not implicit: earlier pages of the chunk may already be
  // purged while their DB rows are retained, and a retry re-fetches
  // those rows and re-purges (R2 deletes are idempotent) before
  // deleting the rows, so the retry completes the delete.
  let deletedItemsCount = 0;
  const folderChunkSize = 50;
  const mediaPageSize = 1000;
  for (let i = 0; i < folderIds.length; i += folderChunkSize) {
    const chunk = folderIds.slice(i, i + folderChunkSize);
    let from = 0;
    for (;;) {
      const { data: pageItems, error: pageError } = await supabase
        .from('media_items')
        .select('id, storage_key, thumbnail_key')
        .eq('user_id', session.userId)
        .in('folder_id', chunk)
        .order('id', { ascending: true })
        .range(from, from + mediaPageSize - 1);
      if (pageError) {
        logServerError('[media/folders] Folder delete media page fetch failed', pageError, {
          source: 'media-folder-delete',
          subdomain,
          folderId,
        });
        return NextResponse.json(
          { error: 'INTERNAL_ERROR', message: 'Failed to delete folder' },
          { status: 500 }
        );
      }
      const page = (pageItems || []) as Array<
        Pick<DatabaseMediaItemRow, 'storage_key' | 'thumbnail_key'>
      >;
      const keysToDelete = page
        .flatMap((item) => [item.storage_key, item.thumbnail_key])
        .filter((k): k is string => Boolean(k));
      await batchDeleteStorageKeys(storage, keysToDelete, 50);
      deletedItemsCount += page.length;
      if (page.length < mediaPageSize) break;
      from += mediaPageSize;
    }

    await supabase
      .from('media_items')
      .delete()
      .eq('user_id', session.userId)
      .in('folder_id', chunk);
  }

  for (let i = 0; i < folderIds.length; i += folderChunkSize) {
    await supabase
      .from('media_folders')
      .delete()
      .eq('user_id', session.userId)
      .in('id', folderIds.slice(i, i + folderChunkSize));
  }

  const responsePayload = DeleteFolderResponseSchema.parse({
    success: true,
    deletedFolderId: folderId,
    deletedSubfoldersCount: Math.max(0, folderIds.length - 1),
    deletedItemsCount,
  });

  return NextResponse.json(responsePayload);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; folderId: string }> }
): Promise<NextResponse> {
  const { subdomain, folderId } = await context.params;
  return handleUpdateFolder(request, subdomain, folderId);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; folderId: string }> }
): Promise<NextResponse> {
  const { subdomain, folderId } = await context.params;
  return handleDeleteFolder(request, subdomain, folderId);
}
