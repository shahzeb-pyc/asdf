import type { DatabaseClient, SessionPayload, UserRole } from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolves the workspace ID for a given tenant subdomain owned by userId (or any owner if role === 'admin').
 * Returns null if the workspace does not exist or does not belong to the user.
 */
export async function resolveTenantWorkspaceId(
  client: DatabaseClient | SupabaseClient | null | undefined,
  subdomain: string,
  userId: string,
  role?: UserRole | string
): Promise<string | null> {
  const isAdmin = role === 'admin';

  if (isLegacyClient(client ?? undefined)) {
    try {
      const sql = isAdmin
        ? 'SELECT id FROM workspaces WHERE subdomain = $1 LIMIT 1'
        : 'SELECT id FROM workspaces WHERE subdomain = $1 AND owner_id = $2 LIMIT 1';
      const params = isAdmin ? [subdomain] : [subdomain, userId];
      const rows = (await (client as DatabaseClient).query(sql, params)) as Array<{ id: string }>;
      return rows?.[0]?.id ?? null;
    } catch (err) {
      // Database query error: workspace unresolved. Logged (spec 139
      // B19) — a DB outage must not silently masquerade as a 404.
      logServerError('[workspace-resolver] Legacy workspace lookup failed', err, {
        source: 'workspace-resolver',
        subdomain,
      });
      return null;
    }
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) {
    return null;
  }

  try {
    let query = supabase.from('workspaces').select('id').eq('subdomain', subdomain);
    if (!isAdmin) {
      query = query.eq('owner_id', userId);
    }
    const { data: ws, error } = await query.maybeSingle();

    if (error) {
      // Logged (spec 139 B19): a query failure is not a missing workspace.
      logServerError('[workspace-resolver] Workspace lookup failed', error, {
        source: 'workspace-resolver',
        subdomain,
      });
      return null;
    }
    if (!ws?.id) {
      return null;
    }
    return ws.id;
  } catch (err) {
    // Query error: workspace unresolved (logged, spec 139 B19).
    logServerError('[workspace-resolver] Workspace lookup threw', err, {
      source: 'workspace-resolver',
      subdomain,
    });
    return null;
  }
}

export type WorkspaceIdFallbackReason = 'no-claim' | 'role-not-user' | 'subdomain-mismatch';

/**
 * S3: resolves the workspace id from the verified session token's
 * `workspaceId` claim when it is usable, and falls back to
 * `resolveTenantWorkspaceId` (the same DB lookup as today) otherwise.
 *
 * The claim is usable only when all of these hold: the session carries
 * a `workspaceId`, the session role is 'user' (admin/seller tokens
 * carry no claim), and the requested subdomain is the token's active
 * subdomain (case-insensitive, the same normalisation
 * `canAccessTenant` uses). Anything else — old claimless tokens,
 * requests for a non-active allowed subdomain, admin callers — takes
 * the DB fallback, which re-proves ownership exactly as today. The
 * `role` argument is passed through untouched, so call sites that do
 * not pass a role keep resolving as a non-owner on the fallback path.
 *
 * `session` must come from `verifySessionToken` (directly or via
 * `authenticateTenantRoute` / `getServerSessionContext` /
 * `extractConnectSession`) — never from a raw cookie, header, body,
 * or URL value. Call sites that cannot supply a verified session keep
 * calling `resolveTenantWorkspaceId` directly.
 */
export async function resolveWorkspaceIdFromSession(
  session: SessionPayload,
  subdomain: string,
  client: DatabaseClient | SupabaseClient | null | undefined,
  role?: UserRole | string
): Promise<string | null> {
  const claimUsable =
    Boolean(session.workspaceId) &&
    session.role === 'user' &&
    session.subdomain.toLowerCase() === subdomain.toLowerCase();
  if (claimUsable) {
    return session.workspaceId as string;
  }

  // S3 fallback-use monitoring (coordinator Q3: a log line only, no new
  // metrics path). Expected shape over the 30-day rollout tail: decay
  // to zero as users re-login and get claim-carrying tokens.
  const reason: WorkspaceIdFallbackReason = !session.workspaceId
    ? 'no-claim'
    : session.role !== 'user'
      ? 'role-not-user'
      : 'subdomain-mismatch';
  console.info('[workspace-resolver] workspace-id fallback used', {
    subdomain,
    reason,
  });
  return resolveTenantWorkspaceId(client, subdomain, session.userId, role);
}
