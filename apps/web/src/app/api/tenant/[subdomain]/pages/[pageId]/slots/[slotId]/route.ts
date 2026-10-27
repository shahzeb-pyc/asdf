import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  PageQueueSlotSchema,
  UpdateQueueSlotRequestSchema,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Single-slot update/delete for the Facebook Page section, on the
 * unified `posting_slots` table (Phase 7). Scoping is by workspace
 * (resolved from the tenant subdomain) + destination — the unified
 * tables carry no per-user column; the workspace is the isolation
 * boundary. (The pre-unification handlers checked page ownership by
 * user only and never resolved the workspace; the workspace check is
 * strictly tighter.)
 */

const DEFAULT_ALLOWED_FORMATS = ['text', 'image', 'reel', 'video', 'story'];

interface SlotWireRow {
  id: string;
  fb_page_id: string;
  slot_time: string;
  is_active: boolean;
  allowed_formats?: string[] | null;
  created_at: string;
  updated_at: string;
}

function toSlotResponse(
  row: SlotWireRow,
  userId: string,
  pageTimezone: string,
  fallbackFormats: string[]
) {
  return PageQueueSlotSchema.parse({
    id: row.id,
    userId,
    pageId: row.fb_page_id,
    slotTime: typeof row.slot_time === 'string' ? row.slot_time : String(row.slot_time),
    timezone: pageTimezone,
    isActive: Boolean(row.is_active),
    allowedFormats: Array.isArray(row.allowed_formats) ? row.allowed_formats : fallbackFormats,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  });
}

async function authenticateSlotRequest(
  request: NextRequest,
  subdomain: string
) {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { session };
}

export async function handleUpdateQueueSlot(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  slotId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateSlotRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON' },
      { status: 400 }
    );
  }

  const parsed = UpdateQueueSlotRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 1. Verify page exists and belongs to the workspace
    const pageRows = (await dbClient.query(
      "SELECT id, timezone FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [pageId, workspaceId]
    )) as Record<string, unknown>[];

    if (!pageRows || pageRows.length === 0) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    const pageTimezone = String(pageRows[0].timezone || 'UTC');

    const ownerRows = (await dbClient.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    )) as Record<string, unknown>[];
    const ownerId =
      typeof ownerRows?.[0]?.owner_id === 'string' ? ownerRows[0].owner_id : session.userId;

    // 2. Update slot scoped to workspace page + slot id
    // (UNIQUE(destination_id, time_of_day) -> 23505 -> 409)
    try {
      const updateRows = (await dbClient.query(
        `UPDATE posting_slots
         SET time_of_day = COALESCE($1, time_of_day),
             is_active = COALESCE($2, is_active),
             kind = COALESCE($3, kind),
             updated_at = now()
         WHERE id = $4 AND destination_id = $5
         RETURNING id, destination_id AS fb_page_id, time_of_day AS slot_time, is_active, kind AS allowed_formats, created_at, updated_at`,
        [
          parsed.data.slotTime ?? null,
          parsed.data.isActive ?? null,
          parsed.data.allowedFormats ?? null,
          slotId,
          pageId,
        ]
      )) as Record<string, unknown>[];

      if (!updateRows || updateRows.length === 0) {
        return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
      }

      const row = updateRows[0] as unknown as SlotWireRow;
      // Toggle/edit can cover or uncover queued formats.
      await refreshDestinationUnmatchedFlag(dbClient, pageId);
      return NextResponse.json(
        toSlotResponse(row, ownerId, pageTimezone, DEFAULT_ALLOWED_FORMATS),
        { status: 200 }
      );
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === '23505'
      ) {
        return NextResponse.json(
          {
            error: 'SLOT_ALREADY_EXISTS',
            message: 'A publishing slot at this time already exists for this page',
          },
          { status: 409 }
        );
      }
      logServerError('[pages/slots] Failed to update queue slot', err, {
        source: 'page-slots',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to update queue slot' },
        { status: 500 }
      );
    }
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: pageData, error: pageErr } = await supabase
      .from('destinations')
      .select('id, timezone')
      .eq('id', pageId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();

    if (pageErr || !pageData) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    const pageTimezone = String(pageData.timezone || 'UTC');

    const { data: workspaceData } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    const ownerId = workspaceData?.owner_id ?? session.userId;

    const updatePayload: {
      time_of_day?: string;
      is_active?: boolean;
      kind?: string[];
      updated_at: string;
    } = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.slotTime !== undefined) updatePayload.time_of_day = parsed.data.slotTime;
    if (parsed.data.isActive !== undefined) updatePayload.is_active = parsed.data.isActive;
    if (parsed.data.allowedFormats !== undefined) updatePayload.kind = parsed.data.allowedFormats;

    const { data: updated, error: updateErr } = await supabase
      .from('posting_slots')
      .update(updatePayload)
      .eq('id', slotId)
      .eq('destination_id', pageId)
      .select('id, destination_id, time_of_day, is_active, kind, created_at, updated_at')
      .maybeSingle();

    if (updateErr) {
      if (updateErr.code === '23505') {
        return NextResponse.json(
          {
            error: 'SLOT_ALREADY_EXISTS',
            message: 'A publishing slot at this time already exists for this page',
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: updateErr.message },
        { status: 500 }
      );
    }

    if (!updated) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    await refreshDestinationUnmatchedFlag(supabase, pageId);

    return NextResponse.json(
      toSlotResponse(
        {
          id: updated.id,
          fb_page_id: updated.destination_id,
          slot_time:
            typeof updated.time_of_day === 'string'
              ? updated.time_of_day
              : String(updated.time_of_day),
          is_active: updated.is_active,
          allowed_formats: updated.kind,
          created_at: updated.created_at,
          updated_at: updated.updated_at,
        },
        ownerId,
        pageTimezone,
        DEFAULT_ALLOWED_FORMATS
      ),
      { status: 200 }
    );
  }
}

export async function handleDeleteQueueSlot(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  slotId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateSlotRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 1. Verify page exists and belongs to the workspace
    const pageRows = (await dbClient.query(
      "SELECT id FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [pageId, workspaceId]
    )) as Record<string, unknown>[];

    if (!pageRows || pageRows.length === 0) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // 2. Delete slot scoped to slotId + pageId
    const deleteRows = (await dbClient.query(
      `DELETE FROM posting_slots
       WHERE id = $1 AND destination_id = $2
       RETURNING id`,
      [slotId, pageId]
    )) as Record<string, unknown>[];

    if (!deleteRows || deleteRows.length === 0) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    // Deleting a time can leave queued posts with no covering time.
    await refreshDestinationUnmatchedFlag(dbClient, pageId);

    return NextResponse.json({ success: true, slotId });
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: pageData, error: pageErr } = await supabase
      .from('destinations')
      .select('id')
      .eq('id', pageId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();

    if (pageErr || !pageData) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const { data: deleted, error: delErr } = await supabase
      .from('posting_slots')
      .delete()
      .eq('id', slotId)
      .eq('destination_id', pageId)
      .select('id');

    if (delErr || !deleted || deleted.length === 0) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    await refreshDestinationUnmatchedFlag(supabase, pageId);

    return NextResponse.json({ success: true, slotId });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string; slotId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId, slotId } = await context.params;
  return handleUpdateQueueSlot(request, subdomain, pageId, slotId);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string; slotId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId, slotId } = await context.params;
  return handleDeleteQueueSlot(request, subdomain, pageId, slotId);
}
