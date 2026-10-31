import { type NextRequest, NextResponse } from 'next/server';
import {
  UpdateThreadsScheduleRequestSchema,
  isThreadsScheduleAdded,
  isThreadsSchedulePaused,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import {
  fetchQueueCounts,
  fetchThreadsAccountsById,
  isAccountExpired,
  threadsFormatsFromKind,
  toScheduleItem,
  type ThreadsScheduleDestinationRow,
} from '@/lib/server/threads-schedule';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Threads Schedule detail / settings / removal.
 *
 * Detail only serves schedule-added destinations: a connected Threads
 * destination that was never added here is 404 on this route, even
 * though it exists. Removal clears the schedule flag only — the
 * account, the destination and historical queue rows stay — and
 * cancels still-queued items so nothing publishes after removal.
 * Pause mirrors Facebook: destination status `disconnected` plus the
 * threads_schedule_status marker, so the claim RPC never picks a
 * paused destination's items up.
 */

async function fetchScheduleDestination(
  supabase: SupabaseClient,
  workspaceId: string,
  scheduleId: string
): Promise<ThreadsScheduleDestinationRow | null> {
  const { data, error } = await supabase
    .from('destinations')
    .select(
      'id, account_id, platform, external_destination_id, name, handle, avatar_url, timezone, status, metadata, created_at, updated_at'
    )
    .eq('id', scheduleId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as ThreadsScheduleDestinationRow;
  if (!isThreadsScheduleAdded(row.metadata)) return null;
  return row;
}

async function fetchSlots(supabase: SupabaseClient, destinationId: string) {
  const { data, error } = await supabase
    .from('posting_slots')
    .select('id, time_of_day, is_active, kind, created_at, updated_at')
    .eq('destination_id', destinationId)
    .order('time_of_day', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    slotTime: String(row.time_of_day).slice(0, 5),
    isActive: Boolean(row.is_active),
    allowedFormats: threadsFormatsFromKind(row.kind),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }));
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
    const destination = await fetchScheduleDestination(supabase, workspaceId, scheduleId);
    if (!destination) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const accounts = await fetchThreadsAccountsById(supabase, workspaceId, [destination.account_id]);
    const account = accounts.get(destination.account_id) ?? null;
    const { counts, error: countsError } = await fetchQueueCounts(
      supabase,
      workspaceId,
      destination.id
    );
    const item = toScheduleItem(destination, account, counts, countsError);
    const slots = await fetchSlots(supabase, destination.id);
    return NextResponse.json({
      item: {
        ...item,
        addedAt: item.addedAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        slots: slots.map((slot) => ({
          ...slot,
          createdAt: slot.createdAt.toISOString(),
          updatedAt: slot.updatedAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    logServerError('[threads/schedule] detail failed', err, { source: 'threads-schedule-detail' });
    return NextResponse.json({ error: 'Failed to load this scheduled account' }, { status: 500 });
  }
}

export async function PATCH(
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
  const parsed = UpdateThreadsScheduleRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: first?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  try {
    const destination = await fetchScheduleDestination(supabase, workspaceId, scheduleId);
    if (!destination) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const accounts = await fetchThreadsAccountsById(supabase, workspaceId, [destination.account_id]);
    const account = accounts.get(destination.account_id) ?? null;
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let nextMetadata: Record<string, unknown> = { ...(destination.metadata ?? {}) };
    if (parsed.data.timezone !== undefined) {
      updates['timezone'] = parsed.data.timezone;
    }
    if (parsed.data.status === 'paused') {
      updates['status'] = 'disconnected';
      nextMetadata = { ...nextMetadata, threads_schedule_status: 'paused' };
    } else if (parsed.data.status === 'active') {
      if (account && isAccountExpired(account)) {
        return NextResponse.json(
          {
            error: 'ACCOUNT_EXPIRED',
            message: 'This account’s connection has expired. Reconnect it in Threads Accounts first.',
          },
          { status: 409 }
        );
      }
      // Resume is only for a Schedule pause (disconnected + paused
      // marker) or an already-publishable destination. A destination
      // disconnected for another reason — or in error — must not be
      // silently reactivated to active by a Schedule resume; it
      // needs reconnecting in Threads Accounts first. The old code
      // checked expiry only, so a plain-disconnected destination
      // came back as active here.
      const wasPaused = isThreadsSchedulePaused(destination.metadata);
      if (
        (destination.status === 'disconnected' && !wasPaused) ||
        destination.status === 'error'
      ) {
        return NextResponse.json(
          {
            error: 'ACCOUNT_DISCONNECTED',
            message: 'This account is disconnected. Reconnect it in Threads Accounts, then resume it here.',
          },
          { status: 409 }
        );
      }
      if (!isThreadsSchedulePaused(destination.metadata)) {
        // Resuming a destination that was never paused is a no-op
        // for status, but the request is still valid.
      }
      updates['status'] = 'active';
      delete nextMetadata['threads_schedule_status'];
    }
    if (parsed.data.status !== undefined) {
      updates['metadata'] = nextMetadata;
    }
    const { error: updateError } = await supabase
      .from('destinations')
      .update(updates)
      .eq('id', scheduleId)
      .eq('workspace_id', workspaceId);
    if (updateError) throw new Error(updateError.message);
    const { counts, error: countsError } = await fetchQueueCounts(
      supabase,
      workspaceId,
      scheduleId
    );
    const item = toScheduleItem(
      {
        ...destination,
        timezone:
          parsed.data.timezone !== undefined ? parsed.data.timezone : destination.timezone,
        status:
          parsed.data.status === 'paused'
            ? 'disconnected'
            : parsed.data.status === 'active'
              ? 'active'
              : destination.status,
        metadata: nextMetadata,
      },
      account,
      counts,
      countsError
    );
    return NextResponse.json({
      item: {
        ...item,
        addedAt: item.addedAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    logServerError('[threads/schedule] settings failed', err, {
      source: 'threads-schedule-settings',
    });
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string }> }
) {
  const { subdomain, scheduleId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  try {
    const destination = await fetchScheduleDestination(supabase, workspaceId, scheduleId);
    if (!destination) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const wasPaused = isThreadsSchedulePaused(destination.metadata);
    const nextMetadata: Record<string, unknown> = { ...(destination.metadata ?? {}) };
    delete nextMetadata['threads_schedule_added_at'];
    delete nextMetadata['threads_schedule_status'];
    // Cancel FIRST, then clear the flag. If the cancel fails, the
    // account stays in Schedule with its queued items still live —
    // the old order cleared the flag first, so a cancel failure
    // left a removed account whose queued items could still publish.
    const { error: cancelError } = await supabase
      .from('queue_items')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('destination_id', scheduleId)
      .eq('status', 'queued');
    if (cancelError) throw new Error(cancelError.message);
    const { error: flagError } = await supabase
      .from('destinations')
      .update({
        metadata: nextMetadata,
        // A schedule-paused destination was stored as disconnected;
        // removing it from Schedule restores it to active so the
        // Accounts view is not left showing a Schedule pause.
        ...(wasPaused ? { status: 'active' } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', scheduleId)
      .eq('workspace_id', workspaceId);
    if (flagError) throw new Error(flagError.message);
    return NextResponse.json({ success: true });
  } catch (err) {
    logServerError('[threads/schedule] remove failed', err, { source: 'threads-schedule-remove' });
    return NextResponse.json({ error: 'Failed to remove this account from In-app Schedule' }, { status: 500 });
  }
}
