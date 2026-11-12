import { type NextRequest, NextResponse } from 'next/server';
import { logServerError } from '@/lib/server-analytics';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { isThreadsScheduleListMember } from '@/lib/server/threads-schedule';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';

/** DELETE one Threads Schedule posting time. */
export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string; slotId: string }> }
) {
  const { subdomain, scheduleId, slotId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { supabase, workspaceId } = auth;
  try {
    const { data: destination, error: destError } = await supabase
      .from('destinations')
      .select('section, status, metadata')
      .eq('id', scheduleId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .eq('section', 'schedule')
      .maybeSingle();
    if (destError) throw new Error(destError.message);
    if (!destination || !isThreadsScheduleListMember(destination as { section: string | null; status: string; metadata: Record<string, unknown> | null })) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const { data: slot, error: slotError } = await supabase
      .from('posting_slots')
      .select('id')
      .eq('id', slotId)
      .eq('destination_id', scheduleId)
      .maybeSingle();
    if (slotError) throw new Error(slotError.message);
    if (!slot) {
      return NextResponse.json({ error: 'Posting time not found' }, { status: 404 });
    }
    const { error: deleteError } = await supabase
      .from('posting_slots')
      .delete()
      .eq('id', slotId)
      .eq('destination_id', scheduleId);
    if (deleteError) throw new Error(deleteError.message);
    await refreshDestinationUnmatchedFlag(supabase, scheduleId);
    return NextResponse.json({ success: true });
  } catch (err) {
    logServerError('[threads/schedule] slot delete failed', err, {
      source: 'threads-schedule-slot-delete',
    });
    return NextResponse.json({ error: 'Failed to delete this posting time' }, { status: 500 });
  }
}
