import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Session + tenant + workspace guard shared by every Instagram
 * Schedule route (the same guard the Instagram Accounts routes use,
 * inlined there). Returns the session and workspace id, or an error
 * response: 401 without a valid session, 403 for another tenant,
 * 404 when the workspace cannot be resolved — never a silent list.
 */
export type InstagramScheduleDbClient =
  | DatabaseClient
  | SupabaseClient;

export async function authenticateInstagramSchedule(
  request: NextRequest,
  subdomain: string,
  dbClient?: InstagramScheduleDbClient
): Promise<
  | { session: { userId: string; role: string }; workspaceId: string }
  | { error: NextResponse }
> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  if (!canAccessTenant(session, subdomain).allowed) {
    return {
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  const workspaceId = await resolveTenantWorkspaceId(
    dbClient,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return {
      error: NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      ),
    };
  }
  return { session, workspaceId };
}
