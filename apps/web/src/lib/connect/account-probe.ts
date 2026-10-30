/**
 * Early revocation surfacing (audit BG20).
 *
 * A Facebook-side revocation is otherwise invisible until a
 * publish fails: the stored token still has a future
 * token_expires_at, so the account reads "Connected". The cheap,
 * explicit probes are discover and import — both already call
 * Graph /me/accounts with the user token, so a dead token there
 * is a real signal, not an extra round-trip. The accounts LIST
 * deliberately does NOT probe: one Graph call per listed account
 * on every render would hammer Graph for a read that already
 * surfaces the last-known status (with the worker refresh job's
 * lapse detection as backstop). List therefore shows last-known
 * status; discover/import mark, and the next list render shows
 * the error card with Reconnect.
 *
 * Marking rules: only an auth-class Graph failure (400/401/403
 * — revoked, expired, or invalid token) marks the account. A
 * 5xx or network failure is transient and must never flip
 * status. Only 'active'/'expired' rows are flipped: a 'revoked'
 * account (BG10 intentional disconnect) keeps its meaning, and
 * an already-'error' row stays 'error'. Best-effort throughout
 * — a marking failure is logged, never thrown, so it can never
 * turn a discover/import failure into a different failure.
 */
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';

/** Graph statuses that mean the user token itself is dead. */
export function isTokenDeadGraphStatus(status: unknown): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** Best-effort: flip an active/expired account to 'error'. */
export async function markAccountConnectionError(
  client: DatabaseClient | SupabaseClient | null | undefined,
  workspaceId: string,
  accountId: string
): Promise<void> {
  try {
    if (
      client &&
      'query' in client &&
      typeof (client as DatabaseClient).query === 'function'
    ) {
      await (client as DatabaseClient).query(
        `UPDATE social_accounts SET status = 'error', updated_at = now()
         WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'
           AND status IN ('active', 'expired')`,
        [accountId, workspaceId]
      );
      return;
    }
    const supabase = (
      client && 'from' in client ? client : getSupabaseAdminClient()
    ) as SupabaseClient | null;
    if (!supabase) return;
    const { error } = await supabase
      .from('social_accounts')
      .update({ status: 'error', updated_at: new Date().toISOString() })
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .in('status', ['active', 'expired']);
    if (error) throw error;
  } catch (err) {
    logServerError(
      '[account-probe] Failed to mark account connection error',
      err,
      { source: 'account-probe', accountId }
    );
  }
}
