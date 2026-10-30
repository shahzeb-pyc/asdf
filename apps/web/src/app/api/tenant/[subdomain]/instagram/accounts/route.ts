import { type NextRequest, NextResponse } from 'next/server';
import {
  evaluateAccountHealth,
  getSessionSecret,
  ListInstagramAccountsResponseSchema,
  verifySessionToken,
  isSessionAuthorizedForSubdomain,
  type DatabaseClient,
  type Database,
  type InstagramAccountStatus,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paginateItems,
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import type { PostgrestError } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * GET /api/tenant/[subdomain]/instagram/accounts — the Instagram accounts list.
 *
 * Instagram-only counterpart of the Facebook accounts list route, reading the
 * SAME unified `social_accounts` table with `platform = 'instagram'` (one data
 * model, no new table). It deliberately has no pages join: an Instagram
 * account's single destination row is the account itself, not a linked-pages
 * list, so there is nothing to aggregate here.
 *
 * Status vocabulary: the stored unified status is `active` / `expired` /
 * `revoked` / `error`; the wire status this route returns folds `revoked`
 * and `error` into `disconnected`, exactly as the Facebook wire map does.
 * The three health buckets partition the filtered set in priority order:
 * expired (stored `expired`, or a past token, whatever the stored status),
 * then error (`revoked`/`error` with a live-or-absent token), then connected.
 */

interface AccountRow {
  id: string;
  external_account_id?: string | null;
  externalAccountId?: string | null;
  display_name?: string | null;
  displayName?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  status?: string | null;
  token_expires_at?: string | Date | null;
  tokenExpiresAt?: string | Date | null;
  created_at?: string | Date | null;
  createdAt?: string | Date | null;
  updated_at?: string | Date | null;
  updatedAt?: string | Date | null;
  destination_count?: number | string | null;
  destinationCount?: number | string | null;
  destination_handle?: string | null;
  destinationHandle?: string | null;
  destination_name?: string | null;
  destinationName?: string | null;
}

/** Unified stored status → wire status (same fold as the Facebook wire map). */
export function unifiedInstagramStatusToWire(status: string | null | undefined): InstagramAccountStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'expired':
      return 'expired';
    default:
      return 'disconnected';
  }
}

function mapAccountRowToView(row: AccountRow) {
  const rawExpiresAt = row.token_expires_at ?? row.tokenExpiresAt;
  const tokenExpiresAt = rawExpiresAt ? new Date(rawExpiresAt) : null;
  const wireStatus = unifiedInstagramStatusToWire(row.status);
  // evaluateAccountHealth speaks the wire vocabulary: 'expired' always wins,
  // a past token also means expired, 'disconnected' is the error bucket.
  const computedStatus = evaluateAccountHealth({
    status: wireStatus,
    tokenExpiresAt,
  });
  return {
    id: row.id,
    externalAccountId: row.external_account_id ?? row.externalAccountId ?? '',
    displayName: row.display_name ?? row.displayName ?? '',
    profilePictureUrl: row.avatar_url ?? row.avatarUrl ?? null,
    status: computedStatus,
    tokenExpiresAt,
    createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? row.updatedAt ?? new Date().toISOString(),
    // The account's publishing destinations (Facebook's linked-pages
    // analogue): count + earliest destination's handle/name, or the
    // zero/null defaults when the account has no destination row.
    destinationCount: Number(row.destination_count ?? row.destinationCount ?? 0) || 0,
    destinationHandle: row.destination_handle ?? row.destinationHandle ?? null,
    destinationName: row.destination_name ?? row.destinationName ?? null,
  };
}

function syncExpiredAccountStatus(
  accountId: string,
  workspaceId: string,
  dbClient?: DatabaseClient | SupabaseClient
): void {
  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    dbClient
      .query(
        `UPDATE social_accounts
         SET status = 'expired', updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [accountId, workspaceId]
      )
      .catch((err: unknown) => {
        console.error(
          '[handleListInstagramAccounts] Failed to persist expired account status:',
          err
        );
      });
    return;
  }
  const supabase = (
    dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
  ) as SupabaseClient | null;
  if (!supabase) return;
  supabase
    .from('social_accounts')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .then(({ error }: { error: PostgrestError | null }) => {
      if (error) {
        console.error(
          '[handleListInstagramAccounts] Failed to persist expired account status via Supabase:',
          error
        );
      }
    });
}

export interface InstagramAccountListFilters {
  search: string;
  status: string;
}

export interface InstagramAccountHealthCounts {
  connected: number;
  expired: number;
  error: number;
}

/** Computed-expired predicate (mirrors evaluateAccountHealth). */
const ACCOUNT_EXPIRED_SQL = `(sa.status = 'expired' OR sa.token_expires_at < now())`;
const ACCOUNT_CONNECTED_SQL = `(sa.status = 'active' AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()))`;
const ACCOUNT_ERROR_SQL = `(sa.status IN ('revoked', 'error') AND (sa.token_expires_at IS NULL OR sa.token_expires_at >= now()))`;

function buildAccountWhere(
  workspaceId: string,
  filters: InstagramAccountListFilters
): { where: string; params: unknown[] } {
  const params: unknown[] = [workspaceId];
  const conditions = ['sa.workspace_id = $1', "sa.platform = 'instagram'"];
  if (filters.search) {
    const p = `$${params.length + 1}`;
    params.push(`%${filters.search}%`);
    conditions.push(`sa.display_name ILIKE ${p}`);
  }
  if (filters.status === 'active') {
    conditions.push(ACCOUNT_CONNECTED_SQL);
  } else if (filters.status === 'expired') {
    conditions.push(ACCOUNT_EXPIRED_SQL);
  } else if (filters.status === 'expiring_soon') {
    conditions.push(
      `(sa.status = 'active' AND sa.token_expires_at > now() AND sa.token_expires_at <= now() + interval '7 days')`
    );
  }
  return { where: conditions.join(' AND '), params };
}

async function fetchSqlAccountsPage(
  dbClient: DatabaseClient,
  workspaceId: string,
  filters: InstagramAccountListFilters,
  page: number,
  limit: number
): Promise<{
  rows: AccountRow[];
  total: number;
  page: number;
  healthCounts?: InstagramAccountHealthCounts | undefined;
}> {
  const { where, params } = buildAccountWhere(workspaceId, filters);
  const countRows = await dbClient.query<{
    total?: unknown;
    connected_count?: unknown;
    expired_count?: unknown;
    error_count?: unknown;
  }>(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ${ACCOUNT_CONNECTED_SQL})::int AS connected_count,
      COUNT(*) FILTER (WHERE ${ACCOUNT_EXPIRED_SQL})::int AS expired_count,
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
      sa.external_account_id,
      sa.display_name,
      sa.avatar_url,
      sa.status,
      sa.token_expires_at,
      sa.created_at,
      sa.updated_at,
      (SELECT COUNT(*)::int FROM destinations d
        WHERE d.account_id = sa.id AND d.workspace_id = sa.workspace_id
        AND d.platform = 'instagram') AS destination_count,
      (SELECT d.handle FROM destinations d
        WHERE d.account_id = sa.id AND d.workspace_id = sa.workspace_id
        AND d.platform = 'instagram'
        ORDER BY d.created_at ASC LIMIT 1) AS destination_handle,
      (SELECT d.name FROM destinations d
        WHERE d.account_id = sa.id AND d.workspace_id = sa.workspace_id
        AND d.platform = 'instagram'
        ORDER BY d.created_at ASC LIMIT 1) AS destination_name
    FROM social_accounts sa
    WHERE ${where}
    ORDER BY CASE WHEN ${ACCOUNT_EXPIRED_SQL} THEN 0 ELSE 1 END, sa.created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...dataParams, limit, (clampedPage - 1) * limit]
  );
  if (numericTotal !== null) {
    return { rows, total: numericTotal, page: clampedPage, healthCounts };
  }
  const total = rows.length;
  const finalPage = paginateMeta(total, page, limit).page;
  return {
    rows: rows.slice((finalPage - 1) * limit, finalPage * limit),
    total,
    page: finalPage,
    healthCounts,
  };
}

interface SupabaseAccountRow {
  id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

async function fetchSupabaseAccounts(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<{ rows?: AccountRow[]; error?: string }> {
  // Audit P1-1: the old single selects silently truncated past
  // PostgREST's 1,000-row limit, giving wrong totals and missing
  // accounts with no error, and a destinations error was ignored
  // entirely (accounts rendered without destinations). Page through
  // with .range() like the Facebook accounts route; past 10 full
  // pages the list fails loudly rather than returning wrong data.
  // The id tiebreakers make paging stable when created_at ties.
  const SUPABASE_PAGE_SIZE = 1000;
  const SUPABASE_MAX_PAGES = 10;
  async function fetchAllPages<T>(
    fetchPage: (
      from: number,
      to: number
    ) => Promise<{
      data: T[] | null;
      error: { message: string } | null;
    }>,
    tooManyMessage: string
  ): Promise<{ rows?: T[]; error?: string }> {
    const rows: T[] = [];
    for (let page = 0; page < SUPABASE_MAX_PAGES; page++) {
      const from = page * SUPABASE_PAGE_SIZE;
      const { data, error } = await fetchPage(
        from,
        from + SUPABASE_PAGE_SIZE - 1
      );
      if (error) {
        return { error: error.message };
      }
      const pageRows = data ?? [];
      rows.push(...pageRows);
      if (pageRows.length < SUPABASE_PAGE_SIZE) {
        break;
      }
      if (page === SUPABASE_MAX_PAGES - 1) {
        return { error: tooManyMessage };
      }
    }
    return { rows };
  }

  const accountsRes = await fetchAllPages<SupabaseAccountRow>(
    async (from, to) => {
      const { data, error } = await supabase
        .from('social_accounts')
        .select(
          'id, external_account_id, display_name, avatar_url, status, token_expires_at, created_at, updated_at'
        )
        .eq('workspace_id', workspaceId)
        .eq('platform', 'instagram')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      return {
        data: data as unknown as SupabaseAccountRow[] | null,
        error: error ? { message: error.message } : null,
      };
    },
    'Too many accounts to list reliably; please contact support.'
  );
  if (accountsRes.error) {
    return { error: accountsRes.error };
  }
  const accountRows = accountsRes.rows ?? [];
  // Destinations join (Supabase path): the earliest destination per
  // account, mirroring the SQL subqueries above.
  const destinationsRes = await fetchAllPages<{
    account_id: string;
    name: string | null;
    handle: string | null;
  }>(
    async (from, to) => {
      const { data, error } = await supabase
        .from('destinations')
        .select('account_id, name, handle, created_at')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'instagram')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: data as unknown as Array<{
          account_id: string;
          name: string | null;
          handle: string | null;
        }> | null,
        error: error ? { message: error.message } : null,
      };
    },
    'Too many destinations to list reliably; please contact support.'
  );
  if (destinationsRes.error) {
    return { error: destinationsRes.error };
  }
  const destinationData = destinationsRes.rows ?? [];
  const destinationsByAccount = new Map<
    string,
    Array<{ name: string | null; handle: string | null }>
  >();
  for (const dest of destinationData) {
    const list = destinationsByAccount.get(dest.account_id) ?? [];
    list.push({ name: dest.name, handle: dest.handle });
    destinationsByAccount.set(dest.account_id, list);
  }
  return {
    rows: accountRows.map((acc) => {
      const dests = destinationsByAccount.get(acc.id) ?? [];
      return {
        id: acc.id,
        external_account_id: acc.external_account_id,
        display_name: acc.display_name,
        avatar_url: acc.avatar_url,
        status: acc.status,
        token_expires_at: acc.token_expires_at,
        created_at: acc.created_at,
        updated_at: acc.updated_at,
        destination_count: dests.length,
        destination_handle: dests[0]?.handle ?? null,
        destination_name: dests[0]?.name ?? null,
      };
    }),
  };
}

type MappedAccount = ReturnType<typeof mapAccountRowToView>;

function filterAndSortAccounts(
  accounts: MappedAccount[],
  filters: InstagramAccountListFilters
): MappedAccount[] {
  const query = filters.search.trim().toLowerCase();
  return accounts
    .filter((account) => {
      const matchesSearch =
        query.length === 0 ||
        (account.displayName ?? '').toLowerCase().includes(query);
      let matchesStatus = true;
      if (filters.status === 'active') matchesStatus = account.status === 'active';
      else if (filters.status === 'expired')
        matchesStatus = account.status === 'expired';
      else if (filters.status === 'expiring_soon') {
        if (account.status === 'expired' || !account.tokenExpiresAt) {
          matchesStatus = false;
        } else {
          const days = Math.ceil(
            (new Date(account.tokenExpiresAt).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          );
          matchesStatus = days > 0 && days <= 7;
        }
      }
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      const aExpired = a.status === 'expired' ? 1 : 0;
      const bExpired = b.status === 'expired' ? 1 : 0;
      if (aExpired !== bExpired) return bExpired - aExpired;
      return (
        new Date(String(b.createdAt)).getTime() -
        new Date(String(a.createdAt)).getTime()
      );
    });
}

export async function handleListInstagramAccounts(
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

  // 2. Tenant isolation check
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const { page: requestedPage, limit } = parsePaginationParams(url.searchParams);
  const filters: InstagramAccountListFilters = {
    search: (url.searchParams.get('search') ?? '').trim(),
    status: url.searchParams.get('status') ?? 'all',
  };

  let accounts: MappedAccount[];
  let meta: PaginationMeta;
  let healthCounts: InstagramAccountHealthCounts | undefined;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const result = await fetchSqlAccountsPage(
      dbClient as DatabaseClient,
      workspaceId,
      filters,
      requestedPage,
      limit
    );
    accounts = result.rows.map((row) => {
      const view = mapAccountRowToView(row);
      if (row.status === 'active' && view.status === 'expired') {
        syncExpiredAccountStatus(view.id, workspaceId, dbClient);
      }
      return view;
    });
    healthCounts = result.healthCounts;
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
    const supabase = (
      dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
    ) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      );
    }
    const res = await fetchSupabaseAccounts(supabase, workspaceId);
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }
    const mapped = (res.rows || []).map((row) => {
      const view = mapAccountRowToView(row);
      if (row.status === 'active' && view.status === 'expired') {
        syncExpiredAccountStatus(view.id, workspaceId, dbClient);
      }
      return view;
    });
    const filtered = filterAndSortAccounts(mapped, filters);
    // Full-set health counts, counted BEFORE slicing, in the same
    // priority order as the SQL aggregates: past token (or stored
    // expired) first, then disconnected, then connected.
    healthCounts = { connected: 0, expired: 0, error: 0 };
    for (const account of filtered) {
      if (
        account.status === 'expired' ||
        (account.tokenExpiresAt &&
          new Date(account.tokenExpiresAt).getTime() <= Date.now())
      ) {
        healthCounts.expired += 1;
      } else if (account.status === 'disconnected') {
        healthCounts.error += 1;
      } else {
        healthCounts.connected += 1;
      }
    }
    const sliced = paginateItems(filtered, requestedPage, limit);
    accounts = sliced.items;
    meta = sliced.meta;
  }

  const parsed = ListInstagramAccountsResponseSchema.safeParse({
    accounts,
    total: meta.total,
    page: meta.page,
    limit: meta.limit,
    totalPages: meta.totalPages,
    healthCounts,
  });
  if (!parsed.success) {
    console.error(
      '[handleListInstagramAccounts] Schema validation error:',
      parsed.error
    );
    return NextResponse.json(
      { error: 'Failed to format accounts list response' },
      { status: 500 }
    );
  }

  return NextResponse.json(parsed.data);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListInstagramAccounts(request, subdomain);
}
