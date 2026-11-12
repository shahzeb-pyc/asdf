import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  isSessionAuthorizedForSubdomain,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { isThreadsScheduleListMember } from '@/lib/server/threads-schedule';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';

/**
 * GET /threads/schedule/candidates — connected Threads accounts with
 * their Threads destination, for the Add dialog. An account with no
 * destination yet has destinationId null (spec 174 2A: the Add dialog
 * posts the accountId and the import creates the schedule copy, so a
 * null destination is addable, not blocked); an already-added
 * destination is flagged so the dialog disables it instead of
 * duplicating it. Bounded: accounts and destinations are paged in
 * 1,000-row chunks.
 */
export async function GET(request: NextRequest, props: { params: Promise<{ subdomain: string }> }) {
  const { subdomain } = await props.params;
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }
  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, supabase);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  try {
    const accounts: Array<{
      id: string;
      external_account_id: string;
      display_name: string;
      avatar_url: string | null;
      status: string;
      token_expires_at: string | null;
    }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('social_accounts')
        .select('id, external_account_id, display_name, avatar_url, status, token_expires_at')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .order('display_name', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as typeof accounts;
      accounts.push(...page);
      if (page.length < 1000) break;
    }
    const destinations: Array<{
      id: string;
      account_id: string;
      name: string;
      handle: string | null;
      timezone: string;
      status: string;
      section: string | null;
      metadata: Record<string, unknown> | null;
    }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('destinations')
        .select('id, account_id, name, handle, timezone, status, section, metadata')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as typeof destinations;
      destinations.push(...page);
      if (page.length < 1000) break;
    }
    // One entry per account (spec 174 1B): the schedule copy when it
    // exists (its id is what the Add dialog posts, and a removed stub
    // is re-addable through it), else the unimported connected row
    // (the Add dialog stamps it to 'schedule'). Rows belonging to
    // another section are never offered as the Add target.
    const destinationByAccount = new Map<string, (typeof destinations)[number]>();
    const rank = (d: (typeof destinations)[number]): number =>
      d.section === 'schedule' ? 0 : d.section === null ? 1 : 2;
    for (const destination of destinations) {
      const prev = destinationByAccount.get(destination.account_id);
      if (!prev || rank(destination) < rank(prev)) {
        destinationByAccount.set(destination.account_id, destination);
      }
    }
    const candidates = accounts.map((account) => {
      const destination = destinationByAccount.get(account.id) ?? null;
      const tokenPast =
        account.token_expires_at !== null &&
        Date.parse(account.token_expires_at) <= Date.now();
      const accountStatus =
        account.status === 'expired' || tokenPast
          ? 'expired'
          : account.status === 'active'
            ? 'active'
            : 'disconnected';
      return {
        accountId: account.id,
        threadsAccountId: account.external_account_id,
        displayName: account.display_name,
        handle: destination?.handle ?? null,
        profilePictureUrl: account.avatar_url,
        destinationId: destination?.id ?? null,
        destinationName: destination?.name ?? null,
        destinationTimezone: destination?.timezone ?? null,
        accountStatus,
        scheduleAdded: destination ? isThreadsScheduleListMember(destination) : false,
      };
    });
    return NextResponse.json({ candidates });
  } catch (err) {
    logServerError('[threads/schedule] candidates failed', err, {
      source: 'threads-schedule-candidates',
    });
    return NextResponse.json({ error: 'Failed to load connected accounts' }, { status: 500 });
  }
}
