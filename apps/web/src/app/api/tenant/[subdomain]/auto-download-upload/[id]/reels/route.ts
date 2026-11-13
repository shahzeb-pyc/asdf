import { type NextRequest, NextResponse } from 'next/server';
import { aduContext } from '@/lib/server/adu';

/**
 * Reels queue.
 *
 * GET: downloaded-only queue, newest first (the old Reels tab).
 * POST { action: 'discover' }: re-queues the config for discovery by
 *   the VPS scraper service (sync_status -> 'pending'). Discovery
 *   itself does NOT run in the web app — it lives in apps/adu-scraper
 *   (yt-dlp + Puppeteer), exactly like the old fbuploadpro, and the
 *   scraper claims pending configs on its own loop. If the scraper
 *   is not running, the config stays 'pending' ("Scrape pending").
 * There is NO 'download' action in the web app: downloading is the
 * VPS downloader service (apps/adu-downloader), which claims pending
 * reels itself, downloads via yt-dlp + aria2, and copies them to the
 * R2 buffer. The old webapp never downloaded in-request either.
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const body = await request.json().catch(() => ({}));
  const action = (body as { action?: string }).action;

  const { data: config, error: configError } = await supabase
    .from('adu_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (configError || !config) {
    return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  }

  if (action === 'discover') {
    // Re-queue only. The scraper service claims this config on its
    // next loop; nothing is discovered in this request.
    const { error: updateError } = await supabase
      .from('adu_configs')
      .update({ sync_status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    return NextResponse.json({
      queued: true,
      message: 'Discovery queued. The scraper service picks up this page on its next run.',
    });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
