export {
  isThreadsScheduleAdded,
  isThreadsSchedulePaused,
} from '@fbuploadpro/contracts';
import {
  THREADS_SCHEDULE_FORMATS,
  isThreadsScheduleAdded,
  isThreadsSchedulePaused,
  threadsScheduleStatusFromRows,
  type ThreadsScheduleFormat,
  type ThreadsScheduleItem,
  type ThreadsScheduleQueueCounts,
  type ThreadsScheduleStatus,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared server helpers for Threads In-app Schedule.
 *
 * Schedule membership lives on the existing `destinations` row
 * (metadata.threads_schedule_added_at), never in a new table. Every
 * query here is workspace-scoped and bounded: list reads page through
 * destinations in 1,000-row chunks (PostgREST's silent cap) and counts
 * come from head/count queries, never from downloading rows.
 */

export interface ThreadsScheduleDestinationRow {
  id: string;
  account_id: string;
  platform: string;
  external_destination_id: string;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  timezone: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadsScheduleAccountRow {
  id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  token_expires_at: string | null;
}

export function threadsProfileUrl(handle: string | null): string | null {
  if (!handle || !handle.trim()) return null;
  return `https://threads.com/@${encodeURIComponent(handle.trim())}`;
}

export function isAccountExpired(row: {
  status: string;
  token_expires_at: string | null;
}): boolean {
  if (row.status === 'expired') return true;
  if (row.token_expires_at === null) return false;
  return Date.parse(row.token_expires_at) <= Date.now();
}

export function scheduleStatusFor(
  destination: ThreadsScheduleDestinationRow,
  account: ThreadsScheduleAccountRow | null
): ThreadsScheduleStatus {
  return threadsScheduleStatusFromRows({
    destinationStatus: destination.status,
    paused: isThreadsSchedulePaused(destination.metadata),
    accountExpired: account ? isAccountExpired(account) : false,
  });
}

export async function fetchScheduleDestinations(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<ThreadsScheduleDestinationRow[]> {
  const rows: ThreadsScheduleDestinationRow[] = [];
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await supabase
      .from('destinations')
      .select(
        'id, account_id, platform, external_destination_id, name, handle, avatar_url, timezone, status, metadata, created_at, updated_at'
      )
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ThreadsScheduleDestinationRow[];
    rows.push(...page);
    if (page.length < CHUNK) break;
  }
  return rows.filter((row) => isThreadsScheduleAdded(row.metadata));
}

export async function fetchThreadsAccountsById(
  supabase: SupabaseClient,
  workspaceId: string,
  accountIds: string[]
): Promise<Map<string, ThreadsScheduleAccountRow>> {
  const map = new Map<string, ThreadsScheduleAccountRow>();
  if (accountIds.length === 0) return map;
  // Bounded: account lists are small, but chunk anyway so a large
  // workspace never builds an unbounded `in` list.
  for (let i = 0; i < accountIds.length; i += 100) {
    const chunk = accountIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from('social_accounts')
      .select(
        'id, external_account_id, display_name, avatar_url, status, token_expires_at'
      )
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .in('id', chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as ThreadsScheduleAccountRow[]) {
      map.set(row.id, row);
    }
  }
  return map;
}

export async function fetchQueueCounts(
  supabase: SupabaseClient,
  workspaceId: string,
  destinationId: string
): Promise<{ counts: ThreadsScheduleQueueCounts; error: boolean }> {
  const countFor = async (status: string): Promise<number | null> => {
    const { count, error } = await supabase
      .from('queue_items')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('destination_id', destinationId)
      .eq('status', status);
    if (error) return null;
    return count ?? 0;
  };
  const [queued, posted, failed] = await Promise.all([
    countFor('queued'),
    countFor('published'),
    countFor('failed'),
  ]);
  if (queued === null || posted === null || failed === null) {
    return {
      counts: { queued: 0, posted: 0, failed: 0 },
      error: true,
    };
  }
  return { counts: { queued, posted, failed }, error: false };
}

export function toScheduleItem(
  destination: ThreadsScheduleDestinationRow,
  account: ThreadsScheduleAccountRow | null,
  counts: ThreadsScheduleQueueCounts,
  countsError: boolean
): ThreadsScheduleItem {
  const addedAtRaw = destination.metadata?.['threads_schedule_added_at'];
  const addedAt =
    typeof addedAtRaw === 'string' && addedAtRaw
      ? new Date(addedAtRaw)
      : new Date(destination.created_at);
  return {
    id: destination.id,
    accountId: destination.account_id,
    accountDisplayName: account?.display_name ?? destination.name,
    threadsAccountId: account?.external_account_id ?? destination.external_destination_id,
    name: destination.name,
    handle: destination.handle,
    profilePictureUrl: destination.avatar_url,
    accountLink: threadsProfileUrl(destination.handle),
    timezone: destination.timezone,
    status: scheduleStatusFor(destination, account),
    queueCounts: counts,
    queueCountsError: countsError || undefined,
    addedAt,
    createdAt: new Date(destination.created_at),
    updatedAt: new Date(destination.updated_at),
  };
}

/** Slot kind values filtered to what Threads supports. */
export function threadsFormatsFromKind(kind: unknown): ThreadsScheduleFormat[] {
  if (!Array.isArray(kind)) return [...THREADS_SCHEDULE_FORMATS];
  const kept = kind.filter(
    (value): value is ThreadsScheduleFormat =>
      typeof value === 'string' &&
      (THREADS_SCHEDULE_FORMATS as readonly string[]).includes(value)
  );
  return kept.length > 0 ? kept : [...THREADS_SCHEDULE_FORMATS];
}

export function slotTimeToHHMM(timeOfDay: string): string {
  return timeOfDay.slice(0, 5);
}
