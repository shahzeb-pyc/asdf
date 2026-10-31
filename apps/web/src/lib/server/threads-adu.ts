import { type NextRequest, NextResponse } from 'next/server';
import {
  threadsAduStatusAlert,
  type AduConfigRow,
  type AduSyncStatus,
} from '@fbuploadpro/contracts';
import {
  aduContext,
  aduMissingTable,
  buildAduConfigView,
  type AduConfigView,
  type AduContext,
} from '@/lib/server/adu';
import type { SupabaseClient } from '@supabase/supabase-js';

export { aduMissingTable as threadsAduMissingTable };

/**
 * Threads Auto Download/Upload server helpers.
 *
 * A Threads ADU config is an adu_configs row whose destination is a
 * Threads destination in the same workspace. Every helper here enforces
 * that: a Facebook config id, or a config from another workspace, reads
 * as "not found" on every Threads route, so Threads routes can never
 * read, edit, delete or re-queue a Facebook config (and vice versa —
 * the Facebook routes never see Threads configs because they filter
 * destinations to platform='facebook' on create and, for the hub, the
 * Threads RPCs below are separate).
 *
 * The Facebook view builder is reused for counts (bounded count
 * queries, never whole-table loads); only the wording is Threads:
 * the fallback destination name and the status alert come from the
 * Threads alert function in contracts, never the Facebook one.
 */
export async function threadsAduContext(
  request: NextRequest,
  subdomain: string
): Promise<
  | { context: AduContext }
  | { errorResponse: NextResponse }
> {
  return aduContext(request, subdomain);
}

interface ThreadsDestinationRow {
  id: string;
  workspace_id: string;
  platform: string;
  account_id: string;
}

export async function loadThreadsAduDestination(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string
): Promise<{ config: AduConfigRow; destination: ThreadsDestinationRow } | null> {
  const { data: config, error } = await supabase
    .from('adu_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', configId)
    .maybeSingle();
  if (error || !config) return null;
  const { data: destination, error: destError } = await supabase
    .from('destinations')
    .select('id, workspace_id, platform, account_id')
    .eq('id', (config as AduConfigRow).destination_id)
    .maybeSingle();
  if (destError || !destination) return null;
  const dest = destination as ThreadsDestinationRow;
  if (dest.platform !== 'threads' || dest.workspace_id !== workspaceId) return null;
  return { config: config as AduConfigRow, destination: dest };
}

export async function loadThreadsAduConfigView(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string
): Promise<AduConfigView | null> {
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, configId);
  if (!scoped) return null;
  const view = await buildAduConfigView(supabase, scoped.config);
  return {
    ...view,
    destinationName:
      view.destinationName === 'Facebook Page' ? 'Threads account' : view.destinationName,
    alert: threadsAduStatusAlert(view.status, view.syncStatus as AduSyncStatus),
  };
}
