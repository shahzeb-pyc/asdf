import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  DisconnectThreadsAccountResponseSchema,
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  disconnectAccountRow,
  stripDestinationCopiesForAccount,
} from '@/lib/connect/disconnect';
import { logServerError } from '@/lib/server-analytics';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DELETE /api/tenant/[subdomain]/threads/accounts/[accountId] —
 * disconnects a Threads account. Threads-only: the disconnect is scoped
 * to workspace + platform='threads', so it can never remove a Facebook
 * or other-platform account. Spec 174 PR 2A: the account row is
 * retained as a disconnected record (never deleted) and every
 * section's copy becomes a disconnected stub (identity + followers +
 * section kept, all working data removed); `ON DELETE RESTRICT` on
 * `destinations.account_id` is the backstop. The response counts the
 * copies stripped, never pages.
 */
export async function handleDisconnectThreadsAccount(
  request: NextRequest,
  subdomain: string,
  accountId: string,
  supabaseOverride?: SupabaseClient | null
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = supabaseOverride ?? getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }

  const workspaceId = await resolveWorkspaceIdFromSession(
    session,
    subdomain,
    supabase,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const { data: account, error: accountErr } = await supabase
      .from('social_accounts')
      .select('id')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (accountErr) throw new Error(accountErr.message);
    if (!account) {
      return NextResponse.json(
        { error: 'Threads account not found' },
        { status: 404 }
      );
    }

    // Strip every section's copy to a disconnected stub, then
    // disconnect the account row itself (retained, never deleted).
    const { stripped } = await stripDestinationCopiesForAccount(
      supabase,
      workspaceId,
      accountId,
      'threads'
    );
    const disconnectedDestinationsCount = stripped;
    const found = await disconnectAccountRow(
      supabase,
      workspaceId,
      accountId,
      'threads'
    );
    if (!found) {
      return NextResponse.json(
        { error: 'Threads account not found' },
        { status: 404 }
      );
    }

    const responsePayload = DisconnectThreadsAccountResponseSchema.parse({
      success: true,
      accountId,
      disconnectedDestinationsCount,
    });
    return NextResponse.json(responsePayload);
  } catch (err) {
    logServerError('[threads/accounts] Failed to disconnect account', err, {
      source: 'threads-disconnect',
      accountId,
    });
    return NextResponse.json(
      { error: "Couldn't disconnect the account. Please try again." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; accountId: string }> }
): Promise<NextResponse> {
  const { subdomain, accountId } = await context.params;
  return handleDisconnectThreadsAccount(request, subdomain, accountId);
}
