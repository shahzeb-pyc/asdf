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

  // Idempotency: same contract as the enqueue route — a retry with
  // a known key returns the stored item view without requeueing
  // (see lib/publishing/idempotency.ts). Only failed items can be
  // retried, so a duplicate tap is already row-safe; the key
  // additionally covers a retried request whose response was lost.
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
        action: 'destination-retry',
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

  if (existing.status !== 'failed') {
    return NextResponse.json(
      { error: 'ITEM_NOT_FAILED', message: 'Only failed posts can be retried.' },
      { status: 400 }
    );
  }

  // Status family 3A: the same PAGE_NOT_PUBLISHABLE gate the
  // enqueue route applies. Only an active destination may retry;
  // every other wire status is a 409, never a fake success for a
  // post that cannot go out. A rate-limited destination with a
  // recorded rate_limited_at past the 3-day cooldown counts as
  // active (matching the detail/list flip); without a recorded
  // timestamp it stays blocked — fail closed.
  {
    const wire = unifiedDestinationStatusToWire(
      destination.status,
      destination.metadata
    );
    const rateLimitedAt =
      typeof destination.metadata?.rate_limited_at === 'string'
        ? destination.metadata.rate_limited_at
        : null;
    const effective =
      wire === 'fb_rate_limited' && rateLimitedAt
        ? evaluatePageHealth({
            status: wire,
            updatedAt: null,
            rateLimitedAt,
          })
        : wire;
    if (effective !== 'active') {
      const messages: Partial<Record<string, string>> = {
        invalid_token:
          'This Page’s connection has expired. Reconnect the Page, then try again.',
        page_checkpoint:
          'This Page is waiting on a Facebook identity check. Resolve it in Facebook, then try again.',
        fb_rate_limited:
          'This Page is rate-limited by Facebook right now. Wait for the limit to lift, then try again.',
        disconnected: 'This Page is disconnected. Add it again, then try again.',
        paused: 'This Page is paused. Resume posting, then try again.',
      };
      return NextResponse.json(
        {
          error: 'PAGE_NOT_PUBLISHABLE',
          message:
            messages[effective] ??
            'This Page cannot publish right now. Fix the Page connection, then try again.',
        },
        { status: 409 }
      );
    }
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
      // R12: a retried post gets a fresh retry budget — the failed
      // item's exhausted count must not carry into its new life,
      // or the next failure would immediately exceed the ceiling.
      // The Queue row's "Retry N of 3" reads retryCount, so it
      // follows the reset on the next fetch.
      retryCount: 0,
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
  const responseBody = UnifiedQueueItemSchema.parse(view);
  if (idempotencyScope) {
    await storeIdempotencyResult(client, idempotencyScope, {
      status: 200,
      body: responseBody,
    });
  }
  return NextResponse.json(responseBody, { status: 200 });
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
