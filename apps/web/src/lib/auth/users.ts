/**
 * AuthUser model + user lookup (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import {
  deriveSubdomainFromEmail,
  type UserRole,
  type UserStatus,
} from '@fbuploadpro/contracts';
import { logServerError } from '../server-analytics';
import { escapePostgrestFilterValue, resolveCanonicalEmail } from './email';
import { getSupabaseAdminClient } from './clients';
import { localUserStore } from './stores';

/**
 * AuthUser represents an authenticated user in memory and session returns.
 * Per Principle 27 of FBUploadPro Constitution, the workspaces table is the sole source of truth
 * for tenant subdomains (users.subdomain is dropped from the database).
 * The subdomain field here represents the user's active/primary workspace subdomain.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  /** Primary workspace subdomain derived or resolved via workspaces table (Principle 27) */
  subdomain: string;
  role: UserRole;
  status: UserStatus;
  passwordUpdatedAt?: number | undefined;
}

async function findWorkspaceSubdomainByOwner(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  ownerId: string,
  fallbackSubdomain: string
): Promise<string> {
  if (!supabase) return fallbackSubdomain;
  try {
    const { data: wsData } = await supabase
      .from('workspaces')
      .select('subdomain')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return wsData?.subdomain || fallbackSubdomain;
  } catch {
    return fallbackSubdomain;
  }
}

/**
 * Discriminated user-lookup outcome (session-global-check spec §2.1).
 *
 * The old lookup swallowed database failures and returned `null`,
 * which callers could not distinguish from "no such user" — and the
 * session check turned that into a 401, i.e. a transient database
 * error looked exactly like an expired session. `error` here means
 * the lookup itself failed (PostgREST error / thrown exception);
 * `absent` means it ran cleanly and found nobody.
 */
export type UserLookupResult =
  | { kind: 'found'; user: AuthUser }
  | { kind: 'absent' }
  | { kind: 'error' };

type SupabaseAdminClient = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;

/** The Supabase user-row query, shared by both lookup entry points. */
async function querySupabaseUser(
  supabase: SupabaseAdminClient,
  canonicalEmail: string
): Promise<UserLookupResult> {
  try {
    const quoted = escapePostgrestFilterValue(canonicalEmail);
    const { data, error } = await supabase
      .from('users')
      .select('id, email, name, phone, role, status, password_updated_at')
      .or(`normalized_email.eq.${quoted},email.ilike.${quoted}`)
      .maybeSingle();

    if (error) {
      logServerError('[Supabase PostgREST] findUserByEmail error', error, { email: canonicalEmail });
      return { kind: 'error' };
    }
    if (!data) return { kind: 'absent' };
    const fallback = deriveSubdomainFromEmail(canonicalEmail);
    const subdomain = await findWorkspaceSubdomainByOwner(supabase, data.id, fallback);
    const rawPasswordUpdatedAt = (data as { password_updated_at?: string | null }).password_updated_at;
    const passwordUpdatedAt = rawPasswordUpdatedAt
      ? Math.floor(new Date(rawPasswordUpdatedAt).getTime() / 1000)
      : undefined;
    return {
      kind: 'found',
      user: { ...(data as object), subdomain, passwordUpdatedAt } as AuthUser,
    };
  } catch (err) {
    logServerError('[Supabase PostgREST] findUserByEmail exception', err, { email: canonicalEmail });
    return { kind: 'error' };
  }
}

/**
 * User lookup that distinguishes failure from absence. Used by the
 * global session check (`validateSessionDetailed`): a lookup error
 * must surface as a server error, never as "no user" (which would
 * become a false 401). Canonicalisation failure counts as absence
 * (no valid email to look up), matching the legacy behaviour.
 */
export async function findUserByEmailDetailed(emailInput: string): Promise<UserLookupResult> {
  let canonicalEmail: string;
  try {
    canonicalEmail = resolveCanonicalEmail(emailInput);
  } catch {
    return { kind: 'absent' };
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    return querySupabaseUser(supabase, canonicalEmail);
  }

  if (process.env.NODE_ENV === 'production') {
    return { kind: 'absent' };
  }

  const local =
    localUserStore.get(canonicalEmail) || localUserStore.get(emailInput.trim().toLowerCase());
  return local ? { kind: 'found', user: local } : { kind: 'absent' };
}

/**
 * Resilient multi-runtime user lookup:
 * 1. Checks Supabase PostgREST over HTTPS when Supabase client is available.
 * 2. Falls back to in-memory test store without throwing unhandled network exceptions in test environments.
 *
 * Legacy wrapper over `findUserByEmailDetailed`, preserving its exact
 * observable behaviour for existing callers (login, signup, password
 * reset, resend-OTP): a lookup error or absence falls through to
 * `null` in production, or to the local test store otherwise.
 */
export async function findUserByEmail(emailInput: string): Promise<AuthUser | null> {
  let canonicalEmail: string;
  try {
    canonicalEmail = resolveCanonicalEmail(emailInput);
  } catch {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const result = await querySupabaseUser(supabase, canonicalEmail);
    if (result.kind === 'found') return result.user;
    // error/absent fall through exactly as before.
  }

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return localUserStore.get(canonicalEmail) || localUserStore.get(emailInput.trim().toLowerCase()) || null;
}
