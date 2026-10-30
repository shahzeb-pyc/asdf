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
import { evaluatePageHealth } from '@fbuploadpro/contracts';
import { unifiedDestinationStatusToWire } from '@/lib/server/facebook-wire';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import {
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  storeIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';

/**
 * Status family 2A: the same PAGE_NOT_PUBLISHABLE gate the enqueue
 * route applies, with the same plain-language messages. Only an
 * active page may Publish Now from Queue/Dashboard; every other
 * wire status is a 409, never a fake success toast for a post that
 * stays queued. A rate-limited page past the 3-day cooldown is
 * treated as active, matching the detail/list cooldown flip.
 * This gate is for Queue/Dashboard Publish Now ONLY — the separate
 * direct Publish Now page/section is untouched.
 */
const PAGE_NOT_PUBLISHABLE_MESSAGES: Partial<Record<string, string>> = {
  invalid_token:
    'This Page’s connection has expired. Reconnect the Page, then try again.',
  page_checkpoint:
    'This Page is waiting on a Facebook identity check. Resolve it in Facebook, then try again.',
  fb_rate_limited:
    'This Page is rate-limited by Facebook right now. Wait for the limit to lift, then try again.',
  disconnected: 'This Page is disconnected. Add it again, then try again.',
  paused: 'This Page is paused. Resume posting, then try again.',
};

function parseDestinationMetadata(
  raw: unknown
): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchPublishNowGate(
  dbClient: DatabaseClient | SupabaseClient | undefined,
  workspaceId: string,
  destinationId: string
): Promise<NextResponse | null> {
  let rawStatus: string | null = null;
  let metadata: Record<string, unknown> | null = null;
  let updatedAt: string | null = null;
  if (dbClient && 'query' in dbClient && typeof dbClient.query === 'function') {
    const rows = (await dbClient.query(
      `SELECT status, metadata, updated_at FROM destinations WHERE id = $1 AND workspace_id = $2`,
      [destinationId, workspaceId]
    )) as Array<{
      status: string;
      metadata: unknown;
      updated_at: string;
    }>;
    const row = rows?.[0];
    if (!row) return null;
    rawStatus = row.status;
    metadata = parseDestinationMetadata(row.metadata);
    updatedAt = row.updated_at ?? null;
  } else {
    const supabase = getRouteSupabase(dbClient);
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('destinations')
      .select('status, metadata, updated_at')
      .eq('id', destinationId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (error || !data) return null;
    rawStatus = (data as { status: string }).status;
    metadata = parseDestinationMetadata((data as { metadata: unknown }).metadata);
    updatedAt = (data as { updated_at?: string }).updated_at ?? null;
  }
  const wire = unifiedDestinationStatusToWire(rawStatus, metadata);
  const effective =
    wire === 'fb_rate_limited'
      ? evaluatePageHealth({
          status: wire,
          updatedAt,
          rateLimitedAt:
            typeof metadata?.rate_limited_at === 'string'
              ? metadata.rate_limited_at
              : null,
        })
      : wire;
  if (effective === 'active') return null;
  return NextResponse.json(
    {
      error: 'PAGE_NOT_PUBLISHABLE',
      message:
        PAGE_NOT_PUBLISHABLE_MESSAGES[effective] ??
        'This Page cannot publish right now. Fix the Page connection, then try again.',
    },
    { status: 409 }
  );
}

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
      `SELECT id, status, destination_id FROM queue_items WHERE id = $1 AND workspace_id = $2`,
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

    // Status gate, after the idempotency replay above (a replayed
    // acknowledgement is not a new dispatch) and after the
    // published check: a non-active destination is a 409 here.
    if (typeof existing.destination_id === 'string') {
      const gate = await fetchPublishNowGate(
        dbClient,
        workspaceId,
        existing.destination_id
      );
      if (gate) return gate;
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

  if (existing.destination_id) {
    const gate = await fetchPublishNowGate(
      dbClient,
      workspaceId,
      existing.destination_id
    );
    if (gate) return gate;
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
