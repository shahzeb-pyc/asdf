import { type NextRequest, NextResponse } from 'next/server';
import { type DatabaseClient } from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import {
  authenticateInstagramSchedule,
  type InstagramScheduleDbClient,
} from '@/lib/server/instagram-schedule-auth';
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
        metadata: unknown;
      }>(
        `SELECT metadata FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
        [destinationId, auth.workspaceId]
      );
      const metadata = destRows[0]?.metadata;
      const scheduled =
        typeof metadata === 'object' &&
        metadata !== null &&
        (metadata as Record<string, unknown>).scheduled === true;
      if (!scheduled) {
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
      .select('metadata')
      .eq('id', destinationId)
      .eq('workspace_id', auth.workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    const scheduled =
      typeof dest?.metadata === 'object' &&
      dest?.metadata !== null &&
      (dest.metadata as Record<string, unknown>).scheduled === true;
    if (!scheduled) {
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
