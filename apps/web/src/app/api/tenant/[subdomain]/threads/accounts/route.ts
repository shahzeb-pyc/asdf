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

/**
 * Fresh base builders. The return types are left inferred: Supabase's
 * filter-builder type carries the table's row shape, and spelling it
 * by hand (PostgrestQueryBuilder) drops the filter methods. Each
 * caller chains eq/ilike/or/order/range on the inferred builder.
 */

/**
 * Threads profile address for a stored @handle. The host is the
 * Threads web host from the connect config
 * (`lib/connect/platforms/threads.ts`: authorize `threads.com`);
 * the handle itself comes from the account's destination row
 * (`destinations.handle` = the Threads username), never from the
 * display name. Null handle → null link.
 */
export function buildThreadsProfileUrl(handle: string | null): string | null {
  if (!handle || !handle.trim()) return null;
  return `https://threads.com/@${encodeURIComponent(handle.trim())}`;
}

export interface ThreadsDestinationInfo {
  handle: string | null;
  connectedDestinationsCount: number;
}

function mapRowToView(
  row: ThreadsAccountRow,
  destinationInfo?: ThreadsDestinationInfo
): ThreadsAccountView {
  // Facebook's UI health model (getAccountHealth parity): a past
  // token means expired regardless of the stored status; an unknown
  // stored status reads as disconnected (Facebook's wire map does
  // the same: unifiedAccountStatusToWire → 'disconnected').
  const tokenPast =
    row.token_expires_at !== null &&
    Date.parse(row.token_expires_at) <= Date.now();
  const status: ThreadsAccountView['status'] =
    row.status === 'expired' || tokenPast
      ? 'expired'
      : row.status === 'active'
        ? 'active'
        : 'disconnected';
  const handle = destinationInfo?.handle ?? null;
  return {
    id: row.id,
    threadsAccountId: row.external_account_id,
    displayName: row.display_name,
    profilePictureUrl: row.avatar_url ?? null,
    handle,
    accountLink: buildThreadsProfileUrl(handle),
    connectedDestinationsCount:
      destinationInfo?.connectedDestinationsCount ?? 0,
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
    statusParam === 'active' ||
    statusParam === 'expired' ||
    statusParam === 'expiring_soon'
      ? statusParam
      : 'all';

  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const liveTokenOr = `token_expires_at.is.null,token_expires_at.gte.${nowIso}`;

  try {
    // Health counts over the SEARCH + STATUS filtered set, Facebook
    // semantics: Facebook's list SQL counts its health buckets over
    // the same WHERE (search + status) as the page, so the Expired
    // filter badge hides on the Active tab (0 within that set)
    // instead of reporting the workspace total. The three buckets
    // partition the filtered set exactly (connected = active with a
    // live-or-absent token; expired = stored expired or a past
    // token; error = disconnected with a live-or-absent token).
    const baseCount = () =>
      supabase
        .from('social_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads');
    const withSearch = <T extends { ilike: (c: string, p: string) => T }>(
      q: T
    ): T => (search ? q.ilike('display_name', `%${search}%`) : q);

    const totalRes = await withSearch(baseCount());
    if (totalRes.error) throw new Error(totalRes.error.message);
    const total = totalRes.count ?? 0;

    const connectedRes = await withSearch(baseCount())
      .eq('status', 'active')
      .or(liveTokenOr);
    if (connectedRes.error) throw new Error(connectedRes.error.message);
    const connected = connectedRes.count ?? 0;

    const errorRes = await withSearch(baseCount())
      .eq('status', 'disconnected')
      .or(liveTokenOr);
    if (errorRes.error) throw new Error(errorRes.error.message);
    const errorCount = errorRes.count ?? 0;

    // Expiring-soon (Facebook parity: active + token in the next
    // 7 days). No UI tab sends it yet, same as Facebook — the API
    // accepts it so the filter is real, not a silent collapse to all.
    const expiringSoonRes = await withSearch(baseCount())
      .eq('status', 'active')
      .gt('token_expires_at', nowIso)
      .lte('token_expires_at', soonIso);
    if (expiringSoonRes.error) throw new Error(expiringSoonRes.error.message);
    const expiringSoon = expiringSoonRes.count ?? 0;

    const searchCounts = {
      connected,
      expired: Math.max(0, total - connected - errorCount),
      error: errorCount,
    };

    // The filtered total differs from the search-only total when a
    // status filter is applied: it comes from the same buckets, so the
    // page is clamped against the filtered set, not the search set.
    // healthCounts follow the same filtered set (see above).
    const filteredTotal =
      statusFilter === 'active'
        ? searchCounts.connected
        : statusFilter === 'expired'
          ? searchCounts.expired
          : statusFilter === 'expiring_soon'
            ? expiringSoon
            : total;
    const healthCounts =
      statusFilter === 'active'
        ? { connected: searchCounts.connected, expired: 0, error: 0 }
        : statusFilter === 'expired'
          ? { connected: 0, expired: searchCounts.expired, error: 0 }
          : statusFilter === 'expiring_soon'
            ? { connected: expiringSoon, expired: 0, error: 0 }
            : searchCounts;
    const meta = paginateMeta(filteredTotal, requestedPage, limit);
    const offset = (meta.page - 1) * limit;

    const columns =
      'id,external_account_id,display_name,avatar_url,status,token_expires_at,created_at,updated_at';

    let rows: ThreadsAccountRow[] = [];
    if (total > 0) {
      const fetchSlice = async (
        kind: 'expired' | 'rest' | 'active' | 'expiring_soon',
        from: number,
        to: number
      ): Promise<ThreadsAccountRow[]> => {
        if (from > to) return [];
        let q = withSearch(
          supabase
            .from('social_accounts')
            .select(columns)
            .eq('workspace_id', workspaceId)
            .eq('platform', 'threads')
            .order('created_at', { ascending: false })
        );
        if (kind === 'expired') {
          q = q.or(`status.eq.expired,token_expires_at.lt.${nowIso}`);
        } else if (kind === 'rest') {
          q = q.neq('status', 'expired').or(liveTokenOr);
        } else if (kind === 'expiring_soon') {
          q = q
            .eq('status', 'active')
            .gt('token_expires_at', nowIso)
            .lte('token_expires_at', soonIso);
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
      } else if (statusFilter === 'expiring_soon') {
        rows = await fetchSlice('expiring_soon', offset, offset + limit - 1);
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

    // Per-account destination info (bounded to the page slice):
    // the @handle for the profile link and the destination count
    // the disconnect dialog shows. Facebook's list returns
    // connectedPagesCount from a join; Threads returns the
    // destination equivalent. Non-disconnected destinations only.
    const destinationInfoByAccount = new Map<string, ThreadsDestinationInfo>();
    if (rows.length > 0) {
      const destRes = await supabase
        .from('destinations')
        .select('account_id,handle')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .neq('status', 'disconnected')
        .in(
          'account_id',
          rows.map((row) => row.id)
        );
      if (destRes.error) throw new Error(destRes.error.message);
      for (const dest of (destRes.data ?? []) as Array<{
        account_id: string;
        handle: string | null;
      }>) {
        const prev = destinationInfoByAccount.get(dest.account_id) ?? {
          handle: null,
          connectedDestinationsCount: 0,
        };
        destinationInfoByAccount.set(dest.account_id, {
          handle: prev.handle ?? dest.handle ?? null,
          connectedDestinationsCount: prev.connectedDestinationsCount + 1,
        });
      }
    }

    const parsed = ListThreadsAccountsResponseSchema.safeParse({
      accounts: rows.map((row) =>
        mapRowToView(row, destinationInfoByAccount.get(row.id))
      ),
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
