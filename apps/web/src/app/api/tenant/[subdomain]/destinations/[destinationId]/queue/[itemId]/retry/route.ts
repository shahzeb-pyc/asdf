import { type NextRequest, NextResponse } from 'next/server';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import type { ConnectDbClient } from '@/lib/connect/persist';
import { enforceIpRateLimit } from '@/lib/request-body';
import { UnifiedQueueItemSchema } from '@/lib/api/schemas/unified-queue';
import { calculateNextVacantSlot } from '@/lib/slot-scheduler';
import {
  fetchDestinationQueuedTimes,
  fetchDestinationSlots,
} from '@/lib/publishing/destination-enqueue';
import {
  fetchDestinationQueueContext,
  fetchDestinationQueueItem,
  fetchDestinationQueueMedia,
  toUnifiedQueueItemView,
  updateDestinationQueueItem,
} from '@/lib/publishing/destination-queue';
import { refreshDestinationUnmatchedFlag } from '@/lib/server/unmatched-flag';

/**
 * POST /api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]/retry
 *
 * The unified failed-post retry (spec 134 PR-134-3, T24; spec §3.5).
 * The retry time is resolved HERE, through the same slot scheduler the
 * enqueue uses, so a retried post lands on the destination's unified
 * `posting_slots` — never on a client-computed guess:
 *
 *   - a custom-scheduled post (its time matches no posting slot) whose
 *     time is still ahead keeps its original time;
 *   - otherwise the post takes the next vacant posting-slot occurrence
 *     covering its format; when no slot covers it, the retry is a 400
 *     (`NO_COVERING_SLOT`) with the plain-language reason.
 *
 * The row returns to `queued` with its claim marker cleared, settling
 * through the unified claim path like any other queued item. Only a
 * failed item can be retried.
 */
export async function handleDestinationRetry(
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

  if (existing.status !== 'failed') {
    return NextResponse.json(
      { error: 'ITEM_NOT_FAILED', message: 'Only failed posts can be retried.' },
      { status: 400 }
    );
  }

  // Facebook is publisher-driven: a retried post goes back to
  // `queued` with NO stored time and NO slot link, keeping its
  // queue position — it goes out at the next fitting posting time,
  // or waits (with the unmatched warning) when no time covers it.
  // There is no NO_COVERING_SLOT refusal for Facebook anymore.
  let scheduledTime: string | null;
  let slotId: string | null;
  if (destination.platform === 'facebook') {
    scheduledTime = null;
    slotId = null;
  } else {
    const now = new Date();
    const slots = await fetchDestinationSlots(client, destination.id);

    slotId = existing.slot_id;

    const itemTime = new Date(existing.scheduled_time as string);
    const slotGoverned = slots.some(
      (slot) =>
        normalizeTimeOfDay(slot.time_of_day) ===
        localTimeOfDay(itemTime, destination.timezone)
    );

    if (!slotGoverned && itemTime.getTime() > now.getTime()) {
      // Custom-scheduled and still ahead: keep the original time.
      scheduledTime = itemTime.toISOString();
    } else {
      const existingQueued = await fetchDestinationQueuedTimes(client, destination.id);
      const computed = calculateNextVacantSlot({
        slots: slots.map((slot) => ({
          id: slot.id,
          slotTime: slot.time_of_day,
          timezone: destination.timezone,
          isActive: Boolean(slot.is_active),
          allowedFormats: slot.kind ?? null,
        })),
        existingScheduledTimes: existingQueued,
        now,
        postFormat: existing.platform_format ?? existing.kind,
      });
      if (!computed) {
        return NextResponse.json(
          {
            error: 'NO_COVERING_SLOT',
            message: 'No posting time covers this post yet.',
          },
          { status: 400 }
        );
      }
      scheduledTime = computed.scheduledTime.toISOString();
      slotId = computed.slotId;
    }
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
      scheduledTime,
      slotId,
      status: 'queued',
      claimedAt: null,
    }
  );

  if (!updated) {
    return NextResponse.json({ error: 'Failed to retry queue item' }, { status: 500 });
  }

  if (destination.platform === 'facebook') {
    await refreshDestinationUnmatchedFlag(client, destination.id);
  }

  const mediaRows = updated.media_item_id
    ? await fetchDestinationQueueMedia(client, session.userId, [updated.media_item_id])
    : [];
  const view = toUnifiedQueueItemView(
    updated,
    new Map(mediaRows.map((media) => [media.id, media]))
  );
  return NextResponse.json(UnifiedQueueItemSchema.parse(view), { status: 200 });
}

/** 'HH:MM' or 'HH:MM:SS' → 'HH:MM:SS'. */
function normalizeTimeOfDay(value: string): string {
  const parts = value.split(':');
  const [hours = '00', minutes = '00', seconds = '00'] = parts;
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

/** The instant's local time of day ('HH:MM:SS') in the given timezone. */
function localTimeOfDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: string) =>
    (parts.find((part) => part.type === type)?.value ?? '00').padStart(2, '0');
  return `${read('hour')}:${read('minute')}:${read('second')}`;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; destinationId: string; itemId: string }> }
): Promise<NextResponse> {
  const { subdomain, destinationId, itemId } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_destination_retry', 30);
  if (limited) return limited;
  return handleDestinationRetry(request, subdomain, destinationId, itemId);
}
