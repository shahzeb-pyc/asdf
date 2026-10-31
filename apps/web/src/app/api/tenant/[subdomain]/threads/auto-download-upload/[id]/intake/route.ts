import { type NextRequest, NextResponse } from 'next/server';
import { localTimeInTimezone } from '@fbuploadpro/contracts';
import { loadThreadsAduDestination, threadsAduContext } from '@/lib/server/threads-adu';

/**
 * Schedule intake for one config (the worker tick runs the same rule
 * for all configs on the minute tick). A config is due only when it is
 * active, synced, has posts_per_day > 0, and one of its posting times
 * falls in the current minute in its own timezone. One job per account
 * per slot, deduped by the unique (config_id, schedule_slot_at) index:
 * a duplicate insert is ignored, never double-created. If a due page
 * has no downloadable reel left and nothing pending/processing/
 * publishing, it flips to completed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, id);
  if (!scoped) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  const config = scoped.config;
  if (config.status !== 'active' || config.sync_status !== 'synced' || config.posts_per_day <= 0) {
    return NextResponse.json({ due: false, reason: 'Config is not active and synced.' });
  }
  const now = new Date();
  const localTime = localTimeInTimezone(now, config.timezone);
  const dueTime = (config.posting_times as string[]).find((t) => t === localTime);
  if (!dueTime) {
    return NextResponse.json({ due: false, localTime, postingTimes: config.posting_times });
  }
  const slotAt = new Date(now);
  slotAt.setSeconds(0, 0);
  const { data: oldest } = await supabase
    .from('adu_reels')
    .select('*')
    .eq('config_id', id)
    .eq('status', 'downloaded')
    .not('media_url', 'is', null)
    .order('downloaded_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!oldest) {
    const { data: busy } = await supabase
      .from('adu_reels')
      .select('id')
      .eq('config_id', id)
      .in('status', ['pending', 'processing'])
      .limit(1);
    const { data: busyJobs } = await supabase
      .from('adu_posting_jobs')
      .select('id')
      .eq('config_id', id)
      .in('status', ['pending_publish', 'publishing'])
      .limit(1);
    if ((!busy || busy.length === 0) && (!busyJobs || busyJobs.length === 0)) {
      await supabase
        .from('adu_configs')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', id);
      return NextResponse.json({ due: true, completed: true });
    }
    return NextResponse.json({ due: true, reason: 'No downloadable reel for this slot yet.' });
  }
  const { error } = await supabase.from('adu_posting_jobs').insert({
    config_id: id,
    reel_id: oldest.id,
    schedule_slot_at: slotAt.toISOString(),
    status: 'pending_publish',
  });
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ due: true, duplicate: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  await supabase
    .from('adu_reels')
    .update({ status: 'processing' })
    .eq('id', oldest.id);
  return NextResponse.json({ due: true, jobCreated: true, reelId: oldest.id });
}
