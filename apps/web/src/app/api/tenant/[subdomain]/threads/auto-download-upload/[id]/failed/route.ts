import { type NextRequest, NextResponse } from 'next/server';
import { loadThreadsAduDestination, threadsAduContext } from '@/lib/server/threads-adu';

/** Failed Posts Reasons: latest 50 failed jobs, with their reel caption. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, id);
  if (!scoped) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  const { data: jobs, error } = await supabase
    .from('adu_posting_jobs')
    .select('*, adu_reels(source_reel_id, caption)')
    .eq('config_id', id)
    .in('status', ['failed_to_publish', 'publish_error', 'integrity_error'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: jobs ?? [] });
}
