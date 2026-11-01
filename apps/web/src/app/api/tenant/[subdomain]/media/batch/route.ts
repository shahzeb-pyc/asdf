import { type NextRequest, NextResponse } from 'next/server';
import {
  BatchMediaRequestSchema,
  BatchMediaResponseSchema,
  canAccessTenant,
  getSessionSecret,
  type IStorageService,
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
import { getStorageService } from '../../../../../../lib/storage';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleBatchMedia(
  request: NextRequest,
  subdomain: string,
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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }

  const parsed = BatchMediaRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const payload = parsed.data;

  // Read-only library (storage over the plan limit): move and caption
  // writes are blocked. Delete is the way back under the limit and is
  // deliberately exempt — it runs through the same branches below.
  if (payload.action !== 'delete') {
    try {
      const quotaClient = isLegacyClient(dbClient) ? dbClient : getRouteSupabase(dbClient);
      if (await isMediaStorageReadOnly(quotaClient, session.userId, session.role === 'admin')) {
        return NextResponse.json(
          { error: MEDIA_STORAGE_READ_ONLY_CODE, message: MEDIA_STORAGE_READ_ONLY_MESSAGE },
          { status: 409 }
        );
      }
    } catch (err) {
      // Gate failure is logged loudly but never masks the handler's own
      // error mapping: the handler's own DB calls surface any real
      // outage, and these organization writes consume no storage — the
      // storage-consuming upload paths keep their own fail-closed gates.
      logServerError('[media] storage read-only check failed', err, { source: 'media' });
    }
  }

  if (isLegacyClient(dbClient)) {
    if (payload.action === 'move') {
      if (payload.folderId !== null) {
        const folderRows = (await dbClient.query(
          `SELECT id FROM media_folders WHERE id = $1 AND user_id = $2`,
          [payload.folderId, session.userId]
        )) as Record<string, unknown>[];

        if (!folderRows || folderRows.length === 0) {
          return NextResponse.json(
            { error: 'FOLDER_NOT_FOUND', message: 'Target folder not found' },
            { status: 404 }
          );
        }
      }

      const updatedRows = ((await dbClient.query(
        `UPDATE media_items
         SET folder_id = $1, updated_at = now()
         WHERE user_id = $2 AND id = ANY($3::uuid[])
         RETURNING id`,
        [payload.folderId, session.userId, payload.mediaIds]
      )) as Record<string, unknown>[]) ?? [];

      const response = BatchMediaResponseSchema.parse({
        success: true,
        action: 'move',
        affectedCount: updatedRows.length,
      });

      return NextResponse.json(response);
    }

    if (payload.action === 'caption') {
      const updatedRows = ((await dbClient.query(
        `UPDATE media_items
         SET caption_text = $1, updated_at = now()
         WHERE user_id = $2 AND id = ANY($3::uuid[])
         RETURNING id`,
        [payload.captionText, session.userId, payload.mediaIds]
      )) as Record<string, unknown>[]) ?? [];

      const response = BatchMediaResponseSchema.parse({
        success: true,
        action: 'caption',
        affectedCount: updatedRows.length,
      });

      return NextResponse.json(response);
    }

    // payload.action === 'delete'
    const storage = storageService ?? getStorageService();
    const mediaRows = ((await dbClient.query(
      `SELECT id, storage_key, thumbnail_key
       FROM media_items
       WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [session.userId, payload.mediaIds]
    )) as Record<string, unknown>[]) ?? [];

    const keysToDelete = mediaRows
      .flatMap((item) => [item.storage_key, item.thumbnail_key])
      .filter((k): k is string => Boolean(k));

    await Promise.all(
      keysToDelete.map((key) =>
        storage.deleteObject(key).catch((err) => {
          console.error(`Failed to delete storage key ${key}:`, err);
        })
      )
    );

    await dbClient.query(
      `DELETE FROM media_items WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [session.userId, payload.mediaIds]
    );

    const response = BatchMediaResponseSchema.parse({
      success: true,
      action: 'delete',
      affectedCount: mediaRows.length,
    });

    return NextResponse.json(response);
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  if (payload.action === 'move') {
    if (payload.folderId !== null) {
      const { data: folder } = await supabase
        .from('media_folders')
        .select('id')
        .eq('id', payload.folderId)
        .eq('user_id', session.userId)
        .maybeSingle();

      if (!folder) {
        return NextResponse.json(
          { error: 'FOLDER_NOT_FOUND', message: 'Target folder not found' },
          { status: 404 }
        );
      }
    }

    const { data: updatedRows, error: updateErr } = await supabase
      .from('media_items')
      .update({
        folder_id: payload.folderId,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', session.userId)
      .in('id', payload.mediaIds)
      .select('id');

    if (updateErr) {
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to batch move media' },
        { status: 500 }
      );
    }

    const response = BatchMediaResponseSchema.parse({
      success: true,
      action: 'move',
      affectedCount: updatedRows?.length ?? 0,
    });

    return NextResponse.json(response);
  }

  if (payload.action === 'caption') {
    const { data: updatedRows, error: updateErr } = await supabase
      .from('media_items')
      .update({
        caption_text: payload.captionText,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', session.userId)
      .in('id', payload.mediaIds)
      .select('id');

    if (updateErr) {
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to batch caption media' },
        { status: 500 }
      );
    }

    const response = BatchMediaResponseSchema.parse({
      success: true,
      action: 'caption',
      affectedCount: updatedRows?.length ?? 0,
    });

    return NextResponse.json(response);
  }

  // payload.action === 'delete'
  const storage = storageService ?? getStorageService();
  const { data: mediaRows, error: fetchErr } = await supabase
    .from('media_items')
    .select('id, storage_key, thumbnail_key')
    .eq('user_id', session.userId)
    .in('id', payload.mediaIds);

  if (fetchErr) {
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to fetch media for deletion' },
      { status: 500 }
    );
  }

  const items = mediaRows ?? [];
  const keysToDelete = items
    .flatMap((item: Record<string, unknown>) => [item.storage_key, item.thumbnail_key])
    .filter((k): k is string => Boolean(k));

  await Promise.all(
    keysToDelete.map((key) =>
      storage.deleteObject(key).catch((err) => {
        console.error(`Failed to delete storage key ${key}:`, err);
      })
    )
  );

  const { error: deleteErr } = await supabase
    .from('media_items')
    .delete()
    .eq('user_id', session.userId)
    .in('id', payload.mediaIds);

  if (deleteErr) {
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Failed to delete media items' },
      { status: 500 }
    );
  }

  const response = BatchMediaResponseSchema.parse({
    success: true,
    action: 'delete',
    affectedCount: items.length,
  });

  return NextResponse.json(response);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleBatchMedia(request, subdomain);
}
