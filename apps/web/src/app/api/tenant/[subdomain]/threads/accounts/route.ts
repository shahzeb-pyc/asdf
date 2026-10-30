import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  isSessionAuthorizedForSubdomain,
  ListThreadsAccountsResponseSchema,
  verifySessionToken,
  type ThreadsAccountView,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  paginateMeta,
  parsePaginationParams,
} from '@/lib/server/pagination';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * GET /api/tenant/[subdomain]/threads/accounts — the Threads accounts
 * list, modelled on the Facebook accounts list route but Threads-only.
 *
 * Data source: the unified `social_accounts` table, platform='threads'
 * — the rows the Threads connect flow persists (see
 * lib/connect/persist.ts: upsert on
 * UNIQUE(workspace_id, platform, external_account_id)). Facebook
 * accounts are never read here: every query filters platform='threads'
 * and the workspace id resolved from the session.
 *
 * Pagination is server-side and bounded, never an unbounded SELECT:
 * health counts come from `head: true` count queries (no rows), and
 * the page slice comes from two bounded `.range()` slices — expired
 * first, then the rest — so expired-first ordering holds across pages
 * without downloading the whole filtered set (PostgREST cannot order
 * by the computed expired rank, and silently truncates at 1,000 rows).
 * Health buckets partition the search-filtered set exactly:
 * connected = active with a live-or-absent token; error = disconnected
 * with a live-or-absent token; expired = everything else (stored
 * expired, or any past token).
 */

interface ThreadsAccountRow {
  id: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  status: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

type ThreadsQuery = ReturnType<SupabaseClient['from']>;

function applyBaseFilters(
  query: ThreadsQuery,
  workspaceId: string,
  search: string
): ThreadsQuery {
  let q = query
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads');
  if (search) {
    q = q.ilike('display_name', `%${search}%`);
  }
  return q;
}

function mapRowToView(row: ThreadsAccountRow): ThreadsAccountView {
  const tokenPast =
    Boolean(row.token_expires_at) &&
    Date.parse(row.token_expires_at) <= Date.now();
  const status: ThreadsAccountView['status'] =
    row.status === 'expired' || tokenPast
      ? 'expired'
      : row.status === 'active'
        ? 'active'
        : 'disconnected';
  return {
    id: row.id,
    threadsAccountId: row.external_account_id,
    displayName: row.display_name,
    profilePictureUrl: row.avatar_url ?? null,
    status,
    tokenExpiresAt: row.token_expires_at
      ? new Date(row.token_expires_at)
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function syncExpiredStatus(
  supabase: SupabaseClient,
  row: ThreadsAccountRow,
  workspaceId: string
): void {
  // Fire-and-forget, like the Facebook list route: an active row whose
  // token has passed is marked expired so later reads see it directly.
  // A failure here must not fail the list read itself.
  if (row.status !== 'active') return;
  if (!row.token_expires_at) return;
  if (Date.parse(row.token_expires_at) > Date.now()) return;
  void supabase
    .from('social_accounts')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('workspace_id', workspaceId)
    .then((res: { error: unknown }) => {
      if (res.error) {
        console.error(
          '[threads/accounts] Failed to persist expired account status:',
          res.error
        );
      }
    });
}

export async function handleListThreadsAccounts(
  request: NextRequest,
  subdomain: string,
  supabaseOverride?: SupabaseClient | null
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();

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
  if (!isSessionAuthorizedForSubdomain(session, subdomain)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = supabaseOverride ?? getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }

  const workspaceId = await resolveTenantWorkspaceId(
    supabase,
    subdomain,
    session.userId
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const { page: requestedPage, limit } = parsePaginationParams(
    url.searchParams
  );
  const search = (url.searchParams.get('search') ?? '').trim();
  const statusParam = url.searchParams.get('status') ?? 'all';
  const statusFilter =
    statusParam === 'active' || statusParam === 'expired'
      ? statusParam
      : 'all';

  const nowIso = new Date().toISOString();
  const liveTokenOr = `token_expires_at.is.null,token_expires_at.gte.${nowIso}`;

  try {
    // Full-set counts over the search-filtered set (status filter is
    // NOT applied to the counts, so the subtitle reports workspace
    // totals; the filtered view reports its own total instead).
    const totalRes = await applyBaseFilters(
      supabase.from('social_accounts').select('id', {
        count: 'exact',
        head: true,
      }),
      workspaceId,
      search
    );
    if (totalRes.error) throw new Error(totalRes.error.message);
    const total = totalRes.count ?? 0;

    const connectedRes = await applyBaseFilters(
      supabase.from('social_accounts').select('id', {
        count: 'exact',
        head: true,
      }),
      workspaceId,
      search
    )
      .eq('status', 'active')
      .or(liveTokenOr);
    if (connectedRes.error) throw new Error(connectedRes.error.message);
    const connected = connectedRes.count ?? 0;

    const errorRes = await applyBaseFilters(
      supabase.from('social_accounts').select('id', {
        count: 'exact',
        head: true,
      }),
      workspaceId,
      search
    )
      .eq('status', 'disconnected')
      .or(liveTokenOr);
    if (errorRes.error) throw new Error(errorRes.error.message);
    const errorCount = errorRes.count ?? 0;

    const healthCounts = {
      connected,
      expired: Math.max(0, total - connected - errorCount),
      error: errorCount,
    };

    // The filtered total differs from the search-only total when a
    // status filter is applied: it comes from the same buckets, so the
    // page is clamped against the filtered set, not the search set.
    const filteredTotal =
      statusFilter === 'active'
        ? healthCounts.connected
        : statusFilter === 'expired'
          ? healthCounts.expired
          : total;
    const meta = paginateMeta(filteredTotal, requestedPage, limit);
    const offset = (meta.page - 1) * limit;

    const columns =
      'id,external_account_id,display_name,avatar_url,status,token_expires_at,created_at,updated_at';

    let rows: ThreadsAccountRow[] = [];
    if (total > 0) {
      const fetchSlice = async (
        kind: 'expired' | 'rest' | 'active',
        from: number,
        to: number
      ): Promise<ThreadsAccountRow[]> => {
        if (from > to) return [];
        let q = applyBaseFilters(
          supabase
            .from('social_accounts')
            .select(columns)
            .order('created_at', { ascending: false }),
          workspaceId,
          search
        );
        if (kind === 'expired') {
          q = q.or(
            `status.eq.expired,token_expires_at.lt.${nowIso}`
          );
        } else if (kind === 'rest') {
          q = q.neq('status', 'expired').or(liveTokenOr);
        } else {
          q = q.eq('status', 'active').or(liveTokenOr);
        }
        const res = await q.range(from, to);
        if (res.error) throw new Error(res.error.message);
        return (res.data ?? []) as ThreadsAccountRow[];
      };

      if (statusFilter === 'active') {
        rows = await fetchSlice('active', offset, offset + limit - 1);
      } else if (statusFilter === 'expired') {
        rows = await fetchSlice('expired', offset, offset + limit - 1);
      } else {
        // Expired-first across pages: expired slice first, then the
        // rest (connected + error) to fill the page.
        const expiredTotal = healthCounts.expired;
        if (offset < expiredTotal) {
          const expiredRows = await fetchSlice(
            'expired',
            offset,
            Math.min(offset + limit - 1, expiredTotal - 1)
          );
          rows = expiredRows;
          const remaining = limit - expiredRows.length;
          if (remaining > 0) {
            const restRows = await fetchSlice('rest', 0, remaining - 1);
            rows = [...expiredRows, ...restRows];
          }
        } else {
          rows = await fetchSlice(
            'rest',
            offset - expiredTotal,
            offset - expiredTotal + limit - 1
          );
        }
      }
    }

    for (const row of rows) {
      syncExpiredStatus(supabase, row, workspaceId);
    }

    const parsed = ListThreadsAccountsResponseSchema.safeParse({
      accounts: rows.map(mapRowToView),
      total: filteredTotal,
      page: meta.page,
      limit: meta.limit,
      totalPages:
        filteredTotal === 0
          ? 0
          : Math.ceil(filteredTotal / meta.limit),
      healthCounts,
    });
    if (!parsed.success) {
      console.error(
        '[threads/accounts] Schema validation error:',
        parsed.error
      );
      return NextResponse.json(
        { error: 'Failed to format accounts list response' },
        { status: 500 }
      );
    }
    return NextResponse.json(parsed.data);
  } catch (err) {
    console.error('[threads/accounts] Failed to list accounts:', err);
    return NextResponse.json(
      { error: "Couldn't load your Threads accounts. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListThreadsAccounts(request, subdomain);
}
