import { type NextRequest, NextResponse } from 'next/server';
import {
  evaluateAccountHealth,
  getSessionSecret,
  ListFacebookAccountsResponseSchema,
  verifySessionToken,
  isSessionAuthorizedForSubdomain,
  type DatabaseClient,
  type Database,
  type FacebookAccountStatus,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import { propagateExpiredAccountDestinations } from '@/lib/publishing/account-expiry-propagation';
import {
  ACCOUNT_STATUS_TO_WIRE_SQL,
  unifiedAccountStatusToWire,
} from '@/lib/server/facebook-wire';
import { isAccountExpiredForList } from '@/components/accounts/accounts-helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One social_accounts row as the list mapper consumes it (spec 137
 * §3.7), already translated to the wire account vocabulary by the
 * facebook-wire maps. SQL rows and Supabase rows both land here; date
 * fields arrive as strings from Supabase and may be Date objects from
 * the raw driver, and the mapper tolerates the camelCase aliases the
 * SQL query path produces.
 */
interface AccountRow {
  id: string;
  fb_account_id?: string | null;
  fbAccountId?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  profile_picture_url?: string | null;
  profilePictureUrl?: string | null;
  gender?: string | null;
  account_link?: string | null;
  accountLink?: string | null;
  status?: FacebookAccountStatus | null;
  token_expires_at?: string | Date | null;
  tokenExpiresAt?: string | Date | null;
  connected_pages_count?: number | string | null;
  connectedPagesCount?: number | string | null;
  connected_pages?: unknown;
  connectedPages?: unknown;
  created_at?: string | Date | null;
  createdAt?: string | Date | null;
  updated_at?: string | Date | null;
  updatedAt?: string | Date | null;
}

function mapAccountRowToView(row: AccountRow) {
  const rawExpiresAt = row.token_expires_at || row.tokenExpiresAt;
  const tokenExpiresAt = rawExpiresAt ? new Date(rawExpiresAt) : null;
  const computedStatus = evaluateAccountHealth({
    status: row.status ?? 'active',
    tokenExpiresAt,
  });
  const rawConnectedPages = row.connected_pages ?? row.connectedPages;

  return {
    id: row.id,
    fbAccountId: row.fb_account_id || row.fbAccountId,
    displayName: row.display_name || row.displayName,
    profilePictureUrl:
      row.profile_picture_url ?? row.profilePictureUrl ?? null,
    gender: row.gender ?? null,
    accountLink: row.account_link ?? row.accountLink ?? null,
    status: computedStatus,
    tokenExpiresAt,
    connectedPagesCount: Number(
      row.connected_pages_count ?? row.connectedPagesCount ?? 0
    ),
    connectedPages: Array.isArray(rawConnectedPages) ? rawConnectedPages : [],
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  };
}

/**
 * Audit N3 — workspace-wide lapsed-account sync, awaited before
 * the list is read. The old code fired one un-awaited update per
 * page-slice row (SQL) or per mapped row (Supabase), so the
 * response could show `expired` while the stored row was still
 * `active`, and sync coverage differed by path. This is a single
 * UPDATE over the whole workspace (active rows whose token has
 * passed), run before the fetch on both paths, so the response
 * always reflects stored state. Propagation to destinations is
 * still best-effort per flipped account and never fails the list.
 *
 * F3 (spec 170): the UPDATE is skipped entirely when no row is
 * lapsed — a cheap existence probe runs first, so the common
 * no-lapse load issues no UPDATE at all. Lapse semantics are
 * unchanged: when rows ARE lapsed they are flipped (and propagated)
 * exactly as before.
 */
async function syncLapsedAccountStatus(
  workspaceId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<void> {
  const propagate = async (client: unknown, accountId: string): Promise<void> => {
    try {
      await propagateExpiredAccountDestinations(
        client as Parameters<typeof propagateExpiredAccountDestinations>[0],
        accountId
      );
    } catch (err: unknown) {
      console.error(
        '[handleListAccounts] Failed to propagate expired account destinations:',
        err
      );
    }
  };

  try {
    if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
      // F3 (spec 170): skip the UPDATE when nothing is lapsed.
      const lapsed = (await dbClient.query(
        `SELECT 1 AS one
         FROM social_accounts
         WHERE workspace_id = $1 AND status = 'active' AND token_expires_at < now()
         LIMIT 1`,
        [workspaceId]
      )) as Array<{ one?: unknown }>;
      if (!Array.isArray(lapsed) || lapsed.length === 0) {
        return;
      }
      const flipped = (await dbClient.query(
        `UPDATE social_accounts
         SET status = 'expired', updated_at = now()
         WHERE workspace_id = $1 AND status = 'active' AND token_expires_at < now()
         RETURNING id`,
        [workspaceId]
      )) as Array<{ id: string }>;
      for (const row of Array.isArray(flipped) ? flipped : []) {
        await propagate(dbClient, row.id);
      }
      return;
    }

    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) return;
    // F3 (spec 170): same skip as the SQL path — a head-only count
    // proves whether any row is lapsed before the UPDATE is issued.
    // A failed probe is logged and the list proceeds with stored
    // state; the sync is best-effort and never fails the list.
    const nowIso = new Date().toISOString();
    const lapsedCheck = await supabase
      .from('social_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .lt('token_expires_at', nowIso);
    if (lapsedCheck?.error) {
      console.error(
        '[handleListAccounts] Failed to check for lapsed account status via Supabase:',
        lapsedCheck.error
      );
      return;
    }
    if (!lapsedCheck?.count) {
      return;
    }
    const result = (await supabase
      .from('social_accounts')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .lt('token_expires_at', new Date().toISOString())
      .select('id')) as unknown as { data?: unknown; error?: unknown };
    if (result?.error) {
      console.error(
        '[handleListAccounts] Failed to persist expired account status via Supabase:',
        result.error
      );
      return;
    }
    const flipped = Array.isArray(result?.data) ? result.data : [];
    for (const row of flipped as Array<{ id: string }>) {
      await propagate(supabase, row.id);
    }
  } catch (err: unknown) {
    console.error('[handleListAccounts] Failed to sync lapsed account status:', err);
  }
}

export interface AccountListFilters {
  search: string;
  status: string;
}

/**
 * Audit BG11 — computed-expired predicate, unified with the
 * Supabase path and the shell's getAccountHealth: an expired
 * wire status OR a past token is expired, regardless of the
 * other field. The old predicate counted active+past-token but
 * not disconnected+past-token, so a disconnected account with
 * a past token was counted as expired yet excluded from the
 * expired filter. This predicate is also the ORDER BY key, so
 * sort order unifies with it.
 */
const ACCOUNT_EXPIRED_SQL = `((${ACCOUNT_STATUS_TO_WIRE_SQL}) = 'expired' OR sa.token_expires_at < now())`;

/**
 * Full-set health buckets, mirroring the shell's getAccountHealth
 * model over the wire status + token expiry (see account-health.ts):
 * an expired wire status or a past token is expired regardless of
 * the other field; disconnected with a live-or-absent token is an
 * error; active with a live-or-absent token is connected. The three
 * buckets partition the filtered set exactly.
 */
const ACCOUNT_CONNECTED_SQL = `((${ACCOUNT_STATUS_TO_WIRE_SQL}) = 'active' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()))`;
const ACCOUNT_HEALTH_EXPIRED_SQL = `((${ACCOUNT_STATUS_TO_WIRE_SQL}) = 'expired' OR sa.token_expires_at < now())`;
const ACCOUNT_ERROR_SQL = `((${ACCOUNT_STATUS_TO_WIRE_SQL}) = 'disconnected' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()))`;

export interface AccountHealthCounts {
  connected: number;
  expired: number;
  error: number;
}

function buildAccountWhere(
  workspaceId: string,
  filters: AccountListFilters
): { where: string; params: unknown[] } {
  const params: unknown[] = [workspaceId];
  const conditions = ['sa.workspace_id = $1', "sa.platform = 'facebook'"];
  if (filters.search) {
    // Audit N2: escape ILIKE wildcards so a literal search for
    // "100%" does not match more than the literal string (the
    // Supabase path already matches literally via includes).
    const escaped = filters.search
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const p = `$${params.length + 1}`;
    params.push(`%${escaped}%`);
    conditions.push(`sa.display_name ILIKE ${p} ESCAPE '\\'`);
  }
  if (filters.status === 'active') {
    conditions.push(
      `(sa.status = 'active' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()))`
    );
  } else if (filters.status === 'expired') {
    conditions.push(ACCOUNT_EXPIRED_SQL);
  } else if (filters.status === 'expiring_soon') {
    conditions.push(
      `(sa.status = 'active' AND sa.token_expires_at > now() AND sa.token_expires_at <= now() + interval '7 days')`
    );
  } else if (filters.status === 'error') {
    // Audit UX2: health 'error' is the complement of connected
    // and expired — neither an active row with a live/absent
    // token, nor the shared expired predicate. This keeps the
    // error tab exactly in step with the health counts.
    conditions.push(
      `(NOT (sa.status = 'active' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now())) AND NOT ${ACCOUNT_EXPIRED_SQL})`
    );
  }
  return { where: conditions.join(' AND '), params };
}

async function fetchSqlAccountsPage(
  dbClient: DatabaseClient,
  workspaceId: string,
  filters: AccountListFilters,
  page: number,
  limit: number
): Promise<{ rows: AccountRow[]; total: number; page: number; healthCounts?: AccountHealthCounts | undefined }> {
  const { where, params } = buildAccountWhere(workspaceId, filters);
  const countRows = await dbClient.query<{
    total?: unknown;
    connected_count?: unknown;
    expired_count?: unknown;
    error_count?: unknown;
  }>(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ${ACCOUNT_CONNECTED_SQL})::int AS connected_count,
      COUNT(*) FILTER (WHERE ${ACCOUNT_HEALTH_EXPIRED_SQL})::int AS expired_count,
      COUNT(*) FILTER (WHERE ${ACCOUNT_ERROR_SQL})::int AS error_count
    FROM social_accounts sa WHERE ${where}`,
    params
  );
  const rawTotal = (countRows[0] as { total?: unknown } | undefined)?.total;
  const countRow = countRows[0] as
    | {
        connected_count?: unknown;
        expired_count?: unknown;
        error_count?: unknown;
      }
    | undefined;
  // As in the pages route: a source that answers the count without
  // the health aggregates (e.g. a test double) leaves healthCounts
  // undefined and the field is omitted; production always answers it.
  const healthCounts =
    typeof countRow?.connected_count === 'number' &&
    typeof countRow.expired_count === 'number' &&
    typeof countRow.error_count === 'number'
      ? {
          connected: countRow.connected_count,
          expired: countRow.expired_count,
          error: countRow.error_count,
        }
      : undefined;
  const numericTotal = typeof rawTotal === 'number' ? rawTotal : null;
  const clampedPage =
    numericTotal === null ? page : paginateMeta(numericTotal, page, limit).page;
  const dataParams = [...params];
  const limitParam = `$${dataParams.length + 1}`;
  const offsetParam = `$${dataParams.length + 2}`;
  const rows = await dbClient.query<AccountRow>(
    `SELECT
      sa.id,
      sa.external_account_id AS fb_account_id,
      sa.display_name,
      sa.avatar_url AS profile_picture_url,
      sa.metadata->>'gender' AS gender,
      sa.metadata->>'account_link' AS account_link,
      ${ACCOUNT_STATUS_TO_WIRE_SQL} AS status,
      sa.token_expires_at,
      sa.created_at,
      sa.updated_at,
      // F3 (spec 170): connected_pages carries id + name only — the
      // disconnect dialog renders names, the card only needs the
      // count, and the card's expanded list falls back to initials
      // without a page avatar URL. The avatar URLs were the bulk of
      // the 59 kB list payload for 14 accounts.
      COUNT(d.id)::int AS connected_pages_count,
      COALESCE(
        json_agg(
          json_build_object(
            'id', d.id,
            'pageName', d.name
          ) ORDER BY d.name ASC
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::json
      ) AS connected_pages
    FROM social_accounts sa
    LEFT JOIN destinations d
      ON d.account_id = sa.id
      AND d.workspace_id = sa.workspace_id
      AND d.platform = 'facebook'
      AND (d.status != 'disconnected' OR d.metadata->>'fb_status' = 'paused')
    WHERE ${where}
    GROUP BY sa.id
    ORDER BY CASE WHEN ${ACCOUNT_EXPIRED_SQL} THEN 0 ELSE 1 END, sa.created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...dataParams, limit, (clampedPage - 1) * limit]
  );
  if (numericTotal !== null) {
    return { rows, total: numericTotal, page: clampedPage, healthCounts };
  }
  // Test doubles that answer every query with the full row set: recover
  // the page from the full set, as in the pages route.
  const total = rows.length;
  const finalPage = paginateMeta(total, page, limit).page;
  return {
    rows: rows.slice((finalPage - 1) * limit, finalPage * limit),
    total,
    page: finalPage,
    healthCounts,
  };
}

/**
 * Minimal structural type for the PostgREST social_accounts /
 * destinations query builder, covering only the filter/ordering
 * methods this file chains, plus the awaited result shape. Same
 * pattern as the pages route's SupabaseDestinationsQuery: the
 * contracts Database type carries no Relationships metadata, so the
 * generated builder type degrades at the select boundary.
 */
interface SupabaseAccountsQuery {
  eq(column: string, value: unknown): SupabaseAccountsQuery;
  neq(column: string, value: unknown): SupabaseAccountsQuery;
  gt(column: string, value: unknown): SupabaseAccountsQuery;
  gte(column: string, value: unknown): SupabaseAccountsQuery;
  lt(column: string, value: unknown): SupabaseAccountsQuery;
  lte(column: string, value: unknown): SupabaseAccountsQuery;
  ilike(column: string, pattern: string): SupabaseAccountsQuery;
  in(column: string, values: unknown[]): SupabaseAccountsQuery;
  or(filters: string): SupabaseAccountsQuery;
  order(
    column: string,
    options?: { ascending?: boolean }
  ): SupabaseAccountsQuery;
  range(from: number, to: number): SupabaseAccountsQuery;
  then<TResult1 = SupabaseAccountsQueryResult, TResult2 = never>(
    onfulfilled?:
      | ((
          value: SupabaseAccountsQueryResult
        ) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
  ): PromiseLike<TResult1 | TResult2>;
}

interface SupabaseAccountsQueryResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

/**
 * Escapes a user search term for LIKE/ILIKE patterns — same
 * backslash convention as the pages route's escapeLikePattern and
 * the SQL path's ESCAPE '\': % and _ match literally, and a
 * literal backslash must not escape the next character.
 */
function escapeLikePattern(input: string): string {
  return input
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

const SUPABASE_ACCOUNT_COLUMNS =
  'id, external_account_id, display_name, avatar_url, metadata, status, token_expires_at, created_at, updated_at';

/**
 * F3 (spec 170) — the shared account predicates in PostgREST form.
 * buildAccountWhere is the SQL form and filterAndSortAccounts the
 * JS form; all three must stay in step (BG11). The wire status is
 * a pure function of the stored status column (active → active,
 * expired → expired, anything else → disconnected), so the
 * predicates are written against the stored column directly:
 * - 'active' (connected): stored active AND a live-or-absent token.
 * - 'expired': stored expired OR any past token.
 * - 'expiring_soon': stored active AND a token 1–7 days out.
 * - 'error': the complement of connected and expired — neither
 *   active nor expired with a live-or-absent token.
 */
function applySupabaseAccountStatus(
  query: SupabaseAccountsQuery,
  status: string,
  nowIso: string,
  soonIso: string
): SupabaseAccountsQuery {
  if (status === 'active') {
    return query
      .eq('status', 'active')
      .or(`token_expires_at.is.null,token_expires_at.gte.${nowIso}`);
  }
  if (status === 'expired') {
    return query.or(`status.eq.expired,token_expires_at.lt.${nowIso}`);
  }
  if (status === 'expiring_soon') {
    return query
      .eq('status', 'active')
      .gt('token_expires_at', nowIso)
      .lte('token_expires_at', soonIso);
  }
  if (status === 'error') {
    return query
      .neq('status', 'active')
      .neq('status', 'expired')
      .or(`token_expires_at.is.null,token_expires_at.gte.${nowIso}`);
  }
  return query;
}

/**
 * The expired rank in PostgREST form: `expired` is the shared BG11
 * predicate (stored expired OR any past token); `!expired` is its
 * exact complement (stored not-expired AND a live-or-absent token).
 */
function applySupabaseAccountRank(
  query: SupabaseAccountsQuery,
  expired: boolean,
  nowIso: string
): SupabaseAccountsQuery {
  if (expired) {
    return query.or(`status.eq.expired,token_expires_at.lt.${nowIso}`);
  }
  return query
    .neq('status', 'expired')
    .or(`token_expires_at.is.null,token_expires_at.gte.${nowIso}`);
}

interface SupabaseAccountRow {
  id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SupabaseLinkedPageRow {
  id: string;
  account_id: string;
  name: string;
}

const SUPABASE_LINKED_PAGES_PAGE_SIZE = 1000;
const SUPABASE_LINKED_PAGES_MAX_PAGES = 10;

type SupabaseAccountsPageResult =
  | {
      rows: AccountRow[];
      total: number;
      page: number;
      healthCounts: AccountHealthCounts;
      error?: undefined;
    }
  | {
      error: string;
      rows?: undefined;
      total?: undefined;
      page?: undefined;
      healthCounts?: undefined;
    };

/**
 * F3 (spec 170) — the prod list path, DB-side throughout. The old
 * fetchSupabaseAccounts pulled EVERY account in the workspace with
 * its destinations joined (up to 10 × 1,000 rows), then mapped,
 * filtered, sorted and sliced in JS. This instead:
 * - counts the filtered set with three head-only COUNTs in parallel
 *   (total + expired + connected; error is total minus the other
 *   two — the three buckets partition the filtered set exactly, so
 *   healthCounts stay full-set while the rows are paged);
 * - fetches the page as two ranged slices — the expired head and
 *   the non-expired tail — concatenated in expired-first order,
 *   because PostgREST cannot ORDER BY the computed expired rank;
 * - counts linked pages with one bounded destinations query over
 *   the page's account ids only (no join, no avatar URLs).
 * Any DB error fails the list loudly (500) instead of returning a
 * partial or wrong page.
 */
async function fetchSupabaseAccountsPage(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  filters: AccountListFilters,
  requestedPage: number,
  limit: number
): Promise<SupabaseAccountsPageResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const soonIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const baseFilters = (query: SupabaseAccountsQuery): SupabaseAccountsQuery => {
    let next = query.eq('workspace_id', workspaceId).eq('platform', 'facebook');
    if (filters.search) {
      next = next.ilike(
        'display_name',
        `%${escapeLikePattern(filters.search)}%`
      );
    }
    return applySupabaseAccountStatus(next, filters.status, nowIso, soonIso);
  };
  const countQuery = (): SupabaseAccountsQuery =>
    baseFilters(
      supabase
        .from('social_accounts')
        .select('id', { count: 'exact', head: true }) as unknown as SupabaseAccountsQuery
    );

  const [totalRes, expiredRes, connectedRes] = await Promise.all([
    countQuery(),
    applySupabaseAccountRank(countQuery(), true, nowIso),
    applySupabaseAccountStatus(countQuery(), 'active', nowIso, soonIso),
  ]);
  if (totalRes.error) {
    console.error(
      '[handleListAccounts] Failed to count accounts (total):',
      totalRes.error
    );
    return { error: totalRes.error.message };
  }
  if (expiredRes.error) {
    console.error(
      '[handleListAccounts] Failed to count accounts (expired):',
      expiredRes.error
    );
    return { error: expiredRes.error.message };
  }
  if (connectedRes.error) {
    console.error(
      '[handleListAccounts] Failed to count accounts (connected):',
      connectedRes.error
    );
    return { error: connectedRes.error.message };
  }
  const total = totalRes.count;
  const expiredTotal = expiredRes.count;
  const connectedTotal = connectedRes.count;
  if (total === null || expiredTotal === null || connectedTotal === null) {
    console.error(
      '[handleListAccounts] Account counts came back without a count.'
    );
    return { error: 'Failed to count accounts' };
  }
  const healthCounts: AccountHealthCounts = {
    connected: connectedTotal,
    expired: expiredTotal,
    error: total - connectedTotal - expiredTotal,
  };
  const meta = paginateMeta(total, requestedPage, limit);
  const page = meta.page;
  if (total === 0) {
    return { rows: [], total, page, healthCounts };
  }

  const offset = (page - 1) * limit;
  const expiredFrom = offset;
  const expiredTo = Math.min(offset + limit, expiredTotal) - 1;
  const expiredNeed = expiredTotal > offset ? expiredTo - expiredFrom + 1 : 0;
  const nonExpiredNeed = limit - expiredNeed;
  const nonExpiredFrom = Math.max(0, offset - expiredTotal);

  const dataQuery = (
    expired: boolean,
    from: number,
    to: number
  ): SupabaseAccountsQuery =>
    applySupabaseAccountRank(
      baseFilters(
        supabase
          .from('social_accounts')
          .select(SUPABASE_ACCOUNT_COLUMNS) as unknown as SupabaseAccountsQuery
      ),
      expired,
      nowIso
    )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);

  const [expiredSlice, nonExpiredSlice] = await Promise.all([
    expiredNeed > 0
      ? dataQuery(true, expiredFrom, expiredTo)
      : Promise.resolve({
          data: [],
          error: null,
          count: null,
        } as SupabaseAccountsQueryResult),
    nonExpiredNeed > 0
      ? dataQuery(false, nonExpiredFrom, nonExpiredFrom + nonExpiredNeed - 1)
      : Promise.resolve({
          data: [],
          error: null,
          count: null,
        } as SupabaseAccountsQueryResult),
  ]);
  if (expiredSlice.error) {
    console.error(
      '[handleListAccounts] Failed to fetch accounts page (expired slice):',
      expiredSlice.error
    );
    return { error: expiredSlice.error.message };
  }
  if (nonExpiredSlice.error) {
    console.error(
      '[handleListAccounts] Failed to fetch accounts page (non-expired slice):',
      nonExpiredSlice.error
    );
    return { error: nonExpiredSlice.error.message };
  }
  const accountRows = [
    ...((expiredSlice.data as SupabaseAccountRow[] | null) ?? []),
    ...((nonExpiredSlice.data as SupabaseAccountRow[] | null) ?? []),
  ];

  // Linked pages for the page's accounts only — the old path joined
  // destinations for the whole workspace. Page through with
  // .range(); past 10 full pages the list fails loudly rather than
  // silently under-counting (same N1 guard as the old full-set
  // fetch).
  const pagesByAccount = new Map<string, SupabaseLinkedPageRow[]>();
  const accountIds = accountRows.map((row) => row.id);
  if (accountIds.length > 0) {
    for (
      let pageIndex = 0;
      pageIndex < SUPABASE_LINKED_PAGES_MAX_PAGES;
      pageIndex++
    ) {
      const from = pageIndex * SUPABASE_LINKED_PAGES_PAGE_SIZE;
      const { data, error } = await (supabase
        .from('destinations')
        .select('id, account_id, name')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        .in('account_id', accountIds)
        .or('status.neq.disconnected,metadata->>fb_status.eq.paused')
        .order('name', { ascending: true })
        .range(
          from,
          from + SUPABASE_LINKED_PAGES_PAGE_SIZE - 1
        ) as unknown as SupabaseAccountsQuery);
      if (error) {
        console.error(
          '[handleListAccounts] Failed to fetch linked pages:',
          error
        );
        return { error: error.message };
      }
      const pageRows = (data as SupabaseLinkedPageRow[] | null) ?? [];
      for (const row of pageRows) {
        const list = pagesByAccount.get(row.account_id) ?? [];
        list.push(row);
        pagesByAccount.set(row.account_id, list);
      }
      if (pageRows.length < SUPABASE_LINKED_PAGES_PAGE_SIZE) {
        break;
      }
      if (pageIndex === SUPABASE_LINKED_PAGES_MAX_PAGES - 1) {
        return {
          error: 'Too many linked pages to list reliably; please contact support.',
        };
      }
    }
  }

  // The contracts Database type resolves this select to never[] (its
  // table entries carry no Relationships metadata for supabase-js),
  // so the result is asserted once, here at the boundary, to the row
  // shape the select actually returns.
  const rows: AccountRow[] = accountRows.map((acc) => {
    const linked = pagesByAccount.get(acc.id) ?? [];
    return {
      id: acc.id,
      fb_account_id: acc.external_account_id,
      display_name: acc.display_name,
      profile_picture_url: acc.avatar_url,
      gender:
        typeof acc.metadata?.gender === 'string' ? acc.metadata.gender : null,
      account_link:
        typeof acc.metadata?.account_link === 'string'
          ? acc.metadata.account_link
          : null,
      status: unifiedAccountStatusToWire(acc.status),
      token_expires_at: acc.token_expires_at,
      created_at: acc.created_at,
      updated_at: acc.updated_at,
      connected_pages_count: linked.length,
      // F3: id + name only — see the json_agg note in the SQL path.
      connected_pages: linked.map((p) => ({ id: p.id, pageName: p.name })),
    };
  });

  return { rows, total, page, healthCounts };
}

export async function handleListAccounts(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

  // 1. Session auth guard
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Audit S1: live session validation — a suspended user or a
  // session issued before a password change must not reach the
  // tenant check or any mutation below.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, dbClient);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // 4. Query connected accounts with connected page count and linked pages aggregation scoped to workspace.
  // Filters apply BEFORE pagination in both paths, and the page slice
  // is taken from the filtered, expired-first sequence.
  const url = new URL(request.url);
  const { page: requestedPage, limit } = parsePaginationParams(
    url.searchParams
  );
  const filters: AccountListFilters = {
    search: (url.searchParams.get('search') ?? '').trim(),
    status: url.searchParams.get('status') ?? 'all',
  };
  // Audit N2: an unknown status used to fall through to "all"
  // silently on both paths. Reject it so a typo'd filter can
  // never masquerade as an unfiltered list.
  const VALID_LIST_STATUSES = ['all', 'active', 'expiring_soon', 'expired', 'error'];
  if (!VALID_LIST_STATUSES.includes(filters.status)) {
    return NextResponse.json(
      { error: `Unknown status filter: ${filters.status}` },
      { status: 400 }
    );
  }

  let accounts: ReturnType<typeof mapAccountRowToView>[];
  let meta: PaginationMeta;
  let healthCounts: AccountHealthCounts | undefined;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // Audit N3: lapse-sync first (awaited, workspace-wide), so
    // the fetched page already reflects stored state.
    await syncLapsedAccountStatus(workspaceId, dbClient);
    // Exact server-side pagination: the SQL path filters, ranks,
    // counts and ranges in the database.
    const result = await fetchSqlAccountsPage(
      dbClient as DatabaseClient,
      workspaceId,
      filters,
      requestedPage,
      limit
    );
    accounts = result.rows.map((row) => mapAccountRowToView(row));
    healthCounts = result.healthCounts;
    // Stable re-sort of the page slice into the documented
    // expired-first order. The database ORDER BY already produces
    // this order; the re-sort only guards against a data source that
    // ignores ORDER BY (e.g. a test double returning fixture order).
    // Array.sort is stable, so it never reorders rows the database
    // already ranked.
    accounts = [...accounts].sort((a, b) => {
      const aExpired = a.status === 'expired' ? 1 : 0;
      const bExpired = b.status === 'expired' ? 1 : 0;
      if (aExpired !== bExpired) return bExpired - aExpired;
      return (
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt))
      );
    });
    meta = paginateMeta(result.total, result.page, limit);
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    // Audit N3: same awaited workspace-wide lapse-sync as the SQL
    // path, before the fetch, so both paths report stored state.
    await syncLapsedAccountStatus(workspaceId, dbClient);
    // F3 (spec 170): the prod path is DB-side now — counts, filters
    // and the page range all run in PostgREST (see
    // fetchSupabaseAccountsPage). No full-set fetch, no JS
    // filter/sort/slice.
    const res = await fetchSupabaseAccountsPage(
      supabase,
      workspaceId,
      filters,
      requestedPage,
      limit
    );
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }
    accounts = (res.rows || []).map((row) => mapAccountRowToView(row));
    healthCounts = res.healthCounts;
    // Stable re-sort of the page slice into the documented
    // expired-first order, by the same BG11 predicate the slices
    // were fetched with. The slices already arrive in this order;
    // the re-sort only guards against a data source that ignores
    // ORDER BY. Array.sort is stable, so it never reorders rows
    // the database already ranked.
    accounts = [...accounts].sort((a, b) => {
      const aExpired = isAccountExpiredForList(a.status, a.tokenExpiresAt)
        ? 1
        : 0;
      const bExpired = isAccountExpiredForList(b.status, b.tokenExpiresAt)
        ? 1
        : 0;
      if (aExpired !== bExpired) return bExpired - aExpired;
      return (
        new Date(String(b.createdAt)).getTime() -
        new Date(String(a.createdAt)).getTime()
      );
    });
    meta = paginateMeta(res.total ?? 0, res.page ?? requestedPage, limit);
  }

  const parsed = ListFacebookAccountsResponseSchema.safeParse({
    accounts,
    total: meta.total,
    page: meta.page,
    limit: meta.limit,
    totalPages: meta.totalPages,
    healthCounts,
  });
  if (!parsed.success) {
    console.error('[handleListAccounts] Schema validation error:', parsed.error);
    return NextResponse.json(
      { error: 'Failed to format accounts list response' },
      { status: 500 }
    );
  }

  return NextResponse.json(parsed.data);
}

/**
 * The shell's filter + expired-first sort (accounts-helpers
 * filterAccountsList / sortAccountsExpiredFirst). F3 (spec 170):
 * the prod Supabase path no longer calls this — its filters and
 * rank are pushed to PostgREST (applySupabaseAccountStatus /
 * applySupabaseAccountRank) — but it stays as the shared predicate
 * model all three paths must agree with (BG11) and as the oracle
 * the API tests compare the DB-side path against. Same search
 * field (display name), same status buckets (including
 * expiring_soon: token expires in 1–7 days), same expired-first
 * then newest order.
 */
type MappedAccount = ReturnType<typeof mapAccountRowToView>;

/**
 * Audit BG11 — the Supabase path's filter/sort, unified with the
 * SQL path and the shell model via isAccountExpiredForList:
 * 'active' means connected (active wire status AND a live or
 * absent token — the old code admitted active+past-token here);
 * 'expired' means the shared expired predicate (the old code
 * matched only the wire status, dropping active+past-token and
 * disconnected+past-token rows the counts still called expired);
 * 'expiring_soon' means active with a token 1–7 days out (the
 * old code admitted disconnected/error accounts with soon
 * tokens); sort is expired-first by the same predicate (the old
 * sort used the wire status only).
 */
export function filterAndSortAccounts(
  accounts: MappedAccount[],
  filters: AccountListFilters
): MappedAccount[] {
  const query = filters.search.trim().toLowerCase();
  return accounts
    .filter((account) => {
      const matchesSearch =
        query.length === 0 ||
        (account.displayName ?? '').toLowerCase().includes(query);
      let matchesStatus = true;
      if (filters.status === 'active')
        matchesStatus =
          account.status === 'active' &&
          !isAccountExpiredForList(account.status, account.tokenExpiresAt);
      else if (filters.status === 'expired')
        matchesStatus = isAccountExpiredForList(
          account.status,
          account.tokenExpiresAt
        );
      else if (filters.status === 'expiring_soon') {
        if (account.status !== 'active' || !account.tokenExpiresAt) {
          matchesStatus = false;
        } else {
          const days = Math.ceil(
            (new Date(account.tokenExpiresAt).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          );
          matchesStatus = days > 0 && days <= 7;
        }
      } else if (filters.status === 'error') {
        // Audit UX2: same complement as the SQL path — neither
        // expired nor connected (active with a live/absent token).
        const expired = isAccountExpiredForList(
          account.status,
          account.tokenExpiresAt
        );
        const connected = account.status === 'active' && !expired;
        matchesStatus = !expired && !connected;
      }
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      const aExpired = isAccountExpiredForList(a.status, a.tokenExpiresAt)
        ? 1
        : 0;
      const bExpired = isAccountExpiredForList(b.status, b.tokenExpiresAt)
        ? 1
        : 0;
      if (aExpired !== bExpired) return bExpired - aExpired;
      return (
        new Date(String(b.createdAt)).getTime() -
        new Date(String(a.createdAt)).getTime()
      );
    });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  // Audit S6: previously unthrottled; 60/min like the other list reads.
  const limited = await enforceIpRateLimit(request, 'tenant_accounts_list', 60);
  if (limited) return limited;
  return handleListAccounts(request, subdomain);
}
