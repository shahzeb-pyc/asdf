import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logServerError } from '@/lib/server-analytics';

/**
 * Recompute a destination's `metadata.unmatched_post_types` flag via
 * the `refresh_destination_unmatched_flag` RPC (queued post formats
 * no active posting time allows, preserving every other metadata
 * key). Call after every change that can move the flag: slot
 * add/update/delete/toggle, enqueue, retry, and publish.
 *
 * Best-effort by design: the flag is advisory, so a refresh failure
 * is logged loudly but must never fail the mutation that triggered
 * it — the next slot/enqueue/publish event refreshes it again.
 */
export async function refreshDestinationUnmatchedFlag(
  client: DatabaseClient | SupabaseClient,
  destinationId: string
): Promise<void> {
  try {
    if ('query' in client && typeof (client as DatabaseClient).query === 'function') {
      await (client as DatabaseClient).query(
        'SELECT public.refresh_destination_unmatched_flag($1)',
        [destinationId]
      );
      return;
    }
    const supabase = client as SupabaseClient;
    if (typeof supabase.rpc === 'function') {
      const { error } = await supabase.rpc('refresh_destination_unmatched_flag', {
        p_destination_id: destinationId,
      });
      if (error) throw error;
    }
  } catch (err) {
    logServerError(
      '[unmatched-flag] Failed to refresh unmatched_post_types',
      err,
      { source: 'unmatched-flag', destinationId }
    );
  }
}
