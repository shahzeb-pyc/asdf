import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Shared ADU hub helpers (Stream D, F22 + F23).
 *
 * One home for the helpers that were copied verbatim into all three
 * hub list routes (`statusFilterToValue`) and all three hub pages
 * (`getAduStatusMarkKind`), plus the one paged options loader the
 * three options routes share (`loadAduOptionsListsForPlatform` —
 * F21 collapsed Facebook's `loadAduOptionsLists` into it; this file
 * is the single copy of the range pager now).
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
 * every row reachable at any workspace size. This is the single copy
 * of the pager (F21 deleted the duplicate in `@/lib/server/adu` when
 * Facebook's loader was collapsed into `loadAduOptionsListsForPlatform`
 * below); this file must stay importable from client components, so it
 * imports nothing from `@/lib/server/adu`.
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
 * platform's Add picker. Throws on any fatal load failure (the route
 * turns it into a 500) — a transient database error must never render
 * as an empty picker that invites duplicate adds. A missing
 * adu_configs table is NOT fatal: the picker still shows accounts and
 * destinations, flagged with migrationMissing, so the UI can say why
 * adding is unavailable instead of failing the whole picker.
 *
 * Platform contract: Instagram/Threads return destinations from every
 * section and the routes dedupe across sections, preferring the adu
 * copy. Facebook keeps its old contract — only adu-section pages
 * (the old `loadAduOptionsLists` filtered section='adu'), returned
 * under `destinations` (the Facebook options route maps it to `pages`
 * for its response). Error messages are per-platform: the Facebook
 * options route surfaces the loader's message in its 500 body, so
 * Facebook keeps its exact old wording; Instagram/Threads routes
 * swallow it for a generic message.
 */
export async function loadAduOptionsListsForPlatform(
  supabase: SupabaseClient,
  workspaceId: string,
  platform: 'instagram' | 'threads' | 'facebook',
): Promise<AduOptionsLists> {
  const messages =
    platform === 'facebook'
      ? {
          accounts: 'Could not load Facebook accounts.',
          destinations: 'Could not load Facebook pages.',
          configured: 'Could not load configured pages.',
        }
      : {
          accounts: 'Could not load accounts.',
          destinations: 'Could not load destinations.',
          configured: 'Could not load configured accounts.',
        };
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
    selectAllPages<Record<string, unknown>>((from, to) => {
      // Facebook only: the picker lists adu-section copies (the old
      // loader's contract). Instagram/Threads return every section
      // and dedupe in the route.
      const query = supabase
        .from('destinations')
        .select('id, account_id, external_destination_id, name, avatar_url, status, metadata, section')
        .eq('workspace_id', workspaceId)
        .eq('platform', platform);
      const filtered = platform === 'facebook' ? query.eq('section', 'adu') : query;
      return filtered.order('name').range(from, to);
    }),
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
    throw new Error(accounts.error.message ?? messages.accounts);
  }
  if (destinations.error) {
    throw new Error(destinations.error.message ?? messages.destinations);
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
    throw new Error(configured.error.message ?? messages.configured);
  }
  return {
    accounts: accounts.rows,
    destinations: destinations.rows,
    configured: configured.rows,
    migrationMissing: false,
  };
}
