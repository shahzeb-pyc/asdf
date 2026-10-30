import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  DisconnectThreadsAccountResponseSchema,
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DELETE /api/tenant/[subdomain]/threads/accounts/[accountId] —
 * disconnects a Threads account. Threads-only: the delete is scoped
 * to workspace + platform='threads', so it can never remove a Facebook
 * or other-platform account. The account's destinations are removed
 * with it (foreign key ON DELETE CASCADE, as with Facebook); the
 * response counts them first, like the Facebook disconnect route,
 * but the count is destinations, never pages.
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

  const workspaceId = await resolveTenantWorkspaceId(
    supabase,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    const { count, error: countError } = await supabase
      .from('destinations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads');
    if (countError) throw new Error(countError.message);
    const disconnectedDestinationsCount = count ?? 0;

    const { data: deleted, error: deleteError } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .select('id');
    if (deleteError) throw new Error(deleteError.message);
    if (!deleted || deleted.length === 0) {
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
    console.error(
      '[threads/accounts] Failed to disconnect account:',
      err
    );
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
