import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseMediaItemRow,
  canAccessTenant,
  getSessionSecret,
  QueueItemSchema,
  UpdateQueueItemRequestSchema,
  verifySessionToken,
  type DatabaseClient,
  type PostFormat,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { deletePostOwnedBytesBestEffort } from '@/lib/publishing/post-owned-media';
import { getStorageService } from '@/lib/storage';
import type { IStorageService } from '@fbuploadpro/contracts';
import {
  unifiedQueueRowToPostFormat,
  unifiedQueueStatusToWire,
  wireFormatToUnifiedKind,
  wireQueueStatusToUnified,
} from '@/lib/server/facebook-wire';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Queue item update/delete for the Facebook Page section, on the
 * unified `queue_items` table (Phase 7). The wire shape is unchanged.
 * Scoping is by workspace (resolved from the tenant subdomain): the
 * unified tables are workspace-scoped, and the response's `userId`
 * is the workspace owner — the identity the wire contract has always
 * reported. Status translation lives in facebook-wire ('skipped'
 * writes land as 'cancelled'; the unified vocabulary has no
 * 'skipped').
 */

/**
 * Resolve storage for best-effort cleanup only: a missing R2
 * configuration must skip the cleanup, never fail the delete it
 * rides along with.
 */
function resolveCleanupStorage(
  storageService?: IStorageService
): IStorageService | null {
  try {
    return storageService ?? getStorageService();
  } catch (err) {
    console.error('Post-owned cleanup skipped: storage unavailable:', err);
    return null;
  }
}

function resolveScheduledTime(
  requestedTime?: string | null,
  existingTime?: string | null
): string {
  if (requestedTime !== undefined && requestedTime !== null) {
    const d = new Date(requestedTime);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError('INVALID_DATE');
    }
    return d.toISOString();
  }
  if (existingTime) {
    const d = new Date(existingTime);
    if (Number.isNaN(d.getTime())) {
      return new Date().toISOString();
    }
    return d.toISOString();
  }
  return new Date().toISOString();
}

/** Media columns the item handlers read (spec 137 §3.7). */
type QueueMediaRecord = Pick<
  DatabaseMediaItemRow,
  'name' | 'media_type' | 'url' | 'thumbnail_url' | 'aspect_ratio' | 'duration_seconds'
>;

/** A unified queue_items row in the field names this handler uses. */
interface UnifiedItemRow {
  id: string;
  destination_id: string;
  slot_id: string | null;
  media_item_id: string | null;
  kind: string | null;
  platform_format: string | null;
  link_url: string | null;
  scheduled_time: string;
  caption: string | null;
  first_comment: string | null;
  status: string;
  retry_count: number | string | null;
  max_retries: number | string | null;
  external_post_id: string | null;
  external_comment_id: string | null;
  created_at: string;
  updated_at: string;
  /** The row's own media_url (post-owned bytes; null for text posts). */
  media_url: string | null;
}

const UNIFIED_ITEM_COLUMNS =
  'id, destination_id, slot_id, media_item_id, kind, platform_format, link_url, scheduled_time, caption, first_comment, status, retry_count, max_retries, external_post_id, external_comment_id, created_at, updated_at, media_url';

const UNIFIED_ITEM_SQL_COLUMNS = `
  id, destination_id, slot_id, media_item_id, kind, platform_format,
  link_url, scheduled_time, caption, first_comment, status, retry_count,
  max_retries, external_post_id, external_comment_id, created_at, updated_at, media_url`;

async function authenticateQueueItemRequest(
  request: NextRequest,
  subdomain: string
) {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}

async function fetchWorkspaceOwnerId(
  client: DatabaseClient | SupabaseClient,
  workspaceId: string
): Promise<string | null> {
  if ('query' in client && typeof (client as DatabaseClient).query === 'function') {
    const rows = (await (client as DatabaseClient).query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    )) as Record<string, unknown>[];
    const owner = rows?.[0]?.owner_id;
    return typeof owner === 'string' ? owner : null;
  }
  const { data } = await (client as SupabaseClient)
    .from('workspaces')
    .select('owner_id')
    .eq('id', workspaceId)
    .maybeSingle();
  return data?.owner_id ?? null;
}

/**
 * Display name for a post-owned queue row's media: the row has no
 * library row to name it, so the public URL's basename is the name
 * ('' when the URL carries none).
 */
function basenameFromMediaUrl(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const last = path.split('/').pop() ?? '';
  if (!last) return '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function buildQueueItemResponse(
  row: UnifiedItemRow,
  userId: string,
  mediaRecord: QueueMediaRecord | null,
  formatOverride?: PostFormat
) {
  // Post-owned rows (media_item_id NULL) have no joined media
  // record, so the PATCH response used to omit `media` entirely
  // for them — same half-wiring as the list path. Fall back to
  // the row's own media_url, mirroring the list fallback.
  const fallbackMedia =
    !mediaRecord && row.media_url
      ? {
          name: basenameFromMediaUrl(row.media_url),
          mediaType: row.kind === 'video' ? 'video' : 'image',
          url: row.media_url,
          thumbnailUrl: null,
          aspectRatio: 'unknown',
          durationSeconds: null,
        }
      : null;

  const queueItem = {
    id: row.id,
    userId,
    pageId: row.destination_id,
    slotId: row.slot_id ?? null,
    mediaId: row.media_item_id ?? null,
    postFormat:
      formatOverride ??
      unifiedQueueRowToPostFormat(row.kind, row.platform_format),
    linkUrl: row.link_url ?? null,
    scheduledTime: new Date(row.scheduled_time as string).toISOString(),
    caption: row.caption ?? '',
    firstComment: row.first_comment ?? null,
    status: unifiedQueueStatusToWire(row.status),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 3),
    fbPostId: row.external_post_id ?? null,
    fbCommentId: row.external_comment_id ?? null,
    publishedAt:
      row.status === 'published'
        ? new Date(row.updated_at as string).toISOString()
        : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    ...(mediaRecord
      ? {
          media: {
            name: mediaRecord.name,
            mediaType: mediaRecord.media_type,
            url: mediaRecord.url,
            thumbnailUrl: mediaRecord.thumbnail_url ?? null,
            aspectRatio: mediaRecord.aspect_ratio ?? 'unknown',
            durationSeconds:
              mediaRecord.duration_seconds != null
                ? Number(mediaRecord.duration_seconds)
                : null,
          },
        }
      : fallbackMedia
        ? { media: fallbackMedia }
        : {}),
  };

  return QueueItemSchema.parse(queueItem);
}

export async function handleUpdateQueueItem(
  request: NextRequest,
  subdomain: string,
  itemId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateQueueItemRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  // Request body validation
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const parsed = UpdateQueueItemRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (isLegacyClient(dbClient)) {
    // Check existing item
    const existingRows = (await dbClient.query(
      `SELECT ${UNIFIED_ITEM_SQL_COLUMNS}
       FROM queue_items
       WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    )) as unknown as UnifiedItemRow[];

    if (!existingRows || existingRows.length === 0) {
      return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
    }

    const existing = existingRows[0];

    if (existing.status === 'published') {
      return NextResponse.json(
        { error: 'CANNOT_UPDATE_PUBLISHED_ITEM', message: 'Published queue items cannot be modified' },
        { status: 400 }
      );
    }

    // K1: fail closed on publishing rows too — the worker outcome
    // is not traceable from here, so an edit racing it could
    // publish stale content or lose the edit.
    if (existing.status === 'publishing') {
      return NextResponse.json(
        { error: 'CANNOT_UPDATE_PUBLISHING_ITEM', message: 'Publishing queue items cannot be modified while they are being published' },
        { status: 400 }
      );
    }

    // Nit: cancelled rows are terminal, like published ones — the
    // calendar used to offer caption edit on them (and the queue
    // panel's edit dialog is the same PATCH). Reject with a clear
    // error so UI and server agree even for direct API callers.
    if (existing.status === 'cancelled') {
      return NextResponse.json(
        { error: 'CANNOT_UPDATE_CANCELLED_ITEM', message: 'Cancelled queue items cannot be modified' },
        { status: 400 }
      );
    }

    const ownerId = (await fetchWorkspaceOwnerId(dbClient, workspaceId)) ?? session.userId;

    // Compute updated values
    const existingFormat = unifiedQueueRowToPostFormat(existing.kind, existing.platform_format);
    const newCaption = parsed.data.caption ?? existing.caption ?? '';
    const newPostFormat = (parsed.data.postFormat ?? existingFormat) as PostFormat;
    // R13, resolved-format half: the schema guard covers edits
    // that change the format to reel; this covers edits that leave
    // the format untouched on an existing reel.
    if (newPostFormat === 'reel' && newCaption.length > 2200) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Reel captions are limited to 2,200 characters' },
        { status: 400 }
      );
    }
    let newFirstComment = parsed.data.firstComment !== undefined ? parsed.data.firstComment : (existing.first_comment ?? null);
    if (newPostFormat === 'story') {
      if (parsed.data.firstComment && parsed.data.firstComment.trim().length > 0) {
        return NextResponse.json(
          { error: 'INVALID_REQUEST', message: 'First comment is not supported for story posts' },
          { status: 400 }
        );
      }
      newFirstComment = null;
    }
    const newLinkUrl = parsed.data.linkUrl !== undefined ? parsed.data.linkUrl : (existing.link_url ?? null);
    let newScheduledTime: string;
    try {
      newScheduledTime = resolveScheduledTime(parsed.data.scheduledTime, existing.scheduled_time);
    } catch (_e) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Invalid scheduled time format' },
        { status: 400 }
      );
    }
    const newStatus = parsed.data.status
      ? wireQueueStatusToUnified(parsed.data.status)
      : existing.status;

    // A format change rewrites kind + platform_format together (the
    // composer's enqueue mapping); without one, both stay as stored.
    const formatWrite = parsed.data.postFormat
      ? wireFormatToUnifiedKind(parsed.data.postFormat)
      : null;

    // R12: requeueing a failed item resets its retry budget; any
    // other edit preserves the stored count.
    const newRetryCount =
      newStatus === 'queued' && existing.status === 'failed'
        ? 0
        : Number(existing.retry_count ?? 0);

    const updateRows = (await dbClient.query(
      `UPDATE queue_items
       SET caption = $1,
           first_comment = $2,
           scheduled_time = $3,
           status = $4,
           kind = COALESCE($5, kind),
           platform_format = CASE WHEN $5 IS NOT NULL THEN $6 ELSE platform_format END,
           link_url = $7,
           retry_count = $8,
           updated_at = now()
       WHERE id = $9 AND workspace_id = $10
       RETURNING ${UNIFIED_ITEM_SQL_COLUMNS}`,
      [
        newCaption,
        newFirstComment,
        newScheduledTime,
        newStatus,
        formatWrite?.kind ?? null,
        formatWrite?.platformFormat ?? null,
        newLinkUrl,
        newRetryCount,
        itemId,
        workspaceId,
      ]
    )) as unknown as UnifiedItemRow[];

    const updated = updateRows[0];

    // Fetch joined media details if present
    let mediaRecord: QueueMediaRecord | null = null;
    if (updated.media_item_id) {
      const mediaRows = await dbClient.query<QueueMediaRecord>(
        `SELECT id, name, media_type, url, thumbnail_url, aspect_ratio, duration_seconds
         FROM media_items
         WHERE id = $1 AND workspace_id = $2`,
        [updated.media_item_id, workspaceId]
      );
      mediaRecord = mediaRows?.[0] ?? null;
    }

    // R25: an edit or requeue can cover or uncover queued formats.
    // Best-effort/log-loud inside the helper; never fails the edit.
    await refreshDestinationUnmatchedFlag(dbClient, updated.destination_id);

    const validated = buildQueueItemResponse(updated, ownerId, mediaRecord, newPostFormat);
    return NextResponse.json(validated, { status: 200 });
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: existing, error: existErr } = await supabase
    .from('queue_items')
    .select(UNIFIED_ITEM_COLUMNS)
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (existErr || !existing) {
    return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
  }

  if (existing.status === 'published') {
    return NextResponse.json(
      { error: 'CANNOT_UPDATE_PUBLISHED_ITEM', message: 'Published queue items cannot be modified' },
      { status: 400 }
    );
  }

  // K1: fail closed on publishing rows too (see the legacy branch).
  if (existing.status === 'publishing') {
    return NextResponse.json(
      { error: 'CANNOT_UPDATE_PUBLISHING_ITEM', message: 'Publishing queue items cannot be modified while they are being published' },
      { status: 400 }
    );
  }

  // Nit: cancelled rows are terminal (see the legacy branch).
  if (existing.status === 'cancelled') {
    return NextResponse.json(
      { error: 'CANNOT_UPDATE_CANCELLED_ITEM', message: 'Cancelled queue items cannot be modified' },
      { status: 400 }
    );
  }

  const ownerId = (await fetchWorkspaceOwnerId(supabase, workspaceId)) ?? session.userId;

  const existingFormat = unifiedQueueRowToPostFormat(existing.kind, existing.platform_format);
  const newCaption = parsed.data.caption ?? existing.caption ?? '';
  const newPostFormat = (parsed.data.postFormat ?? existingFormat) as PostFormat;
  // R13, resolved-format half (see the legacy branch).
  if (newPostFormat === 'reel' && newCaption.length > 2200) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Reel captions are limited to 2,200 characters' },
      { status: 400 }
    );
  }
  let newFirstComment = parsed.data.firstComment !== undefined ? parsed.data.firstComment : (existing.first_comment ?? null);
  if (newPostFormat === 'story') {
    if (parsed.data.firstComment && parsed.data.firstComment.trim().length > 0) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'First comment is not supported for story posts' },
        { status: 400 }
      );
    }
    newFirstComment = null;
  }
  const newLinkUrl = parsed.data.linkUrl !== undefined ? parsed.data.linkUrl : (existing.link_url ?? null);
  let newScheduledTime: string;
  try {
    newScheduledTime = resolveScheduledTime(parsed.data.scheduledTime, existing.scheduled_time);
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid scheduled time format' },
      { status: 400 }
    );
  }
  const newStatus = parsed.data.status
    ? wireQueueStatusToUnified(parsed.data.status)
    : existing.status;

  const updatePayload: {
    caption: string;
    first_comment: string | null;
    scheduled_time: string;
    status: string;
    link_url: string | null;
    retry_count: number;
    kind?: string;
    platform_format?: string | null;
    updated_at: string;
  } = {
    caption: newCaption,
    first_comment: newFirstComment,
    scheduled_time: newScheduledTime,
    status: newStatus,
    link_url: newLinkUrl,
    // R12: requeueing a failed item resets its retry budget.
    retry_count:
      newStatus === 'queued' && existing.status === 'failed'
        ? 0
        : Number(existing.retry_count ?? 0),
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.postFormat) {
    const formatWrite = wireFormatToUnifiedKind(parsed.data.postFormat);
    updatePayload.kind = formatWrite.kind;
    updatePayload.platform_format = formatWrite.platformFormat;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('queue_items')
    .update(updatePayload)
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .select(UNIFIED_ITEM_COLUMNS)
    .single();

  if (updateErr || !updated) {
    return NextResponse.json({ error: 'Failed to update queue item' }, { status: 500 });
  }

  let mediaRecord: QueueMediaRecord | null = null;
  if (updated.media_item_id) {
    const { data: mediaData } = await supabase
      .from('media_items')
      .select('id, name, media_type, url, thumbnail_url, aspect_ratio, duration_seconds')
      .eq('id', updated.media_item_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    mediaRecord = mediaData;
  }

  // R25: see the legacy branch — best-effort, never fails the edit.
  await refreshDestinationUnmatchedFlag(supabase, updated.destination_id);

  const validated = buildQueueItemResponse(
    updated as UnifiedItemRow,
    ownerId,
    mediaRecord,
    newPostFormat
  );
  return NextResponse.json(validated, { status: 200 });
}

export async function handleDeleteQueueItem(
  request: NextRequest,
  subdomain: string,
  itemId: string,
  dbClient?: DatabaseClient | SupabaseClient,
  storageService?: IStorageService
): Promise<NextResponse> {
  const auth = await authenticateQueueItemRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (isLegacyClient(dbClient)) {
    // Check existing item
    const existingRows = (await dbClient.query(
      `SELECT id, status, destination_id, media_storage_key FROM queue_items WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    )) as Record<string, unknown>[];

    if (!existingRows || existingRows.length === 0) {
      return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
    }

    const existing = existingRows[0];
    if (existing.status === 'published') {
      return NextResponse.json(
        { error: 'CANNOT_DELETE_PUBLISHED_ITEM', message: 'Published queue items cannot be deleted' },
        { status: 400 }
      );
    }

    // K1: fail closed on publishing rows too (see the update path).
    if (existing.status === 'publishing') {
      return NextResponse.json(
        { error: 'CANNOT_DELETE_PUBLISHING_ITEM', message: 'Publishing queue items cannot be deleted while they are being published' },
        { status: 400 }
      );
    }

    // Delete item
    await dbClient.query(
      `DELETE FROM queue_items WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    );

    // R25: deleting a queued post can clear the unmatched flag
    // (e.g. the only unmatched post is gone). Best-effort/log-loud
    // inside the helper; never fails the delete.
    if (typeof existing.destination_id === 'string' && existing.destination_id) {
      await refreshDestinationUnmatchedFlag(dbClient, existing.destination_id);
    }

    // Media/posting separation: the post's own bytes go with it.
    // Only post-owned keys are ever deleted here — a library key
    // is left alone, so a queue delete can never delete library
    // bytes. Best-effort, never fails the delete.
    {
      const cleanupStorage = resolveCleanupStorage(storageService);
      if (cleanupStorage) {
        await deletePostOwnedBytesBestEffort(
          cleanupStorage,
          session.userId,
          typeof existing.media_storage_key === 'string'
            ? existing.media_storage_key
            : null
        );
      }
    }

    return NextResponse.json({ success: true, itemId }, { status: 200 });
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: existing, error: existErr } = await supabase
    .from('queue_items')
    .select('id, status, destination_id, media_storage_key')
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (existErr || !existing) {
    return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
  }

  if (existing.status === 'published') {
    return NextResponse.json(
      { error: 'CANNOT_DELETE_PUBLISHED_ITEM', message: 'Published queue items cannot be deleted' },
      { status: 400 }
    );
  }

  // K1: fail closed on publishing rows too (see the update path).
  if (existing.status === 'publishing') {
    return NextResponse.json(
      { error: 'CANNOT_DELETE_PUBLISHING_ITEM', message: 'Publishing queue items cannot be deleted while they are being published' },
      { status: 400 }
    );
  }

  const { error: deleteErr } = await supabase
    .from('queue_items')
    .delete()
    .eq('id', itemId)
    .eq('workspace_id', workspaceId);

  if (deleteErr) {
    return NextResponse.json({ error: 'Failed to delete queue item' }, { status: 500 });
  }

  // R25: see the legacy branch — best-effort, never fails the delete.
  if (existing.destination_id) {
    await refreshDestinationUnmatchedFlag(supabase, existing.destination_id);
  }

  // Media/posting separation: see the legacy branch — the post's own
  // bytes go with it, library keys are never touched.
  {
    const cleanupStorage = resolveCleanupStorage(storageService);
    if (cleanupStorage) {
      await deletePostOwnedBytesBestEffort(
        cleanupStorage,
        session.userId,
        typeof existing.media_storage_key === 'string'
          ? existing.media_storage_key
          : null
      );
    }
  }

  return NextResponse.json({ success: true, itemId }, { status: 200 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, itemId } = await context.params;
  return handleUpdateQueueItem(request, subdomain, itemId);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, itemId } = await context.params;
  return handleDeleteQueueItem(request, subdomain, itemId);
}
