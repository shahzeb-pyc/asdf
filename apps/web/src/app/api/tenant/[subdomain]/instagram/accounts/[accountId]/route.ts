import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  DisconnectInstagramAccountResponseSchema,
  getSessionSecret,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DELETE /api/tenant/[subdomain]/instagram/accounts/[accountId]
 *
 * Instagram-only counterpart of the Facebook disconnect handler. It exists
 * because that handler hardcodes `platform = 'facebook'` and cannot delete
 * an Instagram row. The semantics are identical, scoped to Instagram:
 * session-cookie auth, tenant authorisation, workspace resolution, then
 * delete of the `social_accounts` row for (id, workspace_id,
 * platform = 'instagram'). Foreign-key cascade removes the account's
 * destination row(s) and their queued items, exactly as for Facebook.
 *
 * A second delete of the same id is a 404, not a second side effect:
 * DELETE is naturally idempotent here and no external state is mutated.
 */
export async function handleDisconnectInstagramAccount(
  request: NextRequest,
  subdomain: string,
  accountId: string,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  // 1. Session auth guard
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

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(
    dbClient,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let disconnectedDestinationsCount = 0;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 4. Count the account's destinations prior to cascade deletion
    const countRows = (await dbClient.query(
      "SELECT COUNT(*)::int AS count FROM destinations WHERE account_id = $1 AND workspace_id = $2 AND platform = 'instagram'",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    disconnectedDestinationsCount = Number(countRows?.[0]?.count ?? 0);

    // 5. Delete the account record (FK cascade removes its destinations
    // and their queued items). The platform predicate is load-bearing:
    // without it this handler could delete another platform's account
    // that happens to share an id.
    const result = (await dbClient.query(
      "DELETE FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' RETURNING id",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];

    if (!result || result.length === 0) {
      return NextResponse.json(
        { error: 'Instagram account not found' },
        { status: 404 }
      );
    }
  } else {
    const supabase = (
      dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
    ) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      );
    }

    const { count } = await supabase
      .from('destinations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram');
    disconnectedDestinationsCount = count ?? 0;

    const { data: deleted, error: deleteErr } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .select('id');

    if (deleteErr || !deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'Instagram account not found' },
        { status: 404 }
      );
    }
  }

  const responsePayload = DisconnectInstagramAccountResponseSchema.parse({
    success: true,
    accountId,
    disconnectedDestinationsCount,
  });

  return NextResponse.json(responsePayload);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; accountId: string }> }
): Promise<NextResponse> {
  const { subdomain, accountId } = await context.params;
  return handleDisconnectInstagramAccount(request, subdomain, accountId);
}
