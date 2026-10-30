/**
 * Account-expiry propagation (Facebook Accounts audit, BG1/BG2/BG4).
 *
 * Whenever a social_accounts row flips to 'expired', every destination
 * belonging to that account that is currently 'active' becomes
 * 'error' — the existing destination status for a broken token
 * (Schema B: no new page status is introduced). This is what lets the
 * existing page-status gates do their work without a new per-path
 * account check: queueing, slot claiming, and publishing already
 * refuse non-'active' destinations.
 *
 * Idempotent by construction: only 'active' rows are flipped, so
 * re-running propagation after it already ran changes nothing.
 * Destinations that are NOT 'active' are untouched, which is what
 * protects paused pages (stored as 'disconnected' + the
 * metadata fb_status='paused' marker), plain 'disconnected' pages,
 * pages already in 'error', and 'rate_limited' pages. On reconnect,
 * the existing page-token refresh flips 'error' destinations back to
 * 'active' only when Facebook returns a fresh token for them, so a
 * propagated page reactivates exactly like any other broken-token
 * page — never blindly.
 *
 * Dual-client like the rest of the tenant API: the legacy
 * `DatabaseClient` (SQL) path exists for the test harness and the
 * Supabase path is what production runs. The database trigger in the
 * companion migration is the safety net for flips that happen inside
 * SQL (e.g. the settle RPC), where this helper cannot run; calling
 * this helper as well is deliberate duplication, not a bug — the
 * trigger makes the second pass a no-op.
 */
import type { DatabaseClient } from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';

type PropagationClient = DatabaseClient | SupabaseClient | null | undefined;

/**
 * Flip an expired account's 'active' destinations to 'error'.
 * Returns the number of destinations flipped. Throws on a database
 * error — callers that run this as a best-effort side effect (e.g.
 * the accounts-list expired sync) must catch and log, never let a
 * propagation failure fail the request that triggered it.
 */
export async function propagateExpiredAccountDestinations(
  client: PropagationClient,
  accountId: string
): Promise<number> {
  if (client && 'query' in client && typeof client.query === 'function') {
    const rows = (await (client as DatabaseClient).query(
      `UPDATE destinations
       SET status = 'error', updated_at = now()
       WHERE account_id = $1 AND status = 'active'
       RETURNING id`,
      [accountId]
    )) as Array<{ id: string }>;
    return Array.isArray(rows) ? rows.length : 0;
  }

  const supabase = (
    client && 'from' in client ? client : getSupabaseAdminClient()
  ) as SupabaseClient | null;
  if (!supabase) return 0;
  const { data, error } = await supabase
    .from('destinations')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('status', 'active')
    .select('id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.length : 0;
}

export interface RevocationPropagationResult {
  /** Destinations flipped from 'active' to 'error' by this pass. */
  destinationsFlipped: number;
  /** Queued items on the flipped destinations moved to 'cancelled'. */
  itemsCancelled: number;
}

/**
 * Revocation propagation (launch prep, P0-2): the platform-initiated
 * counterpart of expiry propagation. When a social_accounts row is
 * marked 'revoked' (the user removed the app on Facebook's side),
 * every destination belonging to that account that is currently
 * 'active' becomes 'error' — the same broken-token status expiry
 * uses — and the queued items sitting on exactly those flipped
 * destinations become 'cancelled', so nothing they held can go out
 * later or loop forever as "queued".
 *
 * Queued items on destinations that were NOT flipped are untouched:
 * paused pages (stored as 'disconnected' + marker) keep their queue
 * for a later resume, and already-'error'/'disconnected' pages keep
 * whatever their own state implies. Idempotent by construction: only
 * 'active' destinations flip, and only queued items on flipped
 * destinations cancel, so re-running propagation changes nothing.
 *
 * Throws on a database error, like propagateExpiredAccountDestinations
 * — callers running this as a best-effort side effect of a platform
 * callback (which must still answer 200) must catch and log loudly,
 * never let a propagation failure fail the callback itself.
 */
export async function propagateRevokedAccount(
  client: PropagationClient,
  accountId: string
): Promise<RevocationPropagationResult> {
  if (client && 'query' in client && typeof client.query === 'function') {
    const db = client as DatabaseClient;
    const destRows = (await db.query(
      `UPDATE destinations
       SET status = 'error', updated_at = now()
       WHERE account_id = $1 AND status = 'active'
       RETURNING id`,
      [accountId]
    )) as Array<{ id: string }>;
    const destinationIds = Array.isArray(destRows)
      ? destRows.map((row) => row.id).filter(Boolean)
      : [];
    if (destinationIds.length === 0) {
      return { destinationsFlipped: 0, itemsCancelled: 0 };
    }
    const itemRows = (await db.query(
      `UPDATE queue_items
       SET status = 'cancelled', updated_at = now()
       WHERE status = 'queued' AND destination_id = ANY($1)
       RETURNING id`,
      [destinationIds]
    )) as Array<{ id: string }>;
    return {
      destinationsFlipped: destinationIds.length,
      itemsCancelled: Array.isArray(itemRows) ? itemRows.length : 0,
    };
  }

  const supabase = (
    client && 'from' in client ? client : getSupabaseAdminClient()
  ) as SupabaseClient | null;
  if (!supabase) return { destinationsFlipped: 0, itemsCancelled: 0 };
  const { data, error } = await supabase
    .from('destinations')
    .update({ status: 'error', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('status', 'active')
    .select('id');
  if (error) throw new Error(error.message);
  const destinationIds = Array.isArray(data)
    ? (data as Array<{ id: string }>).map((row) => row.id).filter(Boolean)
    : [];
  if (destinationIds.length === 0) {
    return { destinationsFlipped: 0, itemsCancelled: 0 };
  }
  const { data: itemData, error: itemError } = await supabase
    .from('queue_items')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('status', 'queued')
    .in('destination_id', destinationIds)
    .select('id');
  if (itemError) throw new Error(itemError.message);
  return {
    destinationsFlipped: destinationIds.length,
    itemsCancelled: Array.isArray(itemData) ? itemData.length : 0,
  };
}
