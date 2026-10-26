import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  ListFacebookPagesResponseSchema,
  evaluatePageHealth,
  verifySessionToken,
  canAccessTenant,
  type DatabaseClient,
  type Database,
  type FacebookPageStatus,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paginateItems,
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  DESTINATION_STATUS_TO_WIRE_SQL,
  unifiedDestinationStatusToWire,
} from '@/lib/server/facebook-wire';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * One destinations row as the list mapper consumes it (spec 137 §3.7),
 * already translated to the wire page vocabulary: snake_case
 * (SQL/Supabase) and camelCase spellings; follower/picture fields stay
 * `unknown` here because the extract* helpers below narrow them with
 * typeof — that narrowing is the type boundary for values the
 * database returns untyped.
 */
interface PageListRow {
  id: string;
  facebook_account_id?: string | null;
  facebookAccountId?: string | null;
  account_display_name?: string | null;
  accountDisplayName?: string | null;
  fb_page_id?: string | null;
  fbPageId?: string | null;
  page_name?: string | null;
  pageName?: string | null;
  profile_picture_url?: unknown;
  profilePictureUrl?: unknown;
  category?: string | null;
  starting_followers?: unknown;
  startingFollowers?: unknown;
  current_followers?: unknown;
  currentFollowers?: unknown;
  followers_count?: unknown;
  followersCount?: unknown;
  status?: FacebookPageStatus | null;
  tasks?: unknown;
  rate_limited_at?: string | Date | null;
  rateLimitedAt?: string | Date | null;
  created_at?: string | Date | null;
  createdAt?: string | Date | null;
  updated_at?: string | Date | null;
  updatedAt?: string | Date | null;
}

function extractCurrentFollowers(row: PageListRow): number {
  if (typeof row.current_followers === 'number') return row.current_followers;
  if (typeof row.currentFollowers === 'number') return row.currentFollowers;
  if (typeof row.followers_count === 'number') return row.followers_count;
  if (typeof row.followersCount === 'number') return row.followersCount;
  return 0;
}

function extractStartingFollowers(row: PageListRow, currentFollowers: number): number {
  if (typeof row.starting_followers === 'number') return row.starting_followers;
  if (typeof row.startingFollowers === 'number') return row.startingFollowers;
  return currentFollowers;
}

function extractPagePictureUrl(row: PageListRow): string | null {
  if (typeof row.profile_picture_url === 'string') return row.profile_picture_url;
  if (typeof row.profilePictureUrl === 'string') return row.profilePictureUrl;
  return null;
}


function parsePageTasks(rawTasks: unknown): string[] {
  if (Array.isArray(rawTasks)) {
    return rawTasks;
  }
  if (typeof rawTasks === 'string') {
    try {
      return JSON.parse(rawTasks);
    } catch (_e) {
      return [];
    }
  }
  return [];
}

export interface PageListFilters {
  search: string;
  status: string;
  account: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The attention-first rank the shell sorts by (pages-helpers
 * sortPagesAttentionFirst), expressed in SQL so pagination can be a
 * real range: attention (0), paused (1), active (2), other (3). A
 * rate-limited page counts as attention only while fresh — after the
 * 3-day cooldown evaluatePageHealth flips it back to active, and the
 * rank below mirrors that with the same timestamp rule.
 */
const PAGE_RANK_SQL = `CASE
  WHEN (${DESTINATION_STATUS_TO_WIRE_SQL}) IN ('invalid_token', 'page_checkpoint') THEN 0
  WHEN (${DESTINATION_STATUS_TO_WIRE_SQL}) = 'fb_rate_limited'
    AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) > now() - interval '3 days' THEN 0
  WHEN (${DESTINATION_STATUS_TO_WIRE_SQL}) = 'paused' THEN 1
  WHEN (${DESTINATION_STATUS_TO_WIRE_SQL}) IN ('active', 'fb_rate_limited') THEN 2
  ELSE 3
END`;

const PAGE_FRESH_RATE_LIMITED_SQL = `(${DESTINATION_STATUS_TO_WIRE_SQL}) = 'fb_rate_limited'
  AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) > now() - interval '3 days'`;

function buildPageWhere(
  workspaceId: string,
  filters: PageListFilters
): { where: string; params: unknown[] } {
  // The unified tables are workspace-scoped (no per-user column): the
  // resolved workspace is the isolation boundary, for admins and
  // members alike — the pre-unification admin/member split collapsed
  // into this single query.
  const params: unknown[] = [workspaceId];
  const conditions = [
    'd.workspace_id = $1',
    "d.platform = 'facebook'",
    "(d.status != 'disconnected' OR d.metadata->>'fb_status' = 'paused')",
  ];
  const nextParam = () => `$${params.length + 1}`;
  if (filters.search) {
    const like = `%${filters.search}%`;
    const p = nextParam();
    params.push(like);
    conditions.push(`(d.name ILIKE ${p} OR d.metadata->>'category' ILIKE ${p})`);
  }
  if (filters.status === 'needs_attention') {
    conditions.push(
      `((${DESTINATION_STATUS_TO_WIRE_SQL}) IN ('invalid_token', 'page_checkpoint') OR ${PAGE_FRESH_RATE_LIMITED_SQL})`
    );
  } else if (filters.status === 'active') {
    conditions.push(
      `((${DESTINATION_STATUS_TO_WIRE_SQL}) = 'active' OR ((${DESTINATION_STATUS_TO_WIRE_SQL}) = 'fb_rate_limited' AND NOT (${PAGE_FRESH_RATE_LIMITED_SQL})))`
    );
  } else if (filters.status === 'paused') {
    conditions.push(`(${DESTINATION_STATUS_TO_WIRE_SQL}) = 'paused'`);
  }
  if (filters.account && filters.account !== 'all') {
    const p = nextParam();
    params.push(filters.account);
    // The shell's account filter carries either an account id or a
    // display name; an id is only ever compared as a UUID, so a
    // display-name value must not reach the uuid comparison (Postgres
    // rejects a non-UUID parameter there).
    conditions.push(
      UUID_RE.test(filters.account)
        ? `d.account_id = ${p}`
        : `a.display_name = ${p}`
    );
  }
  return { where: conditions.join(' AND '), params };
}

async function fetchSqlPagesPage(
  dbClient: DatabaseClient,
  workspaceId: string,
  filters: PageListFilters,
  page: number,
  limit: number
): Promise<{ rows: PageListRow[]; total: number; page: number }> {
  const { where, params } = buildPageWhere(workspaceId, filters);
  const countRows = await dbClient.query<{ total?: unknown }>(
    `SELECT COUNT(*)::int AS total
    FROM destinations d
    LEFT JOIN social_accounts a ON a.id = d.account_id
    WHERE ${where}`,
    params
  );
  const rawTotal = (countRows[0] as { total?: unknown } | undefined)?.total;
  const dataParams = [...params];
  const limitParam = `$${dataParams.length + 1}`;
  const offsetParam = `$${dataParams.length + 2}`;
  // Clamp before the range query: an out-of-range ?page= must return
  // the last page's rows, never an empty page. The count is
  // authoritative; the rows-length fallback only covers test doubles
  // that answer every query with the full row set (they return the
  // page rows for the COUNT query too, so the slice below recovers
  // the right page from the full set).
  const numericTotal = typeof rawTotal === 'number' ? rawTotal : null;
  const clampedPage =
    numericTotal === null
      ? page
      : paginateMeta(numericTotal, page, limit).page;
  const rows = await dbClient.query<PageListRow>(
    `SELECT
      d.id,
      d.account_id AS facebook_account_id,
      a.display_name AS account_display_name,
      d.external_destination_id AS fb_page_id,
      d.name AS page_name,
      d.avatar_url AS profile_picture_url,
      d.metadata->>'category' AS category,
      (d.metadata->>'starting_followers')::int AS starting_followers,
      (d.metadata->>'current_followers')::int AS current_followers,
      ${DESTINATION_STATUS_TO_WIRE_SQL} AS status,
      d.metadata->'tasks' AS tasks,
      d.metadata->>'rate_limited_at' AS rate_limited_at,
      d.created_at,
      d.updated_at
    FROM destinations d
    LEFT JOIN social_accounts a ON a.id = d.account_id
    WHERE ${where}
    ORDER BY ${PAGE_RANK_SQL}, d.created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...dataParams, limit, (clampedPage - 1) * limit]
  );
  if (numericTotal !== null) {
    return { rows, total: numericTotal, page: clampedPage };
  }
  const total = rows.length;
  const finalPage = paginateMeta(total, page, limit).page;
  return {
    rows: rows.slice((finalPage - 1) * limit, finalPage * limit),
    total,
    page: finalPage,
  };
}

interface SupabaseDestinationJoinRow {
  id: string;
  account_id: string;
  external_destination_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  created_at: string;
  updated_at: string;
  social_accounts: { display_name: string } | null;
}

async function fetchSupabasePages(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  accountFilter = 'all'
): Promise<{ rows?: PageListRow[]; error?: string }> {
  let query = supabase
    .from('destinations')
    .select(
      'id, account_id, external_destination_id, name, avatar_url, metadata, status, created_at, updated_at, social_accounts(display_name)'
    )
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook');
  // An account id pre-filters exactly; a display-name filter cannot,
  // so it is applied after mapping below instead.
  if (accountFilter !== 'all' && UUID_RE.test(accountFilter)) {
    query = query.eq('account_id', accountFilter);
  }
  const { data: pageData, error } = await query.order('created_at', {
    ascending: false,
  });

  if (error) {
    return { error: error.message };
  }

  // The contracts Database type resolves this joined select to never[]
  // (no Relationships metadata for supabase-js), so the result is
  // asserted once, here at the boundary, to the shape the select
  // actually returns.
  const pageRows = (pageData || []) as unknown as SupabaseDestinationJoinRow[];
  // Disconnected destinations are excluded (a paused page — stored as
  // disconnected + the fb_status marker — stays listed, as before).
  const visibleRows = pageRows.filter(
    (p) => p.status !== 'disconnected' || p.metadata?.fb_status === 'paused'
  );
  const rows: PageListRow[] = visibleRows.map((p) => ({
    id: p.id,
    facebook_account_id: p.account_id,
    account_display_name: p.social_accounts?.display_name || '',
    fb_page_id: p.external_destination_id,
    page_name: p.name,
    profile_picture_url: p.avatar_url,
    category: typeof p.metadata?.category === 'string' ? p.metadata.category : null,
    starting_followers:
      typeof p.metadata?.starting_followers === 'number'
        ? p.metadata.starting_followers
        : null,
    current_followers:
      typeof p.metadata?.current_followers === 'number'
        ? p.metadata.current_followers
        : null,
    status: unifiedDestinationStatusToWire(p.status, p.metadata),
    tasks: p.metadata?.tasks ?? [],
    rate_limited_at:
      typeof p.metadata?.rate_limited_at === 'string'
        ? p.metadata.rate_limited_at
        : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));

  return { rows };
}

export async function handleListPages(
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
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // 4. Query imported pages with parent account display name scoped to workspace.
  // Filters apply BEFORE pagination in both paths, and the page slice
  // is taken from the filtered, attention-first sequence — never the
  // unfiltered list filtered after the fact.
  const url = new URL(request.url);
  const { page: requestedPage, limit } = parsePaginationParams(
    url.searchParams
  );
  const filters: PageListFilters = {
    search: (url.searchParams.get('search') ?? '').trim(),
    status: url.searchParams.get('status') ?? 'all',
    account: url.searchParams.get('account') ?? 'all',
  };

  let pages: ReturnType<typeof mapPageRows>;
  let meta: PaginationMeta;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // Exact server-side pagination: the SQL path filters, ranks, counts
    // and ranges in the database (see fetchSqlPagesPage).
    const result = await fetchSqlPagesPage(
      dbClient as DatabaseClient,
      workspaceId,
      filters,
      requestedPage,
      limit
    );
    pages = mapPageRows(result.rows);
    // Stable re-sort of the page slice into the documented
    // attention-first order (same guard as the accounts route: the
    // database ORDER BY already produces this order; a source that
    // ignores ORDER BY must not change it).
    pages = [...pages].sort((a, b) => {
      const rank = (status: string): number => {
        if (
          status === 'invalid_token' ||
          status === 'page_checkpoint' ||
          status === 'fb_rate_limited'
        )
          return 0;
        if (status === 'paused') return 1;
        if (status === 'active') return 2;
        return 3;
      };
      const rankDiff = rank(a.status) - rank(b.status);
      if (rankDiff !== 0) return rankDiff;
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

    const res = await fetchSupabasePages(supabase, workspaceId, filters.account);
    if (res.error) {
      return NextResponse.json({ error: res.error }, { status: 500 });
    }
    // Supabase path limitation, stated honestly: PostgREST cannot order
    // by the attention-rank CASE, so the filtered rows are mapped,
    // filtered and sorted here and only the page slice is returned to
    // the client — the browser never downloads the whole list, but the
    // database round-trip is not a range query on this path.
    const mapped = mapPageRows(res.rows || []);
    const filtered = filterAndSortPages(mapped, filters);
    const sliced = paginateItems(filtered, requestedPage, limit);
    pages = sliced.items;
    meta = sliced.meta;
  }

  const responsePayload = ListFacebookPagesResponseSchema.parse({
    pages,
    total: meta.total,
    page: meta.page,
    limit: meta.limit,
    totalPages: meta.totalPages,
  });

  return NextResponse.json(responsePayload);
}

/**
 * The shell's filter + attention-first sort (pages-helpers
 * filterPagesList / sortPagesAttentionFirst), mirrored here for the
 * Supabase path, which cannot express the rank in PostgREST. Kept in
 * sync by the parity tests: same search fields (name, category),
 * same status buckets, same account match (id or display name), same
 * rank order (attention, paused, active, other) then newest first.
 */
type MappedPage = ReturnType<typeof mapPageRows>[number];

function filterAndSortPages(
  pages: MappedPage[],
  filters: PageListFilters
): MappedPage[] {
  const query = filters.search.trim().toLowerCase();
  const isAttention = (status: string) =>
    status === 'invalid_token' ||
    status === 'page_checkpoint' ||
    status === 'fb_rate_limited';
  const rank = (status: string) =>
    isAttention(status) ? 0 : status === 'paused' ? 1 : status === 'active' ? 2 : 3;
  return pages
    .filter((page) => {
      const matchesSearch =
        query.length === 0 ||
        (page.pageName ?? '').toLowerCase().includes(query) ||
        (page.category ?? '').toLowerCase().includes(query);
      let matchesStatus = true;
      if (filters.status === 'active') matchesStatus = page.status === 'active';
      else if (filters.status === 'needs_attention')
        matchesStatus = isAttention(page.status);
      else if (filters.status === 'paused')
        matchesStatus = page.status === 'paused';
      const matchesAccount =
        !filters.account ||
        filters.account === 'all' ||
        page.accountDisplayName === filters.account ||
        page.facebookAccountId === filters.account;
      return matchesSearch && matchesStatus && matchesAccount;
    })
    .sort((a, b) => {
      const rankDiff = rank(a.status) - rank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return (
        Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt))
      );
    });
}

function mapPageRows(rows: PageListRow[]) {
  return (rows || []).map((row) => {
    const updatedAt = row.updated_at || row.updatedAt;
    const rateLimitedAt = row.rate_limited_at || row.rateLimitedAt;
    const effectiveStatus = evaluatePageHealth({
      status: row.status ?? 'active',
      updatedAt: updatedAt ?? null,
      rateLimitedAt: rateLimitedAt ?? null,
    });

    const currentFollowers = extractCurrentFollowers(row);
    const startingFollowers = extractStartingFollowers(row, currentFollowers);
    const followersGained = currentFollowers - startingFollowers;

    return {
      id: row.id,
      facebookAccountId: row.facebook_account_id || row.facebookAccountId,
      accountDisplayName:
        row.account_display_name || row.accountDisplayName || '',
      fbPageId: row.fb_page_id || row.fbPageId,
      pageName: row.page_name || row.pageName,
      profilePictureUrl: extractPagePictureUrl(row),
      category: row.category ?? null,
      startingFollowers,
      currentFollowers,
      followersGained,
      followersCount: currentFollowers,
      status: effectiveStatus,
      tasks: parsePageTasks(row.tasks),
      rateLimitedAt: rateLimitedAt ? new Date(rateLimitedAt) : null,
      createdAt: row.created_at || row.createdAt,
      updatedAt: row.updated_at || row.updatedAt,
    };
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListPages(request, subdomain);
}
