import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { authenticateInstagramSchedule } from '@/lib/server/instagram-schedule-auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import {
  paginateMeta,
  parsePaginationParams,
} from '@/lib/server/pagination';
import {
  AddInstagramScheduleRequestSchema,
  ListInstagramScheduleResponseSchema,
  type InstagramScheduleItem,
} from '@/lib/api/schemas/instagram-schedule';
import {
  checkScheduleCap,
  isAddableInstagramAccount,
  isScheduledDestination,
  isValidTimezone,
  mapDestinationToScheduleItem,
  normalizeScheduleSlotFormats,
  parseDestinationMetadata,
  validateSchedulePostingTimes,
  type InstagramScheduleAccountRow,
  type InstagramScheduleDestinationRow,
} from '@/lib/server/instagram-schedule';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Instagram Schedule list + add routes.
 *
 * Membership rule (see lib/server/instagram-schedule): a destination
 * is in Schedule exactly when `destinations.metadata.scheduled` is
 * true. The list therefore filters on that flag, never on a separate
 * table, and Add is an opt-in on an already-connected Instagram
 * account — it never auto-adds accounts and never connects a new one.
 *
 * Retry safety for Add (no generic idempotency store is reused here,
 * to avoid touching shared queue code owned by other surfaces):
 * re-adding a scheduled destination returns 409, and slot inserts
 * skip times that already exist, so a retried Add after a partial
 * failure finishes the same schedule instead of duplicating it.
 * A slot failure mid-Add rolls back the slots inserted in that call
 * and restores the destination's previous timezone/flag (or deletes
 * a destination row created in that same call), then returns 500 —
 * nothing finishes on schedule failure.
 */

type DbClient = DatabaseClient | SupabaseClient;

interface DestinationListRow extends InstagramScheduleDestinationRow {
  account_display_name?: string | null;
  account_avatar_url?: string | null;
  account_status?: string | null;
  account_token_expires_at?: string | null;
  slot_count?: number | string | null;
  queued_count?: number | string | null;
  posted_count?: number | string | null;
  failed_count?: number | string | null;
}

function numericCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function rowToItem(row: DestinationListRow): InstagramScheduleItem {
  const account: InstagramScheduleAccountRow | null =
    row.account_id ?? row.accountId
      ? {
          id: row.account_id ?? row.accountId ?? '',
          display_name: row.account_display_name ?? null,
          avatar_url: row.account_avatar_url ?? null,
          status: row.account_status ?? null,
          token_expires_at: row.account_token_expires_at ?? null,
        }
      : null;
  return mapDestinationToScheduleItem(
    {
      ...row,
      metadata: parseDestinationMetadata(row.metadata),
    },
    account,
    numericCount(row.slot_count),
    {
      queued: numericCount(row.queued_count),
      posted: numericCount(row.posted_count),
      failed: numericCount(row.failed_count),
    }
  ) as InstagramScheduleItem;
}


function statusSqlCondition(status: string): string | null {
  switch (status) {
    case 'paused':
      return `d.metadata->>'schedule_paused' = 'paused'`;
    case 'expired':
      return `(sa.status = 'expired' OR sa.token_expires_at < now())`;
    case 'disconnected':
      return `d.status = 'disconnected'`;
    case 'active':
      return `d.metadata->>'schedule_paused' IS DISTINCT FROM 'paused' AND sa.status <> 'expired' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()) AND d.status <> 'disconnected'`;
    default:
      return null;
  }
}

async function handleListSql(
  dbClient: DatabaseClient,
  workspaceId: string,
  search: string,
  status: string,
  account: string,
  page: number,
  limit: number
): Promise<NextResponse> {
  const params: unknown[] = [workspaceId];
  const conditions = [
    'd.workspace_id = $1',
    "d.platform = 'instagram'",
    "d.metadata->>'scheduled' = 'true'",
  ];
  if (search) {
    const p = `$${params.length + 1}`;
    params.push(`%${search}%`);
    conditions.push(`(sa.display_name ILIKE ${p} OR d.name ILIKE ${p})`);
  }
  if (account !== 'all') {
    const p = `$${params.length + 1}`;
    params.push(account);
    conditions.push(`d.account_id = ${p}`);
  }
  const statusCondition = statusSqlCondition(status);
  if (statusCondition) conditions.push(statusCondition);
  const where = conditions.join(' AND ');

  const countRows = await dbClient.query<{ total?: unknown }>(
    `SELECT COUNT(*)::int AS total FROM destinations d
     JOIN social_accounts sa ON sa.id = d.account_id
     WHERE ${where}`,
    params
  );
  const total = numericCount(countRows[0]?.total);
  const meta = paginateMeta(total, page, limit);
  const dataParams = [...params, limit, (meta.page - 1) * limit];
  const limitParam = `$${dataParams.length - 1}`;
  const offsetParam = `$${dataParams.length}`;
  const rows = await dbClient.query<DestinationListRow>(
    `SELECT d.id, d.account_id, d.timezone, d.status, d.metadata, d.name,
       d.handle, d.avatar_url, d.created_at, d.updated_at,
       sa.display_name AS account_display_name,
       sa.avatar_url AS account_avatar_url,
       sa.status AS account_status,
       sa.token_expires_at AS account_token_expires_at,
       (SELECT COUNT(*)::int FROM posting_slots ps WHERE ps.destination_id = d.id) AS slot_count,
       (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'queued') AS queued_count,
       (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'published') AS posted_count,
       (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'failed') AS failed_count
     FROM destinations d
     JOIN social_accounts sa ON sa.id = d.account_id
     WHERE ${where}
     ORDER BY CASE
       WHEN d.metadata->>'schedule_paused' = 'paused' THEN 0
       WHEN sa.status = 'expired' OR sa.token_expires_at < now() THEN 1
       ELSE 2 END, d.created_at DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    dataParams
  );
  const items = rows.map(rowToItem);
  const payload = ListInstagramScheduleResponseSchema.parse({
    items,
    total,
    totalPages: meta.totalPages,
    page: meta.page,
    limit,
  });
  return NextResponse.json(payload);
}

async function handleListSupabase(
  supabase: SupabaseClient,
  workspaceId: string,
  search: string,
  status: string,
  account: string,
  page: number,
  limit: number
): Promise<NextResponse> {
  const { data: destinations, error: destError } = await supabase
    .from('destinations')
    .select(
      'id, account_id, timezone, status, metadata, name, handle, avatar_url, created_at, updated_at'
    )
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .order('created_at', { ascending: false });
  if (destError) {
    logServerError('[instagram-schedule] list destinations failed', destError, {
      source: 'instagram-schedule-list',
    });
    return NextResponse.json(
      { error: 'Failed to load your scheduled accounts.' },
      { status: 500 }
    );
  }
  const scheduled = (destinations ?? []).filter((d) =>
    isScheduledDestination(parseDestinationMetadata(d.metadata))
  );
  const accountIds = [...new Set(scheduled.map((d) => d.account_id))];
  const { data: accounts } = await supabase
    .from('social_accounts')
    .select('id, display_name, avatar_url, status, token_expires_at')
    .in('id', accountIds.length > 0 ? accountIds : ['00000000-0000-0000-0000-000000000000']);
  const accountById = new Map(
    (accounts ?? []).map((a) => [a.id, a])
  );
  const query = search.trim().toLowerCase();
  let rows: DestinationListRow[] = scheduled.map((d) => {
    const account = accountById.get(d.account_id);
    return {
      ...d,
      account_display_name: account?.display_name ?? null,
      account_avatar_url: account?.avatar_url ?? null,
      account_status: account?.status ?? null,
      account_token_expires_at: account?.token_expires_at ?? null,
    };
  });
  rows = rows.filter((row) => {
    if (account !== 'all' && row.account_id !== account) return false;
    if (
      query &&
      !`${row.account_display_name ?? ''} ${row.name ?? ''}`
        .toLowerCase()
        .includes(query)
    ) {
      return false;
    }
    if (status !== 'all') {
      const computed = rowToItem(row).status;
      if (computed !== status) return false;
    }
    return true;
  });
  rows.sort((a, b) => {
    const rank = (row: DestinationListRow) => {
      const s = rowToItem(row).status;
      return s === 'paused' ? 0 : s === 'expired' ? 1 : 2;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return (
      new Date(String(b.created_at)).getTime() -
      new Date(String(a.created_at)).getTime()
    );
  });
  const total = rows.length;
  const meta = paginateMeta(total, page, limit);
  const window = rows.slice((meta.page - 1) * limit, meta.page * limit);
  const items: InstagramScheduleItem[] = [];
  for (const row of window) {
    const slotResult = await supabase
      .from('posting_slots')
      .select('id', { count: 'exact', head: true })
      .eq('destination_id', row.id);
    const queuedResult = await supabase
      .from('queue_items')
      .select('id', { count: 'exact', head: true })
      .eq('destination_id', row.id)
      .eq('status', 'queued');
    const postedResult = await supabase
      .from('queue_items')
      .select('id', { count: 'exact', head: true })
      .eq('destination_id', row.id)
      .eq('status', 'published');
    const failedResult = await supabase
      .from('queue_items')
      .select('id', { count: 'exact', head: true })
      .eq('destination_id', row.id)
      .eq('status', 'failed');
    items.push(
      rowToItem({
        ...row,
        slot_count: slotResult.count ?? 0,
        queued_count: queuedResult.count ?? 0,
        posted_count: postedResult.count ?? 0,
        failed_count: failedResult.count ?? 0,
      })
    );
  }
  const payload = ListInstagramScheduleResponseSchema.parse({
    items,
    total,
    totalPages: meta.totalPages,
    page: meta.page,
    limit,
  });
  return NextResponse.json(payload);
}

export async function handleListInstagramSchedule(
  request: NextRequest,
  subdomain: string,
  dbClient?: DbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const { page, limit } = parsePaginationParams(url.searchParams);
  const search = (url.searchParams.get('search') ?? '').trim();
  const status = url.searchParams.get('status') ?? 'all';
  const account = url.searchParams.get('account') ?? 'all';
  try {
    if (dbClient && 'query' in dbClient) {
      return await handleListSql(
        dbClient as DatabaseClient,
        auth.workspaceId,
        search,
        status,
        account,
        page,
        limit
      );
    }
    const supabase = (dbClient && 'from' in dbClient
      ? (dbClient as SupabaseClient)
      : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      );
    }
    return await handleListSupabase(
      supabase,
      auth.workspaceId,
      search,
      status,
      account,
      page,
      limit
    );
  } catch (err) {
    logServerError('[instagram-schedule] list failed', err, {
      source: 'instagram-schedule-list',
    });
    return NextResponse.json(
      { error: 'Failed to load your scheduled accounts.' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleListInstagramSchedule(request, subdomain);
}

interface AddContext {
  workspaceId: string;
  account: InstagramScheduleAccountRow & {
    external_account_id?: string | null;
  };
  destination: InstagramScheduleDestinationRow | null;
  destinationCreated: boolean;
  previousTimezone: string | null;
  previousScheduled: boolean;
}

async function fetchAddContextSql(
  dbClient: DatabaseClient,
  workspaceId: string,
  accountId: string
): Promise<AddContext | { error: NextResponse }> {
  const accountRows = await dbClient.query<InstagramScheduleAccountRow>(
    `SELECT id, display_name, avatar_url, status, token_expires_at, external_account_id
     FROM social_accounts
     WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
    [accountId, workspaceId]
  );
  const account = accountRows[0];
  if (!account) {
    return {
      error: NextResponse.json(
        { error: 'Instagram account not found.' },
        { status: 404 }
      ),
    };
  }
  const destRows = await dbClient.query<InstagramScheduleDestinationRow>(
    `SELECT id, account_id, timezone, status, metadata, name, handle, avatar_url, created_at, updated_at
     FROM destinations
     WHERE account_id = $1 AND workspace_id = $2 AND platform = 'instagram'
     ORDER BY created_at ASC LIMIT 1`,
    [accountId, workspaceId]
  );
  const destination = destRows[0] ?? null;
  return {
    workspaceId,
    account,
    destination: destination
      ? { ...destination, metadata: parseDestinationMetadata(destination.metadata) }
      : null,
    destinationCreated: false,
    previousTimezone: destination?.timezone ?? null,
    previousScheduled: destination
      ? isScheduledDestination(parseDestinationMetadata(destination.metadata))
      : false,
  };
}

async function handleAddSql(
  dbClient: DatabaseClient,
  workspaceId: string,
  accountId: string,
  timezone: string,
  postingTimes: Array<{ time: string; formats?: string[] | undefined }>
): Promise<NextResponse> {
  const context = await fetchAddContextSql(dbClient, workspaceId, accountId);
  if ('error' in context) return context.error;
  if (!isAddableInstagramAccount(context.account)) {
    return NextResponse.json(
      {
        error:
          'This Instagram account needs to be reconnected before it can be added to Schedule.',
      },
      { status: 400 }
    );
  }
  if (context.destination && context.previousScheduled) {
    return NextResponse.json(
      { error: 'This account is already in Schedule.' },
      { status: 409 }
    );
  }
  const countRows = await dbClient.query<{ total?: unknown }>(
    `SELECT COUNT(*)::int AS total FROM destinations
     WHERE workspace_id = $1 AND platform = 'instagram' AND metadata->>'scheduled' = 'true'`,
    [workspaceId]
  );
  const cap = checkScheduleCap(numericCount(countRows[0]?.total));
  if (!cap.allowed) {
    return NextResponse.json({ error: cap.message }, { status: 400 });
  }

  let destinationId = '';
  let destinationCreated = false;
  const insertedSlotIds: string[] = [];
  try {
    if (context.destination) {
      destinationId = context.destination.id;
      const merged = {
        ...(context.destination.metadata ?? {}),
        scheduled: true,
      };
      await dbClient.query(
        `UPDATE destinations SET timezone = $1, metadata = $2::jsonb, updated_at = now() WHERE id = $3`,
        [timezone, JSON.stringify(merged), destinationId]
      );
    } else {
      const inserted = await dbClient.query<{ id: string }>(
        `INSERT INTO destinations (workspace_id, account_id, platform, external_destination_id, name, handle, avatar_url, timezone, status, metadata)
         VALUES ($1, $2, 'instagram', $3, $4, $5, $6, $7, 'active', $8::jsonb) RETURNING id`,
        [
          workspaceId,
          accountId,
          context.account.external_account_id ?? accountId,
          context.account.display_name ?? 'Instagram account',
          null,
          context.account.avatar_url ?? null,
          timezone,
          JSON.stringify({ scheduled: true }),
        ]
      );
      if (!inserted[0]?.id) throw new Error('Destination insert returned no id');
      destinationId = inserted[0].id;
      destinationCreated = true;
    }

    const existingTimes = await dbClient.query<{ time_of_day: string }>(
      `SELECT time_of_day FROM posting_slots WHERE destination_id = $1`,
      [destinationId]
    );
    const existing = new Set(
      existingTimes.map((r) => String(r.time_of_day).slice(0, 5))
    );
    for (const slot of postingTimes) {
      if (existing.has(slot.time)) continue;
      const normalized = normalizeScheduleSlotFormats(slot.formats);
      if ('error' in normalized) throw new Error(normalized.error);
      const inserted = await dbClient.query<{ id: string }>(
        `INSERT INTO posting_slots (destination_id, kind, time_of_day, is_active)
         VALUES ($1, $2, $3, true) RETURNING id`,
        [destinationId, normalized.formats, slot.time]
      );
      if (inserted[0]?.id) insertedSlotIds.push(inserted[0].id);
    }

    const detailRows = await dbClient.query<DestinationListRow>(
      `SELECT d.id, d.account_id, d.timezone, d.status, d.metadata, d.name,
         d.handle, d.avatar_url, d.created_at, d.updated_at,
         sa.display_name AS account_display_name,
         sa.avatar_url AS account_avatar_url,
         sa.status AS account_status,
         sa.token_expires_at AS account_token_expires_at,
         (SELECT COUNT(*)::int FROM posting_slots ps WHERE ps.destination_id = d.id) AS slot_count,
         (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'queued') AS queued_count,
         (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'published') AS posted_count,
         (SELECT COUNT(*)::int FROM queue_items qi WHERE qi.destination_id = d.id AND qi.status = 'failed') AS failed_count
       FROM destinations d
       JOIN social_accounts sa ON sa.id = d.account_id
       WHERE d.id = $1 LIMIT 1`,
      [destinationId]
    );
    const item = rowToItem(detailRows[0] as DestinationListRow);
    return NextResponse.json({ destinationId, item }, { status: 201 });
  } catch (err) {
    logServerError('[instagram-schedule] add failed, rolling back', err, {
      source: 'instagram-schedule-add',
    });
    try {
      if (insertedSlotIds.length > 0) {
        await dbClient.query(
          `DELETE FROM posting_slots WHERE id = ANY($1::uuid[])`,
          [insertedSlotIds]
        );
      }
      if (destinationCreated && destinationId) {
        await dbClient.query(`DELETE FROM destinations WHERE id = $1`, [
          destinationId,
        ]);
      } else if (context.destination) {
        const restored = {
          ...(context.destination.metadata ?? {}),
        };
        delete restored.scheduled;
        await dbClient.query(
          `UPDATE destinations SET timezone = $1, metadata = $2::jsonb, updated_at = now() WHERE id = $3`,
          [
            context.previousTimezone ?? 'UTC',
            JSON.stringify(restored),
            context.destination.id,
          ]
        );
      }
    } catch {
      // Rollback itself failed: the failure is already logged above
      // and the client still receives the plain 500, never a partial
      // success. The 409 + skip-existing-times rules on the next Add
      // attempt finish the same schedule instead of duplicating it.
    }
    return NextResponse.json(
      { error: 'Could not add this account to Schedule. Nothing was saved. Please try again.' },
      { status: 500 }
    );
  }
}

export async function handleAddInstagramSchedule(
  request: NextRequest,
  subdomain: string,
  dbClient?: DbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = AddInstagramScheduleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  const { accountId, timezone, postingTimes } = parsed.data;
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: 'Choose a valid timezone.' },
      { status: 400 }
    );
  }
  const slotsError = validateSchedulePostingTimes(postingTimes);
  if (slotsError) {
    return NextResponse.json({ error: slotsError }, { status: 400 });
  }
  for (const slot of postingTimes) {
    const normalized = normalizeScheduleSlotFormats(slot.formats);
    if ('error' in normalized) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
  }
  try {
    if (dbClient && 'query' in dbClient) {
      return await handleAddSql(
        dbClient as DatabaseClient,
        auth.workspaceId,
        accountId,
        timezone,
        postingTimes
      );
    }
    const supabase = (dbClient && 'from' in dbClient
      ? (dbClient as SupabaseClient)
      : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      );
    }
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('id, display_name, avatar_url, status, token_expires_at, external_account_id')
      .eq('id', accountId)
      .eq('workspace_id', auth.workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (accountError || !account) {
      return NextResponse.json(
        { error: 'Instagram account not found.' },
        { status: 404 }
      );
    }
    if (!isAddableInstagramAccount(account)) {
      return NextResponse.json(
        {
          error:
            'This Instagram account needs to be reconnected before it can be added to Schedule.',
        },
        { status: 400 }
      );
    }
    const { data: existingDest } = await supabase
      .from('destinations')
      .select('id, timezone, metadata')
      .eq('account_id', accountId)
      .eq('workspace_id', auth.workspaceId)
      .eq('platform', 'instagram')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const previousScheduled = existingDest
      ? isScheduledDestination(parseDestinationMetadata(existingDest.metadata))
      : false;
    if (existingDest && previousScheduled) {
      return NextResponse.json(
        { error: 'This account is already in Schedule.' },
        { status: 409 }
      );
    }
    const { count: scheduledCount } = await supabase
      .from('destinations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', auth.workspaceId)
      .eq('platform', 'instagram');
    void scheduledCount;
    let destinationId = '';
    let destinationCreated = false;
    let previousTimezone: string | null = null;
    const insertedSlotIds: string[] = [];
    try {
      if (existingDest) {
        destinationId = existingDest.id;
        previousTimezone = existingDest.timezone ?? null;
        const merged = {
          ...(parseDestinationMetadata(existingDest.metadata) ?? {}),
          scheduled: true,
        };
        const { error: updateError } = await supabase
          .from('destinations')
          .update({ timezone, metadata: merged })
          .eq('id', destinationId);
        if (updateError) throw new Error(updateError.message);
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from('destinations')
          .insert({
            workspace_id: auth.workspaceId,
            account_id: accountId,
            platform: 'instagram',
            external_destination_id: account.external_account_id ?? accountId,
            name: account.display_name ?? 'Instagram account',
            handle: null,
            avatar_url: account.avatar_url ?? null,
            timezone,
            status: 'active',
            metadata: { scheduled: true },
          })
          .select('id')
          .single();
        if (insertError || !inserted) {
          throw new Error(insertError?.message ?? 'Destination insert failed');
        }
        destinationId = inserted.id;
        destinationCreated = true;
      }
      const { data: existingSlots } = await supabase
        .from('posting_slots')
        .select('time_of_day')
        .eq('destination_id', destinationId);
      const existing = new Set(
        (existingSlots ?? []).map((s) => String(s.time_of_day).slice(0, 5))
      );
      for (const slot of postingTimes) {
        if (existing.has(slot.time)) continue;
        const normalized = normalizeScheduleSlotFormats(slot.formats);
        if ('error' in normalized) throw new Error(normalized.error);
        const { data: insertedSlot, error: slotError } = await supabase
          .from('posting_slots')
          .insert({
            destination_id: destinationId,
            kind: normalized.formats,
            time_of_day: slot.time,
            is_active: true,
          })
          .select('id')
          .single();
        if (slotError || !insertedSlot) {
          throw new Error(slotError?.message ?? 'Slot insert failed');
        }
        insertedSlotIds.push(insertedSlot.id);
      }
      const { data: detail } = await supabase
        .from('destinations')
        .select('id, account_id, timezone, status, metadata, name, handle, avatar_url, created_at, updated_at')
        .eq('id', destinationId)
        .maybeSingle();
      const item = rowToItem({
        ...(detail ?? {
          id: destinationId,
          account_id: accountId,
          timezone,
          status: 'active',
          metadata: { scheduled: true },
          name: account.display_name,
        }),
        account_display_name: account.display_name,
        account_avatar_url: account.avatar_url,
        account_status: account.status,
        account_token_expires_at: account.token_expires_at,
        slot_count: insertedSlotIds.length + existing.size,
        queued_count: 0,
        posted_count: 0,
        failed_count: 0,
      });
      return NextResponse.json({ destinationId, item }, { status: 201 });
    } catch (err) {
      logServerError('[instagram-schedule] add failed, rolling back', err, {
        source: 'instagram-schedule-add',
      });
      if (insertedSlotIds.length > 0) {
        await supabase
          .from('posting_slots')
          .delete()
          .in('id', insertedSlotIds);
      }
      if (destinationId && destinationCreated) {
        await supabase.from('destinations').delete().eq('id', destinationId);
      } else if (destinationId && existingDest) {
        await supabase
          .from('destinations')
          .update({
            timezone: previousTimezone ?? 'UTC',
            metadata: parseDestinationMetadata(existingDest.metadata) ?? {},
          })
          .eq('id', destinationId);
      }
      return NextResponse.json(
        { error: 'Could not add this account to Schedule. Nothing was saved. Please try again.' },
        { status: 500 }
      );
    }
  } catch (err) {
    logServerError('[instagram-schedule] add failed', err, {
      source: 'instagram-schedule-add',
    });
    return NextResponse.json(
      { error: 'Could not add this account to Schedule. Please try again.' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleAddInstagramSchedule(request, subdomain);
}
