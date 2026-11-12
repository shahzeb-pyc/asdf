/**
 * Account disconnect (spec 174 PR 2A): disconnect + strip, never delete.
 *
 * Owner decision (spec §9 Q2, decided 2026-11-12): deleting/
 * disconnecting an account keeps the account row as a DISCONNECTED
 * record (never deleted), with `ON DELETE RESTRICT` on
 * `destinations.account_id` as the backstop, AND every section's copy
 * of every page becomes a disconnected stub (identity + followers +
 * section kept, all working data removed). This replaces the old
 * launch-prep hard delete (account row deleted, destinations
 * cascaded away with their posting slots, queue items and publish
 * logs).
 *
 * The strip mirrors the 1B page-disconnect strip
 * (`pages/[pageId]/route.ts` DELETE) per copy: queued posts are
 * cancelled first (a cancel failure leaves the copy untouched, so a
 * retry is clean), posting times are deleted, then the row is
 * stripped — status `disconnected`, token NULL, timezone `UTC`,
 * `fb_status` + `tasks` removed from metadata. Identity, followers
 * and the section stay on the row. ADU configs and mirror rows are
 * NOT deleted (same as 1B): they attach to the disconnected stub and
 * are inert while the account is disconnected; a reconnect
 * reactivates the copy and they resume.
 *
 * Both client shapes are supported (legacy SQL + Supabase), like
 * `lib/connect/persist.ts`. Every step fails loud: a half-
 * disconnected account is worse than a clear failure, and the
 * caller retries cleanly (the strip is idempotent — re-running it
 * on an already-stripped copy is a no-op).
 */
import {
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { PAUSED_MARKER_KEY } from '@/lib/server/facebook-wire';
import type {
  DatabaseClient,
  Platform,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConnectDbClient } from './persist';

/** One destinations row as the strip needs it. */
interface CopyRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Strip every destinations copy belonging to one account (all
 * sections, all platforms of that account row) to a disconnected
 * stub. Returns how many copies were stripped. Throws on any
 * database failure.
 */
export async function stripDestinationCopiesForAccount(
  client: ConnectDbClient,
  workspaceId: string,
  accountId: string,
  platform: Platform
): Promise<{ stripped: number }> {
  if (isLegacyClient(client ?? undefined)) {
    const legacy = client as DatabaseClient;
    // Load the copy ids first (the count comes from the strip's
    // RETURNING, not from a separate count query).
    const idRows = (await legacy.query(
      `SELECT id FROM destinations
       WHERE account_id = $1 AND workspace_id = $2 AND platform = $3`,
      [accountId, workspaceId, platform]
    )) as Array<{ id?: unknown }>;
    const ids = (idRows ?? [])
      .map((r) => (typeof r.id === 'string' ? r.id : null))
      .filter((id): id is string => id !== null);
    if (ids.length === 0) return { stripped: 0 };

    // Cancel queued posts FIRST (1B strip order): a cancel failure
    // leaves every copy untouched, so a retry is clean.
    await legacy.query(
      `UPDATE queue_items
       SET status = 'cancelled', updated_at = now()
       WHERE workspace_id = $1 AND destination_id = ANY($2::uuid[])
         AND status = 'queued'`,
      [workspaceId, ids]
    );
    await legacy.query(
      `DELETE FROM posting_slots WHERE destination_id = ANY($1::uuid[])`,
      [ids]
    );
    const stripped = (await legacy.query(
      `UPDATE destinations
       SET status = 'disconnected',
           encrypted_destination_token = NULL,
           timezone = 'UTC',
           metadata = metadata - 'fb_status' - 'tasks',
           updated_at = now()
       WHERE account_id = $1 AND workspace_id = $2 AND platform = $3
       RETURNING id`,
      [accountId, workspaceId, platform]
    )) as Array<Record<string, unknown>>;
    return { stripped: stripped?.length ?? 0 };
  }

  const supabase = getRouteSupabase(client ?? undefined) as SupabaseClient | null;
  if (!supabase) {
    throw new Error('Database service unavailable');
  }
  // Page the copies (PostgREST silently truncates past 1,000 rows).
  const copies: CopyRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('destinations')
      .select('id, metadata')
      .eq('account_id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', platform)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) {
      throw new Error(`Failed to load account destinations: ${error.message}`);
    }
    const page = (data ?? []) as CopyRow[];
    copies.push(...page);
    if (page.length < 1000) break;
  }
  if (copies.length === 0) return { stripped: 0 };
  const ids = copies.map((c) => c.id);

  // Cancel queued posts FIRST (1B strip order).
  const { error: cancelError } = await supabase
    .from('queue_items')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .in('destination_id', ids)
    .eq('status', 'queued');
  if (cancelError) {
    throw new Error(`Failed to cancel queued posts: ${cancelError.message}`);
  }
  const { error: slotsError } = await supabase
    .from('posting_slots')
    .delete()
    .in('destination_id', ids);
  if (slotsError) {
    throw new Error(`Failed to delete posting times: ${slotsError.message}`);
  }
  // One update per copy: the metadata strip differs per row.
  let stripped = 0;
  for (const copy of copies) {
    const nextMetadata = { ...(copy.metadata ?? {}) };
    delete nextMetadata[PAUSED_MARKER_KEY];
    delete nextMetadata.tasks;
    const { data, error } = await supabase
      .from('destinations')
      .update({
        status: 'disconnected',
        encrypted_destination_token: null,
        timezone: 'UTC',
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', copy.id)
      .eq('workspace_id', workspaceId)
      .eq('platform', platform)
      .select('id');
    if (error) {
      throw new Error(`Failed to disconnect destination: ${error.message}`);
    }
    stripped += data?.length ?? 0;
  }
  return { stripped };
}

/**
 * Disconnect the account row itself: status `disconnected`, both
 * tokens NULL, expiry NULL, `updated_at` now. The row is RETAINED —
 * never deleted. Returns false when no such account row exists
 * (the caller turns that into a 404). Throws on a database failure.
 */
export async function disconnectAccountRow(
  client: ConnectDbClient,
  workspaceId: string,
  accountId: string,
  platform: Platform
): Promise<boolean> {
  if (isLegacyClient(client ?? undefined)) {
    const legacy = client as DatabaseClient;
    const rows = (await legacy.query(
      `UPDATE social_accounts
       SET status = 'disconnected',
           encrypted_access_token = NULL,
           encrypted_refresh_token = NULL,
           token_expires_at = NULL,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND platform = $3
       RETURNING id`,
      [accountId, workspaceId, platform]
    )) as Array<Record<string, unknown>>;
    return (rows?.length ?? 0) > 0;
  }

  const supabase = getRouteSupabase(client ?? undefined) as SupabaseClient | null;
  if (!supabase) {
    throw new Error('Database service unavailable');
  }
  const { data, error } = await supabase
    .from('social_accounts')
    .update({
      status: 'disconnected',
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      token_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .select('id');
  if (error) {
    throw new Error(`Failed to disconnect account: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}
