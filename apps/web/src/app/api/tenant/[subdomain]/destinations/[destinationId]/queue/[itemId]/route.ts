import { type NextRequest, NextResponse } from 'next/server';
import { resolveDestinationPlatformOptions } from '@fbuploadpro/contracts';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import type { ConnectDbClient } from '@/lib/connect/persist';
import { bodyTooLargeResponse, readJsonBody } from '@/lib/request-body';
import {
  UnifiedQueueItemSchema,
  UpdateDestinationQueueItemRequestSchema,
} from '@/lib/api/schemas/unified-queue';
import { fetchDestinationSlots } from '@/lib/publishing/destination-enqueue';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';
import {
  deleteDestinationQueueItem,
  fetchDestinationQueueContext,
  fetchDestinationQueueItem,
  fetchDestinationQueueMedia,
  toUnifiedQueueItemView,
  updateDestinationQueueItem,
  type DestinationQueueItemRow,
} from '@/lib/publishing/destination-queue';

/**
 * PATCH / DELETE
 * /api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]
 *
 * The unified per-item actions (spec 134 PR-134-3, T24) — the actions
 * the composer retarget (PR 759) recorded as its residual: PR 756 shipped
 * the unified enqueue but no unified update, so the composer EDIT
 * flow's save stayed on the legacy route. This route is that update,
 * on the unified row.
 *
 * Semantics mirror the legacy item handlers field-for-field where the
 * shapes overlap (published items are immutable; a story carries no
 * first comment; delete is a hard delete the panel undoes by
 * re-enqueueing), with the unified differences spelled out:
 *   - scoping is workspace + destination (the unified tenancy), not
 *     the legacy per-user page scoping;
 *   - format travels as the `kind` + `platformFormat` pair;
 *   - `platformOptions`, when sent, are re-validated as a whole
 *     through the platform's own contracts schema — the same rule the
 *     enqueue applies, so an edit can never smuggle an option the
 *     create path would reject;
 *   - requesting `status: 'queued'` (an edit-save of a failed post, or
 *     a plain requeue) clears the claim marker, so the unified claim
 *     RPC picks the row up cleanly.
 */
export async function handleUpdateDestinationQueueItem(
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
      {
        error: 'CANNOT_UPDATE_PUBLISHED_ITEM',
        message: 'Published queue items cannot be modified',
      },
      { status: 400 }
    );
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const parsed = UpdateDestinationQueueItemRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const data = parsed.data;

  // Story posts carry no first comment (the legacy rule, unified
  // vocabulary: the item's kind after this edit governs).
  const newKind = data.kind ?? existing.kind;
  let newFirstComment =
    data.firstComment !== undefined ? data.firstComment : existing.first_comment;
  if (newKind === 'story') {
    if (data.firstComment && data.firstComment.trim().length > 0) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'First comment is not supported for story posts',
        },
        { status: 400 }
      );
    }
    newFirstComment = null;
  }

  // Platform options are re-validated as a whole when sent (see header).
  let newPlatformOptions = existing.platform_options as Record<string, unknown>;
  if (data.platformOptions !== undefined) {
    const optionsResult = resolveDestinationPlatformOptions(
      destination.platform,
      data.platformOptions
    );
    if (!optionsResult.ok) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: optionsResult.error },
        { status: 400 }
      );
    }
    newPlatformOptions = optionsResult.options;
  }

  // Facebook is publisher-driven: fixed times and slot pins do not
  // exist for its queued posts — a reschedule to a fixed time, or a
  // pin to one slot, is refused rather than stored. (Other platforms
  // keep the previous behaviour.)
  if (
    destination.platform === 'facebook' &&
    (data.scheduledTime !== undefined ||
      (data.slotId !== undefined && data.slotId !== null))
  ) {
    return NextResponse.json(
      {
        error: 'ONE_OFF_NOT_SUPPORTED',
        message:
          'Facebook posts go out through your posting times, in queue order — not at a fixed time.',
      },
      { status: 400 }
    );
  }

  // A pinned slot must belong to this destination (the enqueue's rule).
  if (data.slotId) {
    const slots = await fetchDestinationSlots(client, destination.id);
    if (!slots.some((slot) => slot.id === data.slotId)) {
      return NextResponse.json({ error: 'Queue slot not found' }, { status: 404 });
    }
  }

  const newStatus = data.status ?? existing.status;
  const updated = await updateDestinationQueueItem(
    client,
    workspaceId,
    destination.id,
    itemId,
    {
      caption: data.caption ?? existing.caption ?? '',
      title: data.title !== undefined ? data.title : existing.title,
      firstComment: newFirstComment,
      linkUrl: data.linkUrl !== undefined ? data.linkUrl : existing.link_url,
      kind: newKind,
      platformFormat:
        data.platformFormat !== undefined
          ? data.platformFormat
          : existing.platform_format,
      platformOptions: newPlatformOptions,
      scheduledTime:
        data.scheduledTime !== undefined
          ? new Date(data.scheduledTime).toISOString()
          : existing.scheduled_time
            ? new Date(existing.scheduled_time).toISOString()
            : null,
      slotId: data.slotId !== undefined ? data.slotId : existing.slot_id,
      status: newStatus,
      // Requeueing clears the claim marker; any other edit preserves it.
      claimedAt: newStatus === 'queued' ? null : existing.claimed_at,
    }
  );

  if (!updated) {
    return NextResponse.json({ error: 'Failed to update queue item' }, { status: 500 });
  }

  if (destination.platform === 'facebook') {
    // A format edit or requeue can cover or uncover queued formats.
    await refreshDestinationUnmatchedFlag(client, destination.id);
  }

  return NextResponse.json(
    UnifiedQueueItemSchema.parse(await toView(client, session.userId, updated)),
    { status: 200 }
  );
}

export async function handleDeleteDestinationQueueItem(
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
  const { client, workspaceId } = context;

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
      {
        error: 'CANNOT_DELETE_PUBLISHED_ITEM',
        message: 'Published queue items cannot be deleted',
      },
      { status: 400 }
    );
  }

  const deleted = await deleteDestinationQueueItem(
    client,
    workspaceId,
    destination.id,
    itemId
  );
  if (!deleted) {
    return NextResponse.json({ error: 'Failed to delete queue item' }, { status: 500 });
  }

  if (destination.platform === 'facebook') {
    // Deleting a queued post can clear the unmatched flag (e.g. the
    // only unmatched post is gone).
    await refreshDestinationUnmatchedFlag(client, destination.id);
  }

  return NextResponse.json({ success: true, itemId }, { status: 200 });
}

/** The updated row as the client view, with its library media joined. */
async function toView(
  client: ConnectDbClient,
  userId: string,
  row: DestinationQueueItemRow
) {
  const mediaRows = row.media_item_id
    ? await fetchDestinationQueueMedia(client, userId, [row.media_item_id])
    : [];
  return toUnifiedQueueItemView(
    row,
    new Map(mediaRows.map((media) => [media.id, media]))
  );
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; destinationId: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId, itemId } = await context.params;
  return handleUpdateDestinationQueueItem(request, subdomain, destinationId, itemId);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; destinationId: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId, itemId } = await context.params;
  return handleDeleteDestinationQueueItem(request, subdomain, destinationId, itemId);
}
