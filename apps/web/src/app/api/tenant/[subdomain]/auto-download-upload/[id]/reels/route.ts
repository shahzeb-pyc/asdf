import { type NextRequest, NextResponse } from 'next/server';
import { aduContext } from '@/lib/server/adu';

/**
 * Reels queue.
 *
 * GET: downloaded-only queue, newest first (the old Reels tab).
 * There is NO 'download' action in the web app: downloading is the
 * VPS downloader service (apps/adu-downloader), which claims pending
 * reels itself, downloads via yt-dlp + aria2, and copies them to the
 * R2 buffer. The old webapp never downloaded in-request either.
 * (Spec 179 removed the Discover reels button and with it the only
 * caller of the old POST { action: 'discover' } re-queue, so the
 * POST handler is gone too — the IG/Threads reels routes keep
 * theirs, their detail pages still use them.)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const { data: config } = await supabase
    .from('adu_configs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (!config) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  const view = request.nextUrl.searchParams.get('view') ?? 'queue';
  const status = view === 'posted' ? 'posted' : 'downloaded';
  // Paginated (adu-opt-c F15): 24 rows per page with a server-side
  // count, so a queue past 500 is reachable by paging instead of
  // silently truncating at the newest 500. No `page` param = page 1.
  // Only the columns the Reels tab renders — never `select('*')`.
  const REELS_PAGE_SIZE = 24;
  const rawPage = Number(request.nextUrl.searchParams.get('page') ?? '1');
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const from = (page - 1) * REELS_PAGE_SIZE;
  const to = from + REELS_PAGE_SIZE - 1;
  const { data, error, count } = await supabase
    .from('adu_reels')
    .select('id, source_reel_id, caption, media_url, downloaded_at, status', {
      count: 'exact',
    })
    .eq('config_id', id)
    .eq('status', status)
    .order('downloaded_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const total = count ?? 0;
  return NextResponse.json({
    reels: data ?? [],
    page,
    pageSize: REELS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / REELS_PAGE_SIZE)),
  });
}
