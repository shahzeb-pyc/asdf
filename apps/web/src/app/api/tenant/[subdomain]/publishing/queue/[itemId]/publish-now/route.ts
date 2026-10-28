import { type NextRequest, NextResponse } from 'next/server';
import {
  authenticateTenantRoute,
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enforceIpRateLimit } from '@/lib/request-body';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import {
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  storeIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';

/**
 * Publish-now for the Facebook Page section, on the unified
 * `queue_items` table (Phase 7): the item is re-queued for immediate
 * dispatch (scheduled_time = now, any stale claim marker cleared —
 * the same requeue semantics as the destination queue's publish-now).
 * Scoping is by workspace, the unified tables' isolation boundary.
 */
export async function handlePublishNow(
  request: NextRequest,
  subdomain: string,
  itemId: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session;

  const workspaceId = await resolveTenantWorkspaceId(dbClient, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // Idempotency (same contract as the enqueue route): a retry with a
  // known key returns the stored acknowledgement without
  // re-dispatching. Publish-now re-times a single existing row, so
  // a duplicate tap is already row-safe — the key additionally
  // covers a retried request whose response was lost.
  const idempotency = parseIdempotencyKeyHeader(request.headers);
  if (idempotency.invalid) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Idempotency-Key must be a UUID' },
      { status: 400 }
    );
  }
  const idempotencyScope: IdempotencyScope | null = idempotency.key
    ? {
        workspaceId,
        userId: session.userId,
        action: 'publish-now',
        key: idempotency.key,
      }
    : null;
  if (idempotencyScope) {
    try {
      const replay = await lookupIdempotencyResult(dbClient, idempotencyScope);
      if (replay) {
        return NextResponse.json(replay.body, {
          status: replay.status,
          headers: { 'Idempotency-Replayed': 'true' },
        });
      }
    } catch {
      return NextResponse.json(
        {
          error: 'IDEMPOTENCY_STORE_UNAVAILABLE',
          message: 'Idempotency store unavailable',
        },
        { status: 500 }
      );
    }
  }

  if (isLegacyClient(dbClient)) {
    // Check existing item
    const existingRows = (await dbClient.query(
      `SELECT id, status FROM queue_items WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    )) as Record<string, unknown>[];

    if (!existingRows || existingRows.length === 0) {
      return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
    }

    const existing = existingRows[0];
    if (existing.status === 'published') {
      return NextResponse.json(
        { error: 'ALREADY_PUBLISHED', message: 'Item has already been published' },
        { status: 400 }
      );
    }

    // Update scheduled_time to now() and status to 'queued'
    await dbClient.query(
      `UPDATE queue_items
       SET scheduled_time = now(),
           status = 'queued',
           claimed_at = NULL,
           updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    );

    // A failed item re-entering the queue can set the unmatched
    // flag; the RPC itself is Facebook-gated, so this is a no-op
    // for other platforms.
    const destRows = (await dbClient.query(
      `SELECT destination_id FROM queue_items WHERE id = $1 AND workspace_id = $2`,
      [itemId, workspaceId]
    )) as Array<{ destination_id: string }>;
    if (destRows[0]?.destination_id) {
      await refreshDestinationUnmatchedFlag(dbClient, destRows[0].destination_id);
    }

    if (idempotencyScope) {
      await storeIdempotencyResult(dbClient, idempotencyScope, {
        status: 200,
        body: {
          success: true,
          message: 'Item dispatched for immediate publishing',
        },
      });
    }
    return NextResponse.json(
      {
        success: true,
        message: 'Item dispatched for immediate publishing',
      },
      { status: 200 }
    );
  }

  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }

  const { data: existing, error: existErr } = await supabase
    .from('queue_items')
    .select('id, status, destination_id')
    .eq('id', itemId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (existErr || !existing) {
    return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
  }

  if (existing.status === 'published') {
    return NextResponse.json(
      { error: 'ALREADY_PUBLISHED', message: 'Item has already been published' },
      { status: 400 }
    );
  }

  const { error: updateErr } = await supabase
    .from('queue_items')
    .update({
      scheduled_time: new Date().toISOString(),
      status: 'queued',
      claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .eq('workspace_id', workspaceId);

  if (updateErr) {
    return NextResponse.json({ error: 'Failed to dispatch item' }, { status: 500 });
  }

  // See the pg branch above: re-queueing can set the unmatched flag.
  if (existing.destination_id) {
    await refreshDestinationUnmatchedFlag(supabase, existing.destination_id);
  }

  if (idempotencyScope) {
    await storeIdempotencyResult(dbClient, idempotencyScope, {
      status: 200,
      body: {
        success: true,
        message: 'Item dispatched for immediate publishing',
      },
    });
  }
  return NextResponse.json(
    {
      success: true,
      message: 'Item dispatched for immediate publishing',
    },
    { status: 200 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, itemId } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_publish_now', 30);
  if (limited) return limited;
  return handlePublishNow(request, subdomain, itemId);
}
