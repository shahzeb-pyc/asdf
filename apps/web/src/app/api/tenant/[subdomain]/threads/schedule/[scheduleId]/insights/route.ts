import { type NextRequest, NextResponse } from 'next/server';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { isThreadsScheduleAdded } from '@/lib/server/threads-schedule';

/**
 * GET derived insights for one Threads Schedule destination.
 *
 * Totals and byKind come from queue_items; byDay comes from
 * publish_logs as attempt-level success/failure counts per UTC day
 * over the last 14 days, via bounded head-count queries only (no row
 * downloads, so PostgREST's 1,000-row cap cannot silently truncate).
 * The destination row is workspace-owned, so destination_id scoping
 * on publish_logs (which has no workspace column) is tenant-safe.
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
    const countLogForDay = async (
      result: 'success' | 'failure',
      dayStart: string,
      dayEnd: string
    ): Promise<number> => {
      const { count, error } = await supabase
        .from('publish_logs')
        .select('id', { count: 'exact', head: true })
        .eq('destination_id', scheduleId)
        .eq('platform', 'threads')
        .eq('result', result)
        .gte('created_at', dayStart)
        .lt('created_at', dayEnd);
      if (error) throw new Error(error.message);
      return count ?? 0;
    };
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const dayStarts: Date[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(todayUtc);
      day.setUTCDate(day.getUTCDate() - i);
      dayStarts.push(day);
    }
    const byDay = await Promise.all(
      dayStarts.map(async (day) => {
        const next = new Date(day);
        next.setUTCDate(next.getUTCDate() + 1);
        const [dayPosted, dayFailed] = await Promise.all([
          countLogForDay('success', day.toISOString(), next.toISOString()),
          countLogForDay('failure', day.toISOString(), next.toISOString()),
        ]);
        return {
          date: day.toISOString().slice(0, 10),
          posted: dayPosted,
          failed: dayFailed,
        };
      })
    );
    return NextResponse.json({ totals: { posted, failed, queued }, byKind, byDay });
  } catch (err) {
    logServerError('[threads/schedule] insights failed', err, {
      source: 'threads-schedule-insights',
    });
    return NextResponse.json({ error: 'Failed to load insights' }, { status: 500 });
  }
}
