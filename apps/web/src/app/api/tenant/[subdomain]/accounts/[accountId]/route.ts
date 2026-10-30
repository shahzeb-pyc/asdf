import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  decryptToken,
  DisconnectAccountResponseSchema,
  getSessionSecret,
  getTokenEncryptionKey,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { revokeFacebookAuthorization } from '@/lib/connect/facebook-revoke';
import { logServerError } from '@/lib/server-analytics';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleDisconnectAccount(
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

  // Audit S1: live session validation — a suspended user or a
  // session issued before a password change must not reach the
  // tenant check or any mutation below.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // Launch-prep fix (expired-account removal): disconnect is a hard
  // DELETE of the account row. Deleting the row cascades (ON DELETE
  // CASCADE) to its destinations, and from there to their posting
  // slots, queue items (queued, published and failed alike) and
  // publish logs — so disconnecting an account removes its pages
  // and their posts from this app entirely. This replaces the old
  // BG10 retention behaviour (row kept as 'revoked', destinations
  // merely disconnected, queue items cancelled): the owner must be
  // able to remove an account from the app without any
  // Facebook-side step, and an expired token cannot revoke
  // anything at Facebook anyway.
  //
  // The Facebook-side revocation is best-effort and NEVER gates
  // the local delete:
  // - The token is dead for 'expired' accounts (Facebook rejects
  //   a dead token) and for 'revoked' accounts (already
  //   disconnected), so the revoke call is skipped outright for
  //   those statuses.
  // - For any other status the revoke is attempted, and any
  //   failure (bad token, transient Graph/network failure,
  //   undecryptable token) is logged loudly server-side — and
  //   the delete still proceeds. Deleting the row also deletes
  //   the token itself, so a failed revoke can never leave a
  //   usable token behind in this app.
  // The response still reports facebookRevoked truthfully (true
  // only when DELETE /me/permissions actually succeeded), but it
  // is informational only: false never implies the user must do
  // anything in Facebook Settings — local removal is complete
  // either way.
  const DEAD_TOKEN_STATUSES = new Set(['expired', 'revoked']);

  const attemptRevoke = async (
    encryptedToken: string | null,
    accountStatus: string | null
  ): Promise<boolean> => {
    if (!encryptedToken) return false;
    if (accountStatus !== null && DEAD_TOKEN_STATUSES.has(accountStatus)) {
      return false;
    }
    let userToken: string;
    try {
      userToken = await decryptToken(
        encryptedToken,
        getTokenEncryptionKey()
      );
    } catch (error) {
      logServerError(
        '[disconnect] Could not decrypt account token for revocation; local delete proceeds',
        error,
        { source: 'disconnect', accountId }
      );
      return false;
    }
    const revoked = await revokeFacebookAuthorization(userToken);
    if (!revoked) {
      logServerError(
        '[disconnect] Facebook authorization revocation failed; local delete proceeds and the token is deleted with the account',
        new Error('DELETE /me/permissions did not succeed'),
        { source: 'disconnect', accountId }
      );
    }
    return revoked;
  };

  let disconnectedPagesCount = 0;
  let facebookRevoked = false;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // 4. Load the account row (a 404 here is a genuinely missing
    // account, never a masked DB failure).
    const accountRows = (await dbClient.query(
      "SELECT status, encrypted_access_token FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [accountId, workspaceId]
    )) as Array<{ status?: unknown; encrypted_access_token?: unknown }>;
    if (!accountRows || accountRows.length === 0) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    const accountStatus =
      typeof accountRows[0]?.status === 'string'
        ? accountRows[0].status
        : null;
    const encryptedToken = accountRows[0]?.encrypted_access_token;
    facebookRevoked = await attemptRevoke(
      typeof encryptedToken === 'string' ? encryptedToken : null,
      accountStatus
    );

    // 5. Count the account's pages before deleting (the cascade
    // removes them with the account row), then hard-delete the
    // account. The single DELETE is atomic: either the row and
    // everything cascaded from it goes, or nothing does.
    const pageRows = (await dbClient.query(
      "SELECT id FROM destinations WHERE account_id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    disconnectedPagesCount = pageRows?.length ?? 0;
    const deletedRows = (await dbClient.query(
      "DELETE FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook' RETURNING id",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    if (!deletedRows || deletedRows.length === 0) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
  } else {
    // Plain SupabaseClient (no <Database> generic): the generated
    // Database type predates the unified tables, so the generic
    // types social_accounts/destinations as never — the same
    // untyped-client pattern the accounts list route uses.
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: account, error: accountErr } = await supabase
      .from('social_accounts')
      .select('id, status, encrypted_access_token')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();
    if (accountErr) {
      logServerError('[disconnect] Failed to load account for disconnect', accountErr, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
      );
    }
    if (!account) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    facebookRevoked = await attemptRevoke(
      typeof account.encrypted_access_token === 'string'
        ? account.encrypted_access_token
        : null,
      typeof account.status === 'string' ? account.status : null
    );

    // Count the account's pages before deleting (the cascade
    // removes them with the account row). A count failure fails
    // loud before any delete — never report a fabricated count.
    const { data: pages, error: pagesErr } = await supabase
      .from('destinations')
      .select('id')
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook');
    if (pagesErr) {
      logServerError('[disconnect] Failed to count pages for disconnect', pagesErr, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
      );
    }
    disconnectedPagesCount = pages?.length ?? 0;

    const { data: deleted, error: deleteErr } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .select('id');
    if (deleteErr) {
      logServerError('[disconnect] Failed to delete account', deleteErr, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
      );
    }
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
  }

  const responsePayload = DisconnectAccountResponseSchema.parse({
    success: true,
    accountId,
    disconnectedPagesCount,
    facebookRevoked,
  });

  return NextResponse.json(responsePayload);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; accountId: string }> }
): Promise<NextResponse> {
  const { subdomain, accountId } = await context.params;
  // Audit S6: previously unthrottled destructive action; 20/min like initiate.
  const limited = await enforceIpRateLimit(request, 'tenant_account_disconnect', 20);
  if (limited) return limited;
  return handleDisconnectAccount(request, subdomain, accountId);
}
