import { type NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import {
  canAccessTenant,
  getSessionSecret,
  isMuseKeyFormat,
  museKeyPrefix,
  verifySessionToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Muse agent keys — Media Library only.
 *
 * Auth order is deliberate and narrow:
 * 1. A valid fbup_session cookie wins, exactly as before.
 * 2. Only when the caller explicitly opts in (media routes) does an
 *    Authorization: Bearer agent key get tried. Every other route
 *    keeps cookie-only auth, so a media-only key can never open
 *    billing, queue, publishing, settings, or any other route.
 * A Bearer key that is unknown, expired, or for a workspace the
 * user does not own is rejected — it never falls through to
 * another user or to an unauthenticated path.
 */

export function generateAgentKey(): string {
  return `fbu_${randomBytes(16).toString('hex')}`;
}

export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function parseBearerKey(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const key = match[1]?.trim();
  return key && isMuseKeyFormat(key) ? key : null;
}

type SupabaseLike = Pick<SupabaseClient, 'from'>;

function resolveSupabase(
  dbClient: unknown
): SupabaseLike | null {
  if (
    dbClient &&
    typeof dbClient === 'object' &&
    'from' in dbClient &&
    typeof (dbClient as SupabaseLike).from === 'function'
  ) {
    return dbClient as SupabaseLike;
  }
  return getSupabaseAdminClient() as SupabaseLike | null;
}

interface AgentKeyRow {
  id: string;
  user_id: string;
  expires_at: string | null;
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  status: string;
}

async function resolveAgentSession(
  bearerKey: string,
  subdomain: string,
  dbClient: unknown
): Promise<
  | { session: SessionPayload; agentKeyId: string }
  | { error: 'unauthorized' | 'forbidden' | 'unavailable' }
> {
  const supabase = resolveSupabase(dbClient);
  if (!supabase) return { error: 'unavailable' };

  const { data: keyRow, error: keyError } = await supabase
    .from('agent_keys')
    .select('id, user_id, expires_at')
    .eq('key_hash', hashAgentKey(bearerKey))
    .maybeSingle();
  if (keyError || !keyRow) return { error: 'unauthorized' };
  const key = keyRow as AgentKeyRow;
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    return { error: 'unauthorized' };
  }

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('id, email, role, status')
    .eq('id', key.user_id)
    .maybeSingle();
  if (userError || !userRow) return { error: 'unauthorized' };
  const user = userRow as UserRow;
  if (user.status !== 'active') return { error: 'unauthorized' };
  if (user.role !== 'user' && user.role !== 'admin') {
    return { error: 'forbidden' };
  }

  // Tenant gate for agent keys: the user must own a workspace with
  // this subdomain (admins are global, as with cookie sessions).
  // Media itself is per-user, but the route is tenant-scoped, so
  // an agent key for user A must never open user B's tenant URL.
  if (user.role !== 'admin') {
    const { data: workspace, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id')
      .eq('owner_id', user.id)
      .eq('subdomain', subdomain.toLowerCase())
      .maybeSingle();
    if (workspaceError || !workspace) return { error: 'forbidden' };
  }

  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    userId: user.id,
    email: user.email,
    name: null,
    subdomain: subdomain.toLowerCase(),
    allowedSubdomains: [subdomain.toLowerCase()],
    role: user.role as SessionPayload['role'],
    status: 'active',
    iat: now,
    exp: now + 3600,
  };
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) return { error: 'forbidden' };

  // Best-effort telemetry only: a failed last-used update must
  // never turn a valid upload into a failure.
  try {
    await supabase
      .from('agent_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', key.id);
  } catch (error) {
    // Logged, not fatal: last-used is audit metadata, not auth, so a
    // failed update must never turn a valid upload into a failure.
    // Only the key id is logged — never the key itself.
    console.error(
      '[agent-auth] Failed to update last_used_at for agent key',
      key.id,
      error
    );
  }

  return { session, agentKeyId: key.id };
}

export interface ResolvedTenantSession {
  session: SessionPayload;
  agentKeyId?: string;
}

/**
 * Resolve a tenant session for a media route.
 * Cookie first (unchanged behaviour); Bearer agent key only when
 * allowAgentKey is true. Returns an error response to return
 * directly, or a session (with agentKeyId when Bearer was used).
 */
export async function resolveTenantSession(
  request: NextRequest,
  subdomain: string,
  options: { allowAgentKey?: boolean; dbClient?: unknown } = {}
): Promise<
  | ResolvedTenantSession
  | { errorResponse: NextResponse }
> {
  const sessionSecret = getSessionSecret();
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (sessionCookie) {
    try {
      const session = await verifySessionToken(sessionCookie, sessionSecret);
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
          errorResponse: NextResponse.json(
            { error: 'Forbidden' },
            { status: 403 }
          ),
        };
      }
      return { session };
    } catch {
      // A bad cookie does not silently fall through to Bearer
      // when no Bearer header is present; it is a 401 below.
      if (!request.headers.get('authorization')) {
        return {
          errorResponse: NextResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          ),
        };
      }
    }
  }

  if (options.allowAgentKey) {
    const bearerKey = parseBearerKey(request);
    if (bearerKey) {
      const resolved = await resolveAgentSession(
        bearerKey,
        subdomain,
        options.dbClient
      );
      if ('session' in resolved) return resolved;
      if (resolved.error === 'forbidden') {
        return {
          errorResponse: NextResponse.json(
            { error: 'Forbidden' },
            { status: 403 }
          ),
        };
      }
      if (resolved.error === 'unavailable') {
        return {
          errorResponse: NextResponse.json(
            { error: 'Database service unavailable' },
            { status: 500 }
          ),
        };
      }
      return {
        errorResponse: NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        ),
      };
    }
  }

  return {
    errorResponse: NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    ),
  };
}

export { museKeyPrefix };
