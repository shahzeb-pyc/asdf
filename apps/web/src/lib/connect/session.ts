/**
 * Session + client resolution shared by the connect routes, following the
 * same pattern as the tenant settings routes (fbup_session cookie,
 * verifySessionToken, canAccessTenant).
 */
import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  verifySessionToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { ConnectDbClient } from './persist';

export async function extractConnectSession(
  request: NextRequest
): Promise<SessionPayload | null> {
  const token = request.cookies.get('fbup_session')?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token, getSessionSecret());
  } catch {
    return null;
  }
}

export function resolveConnectDbClient(
  dbClient?: ConnectDbClient | null
): ConnectDbClient | null {
  if (dbClient) return dbClient;
  return (getSupabaseAdminClient() as ConnectDbClient | null) ?? null;
}

export function sessionCanAccessTenant(
  session: SessionPayload,
  subdomain: string
): boolean {
  return canAccessTenant(session, subdomain).allowed;
}

export type SocialRouteContext =
  | {
      session: SessionPayload;
      client: ConnectDbClient;
      workspaceId: string;
      errorResponse?: never;
    }
  | { errorResponse: NextResponse; session?: never; client?: never; workspaceId?: never };

/**
 * Shared guard for the tenant social-accounts routes: session, tenant
 * access, database client, and workspace resolution in one place.
 */
export async function resolveSocialRouteContext(
  request: NextRequest,
  subdomain: string,
  dbClient?: ConnectDbClient
): Promise<SocialRouteContext> {
  const session = await extractConnectSession(request);
  if (!session) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }
  // Audit S1 (owner decision 2026-10-30): a JWT verifies
  // signature/expiry only — it stays valid for 30 days even after
  // the user is suspended or changes their password. Every social
  // route goes through here, so the live check lives here, not in
  // each route: suspension and password changes take effect
  // immediately. Mirrors authenticateTenantRoute (route-auth.ts),
  // dynamically imported to keep this module cycle-free.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }
  if (!sessionCanAccessTenant(session, subdomain)) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      ),
    };
  }

  const client = resolveConnectDbClient(dbClient);
  if (!client) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 503 }
      ),
    };
  }

  const workspaceId = await resolveTenantWorkspaceId(
    client,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      ),
    };
  }

  return { session, client, workspaceId };
}
