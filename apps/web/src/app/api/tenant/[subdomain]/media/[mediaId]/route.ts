import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  DeleteMediaItemResponseSchema,
  getSessionSecret,
  type IStorageService,
  MediaItemResponseSchema,
  UpdateMediaItemRequestSchema,
  verifySessionToken,
  type DatabaseClient,
  type DatabaseMediaItemRow,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import {
  MEDIA_STORAGE_READ_ONLY_CODE,
  MEDIA_STORAGE_READ_ONLY_MESSAGE,
  isMediaStorageReadOnly,
} from '@/lib/billing/storage-quota';
import { getStorageService } from '../../../../../../lib/storage';
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function authenticateUser(request: NextRequest, subdomain: string) {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return {
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}


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
    folderId: row.folder_id,
    name: row.name,
    fileSize: Number(row.file_size),
    mimeType: row.mime_type,
    mediaType: row.media_type,
    storageKey: row.storage_key,
    url: row.url,
    thumbnailKey: row.thumbnail_key,
    thumbnailUrl: row.thumbnail_url,
    durationSeconds:
      row.duration_seconds !== null && row.duration_seconds !== undefined
        ? Number(row.duration_seconds)
        : null,
    aspectRatio: row.aspect_ratio,
    captionText: row.caption_text,
    width: row.width ? Number(row.width) : null,
    height: row.height ? Number(row.height) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  });
}

export async function handleGetMedia(
  request: NextRequest,
  subdomain: string,
  mediaId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateUser(request, subdomain);
  if (auth.error || !auth.session) return auth.error!;

  if (!UUID_REGEX.test(mediaId)) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid media ID format' },
      { status: 400 }
    );
  }

  if (isLegacyClient(dbClient)) {
    const rows = (await dbClient.query(
      `SELECT id, user_id, folder_id, name, file_size, mime_type, media_type,
              storage_key, url, thumbnail_key, thumbnail_url, duration_seconds,
              aspect_ratio, caption_text, width, height,
              created_at, updated_at
       FROM media_items
       WHERE id = $1 AND user_id = $2`,
      [mediaId, auth.session.userId]
    )) as Record<string, unknown>[];

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
    }

    return NextResponse.json(formatMediaRow(rows[0] as MediaItemRow));
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data, error } = await supabase
    .from('media_items')
    .select(
      'id, user_id, folder_id, name, file_size, mime_type, media_type, storage_key, url, thumbnail_key, thumbnail_url, duration_seconds, aspect_ratio, caption_text, width, height, created_at, updated_at'
    )
    .eq('id', mediaId)
    .eq('user_id', auth.session.userId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
  }

  return NextResponse.json(formatMediaRow(data));
}

export async function handleUpdateMedia(
  request: NextRequest,
  subdomain: string,
  mediaId: string,
  dbClient?: DatabaseClient | SupabaseClient,
  storageService?: IStorageService
): Promise<NextResponse> {
  const auth = await authenticateUser(request, subdomain);
  if (auth.error || !auth.session) return auth.error!;

  if (!UUID_REGEX.test(mediaId)) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid media ID format' },
      { status: 400 }
    );
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

  const parsed = UpdateMediaItemRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Read-only library (storage over the plan limit): no metadata
  // writes. Media DELETE is a separate handler and stays allowed.
  try {
    const quotaClient = isLegacyClient(dbClient) ? dbClient : getRouteSupabase(dbClient);
    if (await isMediaStorageReadOnly(quotaClient, auth.session.userId, auth.session.role === 'admin')) {
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

  // Eliminate base64 data-URL bloat: upload to R2 if storageService is available
  let resolvedThumbnailUrl = parsed.data.thumbnailUrl;
  let resolvedThumbnailKey = parsed.data.thumbnailKey;

  if (resolvedThumbnailUrl && resolvedThumbnailUrl.startsWith('data:image/')) {
    try {
      const storage = storageService ?? getStorageService();
      const match = /^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/.exec(resolvedThumbnailUrl);
      if (match) {
        const mimeSubtype = match[1];
        const ext = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype;
        const base64Data = match[2];
        const buffer = Buffer.from(base64Data, 'base64');
        const key = `users/${auth.session.userId}/thumbnails/${mediaId}-${Date.now()}.${ext}`;
        const putResult = await storage.putObject({
          key,
          body: buffer,
          contentType: `image/${mimeSubtype}`,
        });
        resolvedThumbnailKey = key;
        resolvedThumbnailUrl = putResult.publicUrl || storage.getPublicUrl(key);
      }
    } catch (_e) {
      // Keep data: URL fallback in test environments without R2 credentials
    }

    if (process.env.NODE_ENV === 'production' && resolvedThumbnailUrl?.startsWith('data:')) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Direct base64 thumbnail URLs are not supported in production. Please upload image to cloud storage.' },
        { status: 400 }
      );
    }
  }

  if (isLegacyClient(dbClient)) {
    const existingMedia = (await dbClient.query(
      `SELECT id, folder_id, caption_text, thumbnail_key
       FROM media_items
       WHERE id = $1 AND user_id = $2`,
      [mediaId, auth.session.userId]
    )) as Record<string, unknown>[];

    if (!existingMedia || existingMedia.length === 0) {
      return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
    }

    if (parsed.data.folderId !== undefined && parsed.data.folderId !== null) {
      const folderRows = (await dbClient.query(
        `SELECT id FROM media_folders WHERE id = $1 AND user_id = $2`,
        [parsed.data.folderId, auth.session.userId]
      )) as Record<string, unknown>[];

      if (!folderRows || folderRows.length === 0) {
        return NextResponse.json(
          { error: 'FOLDER_NOT_FOUND', message: 'Specified folder was not found' },
          { status: 404 }
        );
      }
    }

    const updates: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (parsed.data.name !== undefined) {
      updates.push(`name = $${paramIdx++}`);
      values.push(parsed.data.name);
    }
    if (parsed.data.folderId !== undefined) {
      updates.push(`folder_id = $${paramIdx++}`);
      values.push(parsed.data.folderId);
    }
    if (parsed.data.captionText !== undefined) {
      updates.push(`caption_text = $${paramIdx++}`);
      values.push(parsed.data.captionText);
    }
    if (resolvedThumbnailKey !== undefined) {
      updates.push(`thumbnail_key = $${paramIdx++}`);
      values.push(resolvedThumbnailKey);
    }
    if (resolvedThumbnailUrl !== undefined) {
      updates.push(`thumbnail_url = $${paramIdx++}`);
      values.push(resolvedThumbnailUrl);
    }
    if (parsed.data.width !== undefined) {
      updates.push(`width = $${paramIdx++}`);
      values.push(parsed.data.width);
    }
    if (parsed.data.height !== undefined) {
      updates.push(`height = $${paramIdx++}`);
      values.push(parsed.data.height);
    }

    values.push(mediaId, auth.session.userId);
    const updateQuery = `
      UPDATE media_items
      SET ${updates.join(', ')}
      WHERE id = $${paramIdx++} AND user_id = $${paramIdx++}
      RETURNING id, user_id, folder_id, name, file_size, mime_type, media_type,
                storage_key, url, thumbnail_key, thumbnail_url, duration_seconds,
                aspect_ratio, caption_text, width, height,
                created_at, updated_at
    `;

    const updatedRows = (await dbClient.query(updateQuery, values)) as Record<string, unknown>[];
    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
    }

    const previousThumbnailKey = existingMedia[0]?.thumbnail_key as string | null | undefined;
    if (
      resolvedThumbnailKey !== undefined &&
      previousThumbnailKey &&
      previousThumbnailKey !== resolvedThumbnailKey
    ) {
      const storage = storageService ?? getStorageService();
      try {
        await storage.deleteObject(previousThumbnailKey);
      } catch (_e) {
        // Continue even if old R2 thumbnail cleanup fails
      }
    }

    return NextResponse.json(formatMediaRow(updatedRows[0] as MediaItemRow));
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: existingMedia, error: existErr } = await supabase
    .from('media_items')
    .select('id, folder_id, caption_text, thumbnail_key')
    .eq('id', mediaId)
    .eq('user_id', auth.session.userId)
    .maybeSingle();

  if (existErr || !existingMedia) {
    return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
  }

  if (parsed.data.folderId !== undefined && parsed.data.folderId !== null) {
    const { data: folderRows } = await supabase
      .from('media_folders')
      .select('id')
      .eq('id', parsed.data.folderId)
      .eq('user_id', auth.session.userId)
      .maybeSingle();

    if (!folderRows) {
      return NextResponse.json(
        { error: 'FOLDER_NOT_FOUND', message: 'Specified folder was not found' },
        { status: 404 }
      );
    }
  }

  const updatePayload: Partial<MediaItemRow> = {
    updated_at: new Date().toISOString(),
  };

  if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
  if (parsed.data.folderId !== undefined) updatePayload.folder_id = parsed.data.folderId;
  if (parsed.data.captionText !== undefined) updatePayload.caption_text = parsed.data.captionText;
  if (resolvedThumbnailKey !== undefined) updatePayload.thumbnail_key = resolvedThumbnailKey;
  if (resolvedThumbnailUrl !== undefined) updatePayload.thumbnail_url = resolvedThumbnailUrl;
  if (parsed.data.width !== undefined) updatePayload.width = parsed.data.width;
  if (parsed.data.height !== undefined) updatePayload.height = parsed.data.height;

  const { data: updatedRow, error: updateErr } = await supabase
    .from('media_items')
    .update(updatePayload)
    .eq('id', mediaId)
    .eq('user_id', auth.session.userId)
    .select(
      'id, user_id, folder_id, name, file_size, mime_type, media_type, storage_key, url, thumbnail_key, thumbnail_url, duration_seconds, aspect_ratio, caption_text, width, height, created_at, updated_at'
    )
    .single();

  if (updateErr || !updatedRow) {
    return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
  }

  const previousThumbnailKey = (existingMedia as Record<string, unknown>).thumbnail_key as string | null | undefined;
  if (
    resolvedThumbnailKey !== undefined &&
    previousThumbnailKey &&
    previousThumbnailKey !== resolvedThumbnailKey
  ) {
    const storage = storageService ?? getStorageService();
    try {
      await storage.deleteObject(previousThumbnailKey);
    } catch (_e) {
      // Continue even if old R2 thumbnail cleanup fails
    }
  }

  return NextResponse.json(formatMediaRow(updatedRow));
}

export async function handleDeleteMedia(
  request: NextRequest,
  subdomain: string,
  mediaId: string,
  dbClient?: DatabaseClient | SupabaseClient,
  storageService?: IStorageService
): Promise<NextResponse> {
  const auth = await authenticateUser(request, subdomain);
  if (auth.error || !auth.session) return auth.error!;

  if (!UUID_REGEX.test(mediaId)) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid media ID format' },
      { status: 400 }
    );
  }

  if (isLegacyClient(dbClient)) {
    const rows = (await dbClient.query(
      `SELECT id, user_id, storage_key, thumbnail_key
       FROM media_items
       WHERE id = $1 AND user_id = $2`,
      [mediaId, auth.session.userId]
    )) as Record<string, unknown>[];

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
    }

    const item = rows[0];
    const storage = storageService ?? getStorageService();
    const storageKeys = [item.storage_key, item.thumbnail_key].filter(Boolean) as string[];
    await Promise.all(
      storageKeys.map((key) =>
        storage.deleteObject(key).catch((err) => {
          console.error(`Failed to delete storage key ${key}:`, err);
        })
      )
    );

    await dbClient.query(
      `DELETE FROM media_items WHERE id = $1 AND user_id = $2`,
      [mediaId, auth.session.userId]
    );

    const payload = DeleteMediaItemResponseSchema.parse({
      success: true,
      mediaId,
    });

    return NextResponse.json(payload);
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: item, error: itemErr } = await supabase
    .from('media_items')
    .select('id, user_id, storage_key, thumbnail_key')
    .eq('id', mediaId)
    .eq('user_id', auth.session.userId)
    .maybeSingle();

  if (itemErr || !item) {
    return NextResponse.json({ error: 'Media item not found' }, { status: 404 });
  }

  const storage = storageService ?? getStorageService();
  const storageKeys = [(item as Record<string, unknown>).storage_key, (item as Record<string, unknown>).thumbnail_key].filter(Boolean) as string[];
  await Promise.all(
    storageKeys.map((key) =>
      storage.deleteObject(key).catch((err) => {
        console.error(`Failed to delete storage key ${key}:`, err);
      })
    )
  );

  await supabase
    .from('media_items')
    .delete()
    .eq('id', mediaId)
    .eq('user_id', auth.session.userId);

  const payload = DeleteMediaItemResponseSchema.parse({
    success: true,
    mediaId,
  });

  return NextResponse.json(payload);
}

export async function GET(
  request: NextRequest,
  props: {
    params:
      | { subdomain: string; mediaId: string }
      | Promise<{ subdomain: string; mediaId: string }>;
  }
) {
  const resolvedParams = await Promise.resolve(props.params);
  return handleGetMedia(request, resolvedParams.subdomain, resolvedParams.mediaId);
}

export async function PATCH(
  request: NextRequest,
  props: {
    params:
      | { subdomain: string; mediaId: string }
      | Promise<{ subdomain: string; mediaId: string }>;
  }
) {
  const resolvedParams = await Promise.resolve(props.params);
  return handleUpdateMedia(
    request,
    resolvedParams.subdomain,
    resolvedParams.mediaId
  );
}

export async function DELETE(
  request: NextRequest,
  props: {
    params:
      | { subdomain: string; mediaId: string }
      | Promise<{ subdomain: string; mediaId: string }>;
  }
) {
  const resolvedParams = await Promise.resolve(props.params);
  return handleDeleteMedia(
    request,
    resolvedParams.subdomain,
    resolvedParams.mediaId
  );
}
