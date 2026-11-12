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
import {
  disconnectAccountRow,
  stripDestinationCopiesForAccount,
} from '@/lib/connect/disconnect';
import { revokeFacebookAuthorization } from '@/lib/connect/facebook-revoke';
import { logServerError } from '@/lib/server-analytics';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
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
  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, dbClient);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // Spec 174 PR 2A — disconnect is disconnect + strip, NEVER delete.
  // The account row is retained as a disconnected record (status
  // 'disconnected', both tokens NULL), and every section's copy of
  // every page becomes a disconnected stub (identity + followers +
  // section kept, all working data removed) via
  // `stripDestinationCopiesForAccount`. `ON DELETE RESTRICT` on
  // `destinations.account_id` is the backstop: a hard DELETE of the
  // account row now fails loudly while any copy references it.
  // This replaces the old launch-prep hard delete (account row
  // deleted, destinations cascaded away with their posting slots,
  // queue items and publish logs).
  //
  // The Facebook-side revocation is best-effort and NEVER gates
  // the local disconnect:
  // - The token is dead for 'expired' accounts (Facebook rejects
  //   a dead token) and for 'revoked' accounts (already
  //   disconnected), so the revoke call is skipped outright for
  //   those statuses.
  // - For any other status the revoke is attempted, and any
  //   failure (bad token, transient Graph/network failure,
  //   undecryptable token) is logged loudly server-side — and
  //   the disconnect still proceeds. Disconnecting the account
  //   NULLs the token itself, so a failed revoke can never leave
  //   a usable token behind in this app.
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

    // 5. Strip every section's copy to a disconnected stub, then
    // disconnect the account row itself (retained, never deleted).
    // Strip-first order: a strip failure leaves the account row
    // untouched, so a retry is clean.
    const { stripped } = await stripDestinationCopiesForAccount(
      dbClient,
      workspaceId,
      accountId,
      'facebook'
    );
    disconnectedPagesCount = stripped;
    const found = await disconnectAccountRow(
      dbClient,
      workspaceId,
      accountId,
      'facebook'
    );
    if (!found) {
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

    // Strip every section's copy to a disconnected stub, then
    // disconnect the account row itself (retained, never deleted).
    // Strip-first order: a strip failure leaves the account row
    // untouched, so a retry is clean.
    try {
      const { stripped } = await stripDestinationCopiesForAccount(
        supabase,
        workspaceId,
        accountId,
        'facebook'
      );
      disconnectedPagesCount = stripped;
      const found = await disconnectAccountRow(
        supabase,
        workspaceId,
        accountId,
        'facebook'
      );
      if (!found) {
        return NextResponse.json(
          { error: 'Facebook account not found' },
          { status: 404 }
        );
      }
    } catch (err) {
      logServerError('[disconnect] Failed to disconnect account', err, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
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
