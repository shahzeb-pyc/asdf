import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  isSessionAuthorizedForSubdomain,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared auth for Threads Schedule routes: session cookie, tenant
 * authorisation, workspace resolution. Returns either the context or
 * the error response — callers never proceed past a failed auth.
 */
export async function authenticateThreadsSchedule(
  request: NextRequest,
  subdomain: string
): Promise<
  | { session: { userId: string; role: string }; workspaceId: string; supabase: SupabaseClient }
  | { errorResponse: NextResponse }
> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch (_e) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      ),
    };
  }
  const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
  if (!workspaceId) {
    return { errorResponse: NextResponse.json({ error: 'Workspace not found' }, { status: 404 }) };
  }
  return { session, workspaceId, supabase };
}
