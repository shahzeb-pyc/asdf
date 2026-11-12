import { type NextRequest, NextResponse } from 'next/server';
import {
  AddThreadsScheduleRequestSchema,
  type ThreadsScheduleItem,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import { paginateMeta, parsePaginationParams } from '@/lib/server/pagination';
import {
  fetchQueueCounts,
  fetchScheduleDestinations,
  fetchThreadsAccountsById,
  isAccountExpired,
  isThreadsScheduleListMember,
  toScheduleItem,
  type ThreadsScheduleDestinationRow,
} from '@/lib/server/threads-schedule';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { assertFeatureAddWithinCap } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  subscriptionGateResponse,
} from '@/lib/billing/route-helpers';

/**
 * Threads In-app Schedule list + add.
 *
 * List: only destinations whose section is 'schedule' (spec 174 1B) —
 * connected Threads accounts that were never added here never appear,
 * by design. Add: a connected Threads ACCOUNT, a validated timezone,
 * and at least one posting time (spec 174 2A: the Add dialog sources
 * live from the connected account, never from a table — connect
 * creates no destinations rows anymore). The add stamps the row's
 * section to 'schedule' (the import IS the section's copy): it
 * reactivates a removed schedule stub, adopts the unimported
 * connected row, or inserts a fresh schedule copy from the account.
 * A row that already belongs to another section is never adopted.
 * The flag, timezone, status and slots are written together; a slot
 * failure rolls all of them back (including pre-existing slots, and
 * deleting a freshly inserted copy) so a half-added account is
 * impossible.
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
  const { supabase, workspaceId, session } = auth;

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
  const { accountId, timezone, postingTimes } = parsed.data;
  const times = postingTimes.map((t) => t.time);
  if (new Set(times).size !== times.length) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Each posting time can only appear once.' },
      { status: 400 }
    );
  }

  try {
    // 1. The account is the import source (spec 174 2A): the Add
    // dialog sources live from the connected account, never from a
    // table. Connect creates no destinations rows anymore, so a
    // freshly connected account has no row to adopt — the import
    // creates the schedule copy here (the IG Schedule POST pattern).
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('id, external_account_id, display_name, avatar_url, status, token_expires_at')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (accountError) throw new Error(accountError.message);
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    const accountRow = account as {
      id: string;
      external_account_id: string;
      display_name: string;
      avatar_url: string | null;
      status: string;
      token_expires_at: string | null;
    };
    if (isAccountExpired(accountRow)) {
      return NextResponse.json(
        {
          error: 'ACCOUNT_EXPIRED',
          message: 'This account’s connection has expired. Reconnect it in Threads Accounts, then add it here.',
        },
        { status: 409 }
      );
    }
    if (
      accountRow.status === 'disconnected' ||
      accountRow.status === 'revoked' ||
      accountRow.status === 'error'
    ) {
      return NextResponse.json(
        {
          error: 'ACCOUNT_DISCONNECTED',
          message: 'This account is disconnected. Reconnect it in Threads Accounts, then add it here.',
        },
        { status: 409 }
      );
    }

    // 2. Resolve the schedule copy: the existing schedule copy
    // (reactivated when it is a removed stub), else the unimported
    // connected row (adopted in place), else a fresh insert from
    // the account. A row belonging to another section is never
    // adopted — the resolution below only ever offers the schedule
    // copy or the unimported row, so a row from another section
    // simply means "no row to adopt" and a fresh copy is inserted.
    const DESTINATION_COLUMNS =
      'id, account_id, platform, section, external_destination_id, name, handle, avatar_url, timezone, status, metadata, created_at, updated_at';
    const { data: scheduleCopy, error: copyError } = await supabase
      .from('destinations')
      .select(DESTINATION_COLUMNS)
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .eq('section', 'schedule')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (copyError) throw new Error(copyError.message);
    const copyRow = (scheduleCopy ?? null) as ThreadsScheduleDestinationRow | null;
    if (copyRow && isThreadsScheduleListMember(copyRow)) {
      return NextResponse.json(
        { error: 'ALREADY_ADDED', message: 'This account is already in In-app Schedule.' },
        { status: 409 }
      );
    }
    let unimportedRow: ThreadsScheduleDestinationRow | null = null;
    if (!copyRow) {
      const { data: unimported, error: unimportedError } = await supabase
        .from('destinations')
        .select(DESTINATION_COLUMNS)
        .eq('account_id', accountId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .is('section', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (unimportedError) throw new Error(unimportedError.message);
      unimportedRow = (unimported ?? null) as ThreadsScheduleDestinationRow | null;
      // An unimported row whose status is disconnected/error means
      // the account's connection died after connect — the account
      // needs reconnecting, not a re-adoption.
      if (
        unimportedRow &&
        (unimportedRow.status === 'disconnected' || unimportedRow.status === 'error')
      ) {
        return NextResponse.json(
          {
            error: 'ACCOUNT_DISCONNECTED',
            message: 'This account is disconnected. Reconnect it in Threads Accounts, then add it here.',
          },
          { status: 409 }
        );
      }
    }
    const targetRow = copyRow ?? unimportedRow;

    // Plan cap gate: adding an account to Schedule registers it
    // against the Threads cap, so an over-cap add is rejected here,
    // before any destination mutation or slot write. Admins are never
    // gated, and a missing billing client skips the gate (same rule
    // as the destination-queue gate). The gate always uses the admin
    // client, never the route's working client — in production they
    // are the same client, and in tests the working client is a fake
    // that must not answer billing queries. The key is the target
    // copy's external id when one exists, else the account's
    // external id — the same key the insert below writes.
    if (session.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (billingClient) {
        try {
          await assertFeatureAddWithinCap(
            billingClient,
            session.userId,
            'threads',
            [targetRow?.external_destination_id ?? accountRow.external_account_id ?? accountId],
            'schedule',
          );
        } catch (err) {
          const gateResponse = subscriptionGateResponse(err);
          if (gateResponse) return gateResponse;
          throw err;
        }
      } else {
        logServerError('[billing] threads schedule cap gate skipped: no billing client', null, {
          source: 'billing',
        });
      }
    }

    const previousMetadata = ((targetRow?.metadata ?? {}) as Record<string, unknown>);
    const previousTimezone = targetRow?.timezone ?? null;
    const previousStatus = targetRow?.status ?? null;
    const previousSection = targetRow?.section ?? null;
    const nextMetadata: Record<string, unknown> = {
      ...previousMetadata,
      threads_schedule_added_at: new Date().toISOString(),
    };
    delete nextMetadata['threads_schedule_status'];

    // Snapshot pre-existing slots BEFORE any mutation, so a slot
    // failure can restore them exactly — the old code deleted them
    // first and never put them back, and its flag rollback also
    // forgot the destination status it had forced to active.
    let destinationId = targetRow?.id ?? '';
    let destinationCreated = false;
    let previousSlotRows: Array<{
      time_of_day: string;
      is_active: boolean;
      kind: unknown;
    }> = [];
    if (targetRow) {
      const { data: previousSlots, error: previousSlotsError } = await supabase
        .from('posting_slots')
        .select('time_of_day, is_active, kind')
        .eq('destination_id', targetRow.id);
      if (previousSlotsError) throw new Error(previousSlotsError.message);
      previousSlotRows = (previousSlots ?? []) as Array<{
        time_of_day: string;
        is_active: boolean;
        kind: unknown;
      }>;
    }

    // The import IS the section's copy: reactivate the removed stub
    // or adopt the unimported row in place, or insert a fresh
    // schedule copy from the account (the unique key
    // (account, external, section) forbids a second schedule copy).
    // The stub's token was stripped on removal; publishing reads the
    // account token at publish time, so the copy needs no token of
    // its own.
    if (targetRow) {
      const { error: flagError } = await supabase
        .from('destinations')
        .update({
          metadata: nextMetadata,
          timezone,
          status: 'active',
          section: 'schedule',
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetRow.id)
        .eq('workspace_id', workspaceId);
      if (flagError) throw new Error(flagError.message);
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('destinations')
        .insert({
          workspace_id: workspaceId,
          account_id: accountId,
          platform: 'threads',
          section: 'schedule',
          external_destination_id: accountRow.external_account_id ?? accountId,
          name: accountRow.display_name ?? 'Threads account',
          handle: null,
          avatar_url: accountRow.avatar_url ?? null,
          timezone,
          status: 'active',
          metadata: nextMetadata,
        })
        .select('id')
        .single();
      if (insertError || !inserted) {
        throw new Error(insertError?.message ?? 'Destination insert failed');
      }
      destinationId = inserted.id as string;
      destinationCreated = true;
    }

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
      // list — must never survive a slot failure. A freshly
      // inserted copy is deleted again instead of restored.
      try {
        if (destinationCreated) {
          await supabase.from('destinations').delete().eq('id', destinationId);
        } else if (targetRow) {
          await supabase
            .from('destinations')
            .update({
              metadata: previousMetadata,
              timezone: previousTimezone,
              status: previousStatus,
              section: previousSection,
              updated_at: new Date().toISOString(),
            })
            .eq('id', destinationId)
            .eq('workspace_id', workspaceId);
        }
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
      } catch (rollbackError) {
        logServerError('[threads/schedule] add rollback failed', rollbackError, {
          source: 'threads-schedule-add-rollback',
        });
      }
      throw slotError;
    }

    await refreshDestinationUnmatchedFlag(supabase, destinationId);
    const { counts, error: countsError } = await fetchQueueCounts(
      supabase,
      workspaceId,
      destinationId
    );
    const { data: detail, error: detailError } = await supabase
      .from('destinations')
      .select(DESTINATION_COLUMNS)
      .eq('id', destinationId)
      .maybeSingle();
    if (detailError) throw new Error(detailError.message);
    const destRow = (detail ?? {
      id: destinationId,
      account_id: accountId,
      platform: 'threads',
      section: 'schedule',
      external_destination_id: accountRow.external_account_id ?? accountId,
      name: accountRow.display_name ?? 'Threads account',
      handle: null,
      avatar_url: accountRow.avatar_url ?? null,
      timezone,
      status: 'active',
      metadata: nextMetadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }) as ThreadsScheduleDestinationRow;
    const item = toScheduleItem(destRow, accountRow, counts, countsError);
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
