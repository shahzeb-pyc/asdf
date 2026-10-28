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

  const selectedSet = new Set(selectedPageIds);
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
      };
    }
  });

  const resolved = await Promise.all(importPromises);
  const importedList = resolved.filter(
    (item): item is { id: string; fbPageId: string; pageName: string } => item !== null
  );

  // Add Page steps 3–4: when a schedule was supplied, it is applied
  // to every imported destination in this same operation, and
  // success is returned only when all of it applied. Any failure
  // returns 500 with no success payload, so the client dialog stays
  // open on Step 4 ("nothing finish"). This is not a rollback: a
  // destination upsert or slot row that already landed is
  // idempotent on retry (destination upsert by
  // account_id + external_destination_id; slot upsert by
  // destination_id + time_of_day, which also refreshes the formats
  // to the retried schedule), so a retry can never duplicate a
  // posting time. The schedule is skipped entirely when absent, so
  // the legacy import path is unchanged.
  if (timezone && postingTimes) {
    if (importedList.length !== selectedPageIds.length) {
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
        for (const page of importedList) {
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
          for (const postingTime of postingTimes) {
            await dbClient.query(
              `INSERT INTO posting_slots (destination_id, time_of_day, is_active, kind, created_at, updated_at)
               VALUES ($1, $2, true, $3, now(), now())
               ON CONFLICT (destination_id, time_of_day) DO UPDATE SET
                 kind = EXCLUDED.kind,
                 is_active = true,
                 updated_at = now()`,
              [page.id, postingTime.slotTime, postingTime.allowedFormats]
            );
          }
        }
      } else {
        const supabase = (
          dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()
        ) as SupabaseClient | null;
        if (!supabase) {
          throw new Error('Database service unavailable');
        }
        for (const page of importedList) {
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
      return NextResponse.json(
        { error: "Couldn't add the selected pages. Please try again." },
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
