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
import { logServerError } from '@/lib/server-analytics';
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

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Parse request body
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch (_e) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

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
  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
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
  let rawItems: Awaited<ReturnType<typeof fetchAllFacebookPages>> = [];
  try {
    rawItems = await fetchAllFacebookPages(
      rawToken,
      'id,name,category,tasks,access_token,followers_count,picture{url}'
    );
  } catch (err) {
    logServerError('[pages/import] Facebook Graph query failed', err, {
      source: 'pages-import',
      subdomain,
    });
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

  // Query existing destinations before upserting via Supabase to
  // preserve starting_followers for active pages (the follower
  // baseline lives in destinations.metadata since the unified schema).
  const isSupabaseMode =
    !dbClient || !('query' in dbClient) || typeof dbClient.query !== 'function';
  const existingPagesMap = new Map<
    string,
    {
      status: string;
      starting_followers: number | null;
      metadata: Record<string, unknown>;
    }
  >();
  // Postgres pre-existing set, for the same "schedule only newly
  // created pages" rule the Supabase path gets from existingPagesMap.
  const preExistingFbPageIds = new Set<string>();

  if (
    dbClient &&
    'query' in dbClient &&
    typeof dbClient.query === 'function' &&
    matchedPages.length > 0
  ) {
    const preExistingRows = (await dbClient.query<{
      external_destination_id?: string;
      externalDestinationId?: string;
    }>(
      `SELECT external_destination_id FROM destinations
       WHERE account_id = $1 AND external_destination_id = ANY($2::text[])`,
      [accountId, matchedPages.map((item) => String(item.id))]
    )) as Array<{
      external_destination_id?: string;
      externalDestinationId?: string;
    }>;
    for (const row of preExistingRows ?? []) {
      const fbPageId = row.external_destination_id ?? row.externalDestinationId;
      if (fbPageId) preExistingFbPageIds.add(String(fbPageId));
    }
  }

  // Evaluated at upsert time, after existingPagesMap is populated
  // below for the Supabase path.
  const isPreExistingDestination = (fbPageId: string): boolean =>
    isSupabaseMode
      ? existingPagesMap.has(fbPageId)
      : preExistingFbPageIds.has(fbPageId);

  // When a schedule is supplied, a Graph result that returns fewer
  // pages than selected is an error BEFORE any destination is
  // written — otherwise a failed schedule would leave pages behind
  // with no schedule and no success to show for them. The legacy
  // import (no schedule) keeps its old behaviour of importing
  // whatever matched.
  if (
    timezone &&
    postingTimes &&
    matchedPages.length !== dedupedSelectedPageIds.length
  ) {
    return NextResponse.json(
      { error: "Couldn't add the selected pages. Please try again." },
      { status: 500 }
    );
  }

  if (isSupabaseMode && matchedPages.length > 0) {
    const supabase = (
      dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
    ) as SupabaseClient | null;
    if (supabase) {
      const pageFbIds = matchedPages.map((item) => String(item.id));
      const { data: existingRows } = await supabase
        .from('destinations')
        .select('external_destination_id, status, metadata')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        .in('external_destination_id', pageFbIds);

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
            });
          }
        }
      }
    }
  }

  const importPromises = matchedPages.map(async (pageItem) => {
    const rawPageToken = pageItem.access_token || rawToken;
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
          status = 'active',
          metadata = (destinations.metadata - 'fb_status')
            || jsonb_build_object(
              'category', $7::text,
              'tasks', $8::jsonb,
              'current_followers', $9::int,
              'starting_followers', CASE
                WHEN destinations.status = 'disconnected'
                  THEN $9::int
                ELSE COALESCE((destinations.metadata->>'starting_followers')::int, $9::int)
              END
            ),
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
        };
      }
      return null;
    } else {
      const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
      if (!supabase) return null;

      const existingPage = existingPagesMap.get(String(pageItem.id));
      const preserveBaseline =
        existingPage &&
        existingPage.status !== 'disconnected' &&
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
      delete nextMetadata.fb_status;

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
            status: 'active',
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
    } => item !== null
  );

  // Best-effort rollback for destinations created in this call only.
  // Pre-existing destinations are never passed here, so they can
  // never be deleted by a failed schedule. A rollback failure is
  // logged, never masked over the original schedule error.
  const rollbackCreatedDestinations = async (
    targets: Array<{ id: string }>
  ): Promise<void> => {
    if (targets.length === 0) return;
    const ids = targets.map((page) => page.id);
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
        if (!supabase) return;
        await supabase.from('posting_slots').delete().in('destination_id', ids);
        await supabase
          .from('destinations')
          .delete()
          .in('id', ids)
          .eq('workspace_id', workspaceId)
          .eq('platform', 'facebook');
      }
    } catch (rollbackErr) {
      logServerError('[pages/import] Failed to roll back created pages', rollbackErr, {
        source: 'pages-import-rollback',
        subdomain,
      });
    }
  };

  // Add Page steps 3–4: when a schedule was supplied, it is applied
  // ONLY to destinations newly created in this call, and success is
  // returned only when all of it applied. A pre-existing destination
  // keeps its own timezone and slots untouched — in particular a
  // paused slot is never reactivated by a re-import. On any
  // schedule failure the destinations created in this call are
  // deleted again (slots first, then destinations; posting_slots
  // also cascades from destinations), so "nothing finish" is true
  // on the server too, not just in the dialog: failure-then-cancel
  // leaves zero new pages, and a retry re-creates them cleanly.
  // Slot writes are idempotent upserts keyed on destination + time,
  // so a retry can never duplicate a posting time. The schedule is
  // skipped entirely when absent, so the legacy import path is
  // unchanged.
  const SCHEDULE_FAILED_MESSAGE =
    "Couldn't save the posting times — try again, your timezone and times are kept";
  if (timezone && postingTimes) {
    const scheduleTargets = importedList.filter((page) => page.isNew);
    // An upsert that failed after the pre-check must not turn into a
    // partial success either: roll back what this call created and
    // report the generic import failure.
    if (importedList.length !== dedupedSelectedPageIds.length) {
      await rollbackCreatedDestinations(scheduleTargets);
      return NextResponse.json(
        { error: "Couldn't add the selected pages. Please try again." },
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
      await rollbackCreatedDestinations(scheduleTargets);
      return NextResponse.json(
        { error: SCHEDULE_FAILED_MESSAGE, code: 'SCHEDULE_FAILED' },
        { status: 500 }
      );
    }
  }

  const responsePayload = ImportPagesResponseSchema.parse({
    success: true,
    importedCount: importedList.length,
    pages: importedList,
  });

  return NextResponse.json(responsePayload);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleImportPages(request, subdomain);
}
