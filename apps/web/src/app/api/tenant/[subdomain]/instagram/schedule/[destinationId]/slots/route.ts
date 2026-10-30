import { type NextRequest, NextResponse } from 'next/server';
import {
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import {
  ListQueueSlotsResponseSchema,
  PageQueueSlotSchema,
} from '@/lib/api/schemas/queue';
import {
  CreateInstagramScheduleSlotRequestSchema,
  UpdateInstagramScheduleTimezoneRequestSchema,
} from '@/lib/api/schemas/instagram-schedule';
import {
  isScheduledDestination,
  isValidTimezone,
  normalizeScheduleSlotFormats,
  parseDestinationMetadata,
} from '@/lib/server/instagram-schedule';
import {
  authenticateInstagramSchedule,
  type InstagramScheduleDbClient,
} from '@/lib/server/instagram-schedule-auth';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Instagram Schedule posting-times routes, adapted from the Facebook
 * Pages slots route with platform='instagram' and Instagram-only
 * formats. A slot belongs to a scheduled destination only: the
 * destination must exist in this workspace, be Instagram, and carry
 * the scheduled flag, or the route answers 404.
 */

interface SlotRow {
  id: string;
  destination_id: string;
  time_of_day: string;
  is_active: boolean;
  kind: string[] | null;
  created_at: string;
  updated_at: string;
}

async function loadDestination(
  dbClient: InstagramScheduleDbClient | undefined,
  workspaceId: string,
  destinationId: string
): Promise<{ id: string; timezone: string; metadata: unknown } | null> {
  if (dbClient && 'query' in dbClient) {
    const rows = await (dbClient as DatabaseClient).query<{
      id: string;
      timezone: string;
      metadata: unknown;
    }>(
      `SELECT id, timezone, metadata FROM destinations
       WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
      [destinationId, workspaceId]
    );
    return rows[0] ?? null;
  }
  const supabase = (dbClient && 'from' in dbClient
    ? (dbClient as SupabaseClient<Database>)
    : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, timezone, metadata')
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

function slotRowToWire(
  row: SlotRow,
  timezone: string,
  ownerId: string
) {
  return PageQueueSlotSchema.parse({
    id: row.id,
    userId: ownerId,
    pageId: row.destination_id,
    slotTime: String(row.time_of_day).slice(0, 5),
    timezone,
    isActive: Boolean(row.is_active),
    allowedFormats: Array.isArray(row.kind) ? row.kind : ['image', 'reel', 'carousel'],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export async function handleListInstagramScheduleSlots(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  try {
    const destination = await loadDestination(dbClient, auth.workspaceId, destinationId);
    if (
      !destination ||
      !isScheduledDestination(parseDestinationMetadata(destination.metadata))
    ) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    let rows: SlotRow[];
    if (dbClient && 'query' in dbClient) {
      rows = await (dbClient as DatabaseClient).query<SlotRow>(
        `SELECT id, destination_id, time_of_day, is_active, kind, created_at, updated_at
         FROM posting_slots WHERE destination_id = $1 ORDER BY time_of_day ASC`,
        [destinationId]
      );
    } else {
      const supabase = (dbClient && 'from' in dbClient
        ? (dbClient as SupabaseClient<Database>)
        : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
      if (!supabase) {
        return NextResponse.json(
          { error: 'Database service unavailable' },
          { status: 500 }
        );
      }
      const { data, error } = await supabase
        .from('posting_slots')
        .select('id, destination_id, time_of_day, is_active, kind, created_at, updated_at')
        .eq('destination_id', destinationId)
        .order('time_of_day', { ascending: true });
      if (error) throw new Error(error.message);
      rows = (data ?? []) as SlotRow[];
    }
    const slots = rows.map((row) =>
      slotRowToWire(row, destination.timezone, auth.session.userId)
    );
    return NextResponse.json(
      ListQueueSlotsResponseSchema.parse({ slots, total: slots.length })
    );
  } catch (err) {
    logServerError('[instagram-schedule] slots list failed', err, {
      source: 'instagram-schedule-slots',
    });
    return NextResponse.json(
      { error: 'Failed to load posting times.' },
      { status: 500 }
    );
  }
}

export async function handleCreateInstagramScheduleSlot(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = CreateInstagramScheduleSlotRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  const normalized = normalizeScheduleSlotFormats(parsed.data.formats);
  if ('error' in normalized) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  try {
    const destination = await loadDestination(dbClient, auth.workspaceId, destinationId);
    if (
      !destination ||
      !isScheduledDestination(parseDestinationMetadata(destination.metadata))
    ) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    if (dbClient && 'query' in dbClient) {
      const sql = dbClient as DatabaseClient;
      const existing = await sql.query<{ id: string }>(
        `SELECT id FROM posting_slots WHERE destination_id = $1 AND time_of_day = $2 LIMIT 1`,
        [destinationId, parsed.data.time]
      );
      if (existing[0]) {
        return NextResponse.json(
          { error: `Posting time ${parsed.data.time} already exists.` },
          { status: 409 }
        );
      }
      const inserted = await sql.query<SlotRow>(
        `INSERT INTO posting_slots (destination_id, kind, time_of_day, is_active)
         VALUES ($1, $2, $3, true) RETURNING id, destination_id, time_of_day, is_active, kind, created_at, updated_at`,
        [destinationId, normalized.formats, parsed.data.time]
      );
      if (!inserted[0]) throw new Error('Slot insert returned no row');
      return NextResponse.json(
        slotRowToWire(inserted[0], destination.timezone, auth.session.userId),
        { status: 201 }
      );
    }
    const supabase = (dbClient && 'from' in dbClient
      ? (dbClient as SupabaseClient<Database>)
      : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      );
    }
    const { data: existing } = await supabase
      .from('posting_slots')
      .select('id')
      .eq('destination_id', destinationId)
      .eq('time_of_day', parsed.data.time)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: `Posting time ${parsed.data.time} already exists.` },
        { status: 409 }
      );
    }
    const { data: inserted, error } = await supabase
      .from('posting_slots')
      .insert({
        destination_id: destinationId,
        kind: normalized.formats,
        time_of_day: parsed.data.time,
        is_active: true,
      })
      .select('id, destination_id, time_of_day, is_active, kind, created_at, updated_at')
      .single();
    if (error || !inserted) throw new Error(error?.message ?? 'Slot insert failed');
    return NextResponse.json(
      slotRowToWire(inserted as SlotRow, destination.timezone, auth.session.userId),
      { status: 201 }
    );
  } catch (err) {
    logServerError('[instagram-schedule] slot create failed', err, {
      source: 'instagram-schedule-slots',
    });
    return NextResponse.json(
      { error: 'Could not add this posting time. Please try again.' },
      { status: 500 }
    );
  }
}

export async function handleUpdateInstagramScheduleTimezone(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = UpdateInstagramScheduleTimezoneRequestSchema.safeParse(body);
  if (!parsed.success || !isValidTimezone(parsed.data.timezone)) {
    return NextResponse.json(
      { error: 'Choose a valid timezone.' },
      { status: 400 }
    );
  }
  try {
    const destination = await loadDestination(dbClient, auth.workspaceId, destinationId);
    if (
      !destination ||
      !isScheduledDestination(parseDestinationMetadata(destination.metadata))
    ) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    if (dbClient && 'query' in dbClient) {
      await (dbClient as DatabaseClient).query(
        `UPDATE destinations SET timezone = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`,
        [parsed.data.timezone, destinationId, auth.workspaceId]
      );
    } else {
      const supabase = (dbClient && 'from' in dbClient
        ? (dbClient as SupabaseClient<Database>)
        : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
      if (!supabase) {
        return NextResponse.json(
          { error: 'Database service unavailable' },
          { status: 500 }
        );
      }
      const { error } = await supabase
        .from('destinations')
        .update({ timezone: parsed.data.timezone })
        .eq('id', destinationId)
        .eq('workspace_id', auth.workspaceId);
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ timezone: parsed.data.timezone });
  } catch (err) {
    logServerError('[instagram-schedule] timezone update failed', err, {
      source: 'instagram-schedule-slots',
    });
    return NextResponse.json(
      { error: 'Could not change the timezone. Please try again.' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleListInstagramScheduleSlots(request, subdomain, destinationId);
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleCreateInstagramScheduleSlot(request, subdomain, destinationId);
}

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleUpdateInstagramScheduleTimezone(request, subdomain, destinationId);
}
