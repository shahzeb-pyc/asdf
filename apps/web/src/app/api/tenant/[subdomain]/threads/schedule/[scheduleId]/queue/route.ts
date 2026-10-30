import { type NextRequest, NextResponse } from 'next/server';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { isThreadsScheduleAdded } from '@/lib/server/threads-schedule';
import { paginateMeta, parsePaginationParams } from '@/lib/server/pagination';

/**
 * GET queue items for one Threads Schedule destination, bounded,
 * with per-status counts from head/count queries. Media comes from
 * the media_items join (single row, never a second unbounded read).
 * Kinds outside Threads' set (story, legacy formats) are filtered
 * out of the response rather than shown as a post type the composer
 * cannot create — they cannot be created through this surface, and
 * a stray legacy row must not break the list.
 */
const THREADS_KINDS = new Set(['text', 'image', 'video', 'carousel']);
const QUEUE_STATUSES = ['queued', 'publishing', 'published', 'failed', 'cancelled'] as const;

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string }> }
) {
  const { subdomain, scheduleId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  const url = new URL(request.url);
  const { page, limit } = parsePaginationParams(url.searchParams);
  const statusFilter = url.searchParams.get('status') ?? 'all';
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
    const counts: Record<string, number> = {
      queued: 0,
      publishing: 0,
      published: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const status of QUEUE_STATUSES) {
      const { count, error } = await supabase
        .from('queue_items')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('destination_id', scheduleId)
        .eq('status', status);
      if (error) throw new Error(error.message);
      counts[status] = count ?? 0;
    }
    let query = supabase
      .from('queue_items')
      .select(
        'id, kind, caption, scheduled_time, status, error_message, external_post_id, created_at, updated_at, media:media_items(name, thumbnail_url)',
        { count: 'exact' }
      )
      .eq('workspace_id', workspaceId)
      .eq('destination_id', scheduleId)
      .order('created_at', { ascending: true });
    if (statusFilter !== 'all' && (QUEUE_STATUSES as readonly string[]).includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    }
    const totalForPage =
      statusFilter !== 'all' && (QUEUE_STATUSES as readonly string[]).includes(statusFilter)
        ? counts[statusFilter] ?? 0
        : Object.values(counts).reduce((sum, value) => sum + value, 0);
    const meta = paginateMeta(totalForPage, page, limit);
    const offset = meta.start === 0 ? 0 : meta.start - 1;
    const { data, error } = await query.range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    const items = (data ?? [])
      .filter((row) => THREADS_KINDS.has(String((row as { kind: unknown }).kind)))
      .map((row) => {
        const typed = row as {
          id: string;
          kind: string;
          caption: string;
          scheduled_time: string | null;
          status: string;
          error_message: string | null;
          external_post_id: string | null;
          created_at: string;
          updated_at: string;
          media: { name: string; thumbnail_url: string | null } | null;
        };
        return {
          id: typed.id,
          kind: typed.kind,
          caption: typed.caption ?? '',
          mediaName: typed.media?.name ?? null,
          mediaThumbnailUrl: typed.media?.thumbnail_url ?? null,
          scheduledTime: typed.scheduled_time ? new Date(typed.scheduled_time).toISOString() : null,
          status: typed.status,
          errorMessage: typed.error_message,
          externalPostId: typed.external_post_id,
          createdAt: new Date(typed.created_at).toISOString(),
          updatedAt: new Date(typed.updated_at).toISOString(),
        };
      });
    return NextResponse.json({
      items,
      total: meta.total,
      page: meta.page,
      limit: meta.limit,
      totalPages: meta.totalPages,
      counts,
    });
  } catch (err) {
    logServerError('[threads/schedule] queue failed', err, { source: 'threads-schedule-queue' });
    return NextResponse.json({ error: 'Failed to load the queue' }, { status: 500 });
  }
}
