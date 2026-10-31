import { type NextRequest, NextResponse } from 'next/server';
import { loadThreadsAduDestination, threadsAduContext } from '@/lib/server/threads-adu';

async function ownedReel(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  workspaceId: string,
  configId: string,
  reelId: string
) {
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, configId);
  if (!scoped) return null;
  const { data: reel } = await supabase
    .from('adu_reels')
    .select('*')
    .eq('config_id', configId)
    .eq('id', reelId)
    .maybeSingle();
  return reel;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string; reelId: string }> }
) {
  const { subdomain, id, reelId } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const reel = await ownedReel(supabase, workspaceId, id, reelId);
  if (!reel) return NextResponse.json({ error: 'Reel not found.' }, { status: 404 });
  if (reel.status !== 'downloaded') {
    return NextResponse.json(
      { error: 'Captions can only be edited while a reel is downloaded.' },
      { status: 400 }
    );
  }
  const body = await request.json().catch(() => null);
  const caption = typeof (body as { caption?: unknown })?.caption === 'string'
    ? ((body as { caption: string }).caption as string)
    : null;
  if (caption === null) {
    return NextResponse.json({ error: 'Enter a caption.' }, { status: 400 });
  }
  const { error } = await supabase
    .from('adu_reels')
    .update({ caption })
    .eq('id', reelId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ updated: true });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string; reelId: string }> }
) {
  const { subdomain, id, reelId } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const reel = await ownedReel(supabase, workspaceId, id, reelId);
  if (!reel) return NextResponse.json({ error: 'Reel not found.' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  if ((body as { action?: string }).action !== 'skip') {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  }
  const { error } = await supabase
    .from('adu_reels')
    .update({ status: 'skipped' })
    .eq('id', reelId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ skipped: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string; reelId: string }> }
) {
  const { subdomain, id, reelId } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const reel = await ownedReel(supabase, workspaceId, id, reelId);
  if (!reel) return NextResponse.json({ error: 'Reel not found.' }, { status: 404 });
  const { error } = await supabase.from('adu_reels').delete().eq('id', reelId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
