import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  decryptToken,
  encryptToken,
  fetchAllFacebookPages,
  getSessionSecret,
  getTokenEncryptionKey,
  ImportPagesRequestSchema,
  ImportPagesResponseSchema,
  verifySessionToken,
  type DatabaseClient,
  type Database,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  isTokenDeadGraphStatus,
  markAccountConnectionError,
} from '@/lib/connect/account-probe';
import { logServerError, trackServerEvent } from '@/lib/server-analytics';
import {
  bodyTooLargeResponse,
  enforceIpRateLimit,
  LARGE_JSON_BODY_LIMIT_BYTES,
  readJsonBody,
} from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function handleImportPages(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient
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

  // 3. Parse request body, capped like magic-link/publish-now
  // (Audit N4: the old raw request.json() was unbounded).
  const bodyRead = await readJsonBody(request, LARGE_JSON_BODY_LIMIT_BYTES);
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too-large'
      ? bodyTooLargeResponse()
      : NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const bodyJson: unknown = bodyRead.value;

  const parseResult = ImportPagesRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Invalid request payload', details: parseResult.error.format() },
      { status: 400 }
    );
  }

  const { accountId, selectedPageIds, timezone, postingTimes } =
    parseResult.data;

  // 4. Resolve workspace ID scoped to user
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // Account row shape as consumed below (spec 137 §3.7): the token
  // fields, in snake_case (SQL/Supabase) and camelCase (legacy) spellings.
  interface AccountLookupRow {
    encrypted_access_token?: string | null;
    encryptedAccessToken?: string | null;
  }
  let account: AccountLookupRow | null = null;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const accounts = await dbClient.query<AccountLookupRow>(
      "SELECT encrypted_access_token FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'",
      [accountId, workspaceId]
    );

    if (!accounts || accounts.length === 0 || !accounts[0]) {
      return NextResponse.json(
        { error: 'Facebook account not found' },
        { status: 404 }
      );
    }
    account = accounts[0];
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient<Database> | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: accData, error: accErr } = await supabase
      .from('social_accounts')
      .select('encrypted_access_token')
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
    logServerError('[pages/import] Failed to decrypt account credentials', err, {
      source: 'pages-import',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to decrypt account credentials' },
      { status: 500 }
    );
  }

  // 5. Query Facebook Graph API v26.0 /me/accounts with pagination
  // BG6 + R14: the unified helper reports truncation — a selected
  // page missing from a truncated list is not "removed", it is
  // unseen, and the PARTIAL_IMPORT message below says so.
  // A truncated/partial re-discovery can only fail to match a
  // selected page, which the schedule pre-check below turns into
  // an error (or the legacy path imports what matched) — it never
  // imports the wrong page. Truncation surfacing for the user
  // belongs to the discover flow (R14), not this import.
  let rawItems: Awaited<ReturnType<typeof fetchAllFacebookPages>>['pages'] = [];
  let graphTruncated = false;
  try {
    const fetched = await fetchAllFacebookPages(
      rawToken,
      'id,name,category,tasks,access_token,followers_count,picture{url}'
    );
    rawItems = fetched.pages;
    graphTruncated = fetched.truncated;
  } catch (err) {
    logServerError('[pages/import] Facebook Graph query failed', err, {
      source: 'pages-import',
      subdomain,
    });
    // Audit BG20: import is also an explicit probe — same rule
    // as discover: an auth-class failure marks the account
    // 'error' so the next list render shows it, instead of the
    // revocation staying invisible until a publish fails.
    const graphStatus =
      err !== null &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined;
    if (isTokenDeadGraphStatus(graphStatus)) {
      await markAccountConnectionError(dbClient, workspaceId, accountId);
    }
    return NextResponse.json(
      { error: 'Failed to query Facebook Graph API' },
      { status: 502 }
    );
  }

  // Duplicate ids in the request collapse to one page: the Graph
  // result holds each page once, so the count check below compares
  // against the deduped list, not the raw request list.
  const dedupedSelectedPageIds = [...new Set(selectedPageIds)];
  const selectedSet = new Set(dedupedSelectedPageIds);
  const matchedPages = rawItems.filter((item) => selectedSet.has(String(item.id)));

  // Audit BG8, fail loud (owner decision 2026-10-30): a selected
  // page Facebook no longer returns (access removed, page
  // deleted/renamed) used to be silently skipped on the
  // no-schedule path while the UI reported success. Now ANY
  // shortfall aborts BEFORE anything is written, naming the
  // missing pages — the old schedule-only guard below is
  // subsumed by this universal one. Nothing is imported on this
  // path, so there is nothing to roll back.
  if (matchedPages.length !== dedupedSelectedPageIds.length) {
    const matchedIds = new Set(matchedPages.map((item) => String(item.id)));
    const missing = dedupedSelectedPageIds.filter(
      (id) => !matchedIds.has(String(id))
    );
    logServerError(
      '[pages/import] Selected pages missing from Graph result',
      new Error(`Graph returned ${matchedPages.length} of ${dedupedSelectedPageIds.length} selected pages`),
      {
        source: 'pages-import-partial',
        subdomain,
        missing,
      }
    );
    return NextResponse.json(
      {
        error: `These pages could not be found on this Facebook account and were not added: ${missing.join(', ')}. Nothing was imported — if you removed access to a page, it can't be added.${graphTruncated ? ' Facebook also returned an incomplete page list, so a missing page may still exist — try again to load the full list.' : ''}`,
        code: 'PARTIAL_IMPORT',
        skipped: missing.map((fbPageId) => ({ fbPageId })),
      },
      { status: 422 }
    );
  }

  // Audit N4, fail loud like BG8: a page Graph returns WITHOUT a
  // page token used to be imported with the USER token stored as
  // the page token — it would read as connected and fail only at
  // publish time, with nothing marking it as wrong. Now such
  // pages abort BEFORE anything is written, named in the same
  // PARTIAL_IMPORT shape as the shortfall guard above.
  const tokenlessPages = matchedPages.filter(
    (item) => !item.access_token
  );
  if (tokenlessPages.length > 0) {
    const tokenlessIds = tokenlessPages.map((item) => String(item.id));
    logServerError(
      '[pages/import] Selected pages returned no page token from Graph',
      new Error(`Graph omitted access_token for ${tokenlessPages.length} selected pages`),
      {
        source: 'pages-import-missing-token',
        subdomain,
        missing: tokenlessIds,
      }
    );
    return NextResponse.json(
      {
        error: `These pages did not return a page token from Facebook and were not added: ${tokenlessIds.join(', ')}. Nothing was imported — if a page's token is missing, it can't publish as that page.`,
        code: 'PARTIAL_IMPORT',
        skipped: tokenlessIds.map((fbPageId) => ({ fbPageId })),
      },
      { status: 422 }
    );
  }

  // Query existing destinations before upserting via Supabase to
  // preserve starting_followers for active pages (the follower
  // baseline lives in destinations.metadata since the unified schema).
  const isSupabaseMode =
    !dbClient || !('query' in dbClient) || typeof dbClient.query !== 'function';
  // The pre-upsert snapshot of a destination, used by rollback to
  // restore exactly what the upsert overwrote (name, avatar, token,
  // metadata) — the upsert runs before any schedule write, so a
  // post-upsert read of these columns would already see the new
  // values. Keyed by fbPageId; populated from the same pre-loads
  // below, so no extra query is needed in either path.
  interface PreUpsertSnapshot {
    name: string | null;
    avatarUrl: string | null;
    encryptedToken: string | null;
    metadata: Record<string, unknown>;
  }
  // The snapshot columns as a load carries them: present (possibly
  // null) when the load selected them, undefined when it did not —
  // kept distinct under exactOptionalPropertyTypes so a load that
  // did not carry a column can never pass as "restore null".
  interface PreUpsertSnapshotCarried {
    name?: string | null | undefined;
    avatarUrl?: string | null | undefined;
    encryptedToken?: string | null | undefined;
  }
  const existingPagesMap = new Map<
    string,
    {
      status: string;
      starting_followers: number | null;
      metadata: Record<string, unknown>;
    } & PreUpsertSnapshotCarried
  >();
  // Postgres pre-existing map, for the same "schedule only newly
  // created or previously disconnected pages" rule the Supabase
  // path gets from existingPagesMap. Status matters, not mere
  // existence: a disconnected row is reactivated by this import
  // and must receive the new schedule, while an active (or paused,
  // etc.) row must keep its own schedule untouched. The map is
  // account-scoped (the upsert key is (account_id,
  // external_destination_id)) and also carries fb_status, because a
  // PAUSED page is stored as disconnected + fb_status='paused' and
  // must NOT be treated as reactivated (K9).
  const preExistingStatusByFbId = new Map<
    string,
    {
      status: string;
      fbStatus: string | null;
      metadata: Record<string, unknown>;
    } & PreUpsertSnapshotCarried
  >();
  // The paused marker is derived from the rich map's fbStatus
  // below (no separate paused map): a paused page is a
  // 'disconnected' row carrying metadata.fb_status = 'paused'.
  // It must survive a re-import paused (token refreshed, status
  // untouched) — so the marker is tracked alongside status on
  // both paths.

  if (
    dbClient &&
    'query' in dbClient &&
    typeof dbClient.query === 'function' &&
    matchedPages.length > 0
  ) {
    const preExistingRows = (await dbClient.query<{
      external_destination_id?: string;
      externalDestinationId?: string;
      status?: string;
      fb_status?: string | null;
      name?: string | null;
      avatar_url?: string | null;
      encrypted_destination_token?: string | null;
      metadata?: Record<string, unknown> | string | null;
    }>(
      `SELECT external_destination_id, status, metadata->>'fb_status' AS fb_status,
        name, avatar_url, encrypted_destination_token, metadata FROM destinations
       WHERE account_id = $1 AND external_destination_id = ANY($2::text[])`,
      [accountId, matchedPages.map((item) => String(item.id))]
    )) as Array<{
      external_destination_id?: string;
      externalDestinationId?: string;
      status?: string;
      fb_status?: string | null;
      name?: string | null;
      avatar_url?: string | null;
      encrypted_destination_token?: string | null;
      metadata?: Record<string, unknown> | string | null;
    }>;
    for (const row of preExistingRows ?? []) {
      const fbPageId = row.external_destination_id ?? row.externalDestinationId;
      if (!fbPageId) continue;
      let metadata: Record<string, unknown> = {};
      if (row.metadata && typeof row.metadata === 'object') {
        metadata = row.metadata as Record<string, unknown>;
      } else if (typeof row.metadata === 'string') {
        try {
          const parsed: unknown = JSON.parse(row.metadata);
          if (parsed && typeof parsed === 'object') {
            metadata = parsed as Record<string, unknown>;
          }
        } catch (_e) {
          // An unparseable stored metadata is treated as empty for
          // the snapshot; the upsert below still rewrites it, and
          // rollback then cannot restore what it could not read —
          // that page is marked incomplete by the caller instead.
          metadata = {};
        }
      }
      // fbStatus prefers the SQL alias; the metadata object's own
      // fb_status is the fallback for loads that did not carry the
      // alias (e.g. older test doubles) — same value in production.
      const fbStatusFromMetadata =
        typeof metadata.fb_status === 'string' ? metadata.fb_status : null;
      preExistingStatusByFbId.set(String(fbPageId), {
        status: row.status ?? '',
        fbStatus: row.fb_status ?? fbStatusFromMetadata,
        // Raw values, NOT coerced: a missing column (undefined)
        // means this load did not carry a restorable snapshot, and
        // preUpsertSnapshot below must say so instead of restoring
        // nulls over the page's real name/token. A real NULL (e.g.
        // no avatar) stays null and restores as null.
        name: row.name,
        avatarUrl: row.avatar_url,
        encryptedToken: row.encrypted_destination_token,
        metadata,
      });
    }
  }

  // Evaluated at upsert time, after existingPagesMap is populated
  // below for the Supabase path.
  const isPreExistingDestination = (fbPageId: string): boolean =>
    isSupabaseMode
      ? existingPagesMap.has(fbPageId)
      : preExistingStatusByFbId.has(fbPageId);
  const preExistingStatus = (fbPageId: string): string =>
    isSupabaseMode
      ? (existingPagesMap.get(fbPageId)?.status ?? '')
      : (preExistingStatusByFbId.get(fbPageId)?.status ?? '');
  const isPausedDestination = (fbPageId: string): boolean => {
    if (preExistingStatus(fbPageId) !== 'disconnected') return false;
    const fbStatus = isSupabaseMode
      ? (existingPagesMap.get(fbPageId)?.metadata?.fb_status ?? null)
      : (preExistingStatusByFbId.get(fbPageId)?.fbStatus ?? null);
    return fbStatus === 'paused';
  };
  // K9/BG8: a paused page (disconnected + fb_status='paused') is
  // NOT a reactivation — it keeps its paused marker and receives
  // no schedule, must not enter scheduleTargets, must not have
  // its slots deleted, and must not have its marker stripped.
  const isReactivatedDestination = (fbPageId: string): boolean =>
    isPreExistingDestination(fbPageId) &&
    preExistingStatus(fbPageId) === 'disconnected' &&
    !isPausedDestination(fbPageId);
  // Pre-upsert snapshot for a fbPageId, from whichever path loaded
  // it. Undefined when the page is not pre-existing (or the load
  // did not carry the columns, e.g. a stale test double) — the
  // rollback caller treats a missing snapshot for a reactivated
  // target as incomplete rather than restoring fabricated values.
  const preUpsertSnapshot = (
    fbPageId: string
  ): PreUpsertSnapshot | undefined => {
    const entry = isSupabaseMode
      ? existingPagesMap.get(fbPageId)
      : preExistingStatusByFbId.get(fbPageId);
    // Every snapshot column must have been carried by the load;
    // a single missing column means "no restorable snapshot", not
    // "restore nulls" — the caller aborts the schedule instead.
    if (
      !entry ||
      entry.name === undefined ||
      entry.avatarUrl === undefined ||
      entry.encryptedToken === undefined
    ) {
      return undefined;
    }
    return {
      name: entry.name,
      avatarUrl: entry.avatarUrl,
      encryptedToken: entry.encryptedToken,
      metadata: entry.metadata,
    };
  };
  // The universal BG8 guard above already rejects a short Graph
  // result before anything is written, schedule or not — the old
  // schedule-only guard lived here and is deleted, not kept
  // alongside it.

  if (isSupabaseMode && matchedPages.length > 0) {
    const supabase = (
      dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
    ) as SupabaseClient | null;
    if (supabase) {
      const pageFbIds = matchedPages.map((item) => String(item.id));
      const { data: existingRows, error: existingErr } = await supabase
        .from('destinations')
        .select('external_destination_id, status, metadata, name, avatar_url, encrypted_destination_token')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        // K9: the upsert key is (account_id,
        // external_destination_id) — scoping by workspace alone
        // misclassifies a second account's row for the same page as
        // pre-existing under this account.
        .eq('account_id', accountId)
        .in('external_destination_id', pageFbIds);

      // Fail loud: an error here must never be read as "no pages
      // exist". Proceeding with an empty map would misclassify
      // every pre-existing page as new, overwrite an active page's
      // schedule, and — on a schedule failure — delete that
      // pre-existing destination in rollback. Abort before any
      // upsert runs.
      if (existingErr) {
        logServerError('[pages/import] Failed to load existing destinations', existingErr, {
          source: 'pages-import-existing',
          subdomain,
        });
        return NextResponse.json(
          { error: "Couldn't add the selected pages. Please try again." },
          { status: 500 }
        );
      }

      if (Array.isArray(existingRows)) {
        for (const row of existingRows) {
          if (row?.external_destination_id) {
            const metadata =
              (row.metadata as Record<string, unknown> | null) ?? {};
            existingPagesMap.set(String(row.external_destination_id), {
              status: row.status,
              starting_followers:
                typeof metadata.starting_followers === 'number'
                  ? metadata.starting_followers
                  : null,
              metadata,
              // Raw values for the pre-upsert rollback snapshot
              // (see preUpsertSnapshot): a missing column stays
              // undefined so a load that did not carry it cannot
              // restore fabricated values.
              name: (row as { name?: string | null }).name,
              avatarUrl: (row as { avatar_url?: string | null }).avatar_url,
              encryptedToken: (row as { encrypted_destination_token?: string | null })
                .encrypted_destination_token,
            });
          }
        }
      }
    }
  }

  const importPromises = matchedPages.map(async (pageItem) => {
    // Audit N4: the token-less guard above already returned, so
    // a missing token here is unreachable — but it must never
    // silently fall back to the user token again, so fail loud.
    // (The R14/K9 per-page skip this replaced is superseded: the
    // upfront guard aborts before anything is written, so this
    // throw can only fire if that guard is ever bypassed.)
    const rawPageToken = pageItem.access_token;
    if (!rawPageToken) {
      throw new Error(
        `Refusing to import page ${String(pageItem.id)} without a page token`
      );
    }
    const encryptedPageToken = await encryptToken(rawPageToken, encryptionKey);

    const followers =
      typeof pageItem.followers_count === 'number'
        ? Math.max(0, pageItem.followers_count)
        : 0;
    const tasksJson = JSON.stringify(Array.isArray(pageItem.tasks) ? pageItem.tasks : []);
    const profilePictureUrl = pageItem.picture?.data?.url ?? null;

    if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
      // Unified identity is (account_id, external_destination_id);
      // the follower baseline + page facts live in metadata. The
      // baseline is preserved unless the existing destination is
      // disconnected — the same rule the pre-unification upsert ran.
      const result = (await dbClient.query(
        `INSERT INTO destinations (
          workspace_id, account_id, platform, external_destination_id, name, avatar_url, encrypted_destination_token, status, metadata, updated_at
        ) VALUES ($1, $2, 'facebook', $3, $4, $5, $6, 'active',
          jsonb_build_object(
            'category', $7::text,
            'tasks', $8::jsonb,
            'starting_followers', $9::int,
            'current_followers', $9::int
          ),
          now())
        ON CONFLICT (account_id, external_destination_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id,
          name = EXCLUDED.name,
          avatar_url = EXCLUDED.avatar_url,
          encrypted_destination_token = EXCLUDED.encrypted_destination_token,
          -- K9/BG8: a paused page (disconnected + fb_status='paused')
          -- stays paused on re-import: its status, its marker and
          -- its follower baseline are preserved, not reset as if
          -- it were a fresh reactivation. Every other row keeps
          -- the previous behaviour (active, marker stripped,
          -- baseline reset only for truly disconnected rows).
          -- The guard is SQL-level (not a $param) so it holds even
          -- if the pre-existing load disagreed with the row.
          status = CASE
            WHEN destinations.status = 'disconnected' AND destinations.metadata->>'fb_status' = 'paused'
              THEN 'disconnected'
            ELSE 'active'
          END,
          metadata = (destinations.metadata - 'fb_status')
            || jsonb_build_object(
              'category', $7::text,
              'tasks', $8::jsonb,
              'current_followers', $9::int,
              'starting_followers', CASE
                WHEN destinations.status = 'disconnected' AND destinations.metadata->>'fb_status' IS DISTINCT FROM 'paused'
                  THEN $9::int
                ELSE COALESCE((destinations.metadata->>'starting_followers')::int, $9::int)
              END
            )
            || CASE
              WHEN destinations.status = 'disconnected' AND destinations.metadata->>'fb_status' = 'paused'
                THEN jsonb_build_object('fb_status', 'paused')
              ELSE '{}'::jsonb
            END,
          updated_at = now()
        RETURNING id, external_destination_id AS fb_page_id, name AS page_name`,
        [
          workspaceId,
          accountId,
          String(pageItem.id),
          String(pageItem.name),
          profilePictureUrl,
          encryptedPageToken,
          pageItem.category ?? null,
          tasksJson,
          followers,
        ]
      )) as Record<string, unknown>[];

      if (result && result.length > 0 && result[0]) {
        const row = result[0];
        return {
          id: row.id,
          fbPageId: row.fb_page_id || row.fbPageId,
          pageName: row.page_name || row.pageName,
          isNew: !isPreExistingDestination(String(pageItem.id)),
          isReactivated: isReactivatedDestination(String(pageItem.id)),
        };
      }
      return null;
    } else {
      const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) return null;

      const existingPage = existingPagesMap.get(String(pageItem.id));
      // K9/BG8: a paused page (disconnected + fb_status='paused')
      // is not a reactivation — its baseline is preserved like an
      // active page's, not reset like a truly disconnected one's,
      // and it keeps its marker below.
      const paused = isPausedDestination(String(pageItem.id));
      const preserveBaseline =
        existingPage &&
        (existingPage.status !== 'disconnected' || paused) &&
        existingPage.starting_followers !== null &&
        existingPage.starting_followers !== undefined;
      const startingFollowersToSave = preserveBaseline
        ? existingPage.starting_followers
        : followers;

      const nextMetadata: Record<string, unknown> = {
        ...(existingPage?.metadata ?? {}),
        category: pageItem.category ?? null,
        tasks: Array.isArray(pageItem.tasks) ? pageItem.tasks : [],
        starting_followers: startingFollowersToSave,
        current_followers: followers,
      };
      // Only a non-paused re-import clears the marker; a paused
      // page keeps fb_status='paused' (spread from existing
      // metadata above) and stays 'disconnected' in the upsert.
      if (!paused) {
        delete nextMetadata.fb_status;
      }

      const { data: upserted, error: upsertErr } = await supabase
        .from('destinations')
        .upsert(
          {
            workspace_id: workspaceId,
            account_id: accountId,
            platform: 'facebook',
            external_destination_id: String(pageItem.id),
            name: String(pageItem.name),
            avatar_url: profilePictureUrl,
            encrypted_destination_token: encryptedPageToken,
            status: paused ? 'disconnected' : 'active',
            metadata: nextMetadata,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'account_id,external_destination_id' }
        )
        .select('id, external_destination_id, name')
        .single();

      if (upsertErr || !upserted) return null;
      return {
        id: upserted.id,
        fbPageId: upserted.external_destination_id,
        pageName: upserted.name,
        isNew: !isPreExistingDestination(String(pageItem.id)),
        isReactivated: isReactivatedDestination(String(pageItem.id)),
      };
    }
  });

  const resolved = await Promise.all(importPromises);
  const importedList = resolved.filter(
    (
      item
    ): item is {
      id: string;
      fbPageId: string;
      pageName: string;
      isNew: boolean;
      isReactivated: boolean;
    } => item !== null
  );

  // Snapshot of a reactivated destination's schedule before this
  // call replaces it, so a schedule failure can restore it exactly.
  // kind may arrive as an array or a JSON string depending on the
  // driver; it is normalised to an array when the snapshot is read.
  interface ReactivatedSnapshot {
    id: string;
    oldTimezone: string;
    oldSlots: Array<{
      slotTime: string;
      allowedFormats: string[];
      isActive: boolean;
    }>;
    // K9: the pre-upsert row the import overwrote (name, avatar,
    // token, metadata). A reactivated page's upsert rewrites all of
    // these, so a schedule rollback that only restored status /
    // timezone / slots would leave the page with the import's new
    // facts attached to its old schedule — a half-restored row.
    preUpsert: PreUpsertSnapshot | undefined;
    complete: boolean;
  }

  const normaliseFormats = (kind: unknown): string[] => {
    if (Array.isArray(kind)) return kind.map((f) => String(f));
    if (typeof kind === 'string') {
      try {
        const parsed: unknown = JSON.parse(kind);
        if (Array.isArray(parsed)) return parsed.map((f) => String(f));
      } catch (_e) {
        // A malformed stored kind must surface, never vanish: log it
        // and fall through to the empty list below.
        logServerError('[pages/import] Failed to parse slot kind JSON', _e, {
          source: 'pages-import-kind',
        });
      }
    }
    return [];
  };

  const snapshotReactivated = async (
    targets: Array<{ id: string; fbPageId?: string }>
  ): Promise<Map<string, ReactivatedSnapshot>> => {
    const snapshots = new Map<string, ReactivatedSnapshot>();
    if (targets.length === 0) return snapshots;
    for (const target of targets) {
      // The pre-upsert snapshot comes from the pre-loads above, not
      // from a post-upsert read (which would already see the new
      // name/token/metadata). A missing one means the schedule
      // cannot be safely restored for this page, so the caller
      // aborts the schedule rather than restoring fabricated rows.
      const pre =
        typeof target.fbPageId === 'string'
          ? preUpsertSnapshot(target.fbPageId)
          : undefined;
      if (!pre) {
        logServerError('[pages/import] Missing pre-upsert snapshot for reactivated page', new Error('Pre-upsert snapshot missing while snapshotting reactivated page'), {
          source: 'pages-import-snapshot',
          subdomain,
        });
      }
      try {
        if (
          dbClient &&
          'query' in dbClient &&
          typeof dbClient.query === 'function'
        ) {
          const tzRows = (await dbClient.query<{
            timezone?: string;
          }>(
            `SELECT timezone FROM destinations
             WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'`,
            [target.id, workspaceId]
          )) as Array<{ timezone?: string }>;
          const slotRows = (await dbClient.query<{
            time_of_day?: string;
            slotTime?: string;
            kind?: unknown;
            is_active?: boolean;
            isActive?: boolean;
          }>(
            `SELECT time_of_day, kind, is_active FROM posting_slots
             WHERE destination_id = $1
             ORDER BY time_of_day`,
            [target.id]
          )) as Array<{
            time_of_day?: string;
            slotTime?: string;
            kind?: unknown;
            is_active?: boolean;
            isActive?: boolean;
          }>;
          // A missing destination row must never be recorded as a
          // complete snapshot with a fabricated UTC/empty schedule:
          // the caller aborts the schedule and restores status only.
          // A missing pre-upsert snapshot gates the same way: the
          // rollback could not restore the upsert's name/token/
          // metadata changes, so the schedule must not be applied.
          if (!tzRows || tzRows.length === 0 || !tzRows[0]?.timezone) {
            logServerError('[pages/import] Failed to snapshot reactivated page', new Error('Destination row missing while snapshotting reactivated page'), {
              source: 'pages-import-snapshot',
              subdomain,
            });
            snapshots.set(target.id, {
              id: target.id,
              oldTimezone: 'UTC',
              oldSlots: [],
              preUpsert: pre,
              complete: false,
            });
          } else {
            snapshots.set(target.id, {
              id: target.id,
              oldTimezone: String(tzRows[0].timezone),
              oldSlots: (slotRows ?? []).map((row) => ({
                slotTime: String(row.time_of_day ?? row.slotTime ?? ''),
                allowedFormats: normaliseFormats(row.kind),
                isActive: row.is_active ?? row.isActive ?? true,
              })),
              preUpsert: pre,
              complete: pre !== undefined,
            });
          }
        } else {
          const supabase = (
            dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
          ) as SupabaseClient | null;
          if (!supabase) {
            snapshots.set(target.id, {
              id: target.id,
              oldTimezone: 'UTC',
              oldSlots: [],
              preUpsert: pre,
              complete: false,
            });
            continue;
          }
          const { data: tzData, error: tzError } = await supabase
            .from('destinations')
            .select('timezone')
            .eq('id', target.id)
            .eq('workspace_id', workspaceId)
            .eq('platform', 'facebook')
            .maybeSingle();
          const { data: slotData, error: slotError } = await supabase
            .from('posting_slots')
            .select('time_of_day, kind, is_active')
            .eq('destination_id', target.id);
          // Fail loud: a snapshot query error (or a missing row)
          // must never be recorded as a complete UTC/empty
          // snapshot — that would let a later schedule failure
          // delete the page's real slots and restore UTC. Mark it
          // incomplete so the caller aborts the schedule and
          // restores status only, without touching timezone/slots.
          if (
            tzError ||
            slotError ||
            !tzData ||
            !(tzData as { timezone?: string }).timezone
          ) {
            logServerError('[pages/import] Failed to snapshot reactivated page', tzError ?? slotError ?? new Error('Destination row missing while snapshotting reactivated page'), {
              source: 'pages-import-snapshot',
              subdomain,
            });
            snapshots.set(target.id, {
              id: target.id,
              oldTimezone: 'UTC',
              oldSlots: [],
              preUpsert: pre,
              complete: false,
            });
            continue;
          }
          const slotRows = (slotData as Array<{
            time_of_day?: string;
            kind?: unknown;
            is_active?: boolean;
          }> | null) ?? [];
          snapshots.set(target.id, {
            id: target.id,
            oldTimezone: String(
              (tzData as { timezone?: string }).timezone
            ),
            oldSlots: slotRows.map((row) => ({
              slotTime: String(row.time_of_day ?? ''),
              allowedFormats: normaliseFormats(row.kind),
              isActive: row.is_active ?? true,
            })),
            preUpsert: pre,
            complete: pre !== undefined,
          });
        }
      } catch (snapshotErr) {
        // No snapshot means no safe full restore for this page, but
        // its status still changed to active in the upsert, so it
        // must at least be returned to disconnected on rollback.
        // The failure is logged here; the schedule itself is
        // aborted by the caller (see below) rather than applied
        // without a restore path.
        logServerError('[pages/import] Failed to snapshot reactivated page', snapshotErr, {
          source: 'pages-import-snapshot',
          subdomain,
        });
        snapshots.set(target.id, {
          id: target.id,
          oldTimezone: 'UTC',
          oldSlots: [],
          preUpsert: pre,
          complete: false,
        });
      }
    }
    return snapshots;
  };

  // Best-effort rollback for this call's schedule targets.
  // Newly created destinations are deleted (slots first, then the
  // destination). Reactivated destinations are NEVER deleted: they
  // are restored to disconnected with their snapshotted timezone
  // and slots AND their pre-upsert name/avatar/token/metadata
  // (K9 — the upsert overwrote all of those, so restoring only
  // status/timezone/slots would leave a half-restored row), or,
  // when no snapshot exists, at least to disconnected, since their
  // timezone/slots were never touched.
  // Active pre-existing destinations are never passed here, so
  // they can never be touched by a rollback. Each target is
  // attempted independently and a rollback failure is logged,
  // never masked over the original schedule error.
  const rollbackScheduleTargets = async (
    created: Array<{ id: string }>,
    reactivatedSnapshots: Map<string, ReactivatedSnapshot>
  ): Promise<void> => {
    const logRollback = (err: unknown) =>
      logServerError('[pages/import] Failed to roll back schedule targets', err, {
        source: 'pages-import-rollback',
        subdomain,
      });
    if (created.length > 0) {
      const ids = created.map((page) => page.id);
      try {
        if (
          dbClient &&
          'query' in dbClient &&
          typeof dbClient.query === 'function'
        ) {
          await dbClient.query(
            `DELETE FROM posting_slots WHERE destination_id = ANY($1::uuid[])`,
            [ids]
          );
          await dbClient.query(
            `DELETE FROM destinations WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND platform = 'facebook'`,
            [ids, workspaceId]
          );
        } else {
          const supabase = (
            dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
          ) as SupabaseClient | null;
          if (supabase) {
            await supabase.from('posting_slots').delete().in('destination_id', ids);
            await supabase
              .from('destinations')
              .delete()
              .in('id', ids)
              .eq('workspace_id', workspaceId)
              .eq('platform', 'facebook');
          }
        }
      } catch (rollbackErr) {
        logRollback(rollbackErr);
      }
    }
    for (const snapshot of reactivatedSnapshots.values()) {
      try {
        if (
          dbClient &&
          'query' in dbClient &&
          typeof dbClient.query === 'function'
        ) {
          if (snapshot.complete) {
            await dbClient.query(
              `DELETE FROM posting_slots WHERE destination_id = $1`,
              [snapshot.id]
            );
            if (snapshot.oldSlots.length > 0) {
              const valuePlaceholders: string[] = [];
              const slotParams: unknown[] = [snapshot.id];
              snapshot.oldSlots.forEach((slot, index) => {
                const base = 2 + index * 3;
                valuePlaceholders.push(
                  `($1, $${base}, $${base + 1}, $${base + 2}, now(), now())`
                );
                slotParams.push(
                  slot.slotTime,
                  slot.isActive,
                  slot.allowedFormats
                );
              });
              await dbClient.query(
                `INSERT INTO posting_slots (destination_id, time_of_day, is_active, kind, created_at, updated_at)
                 VALUES ${valuePlaceholders.join(', ')}`,
                slotParams
              );
            }
            // K9: restore the pre-upsert row too, not just
            // status/timezone/slots — the upsert overwrote name,
            // avatar, token and metadata. Param order keeps
            // [status, timezone, id] first (pinned by tests);
            // the restored columns follow, never fabricated:
            // complete implies preUpsert is present.
            await dbClient.query(
              `UPDATE destinations SET status = $1, timezone = $2, updated_at = now(),
                 name = $5, avatar_url = $6, encrypted_destination_token = $7, metadata = $8::jsonb
               WHERE id = $3 AND workspace_id = $4 AND platform = 'facebook'`,
              [
                'disconnected',
                snapshot.oldTimezone,
                snapshot.id,
                workspaceId,
                snapshot.preUpsert?.name ?? null,
                snapshot.preUpsert?.avatarUrl ?? null,
                snapshot.preUpsert?.encryptedToken ?? null,
                JSON.stringify(snapshot.preUpsert?.metadata ?? {}),
              ]
            );
          } else {
            await dbClient.query(
              `UPDATE destinations SET status = $1, updated_at = now()
               WHERE id = $2 AND workspace_id = $3 AND platform = 'facebook'`,
              ['disconnected', snapshot.id, workspaceId]
            );
          }
        } else {
          const supabase = (
            dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
          ) as SupabaseClient | null;
          if (!supabase) continue;
          if (snapshot.complete) {
            await supabase
              .from('posting_slots')
              .delete()
              .eq('destination_id', snapshot.id);
            if (snapshot.oldSlots.length > 0) {
              await supabase.from('posting_slots').upsert(
                snapshot.oldSlots.map((slot) => ({
                  destination_id: snapshot.id,
                  time_of_day: slot.slotTime,
                  is_active: slot.isActive,
                  kind: slot.allowedFormats,
                })),
                { onConflict: 'destination_id,time_of_day' }
              );
            }
            await supabase
              .from('destinations')
              .update({
                status: 'disconnected',
                timezone: snapshot.oldTimezone,
                // K9: same pre-upsert restore as the SQL path.
                name: snapshot.preUpsert?.name ?? null,
                avatar_url: snapshot.preUpsert?.avatarUrl ?? null,
                encrypted_destination_token:
                  snapshot.preUpsert?.encryptedToken ?? null,
                metadata: snapshot.preUpsert?.metadata ?? {},
                updated_at: new Date().toISOString(),
              })
              .eq('id', snapshot.id)
              .eq('workspace_id', workspaceId)
              .eq('platform', 'facebook');
          } else {
            await supabase
              .from('destinations')
              .update({
                status: 'disconnected',
                updated_at: new Date().toISOString(),
              })
              .eq('id', snapshot.id)
              .eq('workspace_id', workspaceId)
              .eq('platform', 'facebook');
          }
        }
      } catch (rollbackErr) {
        logRollback(rollbackErr);
      }
    }
  };

  // Add Page steps 3–4: when a schedule was supplied, it is applied
  // ONLY to destinations newly created in this call or previously
  // disconnected and reactivated by it, and success is returned
  // only when all of it applied. Any other pre-existing
  // destination keeps its own timezone and slots untouched — in
  // particular a paused page's slots/schedule are untouched by a
  // re-import, and its row stays paused (status + marker + baseline
  // preserved by the upsert, K9), not flipped to active.
  // A reactivated destination's old slots are deleted first, so
  // its final slots are exactly the times picked in Step 4, not
  // old + new merged. On any schedule failure the destinations
  // created in this call are deleted again and reactivated ones
  // are restored to disconnected with their snapshotted timezone
  // and slots, so "nothing finish" is true on the server too, not
  // just in the dialog. Slot writes are idempotent upserts keyed
  // on destination + time, so a retry can never duplicate a
  // posting time. The schedule is skipped entirely when absent, so
  // the legacy import path is unchanged.
  const SCHEDULE_FAILED_MESSAGE =
    "Couldn't save the posting times — try again, your timezone and times are kept";
  if (timezone && postingTimes) {
    const scheduleTargets = importedList.filter(
      (page) => page.isNew || page.isReactivated
    );
    const createdTargets = importedList.filter((page) => page.isNew);
    const reactivatedTargets = importedList.filter(
      (page) => page.isReactivated
    );
    // Snapshots are taken before any schedule write, so a failure
    // anywhere in the batch can restore every reactivated page.
    // If a snapshot could not be taken, the schedule is not
    // applied at all: that page's status is still restored to
    // disconnected by the rollback below.
    const reactivatedSnapshots =
      await snapshotReactivated(reactivatedTargets);
    const snapshotIncomplete = [...reactivatedSnapshots.values()].some(
      (snapshot) => !snapshot.complete
    );
    // An upsert that failed after the pre-check must not turn into a
    // partial success either: roll back what this call changed and
    // report the generic import failure.
    if (importedList.length !== dedupedSelectedPageIds.length) {
      await rollbackScheduleTargets(createdTargets, reactivatedSnapshots);
      return NextResponse.json(
        { error: "Couldn't add the selected pages. Please try again." },
        { status: 500 }
      );
    }
    if (snapshotIncomplete) {
      await rollbackScheduleTargets(createdTargets, reactivatedSnapshots);
      return NextResponse.json(
        { error: SCHEDULE_FAILED_MESSAGE, code: 'SCHEDULE_FAILED' },
        { status: 500 }
      );
    }
    try {
      if (
        dbClient &&
        'query' in dbClient &&
        typeof dbClient.query === 'function'
      ) {
        for (const page of scheduleTargets) {
          const updated = await dbClient.query(
            `UPDATE destinations
             SET timezone = $1, updated_at = now()
             WHERE id = $2 AND workspace_id = $3 AND platform = 'facebook'
             RETURNING id`,
            [timezone, page.id, workspaceId]
          );
          if (!updated || updated.length === 0) {
            throw new Error('Destination not found while applying schedule');
          }
          // Reactivated pages replace their old schedule outright;
          // newly created pages have no slots yet, so this delete
          // is a no-op for them.
          if (page.isReactivated) {
            await dbClient.query(
              `DELETE FROM posting_slots WHERE destination_id = $1`,
              [page.id]
            );
          }
          // One multi-row insert per page, not one query per time.
          const valuePlaceholders: string[] = [];
          const slotParams: unknown[] = [page.id];
          postingTimes.forEach((postingTime, index) => {
            const base = 2 + index * 2;
            valuePlaceholders.push(
              `($1, $${base}, true, $${base + 1}, now(), now())`
            );
            slotParams.push(
              postingTime.slotTime,
              postingTime.allowedFormats
            );
          });
          await dbClient.query(
            `INSERT INTO posting_slots (destination_id, time_of_day, is_active, kind, created_at, updated_at)
             VALUES ${valuePlaceholders.join(', ')}
             ON CONFLICT (destination_id, time_of_day) DO UPDATE SET
               kind = EXCLUDED.kind,
               is_active = true,
               updated_at = now()`,
            slotParams
          );
        }
      } else {
        const supabase = (
          dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
        ) as SupabaseClient | null;
        if (!supabase) {
          throw new Error('Database service unavailable');
        }
        for (const page of scheduleTargets) {
          const { data: updatedPage, error: updateErr } = await supabase
            .from('destinations')
            .update({
              timezone,
              updated_at: new Date().toISOString(),
            })
            .eq('id', page.id)
            .eq('workspace_id', workspaceId)
            .eq('platform', 'facebook')
            .select('id')
            .maybeSingle();
          if (updateErr || !updatedPage) {
            throw new Error(
              updateErr?.message ??
                'Destination not found while applying schedule'
            );
          }
          if (page.isReactivated) {
            const { error: deleteErr } = await supabase
              .from('posting_slots')
              .delete()
              .eq('destination_id', page.id);
            if (deleteErr) {
              throw deleteErr;
            }
          }
          const { error: slotErr } = await supabase
            .from('posting_slots')
            .upsert(
              postingTimes.map((postingTime) => ({
                destination_id: page.id,
                time_of_day: postingTime.slotTime,
                is_active: true,
                kind: postingTime.allowedFormats,
              })),
              { onConflict: 'destination_id,time_of_day' }
            );
          if (slotErr) {
            throw slotErr;
          }
        }
      }
    } catch (err) {
      logServerError('[pages/import] Failed to apply schedule', err, {
        source: 'pages-import-schedule',
        subdomain,
      });
      await rollbackScheduleTargets(createdTargets, reactivatedSnapshots);
      return NextResponse.json(
        { error: SCHEDULE_FAILED_MESSAGE, code: 'SCHEDULE_FAILED' },
        { status: 500 }
      );
    }
  }

  // Audit BG8, second half: a page Graph returned but whose
  // upsert failed (resolved null above) used to vanish from the
  // result with success still true. This runs AFTER the schedule
  // block on purpose: the successfully imported pages keep their
  // requested schedule (a retry would not re-apply it to them,
  // since they are no longer new/reactivated), and the failure is
  // still loud, naming every page that did not save. Rolling back
  // the successful imports is deliberately NOT done: they are
  // valid imports, and rolling back updates to pre-existing rows
  // would destroy their refreshed tokens.
  const importedIds = new Set(importedList.map((page) => page.fbPageId));
  const failedUpserts = matchedPages.filter(
    (page) => !importedIds.has(String(page.id))
  );
  if (failedUpserts.length > 0) {
    const failedNames = failedUpserts.map(
      (page) => String(page.name ?? page.id)
    );
    logServerError(
      '[pages/import] Matched pages failed to save',
      new Error(`Failed to save ${failedUpserts.length} matched pages`),
      { source: 'pages-import-partial', subdomain, failedNames }
    );
    return NextResponse.json(
      {
        error: `These pages could not be saved and were not added: ${failedNames.join(', ')}. The other selected pages were added.`,
        code: 'PARTIAL_IMPORT',
        skipped: failedUpserts.map((page) => ({
          fbPageId: String(page.id),
          pageName: String(page.name ?? page.id),
        })),
      },
      { status: 422 }
    );
  }

  const responsePayload = ImportPagesResponseSchema.parse({
    success: true,
    importedCount: importedList.length,
    pages: importedList,
  });

  // Analytics: only the pages that actually imported count.
  // Fire-and-forget — never blocks the response.
  void trackServerEvent('page_added', session.userId, {
    platform: 'facebook',
    count: importedList.length,
  });

  return NextResponse.json(responsePayload);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  // Audit S6: previously unthrottled Graph-backed call; 20/min like initiate.
  const limited = await enforceIpRateLimit(request, 'tenant_pages_import', 20);
  if (limited) return limited;
  return handleImportPages(request, subdomain);
}
