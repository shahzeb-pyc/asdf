export { isThreadsSchedulePaused } from '@fbuploadpro/contracts';
import {
  THREADS_SCHEDULE_FORMATS,
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
 * Schedule membership lives on the `section` column of the existing
 * `destinations` row (spec 174 Phase 4): a row is in Schedule exactly
 * when its section is 'schedule' and it is not a removed stub. The old
 * `metadata.threads_schedule_added_at` flag is no longer read anywhere
 * — it stays in stored metadata, unread. Every query here is
 * workspace-scoped and bounded: list reads page through destinations
 * in 1,000-row chunks (PostgREST's silent cap) and counts come from
 * head/count queries, never from downloading rows.
 */

export interface ThreadsScheduleDestinationRow {
  id: string;
  account_id: string;
  platform: string;
  section: string | null;
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

/**
 * True when the destination is a member of Threads Schedule as the list
 * shows it (spec 174 Phase 4). Membership is the section column alone:
 * a row the user removed from Schedule is a disconnected stub (status
 * 'disconnected') and is NOT a member, even though its section is
 * still 'schedule' — the stub stays saved but disappears from the
 * list, per the removal rule. A paused row is a member: pause also
 * stores status 'disconnected', but keeps the paused marker. The old
 * added-at flag is no longer read: a disconnected row without the
 * paused marker is not a member, whether or not the flag is set.
 * Connection-died rows are status 'error' (expiry propagation), not
 * 'disconnected', so they stay members through the status branch.
 */
export function isThreadsScheduleListMember(destination: Pick<
  ThreadsScheduleDestinationRow,
  'section' | 'status' | 'metadata'
>): boolean {
  if (destination.section !== 'schedule') return false;
  if (destination.status !== 'disconnected') return true;
  return isThreadsSchedulePaused(destination.metadata);
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
        'id, account_id, platform, section, external_destination_id, name, handle, avatar_url, timezone, status, metadata, created_at, updated_at'
      )
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .eq('section', 'schedule')
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as ThreadsScheduleDestinationRow[];
    rows.push(...page);
    if (page.length < CHUNK) break;
  }
  // Membership is the section column now (spec 174 Phase 4), with
  // removed stubs excluded — see isThreadsScheduleListMember. The
  // old added-at flag stays in stored metadata, unread.
  return rows.filter((row) => isThreadsScheduleListMember(row));
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
  // Spec 174 Phase 4: the old added-at flag is no longer read. The
  // wire field stays (same shape), and now always equals the row's
  // creation time — for rows created by import these are the same
  // instant; for pre-split rows it shows the row creation date
  // instead of the schedule-add date.
  const addedAt = new Date(destination.created_at);
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
