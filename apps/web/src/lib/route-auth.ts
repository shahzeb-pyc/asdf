import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  verifySessionToken,
  canAccessTenant,
  type DatabaseClient,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantSession } from '@/lib/agent-auth';
import type { SupabaseClient } from '@supabase/supabase-js';

export function isLegacyClient(
  client?: DatabaseClient | SupabaseClient
): client is DatabaseClient {
  if (!client) return false;
  // Structural probe (spec 137 §3.7): view the client as a record of
  // unknown members and narrow each with typeof — no `any` casts.
  const candidate = client as { query?: unknown; withTransaction?: unknown };
  return (
    ('query' in client && typeof candidate.query === 'function') ||
    ('withTransaction' in client &&
      typeof candidate.withTransaction === 'function')
  );
}

export function getRouteSupabase(
  client?: DatabaseClient | SupabaseClient
): SupabaseClient | null {
  if (client && 'from' in client) {
    return client as SupabaseClient;
  }
  return getSupabaseAdminClient() as SupabaseClient | null;
}

export async function authenticateTenantRoute(
  request: NextRequest,
  subdomain: string,
  options: { allowAgentKey?: boolean } = {}
): Promise<
  | { session: SessionPayload; agentKeyId?: string; errorResponse?: never }
  | { session?: never; errorResponse: NextResponse }
> {
  // Bearer agent keys are OPT-IN only (media routes). The default
  // stays cookie-only, so existing callers (billing, downloader,
  // publishing, etc.) do not gain Bearer access from this change.
  // A media-only key must never be able to create keys, read
  // activity, or touch non-media routes through this helper.
  if (options.allowAgentKey) {
    const resolved = await resolveTenantSession(request, subdomain, {
      allowAgentKey: true,
    });
    if ('errorResponse' in resolved) {
      return { errorResponse: resolved.errorResponse };
    }
    return { session: resolved.session, agentKeyId: resolved.agentKeyId };
  }

  const sessionSecret = getSessionSecret();
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  let session: SessionPayload;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  // JWT-only (session-global-check spec §2.1): no database lookup
  // per call. The token's own status claim is the session proof
  // here — the same proof middleware already uses. Database-backed
  // state (suspension after login, user deletion, password change)
  // is enforced by the single global session check
  // (`GET /api/auth/session`), not on every API call. A lookup
  // failure therefore cannot surface as a 401 from this helper at
  // all: there is no lookup left to fail.
  if (session.status !== 'active') {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}

/**
 * Global admin authentication for /api/admin/* routes (shell
 * isolation): the same JWT-only session check as
 * authenticateTenantRoute, but with NO tenant — admin data is
 * global, and the admin section has no subdomain to check access
 * against. Non-admins get 403, exactly like the tenant admin
 * routes did; the handlers keep their own role check as well.
 */
export async function authenticateAdminRoute(
  request: NextRequest
): Promise<
  | { session: SessionPayload; errorResponse?: never }
  | { session?: never; errorResponse: NextResponse }
> {
  const sessionSecret = getSessionSecret();
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  let session: SessionPayload;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  // JWT-only, as in authenticateTenantRoute (spec §2.1).
  if (session.status !== 'active') {
    return {
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      ),
    };
  }

  if (session.role !== 'admin') {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}
