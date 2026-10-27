import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  CreateQueueSlotRequestSchema,
  getSessionSecret,
  ListQueueSlotsResponseSchema,
  PageQueueSlotSchema,
  UpdateQueueScheduleTimezoneRequestSchema,
  UpdateQueueScheduleTimezoneResponseSchema,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { recomputeSlotScheduledTime } from '@/lib/slot-scheduler';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Posting-slot routes for the Facebook Page section, on the unified
 * tables (Phase 7): pages are `destinations`, slots are
 * `posting_slots` (time_of_day + kind[]), the page timezone lives on
 * the destination row, and pending items are unified `queue_items`.
 * The wire shape is unchanged: slot rows carry the workspace owner's
 * id as `userId` (the unified tables are workspace-scoped; the owner
 * is the user identity the wire contract has always reported).
 */

const DEFAULT_ALLOWED_FORMATS = ['text', 'image', 'reel', 'video', 'story'];

/** Slot row as consumed here (spec 137 §3.7), in wire field names. */
interface SlotRow {
  id: string;
  fb_page_id: string;
  slot_time: string;
  is_active: boolean;
  allowed_formats?: string[] | null;
  created_at: string;
  updated_at: string;
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

export async function handleListQueueSlots(
  request: NextRequest,
  subdomain: string,
  pageId: string,
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

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let slotRows: SlotRow[] = [];
  let pageTimezone = 'UTC';
  let ownerId: string | null = null;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 1. Verify page exists and belongs to the workspace
    const pageRows = (await dbClient.query(
      "SELECT id, timezone FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [pageId, workspaceId]
    )) as Record<string, unknown>[];

    if (!pageRows || pageRows.length === 0) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }
    pageTimezone = String(pageRows[0].timezone || 'UTC');
    ownerId = await fetchWorkspaceOwnerId(dbClient, workspaceId);

    // 2. Fetch slots for this page
    slotRows = await dbClient.query<SlotRow>(
      `SELECT id, destination_id AS fb_page_id, time_of_day AS slot_time, is_active, kind AS allowed_formats, created_at, updated_at
       FROM posting_slots
       WHERE destination_id = $1
       ORDER BY time_of_day ASC`,
      [pageId]
    );
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
    pageTimezone = String(pageData.timezone || 'UTC');
    ownerId = await fetchWorkspaceOwnerId(supabase, workspaceId);

    const { data: slotsData, error: slotsErr } = await supabase
      .from('posting_slots')
      .select('id, destination_id, time_of_day, is_active, kind, created_at, updated_at')
      .eq('destination_id', pageId)
      .order('time_of_day', { ascending: true });

    if (slotsErr) {
      return NextResponse.json({ error: slotsErr.message }, { status: 500 });
    }
    slotRows = (slotsData || []).map((s) => ({
      id: s.id,
      fb_page_id: s.destination_id,
      slot_time: typeof s.time_of_day === 'string' ? s.time_of_day : String(s.time_of_day),
      is_active: s.is_active,
      allowed_formats: s.kind,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));
  }

  const slots = slotRows.map((row) => ({
    id: row.id,
    userId: ownerId ?? session.userId,
    pageId: row.fb_page_id,
    slotTime: typeof row.slot_time === 'string' ? row.slot_time : String(row.slot_time),
    timezone: pageTimezone,
    isActive: Boolean(row.is_active),
    allowedFormats: Array.isArray(row.allowed_formats) ? row.allowed_formats : DEFAULT_ALLOWED_FORMATS,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  }));

  const responsePayload = ListQueueSlotsResponseSchema.parse({
    slots,
    total: slots.length,
  });

  return NextResponse.json(responsePayload);
}

export async function handleCreateQueueSlot(
  request: NextRequest,
  subdomain: string,
  pageId: string,
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

  const payloadToValidate =
    typeof rawBody === 'object' && rawBody !== null
      ? { pageId, ...rawBody }
      : rawBody;

  const parsed = CreateQueueSlotRequestSchema.safeParse(payloadToValidate);
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

  const allowedFormats = parsed.data.allowedFormats ?? DEFAULT_ALLOWED_FORMATS;

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
    const ownerId = await fetchWorkspaceOwnerId(dbClient, workspaceId);

    // 2. Insert slot (UNIQUE(destination_id, time_of_day) -> 23505 -> 409)
    try {
      const rows = (await dbClient.query(
        `INSERT INTO posting_slots (destination_id, time_of_day, is_active, kind, created_at, updated_at)
         VALUES ($1, $2, true, $3, now(), now())
         RETURNING id, destination_id AS fb_page_id, time_of_day AS slot_time, is_active, kind AS allowed_formats, created_at, updated_at`,
        [pageId, parsed.data.slotTime, allowedFormats]
      )) as Record<string, unknown>[];

      const row = rows[0];
      const responsePayload = PageQueueSlotSchema.parse({
        id: row.id,
        userId: ownerId ?? session.userId,
        pageId: row.fb_page_id,
        slotTime: typeof row.slot_time === 'string' ? row.slot_time : String(row.slot_time),
        timezone: pageTimezone,
        isActive: Boolean(row.is_active),
        allowedFormats: Array.isArray(row.allowed_formats) ? row.allowed_formats : allowedFormats,
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
            error: 'SLOT_ALREADY_EXISTS',
            message: 'A publishing slot at this time already exists for this page',
          },
          { status: 409 }
        );
      }
      logServerError('[pages/slots] Failed to create queue slot', err, {
        source: 'page-slots',
        subdomain,
      });
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: 'Failed to create queue slot' },
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
    const ownerId = await fetchWorkspaceOwnerId(supabase, workspaceId);

    const { data: inserted, error: insertErr } = await supabase
      .from('posting_slots')
      .insert({
        destination_id: pageId,
        time_of_day: parsed.data.slotTime,
        is_active: true,
        kind: allowedFormats,
      })
      .select('id, destination_id, time_of_day, is_active, kind, created_at, updated_at')
      .single();

    if (insertErr) {
      if (insertErr.code === '23505') {
        return NextResponse.json(
          {
            error: 'SLOT_ALREADY_EXISTS',
            message: 'A publishing slot at this time already exists for this page',
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'INTERNAL_ERROR', message: insertErr.message },
        { status: 500 }
      );
    }

    const responsePayload = PageQueueSlotSchema.parse({
      id: inserted.id,
      userId: ownerId ?? session.userId,
      pageId: inserted.destination_id,
      slotTime: typeof inserted.time_of_day === 'string' ? inserted.time_of_day : String(inserted.time_of_day),
      timezone: pageTimezone,
      isActive: Boolean(inserted.is_active),
      allowedFormats: Array.isArray(inserted.kind) ? inserted.kind : allowedFormats,
      createdAt: new Date(inserted.created_at).toISOString(),
      updatedAt: new Date(inserted.updated_at).toISOString(),
    });

    return NextResponse.json(responsePayload, { status: 201 });
  }
}

async function realignPendingQueueItemsPostgres(
  dbClient: DatabaseClient,
  pageId: string,
  newTimezone: string
): Promise<number> {
  const pendingRows = (await dbClient.query(
    `SELECT qi.id, qi.scheduled_time, s.time_of_day AS slot_time
     FROM queue_items qi
     JOIN posting_slots s ON s.id = qi.slot_id
     WHERE qi.destination_id = $1 AND qi.status = 'queued'
     ORDER BY qi.scheduled_time ASC`,
    [pageId]
  )) as Record<string, unknown>[];

  if (!pendingRows || pendingRows.length === 0) {
    return 0;
  }

  const occupiedTimes = new Set<number>();
  const now = new Date();
  let realignedCount = 0;

  for (const row of pendingRows) {
    const originalTime = new Date(row.scheduled_time as string);
    const slotTimeStr = typeof row.slot_time === 'string' ? row.slot_time : String(row.slot_time);
    const newScheduledTime = recomputeSlotScheduledTime({
      originalScheduledTime: originalTime,
      slotTime: slotTimeStr,
      newTimezone,
      now,
      occupiedTimes,
    });
    occupiedTimes.add(newScheduledTime.getTime());

    // Count only items whose time actually moved: rows whose
    // recomputed time equals the original (e.g. an unparseable slot
    // time falling back to the original) are not "realigned".
    if (newScheduledTime.getTime() !== originalTime.getTime()) {
      await dbClient.query(
        `UPDATE queue_items
         SET scheduled_time = $1, updated_at = now()
         WHERE id = $2`,
        [newScheduledTime.toISOString(), row.id]
      );
      realignedCount++;
    }
  }

  return realignedCount;
}

async function realignPendingQueueItemsSupabase(
  supabase: SupabaseClient,
  pageId: string,
  newTimezone: string
): Promise<number> {
  const { data: queueData, error: queueErr } = await supabase
    .from('queue_items')
    .select('id, scheduled_time, slot_id')
    .eq('destination_id', pageId)
    .eq('status', 'queued')
    .not('slot_id', 'is', null)
    .order('scheduled_time', { ascending: true });

  if (queueErr || !queueData || queueData.length === 0) {
    return 0;
  }

  const slotIds = [...new Set(queueData.map((item) => item.slot_id).filter(Boolean))];
  const { data: slotsData, error: slotsErr } = await supabase
    .from('posting_slots')
    .select('id, time_of_day')
    .in('id', slotIds as string[]);

  if (slotsErr || !slotsData || slotsData.length === 0) {
    return 0;
  }

  const slotMap = new Map<string, string>();
  for (const s of slotsData) {
    slotMap.set(s.id, typeof s.time_of_day === 'string' ? s.time_of_day : String(s.time_of_day));
  }

  const occupiedTimes = new Set<number>();
  const now = new Date();
  let realignedCount = 0;

  for (const item of queueData) {
    const slotTime = item.slot_id ? slotMap.get(item.slot_id) : undefined;
    if (!slotTime) continue;

    const originalTime = new Date(item.scheduled_time);
    const newScheduledTime = recomputeSlotScheduledTime({
      originalScheduledTime: originalTime,
      slotTime,
      newTimezone,
      now,
      occupiedTimes,
    });
    occupiedTimes.add(newScheduledTime.getTime());

    // Count only items whose time actually moved (see the Postgres
    // path above): an unchanged recomputation is not a realignment.
    if (newScheduledTime.getTime() !== originalTime.getTime()) {
      await supabase
        .from('queue_items')
        .update({
          scheduled_time: newScheduledTime.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('id', item.id);
      realignedCount++;
    }
  }

  return realignedCount;
}

async function updateScheduleTimezonePostgres(
  dbClient: DatabaseClient,
  pageId: string,
  workspaceId: string,
  newTimezone: string
): Promise<{ notFound?: boolean; updatedCount?: number; realignedQueueCount?: number }> {
  const updatedPages = (await dbClient.query(
    `UPDATE destinations
     SET timezone = $1, updated_at = now()
     WHERE id = $2 AND workspace_id = $3 AND platform = 'facebook'
     RETURNING id`,
    [newTimezone, pageId, workspaceId]
  )) as Record<string, unknown>[];

  if (!updatedPages || updatedPages.length === 0) {
    return { notFound: true };
  }

  const slotRows = await dbClient.query<{ count: number }>(
    'SELECT count(*)::int as count FROM posting_slots WHERE destination_id = $1',
    [pageId]
  );

  const realignedQueueCount = await realignPendingQueueItemsPostgres(
    dbClient,
    pageId,
    newTimezone
  );

  return {
    updatedCount: Number(slotRows[0]?.count ?? 0),
    realignedQueueCount,
  };
}

async function updateScheduleTimezoneSupabase(
  supabase: SupabaseClient,
  pageId: string,
  workspaceId: string,
  newTimezone: string
): Promise<{ notFound?: boolean; error?: string; updatedCount?: number; realignedQueueCount?: number }> {
  const { data: updatedPage, error: updateErr } = await supabase
    .from('destinations')
    .update({
      timezone: newTimezone,
      updated_at: new Date().toISOString(),
    })
    .eq('id', pageId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .select('id')
    .maybeSingle();

  if (updateErr) {
    return { error: updateErr.message };
  }

  if (!updatedPage) {
    return { notFound: true };
  }

  const { count } = await supabase
    .from('posting_slots')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', pageId);

  const realignedQueueCount = await realignPendingQueueItemsSupabase(
    supabase,
    pageId,
    newTimezone
  );

  return {
    updatedCount: count ?? 0,
    realignedQueueCount,
  };
}

export async function handleUpdateQueueScheduleTimezone(
  request: NextRequest,
  subdomain: string,
  pageId: string,
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

  const parsed = UpdateQueueScheduleTimezoneRequestSchema.safeParse(rawBody);
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

  const newTimezone = parsed.data.timezone;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const result = await updateScheduleTimezonePostgres(
      dbClient as DatabaseClient,
      pageId,
      workspaceId,
      newTimezone
    );

    if (result.notFound) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    const responsePayload = UpdateQueueScheduleTimezoneResponseSchema.parse({
      success: true,
      timezone: newTimezone,
      updatedCount: result.updatedCount ?? 0,
      realignedQueueCount: result.realignedQueueCount ?? 0,
    });
    return NextResponse.json(responsePayload);
  }

  const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const result = await updateScheduleTimezoneSupabase(
    supabase,
    pageId,
    workspaceId,
    newTimezone
  );

  if (result.notFound) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  if (result.error) {
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: result.error }, { status: 500 });
  }

  const responsePayload = UpdateQueueScheduleTimezoneResponseSchema.parse({
    success: true,
    timezone: newTimezone,
    updatedCount: result.updatedCount ?? 0,
    realignedQueueCount: result.realignedQueueCount ?? 0,
  });
  return NextResponse.json(responsePayload);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleListQueueSlots(request, subdomain, pageId);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleCreateQueueSlot(request, subdomain, pageId);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleUpdateQueueScheduleTimezone(request, subdomain, pageId);
}
