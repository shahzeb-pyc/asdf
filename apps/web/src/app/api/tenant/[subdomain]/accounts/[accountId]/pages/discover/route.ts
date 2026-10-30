import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  decryptToken,
  DiscoverPagesResponseSchema,
  fetchAllFacebookPages,
  getSessionSecret,
  getTokenEncryptionKey,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  isTokenDeadGraphStatus,
  markAccountConnectionError,
} from '@/lib/connect/account-probe';
import { logServerError } from '@/lib/server-analytics';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleDiscoverPages(
  request: NextRequest,
  subdomain: string,
  accountId: string,
  dbClient?: DatabaseClient | SupabaseClient<Database>
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();
  const encryptionKey = getTokenEncryptionKey();

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
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Resolve workspace ID scoped to user (supports admin inspection)
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // 4. Fetch account and composite ownership (user_id, workspace_id, accountId)
  // Row shapes as consumed below (spec 137 §3.7): the account fields this
  // handler reads, in both the snake_case (SQL/Supabase) and camelCase
  // (legacy) spellings, and the imported-page id rows.
  interface AccountLookupRow {
    encrypted_access_token?: string | null;
    encryptedAccessToken?: string | null;
    display_name?: string | null;
    displayName?: string | null;
  }
  interface ImportedPageIdRow {
    fb_page_id: string;
    fbPageId?: string;
  }
  let account: AccountLookupRow | null = null;
  let importedRows: ImportedPageIdRow[] = [];

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const accounts = await dbClient.query<AccountLookupRow>(
      "SELECT encrypted_access_token, display_name FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [accountId, workspaceId]
    );

    if (!accounts || accounts.length === 0 || !accounts[0]) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    account = accounts[0];

    // Audit BG7: isImported is per-ACCOUNT, not workspace-wide —
    // a page imported under another account must not read as
    // imported when discovering under this one.
    importedRows = await dbClient.query<ImportedPageIdRow>(
      "SELECT external_destination_id AS fb_page_id FROM destinations WHERE workspace_id = $1 AND account_id = $2 AND platform = 'facebook' AND (status != 'disconnected' OR metadata->>'fb_status' = 'paused')",
      [workspaceId, accountId]
    );
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: accData, error: accErr } = await supabase
      .from('social_accounts')
      .select('encrypted_access_token, display_name')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();

    if (accErr || !accData) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    account = accData;

    // Audit N1: page through with .range() like the accounts
    // list — a single select would silently truncate past
    // PostgREST's 1,000-row limit and misreport isImported.
    // Past 10 full pages the discover fails loudly instead.
    const DISCOVER_PAGE_SIZE = 1000;
    const DISCOVER_MAX_PAGES = 10;
    const pageRows: unknown[] = [];
    for (let page = 0; page < DISCOVER_MAX_PAGES; page++) {
      const from = page * DISCOVER_PAGE_SIZE;
      const { data, error: pageErr } = await supabase
        .from('destinations')
        .select('external_destination_id, status, metadata')
        .eq('workspace_id', workspaceId)
        .eq('account_id', accountId)
        .eq('platform', 'facebook')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + DISCOVER_PAGE_SIZE - 1);
      if (pageErr) {
        return NextResponse.json(
          { error: 'Failed to load imported pages' },
          { status: 500 }
        );
      }
      const slice = (data || []) as unknown[];
      pageRows.push(...slice);
      if (slice.length < DISCOVER_PAGE_SIZE) {
        break;
      }
      if (page === DISCOVER_MAX_PAGES - 1) {
        // A 10th full page means more rows may exist — fail
        // loudly rather than misreport isImported on a partial set.
        return NextResponse.json(
          { error: 'Too many imported pages to list reliably; please contact support.' },
          { status: 500 }
        );
      }
    }

    const destinationRows = pageRows as unknown as Array<{
      external_destination_id: string;
      status: string;
      metadata: Record<string, unknown> | null;
    }>;
    importedRows = destinationRows
      .filter(
        (r) =>
          r.status !== 'disconnected' || r.metadata?.fb_status === 'paused'
      )
      .map((r) => ({
        fb_page_id: r.external_destination_id,
      }));
  }

  const encryptedToken =
    account.encrypted_access_token || account.encryptedAccessToken;
  if (!encryptedToken) {
    return NextResponse.json(
      { error: 'Failed to decrypt account credentials' },
      { status: 500 }
    );
  }

  let rawToken: string;
  try {
    rawToken = await decryptToken(encryptedToken, encryptionKey);
  } catch (err) {
    logServerError('[pages/discover] Failed to decrypt account credentials', err, {
      source: 'pages-discover',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to decrypt account credentials' },
      { status: 500 }
    );
  }

  // 4. Query Facebook Graph API v26.0 /me/accounts with pagination
  // BG6 + R14: the unified helper reports truncation, so a partial
  // list is never presented as complete. The payload splits it
  // into capped (truncated) vs mid-list-failed (partial) below.
  let fetched: Awaited<ReturnType<typeof fetchAllFacebookPages>>;
  try {
    fetched = await fetchAllFacebookPages(
      rawToken,
      'id,name,category,tasks,access_token,followers_count,picture{url}'
    );
  } catch (err: unknown) {
    logServerError('[pages/discover] Facebook Graph query failed', err, {
      source: 'pages-discover',
      subdomain,
    });
    const status =
      err !== null &&
      typeof err === 'object' &&
      'status' in err &&
      typeof err.status === 'number'
        ? err.status
        : 500;
    // Audit BG20: discover IS the probe — an auth-class failure
    // means the user token is dead (revoked/invalid), so the
    // account is marked 'error' now instead of reading
    // "Connected" until a publish fails. Transient failures
    // leave the status untouched.
    if (isTokenDeadGraphStatus(status)) {
      await markAccountConnectionError(dbClient, workspaceId, accountId);
    }
    return NextResponse.json(
      { error: 'Failed to query Facebook Graph API' },
      { status }
    );
  }

  // 5. Query already imported active/linked pages for this user to compute isImported
  const importedPageIds = new Set(
    importedRows.map((r) => r.fb_page_id || r.fbPageId)
  );

  // 6. Strictly filter for authentic Facebook Pages (ignore groups or malformed nodes)
  // K9: this filter exists because /me/accounts can return non-page
  // nodes (the pinned case is a group node with an id and a name but
  // no category and no tasks). A real page with neither a category
  // nor tasks would be dropped by it too, and the two cannot be told
  // apart from the Graph payload — so the drop is COUNTED and
  // surfaced (droppedCount) instead of silently disappearing, and
  // the Add Page flow shows that count next to the list.
  const rawItems = fetched.pages;
  const isDiscoverablePage = (item: (typeof rawItems)[number]): boolean =>
    Boolean(item.id && item.name && (item.category || item.tasks));
  const droppedCount = rawItems.filter((item) => !isDiscoverablePage(item)).length;
  const discoveredPages = rawItems
    .filter(isDiscoverablePage)
    .map((item) => {
      const followers =
        typeof item.followers_count === 'number'
          ? Math.max(0, item.followers_count)
          : 0;
      return {
        fbPageId: String(item.id),
        pageName: String(item.name),
        profilePictureUrl: item.picture?.data?.url ?? null,
        category: item.category ?? null,
        currentFollowers: followers,
        followersCount: followers,
        tasks: Array.isArray(item.tasks) ? item.tasks : [],
        isImported: importedPageIds.has(String(item.id)),
      };
    });

  const responsePayload = DiscoverPagesResponseSchema.parse({
    accountId,
    accountDisplayName: account.display_name || account.displayName,
    pages: discoveredPages,
    total: discoveredPages.length,
    // R14: never present a capped or mid-list-failed fetch as the
    // account's complete page list — the modal warns on both flags.
    // Payload `truncated` is cap-only (reason 'page_limit'), NOT
    // the helper's either-cause flag: the modal's capped-list text
    // names the 500 cap specifically.
    truncated: fetched.truncationReason === 'page_limit',
    partial: fetched.partial,
    droppedCount,
  });

  return NextResponse.json(responsePayload);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; accountId: string }> }
): Promise<NextResponse> {
  const { subdomain, accountId } = await context.params;
  // Audit S6: previously unthrottled Graph-backed call; 20/min like import.
  const limited = await enforceIpRateLimit(request, 'tenant_account_discover', 20);
  if (limited) return limited;
  return handleDiscoverPages(request, subdomain, accountId);
}
