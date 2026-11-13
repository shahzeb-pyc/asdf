import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared ADU hub helpers (Stream D, F22 + F23).
 *
 * One home for the helpers that were copied verbatim into all three
 * hub list routes (`statusFilterToValue`) and all three hub pages
 * (`getAduStatusMarkKind`), plus the one paged options loader the
 * Instagram and Threads options routes share (`loadAduOptionsListsForPlatform`).
 *
 * This file is deliberately framework-neutral and imports nothing
 * from `@/lib/server/adu`: the hub pages are client components, and
 * importing that module here would drag its server-only code
 * (decrypt, billing, Graph) into the client bundle. The 42P01
 * missing-table check below is therefore a local code comparison,
 * not the imported `aduMissingTable`.
 */

/**
 * Maps a hub status-filter label (the label the filter dropdown
 * shows) to the `adu_configs.status` value it filters on. Unknown
 * labels map to null — no filter, never a wrong filter.
 */
export function statusFilterToValue(filter: string): string | null {
  const map: Record<string, string> = {
    Active: 'active',
    Paused: 'paused',
    'Verification Req.': 'fb_verification_required',
    'Rate Limited': 'fb_rate_limited',
    'Page Not Accessible': 'page_not_accessible',
    'Invalid Token': 'invalid_token',
    'Invalid Username': 'invalid_username',
    'Creator Suspended': 'creator_suspended',
    Completed: 'completed',
    '2FA Req. on BM': '2fa_required_on_BM',
    'Check Dev App': 'check_developer_app',
    'Account Suspended': 'account_suspended',
    'Missing Page Access': 'missing_page_access',
    'Missing Permission': 'missing_permission',
  };
  return map[filter] ?? null;
}

export type AduStatusMarkKind = 'operational' | 'queued' | 'critical';

/**
 * Maps an ADU display status (the label `aduDisplayStatus` produces)
 * to a shared `StatusMark` kind, following page-card's kind
 * semantics: operational = healthy, queued = waiting, critical =
 * needs attention. Unknown labels map to critical — an unexpected
 * value must never read as healthy.
 *
 * - operational: 'Active posting' (active), 'All reels posted'
 *   (completed — a healthy terminal state, nothing wrong).
 * - queued: 'Scrape pending' (pending/browser_pending),
 *   'Scraping reels' (processing), 'Paused' (paused — paused, like
 *   page-card's paused → queued).
 * - critical: everything else — 'Source not found' (sync error),
 *   'Verification required', 'Invalid token', 'Rate limited',
 *   'Page not accessible', 'Source disabled', 'Creator suspended',
 *   'BM 2FA required', 'Check developer app', 'Account suspended',
 *   'Missing page access', 'Missing permission'.
 */
export function getAduStatusMarkKind(displayStatus: string): AduStatusMarkKind {
  if (displayStatus === 'Active posting' || displayStatus === 'All reels posted') {
    return 'operational';
  }
  if (
    displayStatus === 'Scrape pending' ||
    displayStatus === 'Scraping reels' ||
    displayStatus === 'Paused'
  ) {
    return 'queued';
  }
  return 'critical';
}

export interface AduOptionsLists {
  accounts: Array<Record<string, unknown>>;
  destinations: Array<Record<string, unknown>>;
  configured: Array<Record<string, unknown>>;
  migrationMissing: boolean;
}

interface PageResult<T> {
  data: T[] | null;
  error: { message?: string; code?: string } | null;
}

/**
 * PostgREST silently truncates an unbounded select at 1,000 rows, so a
 * picker that loads "all" accounts/pages/configs drops rows past 1,000
 * with no error. Range pages (deterministic order, 1,000/page) keep
 * every row reachable at any workspace size. Same pattern as
 * `loadAduOptionsLists` in `@/lib/server/adu` — duplicated here
 * (not imported) because this file must stay importable from client
 * components; F1 owns the collapse of the two loaders.
 */
async function selectAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; error: PageResult<T>['error'] }> {
  const rows: T[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, error: null };
  }
}

function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01';
}

/**
 * Accounts + destinations + already-configured ADU rows for one
 * platform's Add picker (Instagram or Threads). Throws on any fatal
 * load failure (the route turns it into a 500) — a transient database
 * error must never render as an empty picker that invites duplicate
 * adds. A missing adu_configs table is NOT fatal: the picker still
 * shows accounts and destinations, flagged with migrationMissing, so
 * the UI can say why adding is unavailable instead of failing the
 * whole picker. Same contract as FB's `loadAduOptionsLists`, except
 * the destinations select carries no section filter: the routes
 * dedupe across sections, preferring the adu copy.
 */
export async function loadAduOptionsListsForPlatform(
  supabase: SupabaseClient,
  workspaceId: string,
  platform: 'instagram' | 'threads',
): Promise<AduOptionsLists> {
  // The three selects are independent — run them concurrently.
  // Error precedence is accounts first, then destinations, then
  // configured.
  const [accounts, destinations, configured] = await Promise.all([
    selectAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from('social_accounts')
        .select('id, external_account_id, display_name, avatar_url, status')
        .eq('workspace_id', workspaceId)
        .eq('platform', platform)
        .order('display_name')
        .range(from, to),
    ),
    selectAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from('destinations')
        .select('id, account_id, external_destination_id, name, avatar_url, status, metadata, section')
        .eq('workspace_id', workspaceId)
        .eq('platform', platform)
        .order('name')
        .range(from, to),
    ),
    selectAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from('adu_configs')
        .select('destination_id, source_platform, source_username')
        .eq('workspace_id', workspaceId)
        .order('destination_id')
        .range(from, to),
    ),
  ]);
  if (accounts.error) {
    throw new Error(accounts.error.message ?? 'Could not load accounts.');
  }
  if (destinations.error) {
    throw new Error(destinations.error.message ?? 'Could not load destinations.');
  }
  if (configured.error) {
    if (isMissingTable(configured.error)) {
      return {
        accounts: accounts.rows,
        destinations: destinations.rows,
        configured: [],
        migrationMissing: true,
      };
    }
    throw new Error(configured.error.message ?? 'Could not load configured accounts.');
  }
  return {
    accounts: accounts.rows,
    destinations: destinations.rows,
    configured: configured.rows,
    migrationMissing: false,
  };
}
