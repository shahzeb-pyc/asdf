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
import {
  disconnectAccountRow,
  stripDestinationCopiesForAccount,
} from '@/lib/connect/disconnect';
import { logServerError } from '@/lib/server-analytics';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * DELETE /api/tenant/[subdomain]/instagram/accounts/[accountId]
 *
 * Instagram-only counterpart of the Facebook disconnect handler. It exists
 * because that handler hardcodes `platform = 'facebook'` and cannot
 * disconnect an Instagram row. The semantics are identical, scoped to
 * Instagram: session-cookie auth, tenant authorisation, workspace
 * resolution, then disconnect + strip (spec 174 PR 2A) — the account
 * row is retained as a disconnected record (never deleted) and every
 * section's copy becomes a disconnected stub (identity + followers +
 * section kept, all working data removed). `ON DELETE RESTRICT` on
 * `destinations.account_id` is the backstop.
 *
 * A second delete of the same id is a 404 only when the account row
 * is genuinely gone; disconnecting an already-disconnected account
 * re-strips its copies (idempotent) and succeeds again.
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
  const workspaceId = await resolveWorkspaceIdFromSession(
    session,
    subdomain,
    dbClient,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let disconnectedDestinationsCount = 0;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 4. The account row must exist (a 404 here is a genuinely
    // missing account, never a masked DB failure). The platform
    // predicate is load-bearing: without it this handler could
    // disconnect another platform's account that happens to share
    // an id.
    const accountRows = (await dbClient.query(
      "SELECT id FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram'",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    if (!accountRows || accountRows.length === 0) {
      return NextResponse.json(
        { error: 'Instagram account not found' },
        { status: 404 }
      );
    }

    // 5. Strip every section's copy to a disconnected stub, then
    // disconnect the account row itself (retained, never deleted).
    const { stripped } = await stripDestinationCopiesForAccount(
      dbClient,
      workspaceId,
      accountId,
      'instagram'
    );
    disconnectedDestinationsCount = stripped;
    await disconnectAccountRow(dbClient, workspaceId, accountId, 'instagram');
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

    try {
      const { data: account, error: accountErr } = await supabase
        .from('social_accounts')
        .select('id')
        .eq('id', accountId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'instagram')
        .maybeSingle();
      if (accountErr) throw new Error(accountErr.message);
      if (!account) {
        return NextResponse.json(
          { error: 'Instagram account not found' },
          { status: 404 }
        );
      }

      const { stripped } = await stripDestinationCopiesForAccount(
        supabase,
        workspaceId,
        accountId,
        'instagram'
      );
      disconnectedDestinationsCount = stripped;
      const found = await disconnectAccountRow(
        supabase,
        workspaceId,
        accountId,
        'instagram'
      );
      if (!found) {
        return NextResponse.json(
          { error: 'Instagram account not found' },
          { status: 404 }
        );
      }
    } catch (err) {
      logServerError('[instagram/accounts] Failed to disconnect account', err, {
        source: 'instagram-disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: "Couldn't disconnect the account. Please try again." },
        { status: 500 }
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
