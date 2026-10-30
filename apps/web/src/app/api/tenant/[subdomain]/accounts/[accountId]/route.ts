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

  // Audit BG10: disconnect is a status change + revocation +
  // retention, NOT a hard delete. The account row stays (status
  // 'revoked' — the wire maps it to 'disconnected', so cards show
  // error health with Reconnect), its destinations become
  // 'disconnected', queued items become 'cancelled' (archived,
  // never deleted), and publish logs are untouched. No migration
  // was needed: 'revoked' / 'disconnected' / 'cancelled' are all
  // already allowed by the unified-schema CHECK constraints.
  //
  // Revoke failure deliberately does NOT block the disconnect:
  // disconnect is the safety action, and blocking it would strand
  // the token the user wants gone. It is logged loudly and
  // surfaced as facebookRevoked=false so the UI can say the
  // authorization may still be live in Facebook settings.
  // A revoke failure also never leaves a publishable token
  // behind in practice: the revoked-status account and
  // disconnected destinations fail both claim gates (the due
  // claimer requires sa.status='active' AND d.status='active').
  const attemptRevoke = async (
    encryptedToken: string | null
  ): Promise<boolean> => {
    if (!encryptedToken) return false;
    let userToken: string;
    try {
      userToken = await decryptToken(
        encryptedToken,
        getTokenEncryptionKey()
      );
    } catch (error) {
      logServerError(
        '[disconnect] Could not decrypt account token for revocation',
        error,
        { source: 'disconnect', accountId }
      );
      return false;
    }
    const revoked = await revokeFacebookAuthorization(userToken);
    if (!revoked) {
      logServerError(
        '[disconnect] Facebook authorization revocation failed; local disconnect proceeds but the app may still be authorized in Facebook settings',
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
      "SELECT encrypted_access_token FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [accountId, workspaceId]
    )) as Array<{ encrypted_access_token?: unknown }>;
    if (!accountRows || accountRows.length === 0) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    const encryptedToken = accountRows[0]?.encrypted_access_token;
    facebookRevoked = await attemptRevoke(
      typeof encryptedToken === 'string' ? encryptedToken : null
    );

    // 5. Disconnect destinations first, then cancel their queued
    // items, then mark the account revoked. Every step is in the
    // safe direction if a later one fails (a disconnected
    // destination or a revoked account can no longer publish).
    const disconnectedRows = (await dbClient.query(
      "UPDATE destinations SET status = 'disconnected', updated_at = now() WHERE account_id = $1 AND workspace_id = $2 AND platform = 'facebook' AND status <> 'disconnected' RETURNING id",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    disconnectedPagesCount = disconnectedRows?.length ?? 0;
    await dbClient.query(
      "UPDATE queue_items SET status = 'cancelled', updated_at = now() WHERE status = 'queued' AND destination_id IN (SELECT id FROM destinations WHERE account_id = $1 AND workspace_id = $2 AND platform = 'facebook')",
      [accountId, workspaceId]
    );
    const revokedRows = (await dbClient.query(
      "UPDATE social_accounts SET status = 'revoked', updated_at = now() WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook' RETURNING id",
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    if (!revokedRows || revokedRows.length === 0) {
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
      .select('id, encrypted_access_token')
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
        : null
    );

    const { data: disconnected, error: disconnectErr } = await supabase
      .from('destinations')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .neq('status', 'disconnected')
      .select('id');
    if (disconnectErr) {
      logServerError('[disconnect] Failed to disconnect destinations', disconnectErr, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
      );
    }
    disconnectedPagesCount = disconnected?.length ?? 0;

    const { data: destinationIds } = await supabase
      .from('destinations')
      .select('id')
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook');
    const destinationIdList = (destinationIds ?? []).map((row) => row.id);
    if (destinationIdList.length > 0) {
      // Best-effort with the claim gates as backstop (see above):
      // a failed cancel leaves queued rows on disconnected
      // destinations, which neither claimer will ever pick up.
      const { error: cancelErr } = await supabase
        .from('queue_items')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('status', 'queued')
        .in('destination_id', destinationIdList);
      if (cancelErr) {
        logServerError('[disconnect] Failed to cancel queued items for disconnected account', cancelErr, {
          source: 'disconnect',
          accountId,
        });
      }
    }

    const { data: revoked, error: revokeErr } = await supabase
      .from('social_accounts')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .select('id');
    if (revokeErr) {
      logServerError('[disconnect] Failed to mark account revoked', revokeErr, {
        source: 'disconnect',
        accountId,
      });
      return NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 500 }
      );
    }
    if (!revoked || revoked.length === 0) {
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
