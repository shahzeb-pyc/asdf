import { type NextRequest, NextResponse } from 'next/server';
import { authenticateThreadsSchedule } from '@/lib/server/threads-schedule-auth';
import { handleThreadsQueueItemAction } from '@/lib/server/threads-schedule-queue-action';

/** POST retry for one failed Threads Schedule queue item. */
export async function POST(
  request: NextRequest,
  props: { params: Promise<{ subdomain: string; scheduleId: string; itemId: string }> }
) {
  const { subdomain, scheduleId, itemId } = await props.params;
  const auth = await authenticateThreadsSchedule(request, subdomain);
  if ('errorResponse' in auth) return auth.errorResponse;
  return handleThreadsQueueItemAction(
    auth.supabase,
    auth.workspaceId,
    auth.session.userId,
    scheduleId,
    itemId,
    'retry',
    request
  );
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
