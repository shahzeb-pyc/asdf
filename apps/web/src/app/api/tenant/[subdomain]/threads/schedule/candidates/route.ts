import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  isSessionAuthorizedForSubdomain,
  isThreadsScheduleAdded,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';

/**
 * GET /threads/schedule/candidates — connected Threads accounts with
 * their Threads destination, for the Add dialog. An account with no
 * destination yet has destinationId null (it cannot be added until
 * its destination exists); an already-added destination is flagged
 * so the dialog disables it instead of duplicating it. Bounded:
 * accounts and destinations are paged in 1,000-row chunks.
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
  const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
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
      metadata: Record<string, unknown> | null;
    }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('destinations')
        .select('id, account_id, name, handle, timezone, metadata')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as typeof destinations;
      destinations.push(...page);
      if (page.length < 1000) break;
    }
    const destinationByAccount = new Map<string, (typeof destinations)[number]>();
    for (const destination of destinations) {
      if (!destinationByAccount.has(destination.account_id)) {
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
        scheduleAdded: destination ? isThreadsScheduleAdded(destination.metadata) : false,
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
