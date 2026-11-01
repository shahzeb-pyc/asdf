import { cache } from 'react';
import { getServerSessionContext } from '@/lib/auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { reportError } from '@/lib/report-error';

/**
 * Server-only: resolve a tenant workspace's identity for a subdomain.
 *
 * The cached unit is the workspace ROW lookup (spec 130 §5.8,
 * discharging spec 137 §11(b)): within one request the tenant layout's
 * `generateMetadata`, the layout body, the workspace home page's hero
 * name AND the home page's data loader share ONE session lookup + ONE
 * Supabase query instead of performing the same lookup repeatedly.
 * `getWorkspaceDisplayName` is a thin, uncached wrapper over the cached
 * resolver — wrapping it separately would create a second cache entry
 * and a second lookup. Callers that need the id use
 * `getWorkspaceIdentity` directly; it resolves through the same entry.
 *
 * Failure contract (named and tested, not a silent swallow): a failed
 * lookup is reported through the `reportError` seam and resolves to
 * null — it never throws into render, so a lookup outage degrades to
 * the subdomain-slug fallback instead of breaking the shell.
 */
export type WorkspaceIdentity = {
  id: string | null;
  name: string | null;
};

const resolveWorkspaceIdentity = cache(
  async (subdomain: string): Promise<WorkspaceIdentity | null> => {
    try {
      const supabase = getSupabaseAdminClient();
      if (!supabase) return null;
      const session = await getServerSessionContext();
      let query = supabase
        .from('workspaces')
        .select('id, name')
        .eq('subdomain', subdomain);
      if (session?.userId) {
        query = query.eq('owner_id', session.userId);
      }
      const { data } = await query.maybeSingle();
      const row = data as { id?: unknown; name?: unknown } | null;
      if (!row) return null;
      return {
        id: typeof row.id === 'string' && row.id ? row.id : null,
        name: typeof row.name === 'string' && row.name.trim() ? row.name : null,
      };
    } catch (error) {
      reportError(error, { source: 'workspace-display-name' });
      return null;
    }
  },
);

export const getWorkspaceIdentity = resolveWorkspaceIdentity;

/**
 * Server-only: resolve the workspace display name for a tenant subdomain.
 * Returns null when the lookup fails — callers fall back to the subdomain.
 */
export async function getWorkspaceDisplayName(
  subdomain: string,
): Promise<string | null> {
  const workspace = await resolveWorkspaceIdentity(subdomain);
  return workspace?.name ?? null;
}
