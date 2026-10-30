import { type NextRequest, NextResponse } from 'next/server';
import {
  DisconnectPageResponseSchema,
  evaluatePageHealth,
  FacebookPageViewSchema,
  getSessionSecret,
  verifySessionToken,
  type DatabaseClient,
  type FacebookPageStatus,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  DESTINATION_STATUS_TO_WIRE_SQL,
  PAUSED_MARKER_KEY,
  PAUSED_MARKER_VALUE,
  unifiedDestinationStatusToWire,
  wirePageStatusToUnified,
} from '@/lib/server/facebook-wire';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const UpdatePageRequestSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  timezone: z.string().min(1).max(50).optional(),
});

/**
 * One destinations row as formatPageRow consumes it (spec 137 §3.7),
 * already translated to the wire page vocabulary: snake_case
 * (SQL/Supabase) and camelCase spellings, plus the joined account
 * display name. `tasks` stays unknown — the formatter narrows it
 * (array | JSON string) itself.
 */
interface PageDetailRow {
  id: string;
  facebook_account_id?: string | null;
  facebookAccountId?: string | null;
  account_display_name?: string | null;
  account_avatar_url?: string | null;
  fb_page_id?: string | null;
  fbPageId?: string | null;
  page_name?: string | null;
  pageName?: string | null;
  profile_picture_url?: string | null;
  category?: string | null;
  timezone?: string | null;
  starting_followers?: number | string | null;
  current_followers?: number | string | null;
  status: FacebookPageStatus;
  tasks?: unknown;
  unmatched_post_types?: unknown;
  created_at: string;
  updated_at: string;
  rate_limited_at?: string | null;
}

function formatPageRow(row: PageDetailRow) {
  let parsedTasks: string[] = [];
  if (Array.isArray(row.tasks)) {
    parsedTasks = row.tasks;
  } else if (typeof row.tasks === 'string') {
    try {
      parsedTasks = JSON.parse(row.tasks);
    } catch (_e) {
      parsedTasks = [];
    }
  }
  const unmatchedPostTypes = Array.isArray(row.unmatched_post_types)
    ? (row.unmatched_post_types as unknown[]).filter(
        (t): t is string => typeof t === 'string'
      )
    : [];

  const startingFollowers = Number(row.starting_followers ?? 0);
  const currentFollowers = Number(row.current_followers ?? 0);
  const followersGained = currentFollowers - startingFollowers;

  return FacebookPageViewSchema.parse({
    id: row.id,
    facebookAccountId: row.facebook_account_id || row.facebookAccountId,
    accountDisplayName: row.account_display_name ?? null,
    accountPictureUrl: row.account_avatar_url ?? null,
    fbPageId: row.fb_page_id || row.fbPageId,
    pageName: row.page_name || row.pageName,
    profilePictureUrl: row.profile_picture_url ?? null,
    category: row.category ?? null,
    timezone: row.timezone ?? 'UTC',
    startingFollowers,
    currentFollowers,
    followersGained,
    status: row.status,
    tasks: parsedTasks,
    unmatchedPostTypes,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  });
}

/**
 * Status family 5A: the dedicated detail path must agree with the
 * Pages list (mapPageRows applies evaluatePageHealth there). A
 * rate-limited page past the 3-day cooldown reads as Active here
 * too, so the detail header/banner and the list can never disagree
 * about the same page. Other statuses pass through unchanged
 * (evaluatePageHealth returns paused/checkpoint/expired as-is).
 */
function applyRateLimitCooldown<
  T extends { status: FacebookPageStatus; updatedAt: string | Date },
>(page: T, rateLimitedAt: string | null | undefined): T {
  if (page.status !== 'fb_rate_limited') return page;
  return {
    ...page,
    status: evaluatePageHealth({
      status: page.status,
      updatedAt: page.updatedAt,
      rateLimitedAt: rateLimitedAt ?? null,
    }),
  };
}

/**
 * Status family 1A/4A server gate for the status PATCH. Menu hiding
 * alone is never trusted: the API must reject a status change the
 * UI would never offer. Allowed transitions, by CURRENT wire status
 * (after the 5A cooldown flip, so a page past cooldown is 'active'):
 * - active / paused: active or paused (Pause / Resume)
 * - page_checkpoint: active ONLY — this is the Mark Verified &
 *   Reactivate banner path, which PATCHes 'active' and clears the
 *   checkpoint marker. Pausing a checkpoint page is blocked: it
 *   would overwrite the checkpoint marker with the paused marker.
 * - invalid_token, fb_rate_limited (pre-cooldown), disconnected,
 *   unknown: nothing. Expired pages recover by reconnecting, not by
 *   a status PATCH; rate-limited pages wait for the cooldown; a
 *   disconnected page is re-added, not resumed.
 * Timezone-only updates bypass this gate (no status in the body).
 */
function statusTransitionAllowed(
  current: FacebookPageStatus,
  requested: 'active' | 'paused'
): boolean {
  if (current === 'active' || current === 'paused') return true;
  if (current === 'page_checkpoint') return requested === 'active';
  return false;
}

const STATUS_TOGGLE_BLOCKED_MESSAGES: Partial<
  Record<FacebookPageStatus, string>
> = {
  invalid_token:
    "Cannot change automation while this Page's connection has expired. Reconnect the parent Facebook account first.",
  page_checkpoint:
    'Cannot pause a Page waiting on a Facebook identity check. Use Mark Verified & Reactivate Page first.',
  fb_rate_limited:
    'Cannot resume a rate-limited Page yet. It auto-resumes after 3 days.',
  disconnected:
    'Cannot change automation on a disconnected Page. Add it again first.',
};

async function authenticateTenantRequest(
  request: NextRequest,
  subdomain: string
): Promise<{ errorResponse?: NextResponse; session?: SessionPayload }> {
  const secretKey = getSessionSecret();

  const token = request.cookies.get('fbup_session')?.value;
  if (!token) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  try {
    const verified = await verifySessionToken(token, secretKey);
    if (verified.subdomain !== subdomain && verified.role !== 'admin') {
      return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { session: verified };
  } catch (_e) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
}

async function fetchActivePageById(
  client: DatabaseClient | SupabaseClient | null | undefined,
  pageId: string,
  workspaceId: string
) {
  if (client && 'query' in client && typeof client.query === 'function') {
    const rows = await client.query<PageDetailRow>(
      `SELECT
        d.id,
        d.account_id AS facebook_account_id,
        a.display_name AS account_display_name,
        a.avatar_url AS account_avatar_url,
        d.external_destination_id AS fb_page_id,
        d.name AS page_name,
        d.avatar_url AS profile_picture_url,
        d.metadata->>'category' AS category,
        d.timezone,
        (d.metadata->>'starting_followers')::int AS starting_followers,
        (d.metadata->>'current_followers')::int AS current_followers,
        ${DESTINATION_STATUS_TO_WIRE_SQL} AS status,
        d.metadata->'tasks' AS tasks,
        d.metadata->'unmatched_post_types' AS unmatched_post_types,
        d.metadata->>'rate_limited_at' AS rate_limited_at,
        d.created_at,
        d.updated_at
      FROM destinations d
      LEFT JOIN social_accounts a ON a.id = d.account_id
      WHERE d.id = $1 AND d.workspace_id = $2 AND d.platform = 'facebook'
        AND (d.status != 'disconnected' OR d.metadata->>'fb_status' = 'paused')`,
      [pageId, workspaceId]
    );

    if (!rows || rows.length === 0 || !rows[0]) {
      return null;
    }
    return applyRateLimitCooldown(formatPageRow(rows[0]), rows[0].rate_limited_at);
  }

  const supabase = (client && 'from' in client ? client : getSupabaseAdminClient()) as SupabaseClient | null;
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('destinations')
    .select(
      'id, account_id, external_destination_id, name, avatar_url, timezone, metadata, status, created_at, updated_at, social_accounts(display_name, avatar_url)'
    )
    .eq('id', pageId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .maybeSingle();

  if (error || !data) return null;

  const row = data as unknown as {
    id: string;
    account_id: string;
    external_destination_id: string;
    name: string;
    avatar_url: string | null;
    timezone: string;
    metadata: Record<string, unknown> | null;
    status: string;
    created_at: string;
    updated_at: string;
    social_accounts: { display_name: string; avatar_url: string | null } | null;
  };

  // Disconnected destinations are not fetchable here; a paused page
  // (disconnected + the fb_status marker) is.
  if (
    row.status === 'disconnected' &&
    row.metadata?.[PAUSED_MARKER_KEY] !== PAUSED_MARKER_VALUE
  ) {
    return null;
  }

  return applyRateLimitCooldown(
    formatPageRow({
      id: row.id,
      facebook_account_id: row.account_id,
      account_display_name: row.social_accounts?.display_name ?? null,
      account_avatar_url: row.social_accounts?.avatar_url ?? null,
      fb_page_id: row.external_destination_id,
      page_name: row.name,
      profile_picture_url: row.avatar_url,
      category: typeof row.metadata?.category === 'string' ? row.metadata.category : null,
      timezone: row.timezone,
      starting_followers:
        typeof row.metadata?.starting_followers === 'number'
          ? row.metadata.starting_followers
          : null,
      current_followers:
        typeof row.metadata?.current_followers === 'number'
          ? row.metadata.current_followers
          : null,
      status: unifiedDestinationStatusToWire(row.status, row.metadata),
      tasks: row.metadata?.tasks ?? [],
      unmatched_post_types: Array.isArray(row.metadata?.unmatched_post_types)
        ? row.metadata.unmatched_post_types
        : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    typeof row.metadata?.rate_limited_at === 'string'
      ? row.metadata.rate_limited_at
      : null
  );
}

interface QueueStatusCounts {
  queued: number;
  publishing: number;
  published: number;
  failed: number;
}

const DEFAULT_QUEUE_STATUS_COUNTS: QueueStatusCounts = {
  queued: 0,
  publishing: 0,
  published: 0,
  failed: 0,
};

async function fetchQueueCountsSql(
  client: DatabaseClient,
  pageId: string
): Promise<QueueStatusCounts | null> {
  try {
    const rows = (await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued') AS queued,
         COUNT(*) FILTER (WHERE status = 'publishing') AS publishing,
         COUNT(*) FILTER (WHERE status = 'published') AS published,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM queue_items
       WHERE destination_id = $1`,
      [pageId]
    )) as Record<string, unknown>[];
    if (rows && rows[0]) {
      return {
        queued: Number(rows[0].queued ?? 0),
        publishing: Number(rows[0].publishing ?? 0),
        published: Number(rows[0].published ?? 0),
        failed: Number(rows[0].failed ?? 0),
      };
    }
  } catch (err) {
    // Caller serves the default counts — logged (spec 139 B19):
    // queue counters must not silently zero.
    logServerError('[pages] Queue-count query failed', err, {
      source: 'page-queue-counts',
      pageId,
    });
  }
  return null;
}

const QUEUE_COUNT_STATUSES = ['queued', 'publishing', 'published', 'failed'] as const;

/**
 * Bounded counts on the unified queue (spec 139 A14): one head/count
 * query per status — a constant number of queries that transfers zero
 * rows, instead of selecting every queue row for the page and counting
 * in JS (which grew with queue history and silently truncated at the
 * PostgREST row cap). This replaced the grouped counts RPC when that
 * function was dropped with the legacy schema (Phase 7). A
 * count-query error returns null, so the caller serves the default
 * zero counts exactly as before on failure — there is no silent JS
 * fallback.
 */
async function fetchQueueCountsBounded(
  supabase: SupabaseClient,
  pageId: string
): Promise<QueueStatusCounts | null> {
  try {
    const counts: QueueStatusCounts = { ...DEFAULT_QUEUE_STATUS_COUNTS };
    const perStatus = await Promise.all(
      QUEUE_COUNT_STATUSES.map(async (status) => {
        const { count, error } = await supabase
          .from('queue_items')
          .select('id', { head: true, count: 'exact' })
          .eq('destination_id', pageId)
          .eq('status', status);
        if (error) throw error;
        return [status, count ?? 0] as const;
      })
    );
    for (const [status, count] of perStatus) {
      counts[status] = count;
    }
    return counts;
  } catch (err) {
    // Caller serves the default zero counts — logged (spec 139 B19).
    logServerError('[pages] Bounded queue-count query failed', err, {
      source: 'page-queue-counts',
      pageId,
    });
  }
  return null;
}

async function fetchPageQueueCounts(
  client: DatabaseClient | SupabaseClient | null | undefined,
  pageId: string
): Promise<QueueStatusCounts> {
  if (!client) return { ...DEFAULT_QUEUE_STATUS_COUNTS };

  if ('query' in client && typeof client.query === 'function') {
    const counts = await fetchQueueCountsSql(client, pageId);
    return counts ?? { ...DEFAULT_QUEUE_STATUS_COUNTS };
  }

  const supabase = ('from' in client ? client : getSupabaseAdminClient()) as SupabaseClient | null;
  if (!supabase) return { ...DEFAULT_QUEUE_STATUS_COUNTS };

  const counts = await fetchQueueCountsBounded(supabase, pageId);
  return counts ?? { ...DEFAULT_QUEUE_STATUS_COUNTS };
}

export async function handleGetPage(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const [page, queueCounts] = await Promise.all([
    fetchActivePageById(dbClient, pageId, workspaceId),
    fetchPageQueueCounts(dbClient, pageId),
  ]);
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  return NextResponse.json({ page, queueCounts });
}

export async function handleUpdatePage(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const parsed = UpdatePageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }

  // Wire status -> unified write (facebook-wire): 'active' clears the
  // paused marker + rate-limit state; 'paused' stores status
  // 'disconnected' with the marker set.
  const statusWrite = parsed.data.status
    ? wirePageStatusToUnified(parsed.data.status)
    : null;

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    // Status-family gate (SQL path): read the CURRENT row before
    // writing. A missing row skips the gate and falls through to
    // the existing 404 path below; a present row that may not
    // change status is rejected with 409, never silently no-op'd.
    // The same read covers timezone-only PATCHes: a plain
    // disconnected page would otherwise match zero rows in the
    // UPDATE's visibility WHERE clause and surface as a confusing
    // 404 for a page that exists, so it is rejected with 409 here.
    if (parsed.data.status || parsed.data.timezone) {
      const currentRows = (await dbClient.query(
        `SELECT status, metadata, updated_at
         FROM destinations
         WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'`,
        [pageId, workspaceId]
      )) as Array<{
        status: string;
        metadata: Record<string, unknown> | string | null;
        updated_at: string;
      }>;
      const currentRow = currentRows?.[0];
      if (currentRow) {
        // Invalid stored metadata JSON is treated as no metadata for
        // the status gate (assignment in the catch, not a bare return,
        // per the silent-failure guardrail).
        const currentMetadata: Record<string, unknown> | null =
          typeof currentRow.metadata === 'string'
            ? (() => {
                let parsed: Record<string, unknown> | null = null;
                try {
                  parsed = JSON.parse(
                    currentRow.metadata
                  ) as Record<string, unknown>;
                } catch {
                  parsed = null;
                }
                return parsed;
              })()
            : currentRow.metadata;
        if (parsed.data.status) {
          const currentWire = unifiedDestinationStatusToWire(
            currentRow.status,
            currentMetadata
          );
          const effectiveCurrent =
            currentWire === 'fb_rate_limited'
              ? evaluatePageHealth({
                  status: currentWire,
                  updatedAt: currentRow.updated_at,
                  rateLimitedAt:
                    typeof currentMetadata?.rate_limited_at === 'string'
                      ? currentMetadata.rate_limited_at
                      : null,
                })
              : currentWire;
          if (!statusTransitionAllowed(effectiveCurrent, parsed.data.status)) {
            return NextResponse.json(
              {
                error: 'PAGE_STATUS_NOT_ALLOWED',
                message:
                  STATUS_TOGGLE_BLOCKED_MESSAGES[effectiveCurrent] ??
                  'This Page cannot change automation right now.',
              },
              { status: 409 }
            );
          }
        } else {
          const visible =
            currentRow.status !== 'disconnected' ||
            currentMetadata?.[PAUSED_MARKER_KEY] === PAUSED_MARKER_VALUE;
          if (!visible) {
            return NextResponse.json(
              {
                error: 'PAGE_NOT_EDITABLE',
                message:
                  'Cannot change settings on a disconnected Page. Add it again first.',
              },
              { status: 409 }
            );
          }
        }
      }
    }
    if (parsed.data.status || parsed.data.timezone) {
      await dbClient.query(
        `UPDATE destinations d
         SET status = COALESCE($1, d.status),
             metadata = CASE
               WHEN $4::boolean IS NULL THEN d.metadata
               WHEN $4::boolean THEN jsonb_set(d.metadata, '{fb_status}', '"paused"')
               ELSE (d.metadata - 'fb_status' - 'rate_limited_at')
             END,
             timezone = COALESCE($2, d.timezone),
             next_allowed_publish_at = CASE WHEN $1 = 'active' THEN NULL ELSE d.next_allowed_publish_at END,
             updated_at = now()
         WHERE d.id = $3 AND d.workspace_id = $5 AND d.platform = 'facebook'
           AND (d.status != 'disconnected' OR d.metadata->>'fb_status' = 'paused')`,
        [
          statusWrite?.status ?? null,
          parsed.data.timezone ?? null,
          pageId,
          statusWrite ? statusWrite.pausedMarker === true : null,
          workspaceId,
        ]
      );
    }
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }
    if (parsed.data.status || parsed.data.timezone) {
      // The paused marker lives in metadata, so the update is a
      // read-modify-write of that one row. A read failure must fail
      // loud (B1): falling through with `current` null would skip
      // the update and then return the unchanged page as success.
      const { data: current, error: currentError } = await supabase
        .from('destinations')
        .select('status, metadata, updated_at')
        .eq('id', pageId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'facebook')
        .maybeSingle();

      if (currentError) {
        logServerError('[pages] Page read failed before update', currentError, {
          source: 'page-update',
          pageId,
        });
        return NextResponse.json(
          { error: 'Failed to update page' },
          { status: 500 }
        );
      }

      // Status-family gate (Supabase path), same rule as SQL: a
      // present row that may not change status is rejected with
      // 409. A missing row (current null) skips the gate and falls
      // through to the existing 404 path below. Checkpoint ->
      // active is allowed here — that is the Mark Verified banner.
      if (parsed.data.status && current) {
        const gateMetadata =
          (current.metadata as Record<string, unknown> | null) ?? {};
        const gateWire = unifiedDestinationStatusToWire(
          current.status,
          gateMetadata
        );
        const gateEffective =
          gateWire === 'fb_rate_limited'
            ? evaluatePageHealth({
                status: gateWire,
                updatedAt: (current as { updated_at?: string }).updated_at ?? null,
                rateLimitedAt:
                  typeof gateMetadata.rate_limited_at === 'string'
                    ? gateMetadata.rate_limited_at
                    : null,
              })
            : gateWire;
        if (!statusTransitionAllowed(gateEffective, parsed.data.status)) {
          return NextResponse.json(
            {
              error: 'PAGE_STATUS_NOT_ALLOWED',
              message:
                STATUS_TOGGLE_BLOCKED_MESSAGES[gateEffective] ??
                'This Page cannot change automation right now.',
            },
            { status: 409 }
          );
        }
      }

      const currentMetadata =
        (current?.metadata as Record<string, unknown> | null) ?? {};
      const visible =
        current !== null &&
        (current.status !== 'disconnected' ||
          currentMetadata[PAUSED_MARKER_KEY] === PAUSED_MARKER_VALUE);

      // P1-5: a present-but-plain-disconnected page must not fall
      // through to a success response with its settings unchanged
      // (the status gate above only runs when a status is in the
      // body, so a timezone-only PATCH would otherwise skip the
      // update and report success). A missing row still falls
      // through to the 404 path below.
      if (current !== null && !visible) {
        return NextResponse.json(
          {
            error: 'PAGE_NOT_EDITABLE',
            message:
              'Cannot change settings on a disconnected Page. Add it again first.',
          },
          { status: 409 }
        );
      }

      if (visible) {
        const updates: {
          status?: string;
          timezone?: string;
          next_allowed_publish_at?: string | null;
          metadata?: Record<string, unknown>;
          updated_at: string;
        } = {
          updated_at: new Date().toISOString(),
        };
        if (statusWrite) {
          updates.status = statusWrite.status;
          const nextMetadata = { ...currentMetadata };
          if (statusWrite.pausedMarker === true) {
            nextMetadata[PAUSED_MARKER_KEY] = PAUSED_MARKER_VALUE;
          } else if (statusWrite.pausedMarker === false) {
            delete nextMetadata[PAUSED_MARKER_KEY];
            delete nextMetadata.rate_limited_at;
          }
          updates.metadata = nextMetadata;
          if (parsed.data.status === 'active') {
            updates.next_allowed_publish_at = null;
          }
        }
        if (parsed.data.timezone) {
          updates.timezone = parsed.data.timezone;
        }
        // B1: the update error must be checked. The old code awaited
        // this with no error destructure and fell through to
        // `{ success: true, page }` with the unchanged page, so a
        // failed Pause/Resume toasted success. The SQL path throws
        // on failure; the Supabase path now fails loud the same way.
        const { error: updateError } = await supabase
          .from('destinations')
          .update(updates)
          .eq('id', pageId)
          .eq('workspace_id', workspaceId)
          .eq('platform', 'facebook');
        if (updateError) {
          logServerError('[pages] Page update failed', updateError, {
            source: 'page-update',
            pageId,
          });
          return NextResponse.json(
            { error: 'Failed to update page' },
            { status: 500 }
          );
        }
      }
    }
  }

  const page = await fetchActivePageById(dbClient, pageId, workspaceId);
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, page });
}

export async function handleDisconnectPage(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const result = (await dbClient.query(
      `UPDATE destinations
       SET status = 'disconnected',
           encrypted_destination_token = NULL,
           metadata = metadata - 'fb_status',
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook'
       RETURNING id, external_destination_id AS fb_page_id`,
      [pageId, workspaceId]
    )) as Record<string, unknown>[];

    if (!result || result.length === 0 || !result[0]) {
      return NextResponse.json(
        { error: 'Facebook page not found' },
        { status: 404 }
      );
    }

    // Queued items for a disconnected page are cancelled (the unified
    // vocabulary has no 'skipped'; spec 120 backfilled skipped ->
    // cancelled).
    await dbClient.query(
      `UPDATE queue_items
       SET status = 'cancelled',
           updated_at = now()
       WHERE workspace_id = $1 AND destination_id = $2 AND status = 'queued'`,
      [workspaceId, pageId]
    );
  } else {
    const supabase = (dbClient && 'from' in dbClient ? dbClient : getSupabaseAdminClient()) as SupabaseClient | null;
    if (!supabase) {
      return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
    }

    const { data: existing, error: existingError } = await supabase
      .from('destinations')
      .select('metadata')
      .eq('id', pageId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();

    // A genuine database failure is not a missing page: reserve 404
    // for a truly absent row and fail loud (500) on a fetch error.
    if (existingError) {
      logServerError('[pages] Page read failed before disconnect', existingError, {
        source: 'page-disconnect',
        pageId,
      });
      return NextResponse.json(
        { error: 'Failed to disconnect page' },
        { status: 500 }
      );
    }

    if (!existing) {
      return NextResponse.json(
        { error: 'Facebook page not found' },
        { status: 404 }
      );
    }

    const nextMetadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
    };
    delete nextMetadata[PAUSED_MARKER_KEY];

    // B2 ordering: cancel queued posts FIRST, then disconnect.
    // The old order disconnected first and ignored the cancel
    // error, returning success while queued posts stayed queued.
    // Cancel-first is the safe order here: a cancel failure leaves
    // the page untouched (retry is clean, no half-done state), and
    // the only half-done state left — cancel succeeded but the
    // disconnect update then fails — is safe to retry, because the
    // disconnect step does not filter on status, so a retry
    // re-runs the (now no-op) cancel and completes the disconnect.
    // The reverse half-done state (disconnected + still-queued)
    // is the dangerous one: those posts could resurface if the
    // page is re-added, and cancel-first can never produce it.
    const { error: cancelError } = await supabase
      .from('queue_items')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('workspace_id', workspaceId)
      .eq('destination_id', pageId)
      .eq('status', 'queued');

    if (cancelError) {
      logServerError('[pages] Queue cancel failed on disconnect', cancelError, {
        source: 'page-disconnect',
        pageId,
      });
      return NextResponse.json(
        { error: 'Failed to disconnect page' },
        { status: 500 }
      );
    }

    const { data: updated, error } = await supabase
      .from('destinations')
      .update({
        status: 'disconnected',
        encrypted_destination_token: null,
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pageId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .select('id, external_destination_id');

    // Same 404 discipline as the read above: an update error is a
    // server failure, not a missing page; only zero updated rows
    // (row vanished between the read and the write) is a 404.
    if (error) {
      logServerError('[pages] Page disconnect update failed', error, {
        source: 'page-disconnect',
        pageId,
      });
      return NextResponse.json(
        { error: 'Failed to disconnect page' },
        { status: 500 }
      );
    }

    if (!updated || updated.length === 0) {
      return NextResponse.json(
        { error: 'Facebook page not found' },
        { status: 404 }
      );
    }

  }

  const responsePayload = DisconnectPageResponseSchema.parse({
    success: true,
    pageId,
  });

  return NextResponse.json(responsePayload);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleGetPage(request, subdomain, pageId);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleUpdatePage(request, subdomain, pageId);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> }
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleDisconnectPage(request, subdomain, pageId);
}
