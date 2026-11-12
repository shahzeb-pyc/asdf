import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  decryptToken,
  encryptToken,
  fetchAllFacebookPages,
  getSessionSecret,
  getTokenEncryptionKey,
  PublishNowImportRequestSchema,
  PublishNowImportResponseSchema,
  verifySessionToken,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  isTokenDeadGraphStatus,
  markAccountConnectionError,
} from '@/lib/connect/account-probe';
import { logServerError } from '@/lib/server-analytics';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Publish Now import (spec 174 1B).
 *
 * The Publish Now picker lists ONLY Publish Now imports. This route
 * is the import step that runs before the picker: for each selected
 * Facebook account it fetches that account's pages live from Graph
 * (the same fetch the discover route runs) and upserts one
 * destination copy per page with `section = 'publish_now'`.
 *
 * The import IS the section's copy — it never adopts or mutates a
 * row belonging to another section (the conflict target includes
 * the section, and the pre-load reads publish_now copies only).
 * A removed stub is reactivated by the import (fresh token, status
 * active); an active copy keeps its follower baseline. Publish Now
 * is uncapped, so this import never touches the paid cap and never
 * writes posting times, queue rows, or usage rows.
 *
 * The picker renders the returned groups directly; each page's
 * disabled-with-reason state comes from its own copy's status —
 * the old GET /pages cross-section lookup (limit 500, fail-open)
 * is gone.
 */

interface PublishNowImportAccountRow {
  id: string;
  display_name: string | null;
  encrypted_access_token: string | null;
}

interface PublishNowCopyRow {
  external_destination_id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export async function handleImportPublishNowPages(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient<Database>
): Promise<NextResponse> {
  const limited = await enforceIpRateLimit(request, 'tenant_publish_now_import', 20);
  if (limited) return limited;

  const sessionSecret = getSessionSecret();
  const encryptionKey = getTokenEncryptionKey();

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

  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = (dbClient ?? getSupabaseAdminClient()) as SupabaseClient<Database> | null;
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, supabase);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  const parsed = PublishNowImportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const groups: Array<{
    accountId: string;
    accountName: string;
    pages: Array<{
      fbPageId: string;
      pageName: string;
      profilePictureUrl: string | null;
      category: string | null;
      followers: number;
      status: string;
    }>;
  }> = [];
  const failures: string[] = [];

  for (const accountId of parsed.data.accountIds) {
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('id, display_name, encrypted_access_token')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();
    if (accountError || !account) {
      failures.push(accountId);
      continue;
    }
    const accountRow = account as unknown as PublishNowImportAccountRow;
    const accountName = accountRow.display_name ?? 'Facebook account';

    const encryptedToken = accountRow.encrypted_access_token;
    if (!encryptedToken) {
      failures.push(accountName);
      continue;
    }
    let rawToken: string;
    try {
      rawToken = await decryptToken(encryptedToken, encryptionKey);
    } catch (err) {
      logServerError('[publish-now/import] Failed to decrypt account credentials', err, {
        source: 'publish-now-import',
        subdomain,
      });
      failures.push(accountName);
      continue;
    }

    let fetched: Awaited<ReturnType<typeof fetchAllFacebookPages>>;
    try {
      fetched = await fetchAllFacebookPages(
        rawToken,
        'id,name,category,tasks,access_token,followers_count,picture{url}'
      );
    } catch (err: unknown) {
      logServerError('[publish-now/import] Facebook Graph query failed', err, {
        source: 'publish-now-import',
        subdomain,
      });
      const status =
        err !== null && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : 500;
      if (isTokenDeadGraphStatus(status)) {
        await markAccountConnectionError(supabase, workspaceId, accountId);
      }
      failures.push(accountName);
      continue;
    }

    // Same discoverable-page rule as the discover route: /me/accounts
    // can return non-page nodes (the pinned case is a group node with
    // an id and a name but no category and no tasks).
    const rawItems = fetched.pages;
    const isDiscoverablePage = (item: (typeof rawItems)[number]): boolean =>
      Boolean(item.id && item.name && (item.category || item.tasks));
    const discoveredPages = rawItems.filter(isDiscoverablePage);

    const pageFbIds = discoveredPages.map((item) => String(item.id));
    const { data: existingRows, error: existingError } = await supabase
      .from('destinations')
      .select('external_destination_id, status, metadata')
      .eq('workspace_id', workspaceId)
      .eq('account_id', accountId)
      .eq('platform', 'facebook')
      .eq('section', 'publish_now')
      .in('external_destination_id', pageFbIds.length > 0 ? pageFbIds : ['']);
    if (existingError) {
      logServerError('[publish-now/import] Failed to load existing copies', existingError, {
        source: 'publish-now-import',
        subdomain,
      });
      failures.push(accountName);
      continue;
    }
    const existingByFbId = new Map<string, PublishNowCopyRow>();
    for (const row of (existingRows ?? []) as unknown as PublishNowCopyRow[]) {
      existingByFbId.set(row.external_destination_id, row);
    }

    const nowIso = new Date().toISOString();
    const upsertRows: Array<Record<string, unknown>> = [];
    const responsePages: Array<{
      fbPageId: string;
      pageName: string;
      profilePictureUrl: string | null;
      category: string | null;
      followers: number;
      status: string;
    }> = [];
    let upsertFailed = false;
    for (const item of discoveredPages) {
      const fbPageId = String(item.id);
      const followers =
        typeof item.followers_count === 'number' ? Math.max(0, item.followers_count) : 0;
      if (!item.access_token) {
        // A page without a token cannot be published to; skip it
        // rather than importing a copy that can never publish.
        continue;
      }
      let encryptedPageToken: string;
      try {
        encryptedPageToken = await encryptToken(item.access_token, encryptionKey);
      } catch (err) {
        logServerError('[publish-now/import] Failed to encrypt page token', err, {
          source: 'publish-now-import',
          subdomain,
        });
        upsertFailed = true;
        break;
      }
      const existing = existingByFbId.get(fbPageId);
      const existingMetadata = existing?.metadata ?? {};
      const preserveBaseline =
        existing !== undefined &&
        existing.status !== 'disconnected' &&
        typeof existingMetadata.starting_followers === 'number';
      upsertRows.push({
        workspace_id: workspaceId,
        account_id: accountId,
        platform: 'facebook',
        section: 'publish_now',
        external_destination_id: fbPageId,
        name: String(item.name),
        avatar_url: item.picture?.data?.url ?? null,
        encrypted_destination_token: encryptedPageToken,
        status: 'active',
        metadata: {
          ...existingMetadata,
          category: item.category ?? null,
          tasks: Array.isArray(item.tasks) ? item.tasks : [],
          starting_followers: preserveBaseline
            ? existingMetadata.starting_followers
            : followers,
          current_followers: followers,
          followers_updated_at: nowIso,
        },
        updated_at: nowIso,
      });
      responsePages.push({
        fbPageId,
        pageName: String(item.name),
        profilePictureUrl: item.picture?.data?.url ?? null,
        category: item.category ?? null,
        followers,
        status: 'active',
      });
    }
    if (upsertFailed) {
      failures.push(accountName);
      continue;
    }
    if (upsertRows.length > 0) {
      const { error: upsertError } = await supabase
        .from('destinations')
        .upsert(upsertRows, { onConflict: 'account_id,external_destination_id,section' });
      if (upsertError) {
        logServerError('[publish-now/import] Failed to upsert copies', upsertError, {
          source: 'publish-now-import',
          subdomain,
        });
        failures.push(accountName);
        continue;
      }
    }
    groups.push({ accountId, accountName, pages: responsePages });
  }

  return NextResponse.json(
    PublishNowImportResponseSchema.parse({ groups, failures })
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleImportPublishNowPages(request, subdomain);
}
