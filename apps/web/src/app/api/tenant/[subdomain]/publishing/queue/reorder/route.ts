import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  ReorderQueueItemsRequestSchema,
  ReorderQueueItemsResponseSchema,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Queue reorder for the Facebook Page section (Queue section rebuild),
 * on the unified `queue_items` table.
 *
 * The client sends the FULL new queue order for one page
 * (`{ pageId, itemIds }`). The server rejects anything that is not
 * exactly the page's current queued set — a non-queued id, an id from
 * another page, or a partial list all fail — and then rewrites
 * `queue_seq` densely in list order.
 *
 * Atomicity differs by client shape (both DB shapes are supported, as
 * in the sibling queue routes): the legacy SQL path runs one CASE
 * UPDATE inside a transaction; the Supabase path has no raw-SQL
 * transaction, so it updates in two passes — first to large offset
 * values (unique, order-preserving), then to dense values — so a
 * failure can never leave duplicate queue_seq values behind.
 * No migration: `queue_seq` already exists (PR #24).
 * No idempotency key: queue management, not publishing.
 */

const REORDER_OFFSET = 1_000_000;

async function authenticateReorderRequest(request: NextRequest, subdomain: string) {
  const sessionSecret = getSessionSecret();

  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return {
      errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { session };
}

/**
 * The submitted list must be exactly the page's queued set: same ids,
 * no more, no fewer. Returns an error response when it is not, or
 * null when the list is valid.
 */
function validateReorderList(queuedIds: string[], itemIds: string[]): NextResponse | null {
  const queuedSet = new Set(queuedIds);
  const unknown = itemIds.find((id) => !queuedSet.has(id));
  if (unknown) {
    return NextResponse.json(
      {
        error: 'NON_QUEUED_ITEM',
        message: 'All reordered items must be queued posts on this page.',
      },
      { status: 400 }
    );
  }
  if (itemIds.length !== queuedIds.length) {
    return NextResponse.json(
      {
        error: 'INCOMPLETE_ORDER',
        message: 'The reorder list must contain every queued post on this page.',
      },
      { status: 400 }
    );
  }
  return null;
}

export async function handleReorderQueueItems(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateReorderRequest(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session!;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (_e) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const parsed = ReorderQueueItemsRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { pageId, itemIds } = parsed.data;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  if (isLegacyClient(dbClient)) {
    try {
      await dbClient.query('BEGIN');
      const queuedRows = (await dbClient.query(
        `SELECT id FROM queue_items
         WHERE destination_id = $1 AND workspace_id = $2 AND status = 'queued'
         ORDER BY queue_seq ASC NULLS LAST, created_at ASC`,
        [pageId, workspaceId]
      )) as Array<{ id: string }>;
      const queuedIds = queuedRows.map((row) => row.id);

      const invalid = validateReorderList(queuedIds, itemIds);
      if (invalid) {
        await dbClient.query('ROLLBACK');
        return invalid;
      }

      // One atomic CASE UPDATE: position i (1-based) in list order.
      const caseSql = itemIds
        .map((_, index) => `WHEN $${index + 1} THEN ${index + 1}`)
        .join(' ');
      const params: unknown[] = [...itemIds, workspaceId, pageId];
      await dbClient.query(
        `UPDATE queue_items SET queue_seq = CASE id ${caseSql} END
         WHERE workspace_id = $${itemIds.length + 1}
           AND destination_id = $${itemIds.length + 2}`,
        params
      );
      await dbClient.query('COMMIT');
    } catch (_e) {
      try {
        await dbClient.query('ROLLBACK');
      } catch (rollbackErr) {
        // Rollback also failed: log it; the original reorder failure is
        // still reported below, so the caller sees the reorder failure.
        console.error('[handleReorderQueueItems] Rollback failed after reorder error:', rollbackErr);
      }
      return NextResponse.json({ error: 'Failed to reorder queue' }, { status: 500 });
    }

    return NextResponse.json(
      ReorderQueueItemsResponseSchema.parse({ success: true, itemIds }),
      { status: 200 }
    );
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: queuedRows, error: queuedError } = await supabase
    .from('queue_items')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('destination_id', pageId)
    .eq('status', 'queued');
  if (queuedError) {
    return NextResponse.json({ error: 'Failed to reorder queue' }, { status: 500 });
  }
  const queuedIds = (queuedRows as Array<{ id: string }>).map((row) => row.id);

  const invalid = validateReorderList(queuedIds, itemIds);
  if (invalid) return invalid;

  // Two passes: offset values first (unique, order-preserving), then
  // dense values — so a failure can never leave duplicate queue_seq.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < itemIds.length; index += 1) {
      const queueSeq = pass === 0 ? REORDER_OFFSET + index + 1 : index + 1;
      const { error: updateError } = await supabase
        .from('queue_items')
        .update({ queue_seq: queueSeq })
        .eq('id', itemIds[index]!)
        .eq('workspace_id', workspaceId);
      if (updateError) {
        return NextResponse.json({ error: 'Failed to reorder queue' }, { status: 500 });
      }
    }
  }

  return NextResponse.json(
    ReorderQueueItemsResponseSchema.parse({ success: true, itemIds }),
    { status: 200 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleReorderQueueItems(request, subdomain);
}
