import { type NextRequest, NextResponse } from 'next/server';
import {
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import {
  InstagramScheduleDetailResponseSchema,
  UpdateInstagramScheduleRequestSchema,
} from '@/lib/api/schemas/instagram-schedule';
import {
  isScheduledDestination,
  mapDestinationToScheduleItem,
  parseDestinationMetadata,
} from '@/lib/server/instagram-schedule';
import {
  authenticateInstagramSchedule,
  type InstagramScheduleDbClient,
} from '@/lib/server/instagram-schedule-auth';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Instagram Schedule detail routes.
 *
 * GET returns the scheduled destination or 404 — a destination that
 * is not in Schedule (flag absent) is not a Schedule detail, even
 * though the destination row itself exists for Accounts/Publish Now.
 *
 * PATCH toggles Pause/Resume only. Timezone changes live on the
 * slots route, mirroring Pages.
 *
 * DELETE is Remove from Schedule: it deletes the destination's
 * posting times, clears the scheduled flag, and cancels queued posts
 * (they must not publish after removal). It never deletes the
 * destination row, the connected account, or published/failed history.
 */

interface DetailRow {
  id: string;
  account_id: string;
  timezone: string | null;
  status: string | null;
  metadata: unknown;
  name: string | null;
  handle: string | null;
  avatar_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  account_display_name: string | null;
  account_avatar_url: string | null;
  account_status: string | null;
  account_token_expires_at: string | null;
  slot_count: number | string | null;
  queued_count: number | string | null;
  posted_count: number | string | null;
  failed_count: number | string | null;
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function fetchDetailSql(
  dbClient: DatabaseClient,
  workspaceId: string,
  destinationId: string
): Promise<DetailRow | null> {
  const rows = await dbClient.query<DetailRow>(
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
     WHERE d.id = $1 AND d.workspace_id = $2 AND d.platform = 'instagram' LIMIT 1`,
    [destinationId, workspaceId]
  );
  return rows[0] ?? null;
}

function detailRowToResponse(row: DetailRow) {
  const item = mapDestinationToScheduleItem(
    { ...row, metadata: parseDestinationMetadata(row.metadata) },
    {
      id: row.account_id,
      display_name: row.account_display_name,
      avatar_url: row.account_avatar_url,
      status: row.account_status,
      token_expires_at: row.account_token_expires_at,
    },
    numeric(row.slot_count),
    {
      queued: numeric(row.queued_count),
      posted: numeric(row.posted_count),
      failed: numeric(row.failed_count),
    }
  );
  return InstagramScheduleDetailResponseSchema.parse({ item });
}

async function fetchDetailSupabase(
  supabase: SupabaseClient,
  workspaceId: string,
  destinationId: string
): Promise<DetailRow | null> {
  const { data: dest, error } = await supabase
    .from('destinations')
    .select(
      'id, account_id, timezone, status, metadata, name, handle, avatar_url, created_at, updated_at'
    )
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .maybeSingle();
  if (error || !dest) return null;
  const { data: account } = await supabase
    .from('social_accounts')
    .select('display_name, avatar_url, status, token_expires_at')
    .eq('id', dest.account_id)
    .maybeSingle();
  const slotCount = await supabase
    .from('posting_slots')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', destinationId);
  const queued = await supabase
    .from('queue_items')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', destinationId)
    .eq('status', 'queued');
  const posted = await supabase
    .from('queue_items')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', destinationId)
    .eq('status', 'published');
  const failed = await supabase
    .from('queue_items')
    .select('id', { count: 'exact', head: true })
    .eq('destination_id', destinationId)
    .eq('status', 'failed');
  return {
    ...dest,
    account_display_name: account?.display_name ?? null,
    account_avatar_url: account?.avatar_url ?? null,
    account_status: account?.status ?? null,
    account_token_expires_at: account?.token_expires_at ?? null,
    slot_count: slotCount.count ?? 0,
    queued_count: queued.count ?? 0,
    posted_count: posted.count ?? 0,
    failed_count: failed.count ?? 0,
  };
}

async function loadDetail(
  dbClient: InstagramScheduleDbClient | undefined,
  workspaceId: string,
  destinationId: string
): Promise<DetailRow | null> {
  if (dbClient && 'query' in dbClient) {
    return fetchDetailSql(dbClient as DatabaseClient, workspaceId, destinationId);
  }
  const supabase = (dbClient && 'from' in dbClient
    ? (dbClient as SupabaseClient)
    : getSupabaseAdminClient()) as SupabaseClient | null;
  if (!supabase) return null;
  return fetchDetailSupabase(supabase, workspaceId, destinationId);
}

function requireScheduled(row: DetailRow | null): row is DetailRow {
  return row !== null && isScheduledDestination(parseDestinationMetadata(row.metadata));
}

export async function handleGetInstagramScheduleDetail(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  try {
    const row = await loadDetail(dbClient, auth.workspaceId, destinationId);
    if (!requireScheduled(row)) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    return NextResponse.json(detailRowToResponse(row));
  } catch (err) {
    logServerError('[instagram-schedule] detail failed', err, {
      source: 'instagram-schedule-detail',
    });
    return NextResponse.json(
      { error: 'Failed to load this scheduled account.' },
      { status: 500 }
    );
  }
}

export async function handleUpdateInstagramSchedule(
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
  const parsed = UpdateInstagramScheduleRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  try {
    const row = await loadDetail(dbClient, auth.workspaceId, destinationId);
    if (!requireScheduled(row)) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    const metadata = parseDestinationMetadata(row.metadata) ?? {};
    if (parsed.data.paused) {
      metadata.schedule_paused = 'paused';
    } else {
      delete metadata.schedule_paused;
    }
    const nextStatus = parsed.data.paused ? 'disconnected' : 'active';
    if (dbClient && 'query' in dbClient) {
      await (dbClient as DatabaseClient).query(
        `UPDATE destinations SET status = $1, metadata = $2::jsonb, updated_at = now() WHERE id = $3 AND workspace_id = $4`,
        [nextStatus, JSON.stringify(metadata), destinationId, auth.workspaceId]
      );
    } else {
      const supabase = (dbClient && 'from' in dbClient
        ? (dbClient as SupabaseClient)
        : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) {
        return NextResponse.json(
          { error: 'Database service unavailable' },
          { status: 500 }
        );
      }
      const { error } = await supabase
        .from('destinations')
        .update({ status: nextStatus, metadata })
        .eq('id', destinationId)
        .eq('workspace_id', auth.workspaceId);
      if (error) throw new Error(error.message);
    }
    const updated = await loadDetail(dbClient, auth.workspaceId, destinationId);
    if (!updated) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    return NextResponse.json(detailRowToResponse(updated));
  } catch (err) {
    logServerError('[instagram-schedule] pause/resume failed', err, {
      source: 'instagram-schedule-detail',
    });
    return NextResponse.json(
      { error: 'Could not update this scheduled account. Please try again.' },
      { status: 500 }
    );
  }
}

export async function handleDeleteInstagramSchedule(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  try {
    const row = await loadDetail(dbClient, auth.workspaceId, destinationId);
    if (!requireScheduled(row)) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    const metadata = parseDestinationMetadata(row.metadata) ?? {};
    delete metadata.scheduled;
    delete metadata.schedule_paused;
    if (dbClient && 'query' in dbClient) {
      const sql = dbClient as DatabaseClient;
      await sql.query(`DELETE FROM posting_slots WHERE destination_id = $1`, [
        destinationId,
      ]);
      await sql.query(
        `UPDATE queue_items SET status = 'cancelled', updated_at = now() WHERE destination_id = $1 AND status = 'queued'`,
        [destinationId]
      );
      await sql.query(
        `UPDATE destinations SET status = 'active', metadata = $1::jsonb, updated_at = now() WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify(metadata), destinationId, auth.workspaceId]
      );
    } else {
      const supabase = (dbClient && 'from' in dbClient
        ? (dbClient as SupabaseClient)
        : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) {
        return NextResponse.json(
          { error: 'Database service unavailable' },
          { status: 500 }
        );
      }
      await supabase
        .from('posting_slots')
        .delete()
        .eq('destination_id', destinationId);
      await supabase
        .from('queue_items')
        .update({ status: 'cancelled' })
        .eq('destination_id', destinationId)
        .eq('status', 'queued');
      const { error } = await supabase
        .from('destinations')
        .update({ status: 'active', metadata })
        .eq('id', destinationId)
        .eq('workspace_id', auth.workspaceId);
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ removed: true });
  } catch (err) {
    logServerError('[instagram-schedule] remove failed', err, {
      source: 'instagram-schedule-detail',
    });
    return NextResponse.json(
      { error: 'Could not remove this account from Schedule. Please try again.' },
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
  return handleGetInstagramScheduleDetail(request, subdomain, destinationId);
}

export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleUpdateInstagramSchedule(request, subdomain, destinationId);
}

export async function DELETE(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ subdomain: string; destinationId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await params;
  return handleDeleteInstagramSchedule(request, subdomain, destinationId);
}
