import { type NextRequest, NextResponse } from 'next/server';
import { CreateThreadsScheduleSlotRequestSchema } from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import {
  isThreadsScheduleAdded,
  threadsFormatsFromKind,
} from '@/lib/server/threads-schedule';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Threads Schedule posting times. Same wire shape as Pages slots,
 * formats restricted to text/image/video/carousel. A slot time is
 * unique per destination (the posting_slots unique constraint turns
 * a duplicate into a 409, never a silent overwrite).
 */
async function fetchScheduleDestinationId(
  supabase: SupabaseClient,
  workspaceId: string,
  scheduleId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('destinations')
    .select('metadata')
    .eq('id', scheduleId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  return isThreadsScheduleAdded((data as { metadata: Record<string, unknown> | null }).metadata);
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string }> }
) {
  const { subdomain, scheduleId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  try {
    const found = await fetchScheduleDestinationId(supabase, workspaceId, scheduleId);
    if (!found) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const { data: destination } = await supabase
      .from('destinations')
      .select('timezone')
      .eq('id', scheduleId)
      .maybeSingle();
    const { data, error } = await supabase
      .from('posting_slots')
      .select('id, time_of_day, is_active, kind, created_at, updated_at')
      .eq('destination_id', scheduleId)
      .order('time_of_day', { ascending: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({
      slots: (data ?? []).map((row) => ({
        id: row.id as string,
        slotTime: String(row.time_of_day).slice(0, 5),
        isActive: Boolean(row.is_active),
        allowedFormats: threadsFormatsFromKind(row.kind),
        createdAt: new Date(row.created_at as string).toISOString(),
        updatedAt: new Date(row.updated_at as string).toISOString(),
      })),
      timezone: (destination as { timezone?: string } | null)?.timezone ?? 'UTC',
    });
  } catch (err) {
    logServerError('[threads/schedule] slots failed', err, { source: 'threads-schedule-slots' });
    return NextResponse.json({ error: 'Failed to load posting times' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string }> }
) {
  const { subdomain, scheduleId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = CreateThreadsScheduleSlotRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: first?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  try {
    const found = await fetchScheduleDestinationId(supabase, workspaceId, scheduleId);
    if (!found) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const { data, error } = await supabase
      .from('posting_slots')
      .insert({
        destination_id: scheduleId,
        time_of_day: parsed.data.time,
        is_active: true,
        kind: parsed.data.formats,
      })
      .select('id, time_of_day, is_active, kind, created_at, updated_at')
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'SLOT_ALREADY_EXISTS', message: 'A posting time at this time already exists.' },
          { status: 409 }
        );
      }
      throw new Error(error.message);
    }
    await refreshDestinationUnmatchedFlag(supabase, scheduleId);
    return NextResponse.json(
      {
        id: data.id as string,
        slotTime: String(data.time_of_day).slice(0, 5),
        isActive: Boolean(data.is_active),
        allowedFormats: threadsFormatsFromKind(data.kind),
        createdAt: new Date(data.created_at as string).toISOString(),
        updatedAt: new Date(data.updated_at as string).toISOString(),
      },
      { status: 201 }
    );
  } catch (err) {
    logServerError('[threads/schedule] slot create failed', err, {
      source: 'threads-schedule-slot-create',
    });
    return NextResponse.json({ error: 'Failed to add this posting time' }, { status: 500 });
  }
}
