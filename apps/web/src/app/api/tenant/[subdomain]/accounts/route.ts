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
  paginateItems,
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import type { PostgrestError } from '@supabase/supabase-js';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { propagateExpiredAccountDestinations } from '@/lib/publishing/account-expiry-propagation';
import {
  ACCOUNT_STATUS_TO_WIRE_SQL,
  unifiedAccountStatusToWire,
} from '@/lib/server/facebook-wire';
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

function syncExpiredAccountStatus(
  accountId: string,
  workspaceId: string,
  dbClient?: DatabaseClient | SupabaseClient
): void {
  // Propagation is best-effort here and never fails the list call:
  // the account flip itself is what the trigger (once applied) also
  // keys off, so a propagation failure is logged and the trigger
  // pass makes it a no-op on retry.
  const propagate = (client: unknown): void => {
    propagateExpiredAccountDestinations(
      client as Parameters<typeof propagateExpiredAccountDestinations>[0],
      accountId
    ).catch((err: unknown) => {
      console.error(
        '[handleListAccounts] Failed to propagate expired account destinations:',
        err
      );
    });
  };

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    dbClient
      .query(
        `UPDATE social_accounts
       SET status = 'expired', updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
        [accountId, workspaceId]
      )
      .then(() => {
        propagate(dbClient);
      })
      .catch((err: unknown) => {
        console.error('[handleListAccounts] Failed to persist expired account status:', err);
      });
    return;
  }

  const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
  if (!supabase) return;

  supabase
    .from('social_accounts')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .then(({ error }: { error: PostgrestError | null }) => {
      if (error) {
        console.error('[handleListAccounts] Failed to persist expired account status via Supabase:', error);
        return;
      }
      propagate(supabase);
    });
}

export interface AccountListFilters {
  search: string;
  status: string;
}

/** Computed-expired predicate (mirrors evaluateAccountHealth). */
const ACCOUNT_EXPIRED_SQL = `(sa.status = 'expired' OR (sa.status = 'active' AND sa.token_expires_at < now()))`;

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
    const p = `$${params.length + 1}`;
    params.push(`%${filters.search}%`);
    conditions.push(`sa.display_name ILIKE ${p}`);
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
      COUNT(d.id)::int AS connected_pages_count,
      COALESCE(
        json_agg(
          json_build_object(
            'id', d.id,
            'pageName', d.name,
            'profilePictureUrl', d.avatar_url
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

interface SupabaseAccountJoinRow {
  id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
  destinations: Array<{
    id: string;
    name: string;
    avatar_url: string | null;
    status: string;
    workspace_id: string;
    metadata: Record<string, unknown> | null;
  }> | null;
}

async function fetchSupabaseAccounts(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<{ rows?: AccountRow[]; error?: string }> {
  const { data: accountsData, error } = await supabase
    .from('social_accounts')
    .select(`
      id,
      external_account_id,
      display_name,
      avatar_url,
      metadata,
      status,
      token_expires_at,
      created_at,
      updated_at,
      destinations (
        id,
        name,
        avatar_url,
        status,
        workspace_id,
        metadata
      )
    `)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .order('created_at', { ascending: false });

  if (error) {
    return { error: error.message };
  }

  // The contracts Database type resolves this joined select to never[]
  // (its table entries carry no Relationships metadata for supabase-js),
  // so the result is asserted once, here at the boundary, to the row
  // shape the select actually returns.
  const accountRows = (accountsData || []) as unknown as SupabaseAccountJoinRow[];
  const rows: AccountRow[] = accountRows.map((acc) => {
    const activePages = (acc.destinations || []).filter(
      (p) =>
        (p.status !== 'disconnected' || p.metadata?.fb_status === 'paused') &&
        p.workspace_id === workspaceId
    );
    return {
      id: acc.id,
      fb_account_id: acc.external_account_id,
      display_name: acc.display_name,
      profile_picture_url: acc.avatar_url,
      gender: typeof acc.metadata?.gender === 'string' ? acc.metadata.gender : null,
      account_link:
        typeof acc.metadata?.account_link === 'string' ? acc.metadata.account_link : null,
      status: unifiedAccountStatusToWire(acc.status),
      token_expires_at: acc.token_expires_at,
      created_at: acc.created_at,
      updated_at: acc.updated_at,
      connected_pages_count: activePages.length,
      connected_pages: activePages.map((p) => ({
        id: p.id,
        pageName: p.name,
        profilePictureUrl: p.avatar_url,
      })),
    };
  });

  return { rows };
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

  // 2. Tenant isolation check
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
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

  let accounts: ReturnType<typeof mapAccountRowToView>[];
  let meta: PaginationMeta;
  let healthCounts: AccountHealthCounts | undefined;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // Exact server-side pagination: the SQL path filters, ranks,
    // counts and ranges in the database.
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

    const res = await fetchSupabaseAccounts(supabase, workspaceId);
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }
    // Supabase path limitation, as in the pages route: PostgREST
    // cannot order by the computed-expired rank, so the filtered rows
    // are mapped, filtered and sorted here and only the page slice is
    // returned to the client.
    const mapped = (res.rows || []).map((row) => {
      const view = mapAccountRowToView(row);
      if (row.status === 'active' && view.status === 'expired') {
        syncExpiredAccountStatus(view.id, workspaceId, dbClient);
      }
      return view;
    });
    const filtered = filterAndSortAccounts(mapped, filters);
    // Full-set health counts, counted BEFORE slicing, using the
    // same health model as the shell subtitle (getAccountHealth):
    // expired wire status or a past token is expired, disconnected
    // with a live-or-absent token is an error, otherwise connected.
    healthCounts = { connected: 0, expired: 0, error: 0 };
    for (const account of filtered) {
      if (account.status === 'expired') {
        healthCounts.expired += 1;
      } else if (
        account.tokenExpiresAt &&
        new Date(account.tokenExpiresAt).getTime() <= Date.now()
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
 * filterAccountsList / sortAccountsExpiredFirst), mirrored here for
 * the Supabase path. Same search field (display name), same status
 * buckets (including expiring_soon: token expires in 1–7 days), same
 * expired-first then newest order.
 */
type MappedAccount = ReturnType<typeof mapAccountRowToView>;

function filterAndSortAccounts(
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListAccounts(request, subdomain);
}
