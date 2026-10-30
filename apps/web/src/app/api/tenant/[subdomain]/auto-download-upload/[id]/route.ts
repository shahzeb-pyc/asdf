import { type NextRequest, NextResponse } from 'next/server';
import {
  AduUpdateConfigSchema,
  generateDailyRandomTimes,
  sanitizeSourceIdentity,
} from '@fbuploadpro/contracts';
import { aduContext, loadAduConfigView } from '@/lib/server/adu';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const view = await loadAduConfigView(resolved.context.supabase, resolved.context.workspaceId, id);
  if (!view) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  return NextResponse.json({ config: view });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const body = await request.json().catch(() => null);
  const parsed = AduUpdateConfigSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.status) update.status = parsed.data.status;
  if (parsed.data.timezone) update.timezone = parsed.data.timezone;
  if (parsed.data.displayName !== undefined) update.display_name = parsed.data.displayName;
  if (parsed.data.sourcePlatform || parsed.data.sourceUsername) {
    const { data: current } = await supabase
      .from('adu_configs')
      .select('source_platform, source_username')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
    const platform = parsed.data.sourcePlatform ?? (current.source_platform as 'instagram' | 'youtube' | 'tiktok' | 'facebook');
    const username = parsed.data.sourceUsername
      ? sanitizeSourceIdentity(platform, parsed.data.sourceUsername)
      : (current.source_username as string);
    if (!username) return NextResponse.json({ error: 'Enter a source username.' }, { status: 400 });
    update.source_platform = platform;
    update.source_username = username;
    // Changing the source re-syncs the queue: pending/downloaded reels
    // from the old source are removed, and discovery runs again.
    update.sync_status = 'pending';
    await supabase.from('adu_reels').delete().eq('config_id', id).in('status', ['pending', 'processing', 'downloaded']);
  }
  let postsPerDay = parsed.data.postsPerDay;
  let scheduleType = parsed.data.scheduleType;
  if (postsPerDay !== undefined || scheduleType || parsed.data.postingTimes) {
    const { data: current } = await supabase
      .from('adu_configs')
      .select('posts_per_day, schedule_type, posting_times')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
    postsPerDay = postsPerDay ?? (current.posts_per_day as number);
    scheduleType = scheduleType ?? (current.schedule_type as 'dailyrandom' | 'fixed');
    if (scheduleType === 'fixed') {
      const times = parsed.data.postingTimes;
      if (!times || times.length !== postsPerDay) {
        return NextResponse.json(
          { error: 'Please select a time for all posting slots.' },
          { status: 400 }
        );
      }
      update.posting_times = times;
    } else {
      update.posting_times = generateDailyRandomTimes(postsPerDay);
    }
    update.posts_per_day = postsPerDay;
    update.schedule_type = scheduleType;
  }
  const { error } = await supabase
    .from('adu_configs')
    .update(update)
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'This page or source user is already configured.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const view = await loadAduConfigView(supabase, workspaceId, id);
  return NextResponse.json({ config: view });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Ownership first: the reels delete below is keyed only by config id,
  // so a foreign id must 404 here before anything is deleted — otherwise
  // one workspace could wipe another workspace's reels while its config
  // (deleted with the workspace filter) survives.
  const { data: owned } = await supabase
    .from('adu_configs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  // Old behaviour: reels are deleted first (in batches in the old app;
  // a single delete by config is equivalent here), then the page.
  await supabase.from('adu_reels').delete().eq('config_id', id);
  const { error } = await supabase
    .from('adu_configs')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
