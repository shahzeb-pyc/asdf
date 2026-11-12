import { type NextRequest, NextResponse } from 'next/server';
import { type DatabaseClient } from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import {
  authenticateInstagramSchedule,
  type InstagramScheduleDbClient,
} from '@/lib/server/instagram-schedule-auth';
import {
  isScheduleListMember,
  parseDestinationMetadata,
} from '@/lib/server/instagram-schedule';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Deletes one posting time from a scheduled Instagram destination. */

export async function handleDeleteInstagramScheduleSlot(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  slotId: string,
  dbClient?: InstagramScheduleDbClient
): Promise<NextResponse> {
  const auth = await authenticateInstagramSchedule(request, subdomain, dbClient);
  if ('error' in auth) return auth.error;
  try {
    if (dbClient && 'query' in dbClient) {
      const destRows = await (dbClient as DatabaseClient).query<{
        section: unknown;
        status: unknown;
        metadata: unknown;
      }>(
        `SELECT section, status, metadata FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' AND section = 'schedule' LIMIT 1`,
        [destinationId, auth.workspaceId]
      );
      if (
        !destRows[0] ||
        !isScheduleListMember({
          section: typeof destRows[0].section === 'string' ? destRows[0].section : null,
          status: typeof destRows[0].status === 'string' ? destRows[0].status : null,
          metadata: parseDestinationMetadata(destRows[0].metadata),
        })
      ) {
        return NextResponse.json(
          { error: 'Scheduled account not found.' },
          { status: 404 }
        );
      }
      const deleted = await (dbClient as DatabaseClient).query<{ id: string }>(
        `DELETE FROM posting_slots WHERE id = $1 AND destination_id = $2 RETURNING id`,
        [slotId, destinationId]
      );
      if (!deleted[0]) {
        return NextResponse.json(
          { error: 'Posting time not found.' },
          { status: 404 }
        );
      }
      return NextResponse.json({ deleted: true });
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
    const { data: dest } = await supabase
      .from('destinations')
      .select('section, status, metadata')
      .eq('id', destinationId)
      .eq('workspace_id', auth.workspaceId)
      .eq('platform', 'instagram')
      .eq('section', 'schedule')
      .maybeSingle();
    if (
      !dest ||
      !isScheduleListMember({
        section: dest.section as string | null,
        status: dest.status as string | null,
        metadata: parseDestinationMetadata(dest.metadata),
      })
    ) {
      return NextResponse.json(
        { error: 'Scheduled account not found.' },
        { status: 404 }
      );
    }
    const { data: deleted, error } = await supabase
      .from('posting_slots')
      .delete()
      .eq('id', slotId)
      .eq('destination_id', destinationId)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!deleted) {
      return NextResponse.json(
        { error: 'Posting time not found.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ deleted: true });
  } catch (err) {
    logServerError('[instagram-schedule] slot delete failed', err, {
      source: 'instagram-schedule-slots',
    });
    return NextResponse.json(
      { error: 'Could not delete this posting time. Please try again.' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ subdomain: string; destinationId: string; slotId: string }>;
  }
): Promise<NextResponse> {
  const { subdomain, destinationId, slotId } = await params;
  return handleDeleteInstagramScheduleSlot(
    request,
    subdomain,
    destinationId,
    slotId
  );
}
