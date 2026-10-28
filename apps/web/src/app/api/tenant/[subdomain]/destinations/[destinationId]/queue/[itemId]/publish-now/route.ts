import { type NextRequest, NextResponse } from 'next/server';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import type { ConnectDbClient } from '@/lib/connect/persist';
import { enforceIpRateLimit } from '@/lib/request-body';
import {
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  storeIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';
import {
  fetchDestinationQueueContext,
  fetchDestinationQueueItem,
  updateDestinationQueueItem,
} from '@/lib/publishing/destination-queue';

/**
 * POST /api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]/publish-now
 *
 * The unified publish-now (spec 134 PR-134-3, T24) — the second half
 * of the composer-retarget residual (PR 759): the composer EDIT flow's
 * Post now intent settles through here for unified items. Mirrors the
 * legacy publish-now exactly: a published item is a 400
 * (`ALREADY_PUBLISHED`); anything else is re-timed to now and
 * (re)queued with its claim marker cleared, so the unified claim RPC
 * dispatches it on its next pass.
 */
export async function handleDestinationPublishNow(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  itemId: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const context = await resolveSocialRouteContext(request, subdomain, dbClient);
  if (context.errorResponse) {
    return context.errorResponse;
  }
  const { session, client, workspaceId } = context;

  // Idempotency: same contract as the enqueue route — a retry with
  // a known key returns the stored acknowledgement without
  // re-dispatching (see lib/publishing/idempotency.ts).
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
        action: 'destination-publish-now',
        key: idempotency.key,
      }
    : null;
  if (idempotencyScope) {
    try {
      const replay = await lookupIdempotencyResult(client, idempotencyScope);
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

  const destination = await fetchDestinationQueueContext(
    client,
    workspaceId,
    destinationId
  );
  if (!destination) {
    return NextResponse.json({ error: 'Destination not found' }, { status: 404 });
  }

  const existing = await fetchDestinationQueueItem(
    client,
    workspaceId,
    destination.id,
    itemId
  );
  if (!existing) {
    return NextResponse.json({ error: 'Queue item not found' }, { status: 404 });
  }

  if (existing.status === 'published') {
    return NextResponse.json(
      { error: 'ALREADY_PUBLISHED', message: 'Item has already been published' },
      { status: 400 }
    );
  }

  const updated = await updateDestinationQueueItem(
    client,
    workspaceId,
    destination.id,
    itemId,
    {
      caption: existing.caption ?? '',
      title: existing.title,
      firstComment: existing.first_comment,
      linkUrl: existing.link_url,
      kind: existing.kind,
      platformFormat: existing.platform_format,
      platformOptions: existing.platform_options as Record<string, unknown>,
      scheduledTime: new Date().toISOString(),
      slotId: existing.slot_id,
      status: 'queued',
      claimedAt: null,
    }
  );

  if (!updated) {
    return NextResponse.json({ error: 'Failed to publish queue item' }, { status: 500 });
  }

  if (idempotencyScope) {
    await storeIdempotencyResult(client, idempotencyScope, {
      status: 200,
      body: {
        success: true,
        message: 'Item dispatched for immediate publishing',
      },
    });
  }
  return NextResponse.json(
    { success: true, message: 'Item dispatched for immediate publishing' },
    { status: 200 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; destinationId: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId, itemId } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_destination_publish_now', 30);
  if (limited) return limited;
  return handleDestinationPublishNow(request, subdomain, destinationId, itemId);
}
