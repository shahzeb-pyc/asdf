import { type NextRequest, NextResponse } from 'next/server';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { isThreadsScheduleAdded } from '@/lib/server/threads-schedule';

/**
 * GET derived insights for one Threads Schedule destination.
 *
 * Derived from queue_items only: posted/failed by kind and totals.
 * No live Threads insights are reported — the connect scopes are
 * threads_basic + threads_content_publish, so no follower or reach
 * numbers exist, and none are invented here.
 */
const KINDS = ['text', 'image', 'video', 'carousel'] as const;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string }> }
) {
  const { subdomain, scheduleId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  try {
    const { data: destination, error: destError } = await supabase
      .from('destinations')
      .select('metadata')
      .eq('id', scheduleId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (destError) throw new Error(destError.message);
    if (!destination || !isThreadsScheduleAdded((destination as { metadata: Record<string, unknown> | null }).metadata)) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const countFor = async (status: string, kind?: string): Promise<number> => {
      let query = supabase
        .from('queue_items')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('destination_id', scheduleId)
        .eq('status', status);
      if (kind) query = query.eq('kind', kind);
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return count ?? 0;
    };
    const [posted, failed, queued] = await Promise.all([
      countFor('published'),
      countFor('failed'),
      countFor('queued'),
    ]);
    const byKind = [];
    for (const kind of KINDS) {
      const [kindPosted, kindFailed] = await Promise.all([
        countFor('published', kind),
        countFor('failed', kind),
      ]);
      byKind.push({ kind, posted: kindPosted, failed: kindFailed });
    }
    return NextResponse.json({ totals: { posted, failed, queued }, byKind });
  } catch (err) {
    logServerError('[threads/schedule] insights failed', err, {
      source: 'threads-schedule-insights',
    });
    return NextResponse.json({ error: 'Failed to load insights' }, { status: 500 });
  }
}
