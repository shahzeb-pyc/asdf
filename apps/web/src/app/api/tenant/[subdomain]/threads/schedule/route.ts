import { type NextRequest, NextResponse } from 'next/server';
import {
  AddThreadsScheduleRequestSchema,
  isThreadsScheduleAdded,
  type ThreadsScheduleItem,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import { paginateMeta, parsePaginationParams } from '@/lib/server/pagination';
import {
  fetchQueueCounts,
  fetchScheduleDestinations,
  fetchThreadsAccountsById,
  isAccountExpired,
  toScheduleItem,
  type ThreadsScheduleDestinationRow,
} from '@/lib/server/threads-schedule';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';

/**
 * Threads In-app Schedule list + add.
 *
 * List: only destinations whose metadata carries
 * threads_schedule_added_at — connected Threads accounts that were
 * never added here never appear, by design. Add: a connected Threads
 * destination, a validated timezone, and at least one posting time.
 * The flag, timezone, status and slots are written together; a slot
 * failure rolls all of them back (including pre-existing slots) so
 * a half-added account is impossible.
 */

export async function GET(request: NextRequest, props: { params: Promise<{ subdomain: string }> }) {
  const { subdomain } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  const url = new URL(request.url);
  const { page, limit } = parsePaginationParams(url.searchParams);
  const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
  const statusFilter = url.searchParams.get('status') ?? 'all';
  const accountFilter = url.searchParams.get('account') ?? 'all';

  try {
    const destinations = await fetchScheduleDestinations(supabase, workspaceId);
    const accounts = await fetchThreadsAccountsById(
      supabase,
      workspaceId,
      destinations.map((d) => d.account_id)
    );
    const items: ThreadsScheduleItem[] = [];
    for (const destination of destinations) {
      const account = accounts.get(destination.account_id) ?? null;
      const item = toScheduleItem(destination, account, { queued: 0, posted: 0, failed: 0 }, false);
      if (search) {
        const haystack = `${item.name} ${item.handle ?? ''} ${item.accountDisplayName}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      if (statusFilter !== 'all' && item.status !== statusFilter) continue;
      if (accountFilter !== 'all' && item.accountId !== accountFilter) continue;
      const { counts, error } = await fetchQueueCounts(supabase, workspaceId, destination.id);
      item.queueCounts = counts;
      item.queueCountsError = error || undefined;
      items.push(item);
    }
    items.sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
    const meta = paginateMeta(items.length, page, limit);
    const pageItems = items.slice(meta.start - 1, meta.end);
    return NextResponse.json({
      items: pageItems.map((item) => ({
        ...item,
        addedAt: item.addedAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      total: meta.total,
      page: meta.page,
      limit: meta.limit,
      totalPages: meta.totalPages,
    });
  } catch (err) {
    logServerError('[threads/schedule] list failed', err, { source: 'threads-schedule-list' });
    return NextResponse.json({ error: 'Failed to list scheduled accounts' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ subdomain: string }> }) {
  const { subdomain } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json({ error: 'INVALID_REQUEST', message: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = AddThreadsScheduleRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: first?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  const { destinationId, timezone, postingTimes } = parsed.data;
  const times = postingTimes.map((t) => t.time);
  if (new Set(times).size !== times.length) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Each posting time can only appear once.' },
      { status: 400 }
    );
  }

  try {
    const { data: destination, error: destError } = await supabase
      .from('destinations')
      .select(
        'id, account_id, platform, external_destination_id, name, handle, avatar_url, timezone, status, metadata, created_at, updated_at'
      )
      .eq('id', destinationId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (destError) throw new Error(destError.message);
    if (!destination) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    const destRow = destination as ThreadsScheduleDestinationRow;
    if (isThreadsScheduleAdded(destRow.metadata)) {
      return NextResponse.json(
        { error: 'ALREADY_ADDED', message: 'This account is already in In-app Schedule.' },
        { status: 409 }
      );
    }
    const { data: account } = await supabase
      .from('social_accounts')
      .select('id, external_account_id, display_name, avatar_url, status, token_expires_at')
      .eq('id', destRow.account_id)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (isAccountExpired(account as { status: string; token_expires_at: string | null })) {
      return NextResponse.json(
        {
          error: 'ACCOUNT_EXPIRED',
          message: 'This account’s connection has expired. Reconnect it in Threads Accounts, then add it here.',
        },
        { status: 409 }
      );
    }
    if (destRow.status === 'error' || destRow.status === 'disconnected') {
      return NextResponse.json(
        {
          error: 'ACCOUNT_DISCONNECTED',
          message: 'This account is disconnected. Reconnect it in Threads Accounts, then add it here.',
        },
        { status: 409 }
      );
    }

    const previousMetadata = (destRow.metadata ?? {}) as Record<string, unknown>;
    const previousTimezone = destRow.timezone;
    const previousStatus = destRow.status;
    const nextMetadata: Record<string, unknown> = {
      ...previousMetadata,
      threads_schedule_added_at: new Date().toISOString(),
    };
    delete nextMetadata['threads_schedule_status'];

    // Snapshot pre-existing slots BEFORE any mutation, so a slot
    // failure can restore them exactly — the old code deleted them
    // first and never put them back, and its flag rollback also
    // forgot the destination status it had forced to active.
    const { data: previousSlots, error: previousSlotsError } = await supabase
      .from('posting_slots')
      .select('time_of_day, is_active, kind')
      .eq('destination_id', destinationId);
    if (previousSlotsError) throw new Error(previousSlotsError.message);
    const previousSlotRows = (previousSlots ?? []) as Array<{
      time_of_day: string;
      is_active: boolean;
      kind: unknown;
    }>;

    const { error: flagError } = await supabase
      .from('destinations')
      .update({
        metadata: nextMetadata,
        timezone,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', destinationId)
      .eq('workspace_id', workspaceId);
    if (flagError) throw new Error(flagError.message);

    try {
      const { error: deleteError } = await supabase
        .from('posting_slots')
        .delete()
        .eq('destination_id', destinationId);
      if (deleteError) throw new Error(deleteError.message);
      const { error: insertError } = await supabase.from('posting_slots').insert(
        postingTimes.map((t) => ({
          destination_id: destinationId,
          time_of_day: t.time,
          is_active: true,
          kind: t.formats,
        }))
      );
      if (insertError) throw new Error(insertError.message);
    } catch (slotError) {
      // Roll everything back: flag, timezone, status AND slots.
      // A half-added account — or a silently emptied posting-times
      // list — must never survive a slot failure.
      await supabase
        .from('destinations')
        .update({
          metadata: previousMetadata,
          timezone: previousTimezone,
          status: previousStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', destinationId)
        .eq('workspace_id', workspaceId);
      await supabase.from('posting_slots').delete().eq('destination_id', destinationId);
      if (previousSlotRows.length > 0) {
        await supabase.from('posting_slots').insert(
          previousSlotRows.map((slot) => ({
            destination_id: destinationId,
            time_of_day: slot.time_of_day,
            is_active: slot.is_active,
            kind: slot.kind,
          }))
        );
      }
      throw slotError;
    }

    await refreshDestinationUnmatchedFlag(supabase, destinationId);
    const { counts, error: countsError } = await fetchQueueCounts(
      supabase,
      workspaceId,
      destinationId
    );
    const item = toScheduleItem(
      { ...destRow, metadata: nextMetadata, timezone, status: 'active' },
      account as {
        id: string;
        external_account_id: string;
        display_name: string;
        avatar_url: string | null;
        status: string;
        token_expires_at: string | null;
      },
      counts,
      countsError
    );
    return NextResponse.json(
      {
        item: {
          ...item,
          addedAt: item.addedAt.toISOString(),
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        },
      },
      { status: 201 }
    );
  } catch (err) {
    logServerError('[threads/schedule] add failed', err, { source: 'threads-schedule-add' });
    return NextResponse.json({ error: 'Failed to add this account to In-app Schedule' }, { status: 500 });
  }
}
