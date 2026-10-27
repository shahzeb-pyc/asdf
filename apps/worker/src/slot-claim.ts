import {
  findDueSlots,
  PublishQueueMessageSchema,
  PUBLISH_LANE_FAST,
  routePublishLaneForItem,
  type PublishLane,
} from '@fbuploadpro/contracts';
// Note: the heavy lane is selected by the else branch below, so
// PUBLISH_LANE_HEAVY is intentionally not imported here.
import { captureWorkerError, type PostHogEnv } from './analytics.js';
import {
  SEND_BATCH_CHUNK_SIZE,
  type ClaimerDbClient,
  type ClaimerQueues,
  type PublishQueueMessage,
} from './claimer.js';

// ==========================================
// Slot-claim tick (publisher-driven posting times)
// ==========================================
//
// Queued Facebook posts store NO posting time. Once per tick, for
// every active Facebook destination, this tick finds the posting
// times whose occurrence today (in the page timezone) falls inside
// the claim window, and claims ONE post per due slot through the
// `claim_posting_slot_item` RPC: the first queued post fitting that
// slot's allowed formats, in queue order, skipping posts that do
// not fit. The RPC itself is the safety net:
//
//   - One post per slot per day: the posting_slot_claims unique
//     constraint (destination, slot, claim date) makes a second
//     claim for the same slot+day insert nothing — retry-safe and
//     double-fire-proof even if the tick runs twice.
//   - Missed is lost: the RPC refuses slots whose occurrence is
//     outside the window, so a tick that runs late never catches up.
//   - Only active pages publish: the RPC verifies destination
//     status = 'active' and slot is_active (paused pages are stored
//     as disconnected + marker, so they are excluded).
//
// The tick ONLY claims and enqueues — it never publishes, exactly
// like the due-based claimer. Non-Facebook platforms keep the
// due-based claim path; their queued rows still carry stored times.

/**
 * Claim window in minutes: a slot occurrence this old (or newer) is
 * still claimable. The claim tick runs every minute, so 5 minutes
 * absorbs tick jitter and short outages; anything older is a missed
 * time and is lost by design.
 */
export const SLOT_CLAIM_WINDOW_MINUTES = 5;

export interface ActivePostingSlotRow {
  destination_id: string;
  slot_id: string;
  time_of_day: string;
  timezone: string;
  kind: string[];
}

export interface SlotClaimTickDeps {
  db: ClaimerDbClient;
  queues: ClaimerQueues;
  env?: PostHogEnv;
  now?: Date;
  windowMinutes?: number;
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

export interface SlotClaimTickResult {
  claimed: number;
  enqueuedFast: number;
  enqueuedHeavy: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseSlotRows(data: unknown): ActivePostingSlotRow[] {
  if (!Array.isArray(data)) return [];
  const rows: ActivePostingSlotRow[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const destinationId = row.destination_id;
    const slotId = row.slot_id;
    const timeOfDay = row.time_of_day;
    const timezone = row.timezone;
    const kind = row.kind;
    if (
      typeof destinationId !== 'string' ||
      typeof slotId !== 'string' ||
      typeof timeOfDay !== 'string' ||
      typeof timezone !== 'string' ||
      !Array.isArray(kind) ||
      !kind.every((k) => typeof k === 'string')
    ) {
      continue;
    }
    rows.push({
      destination_id: destinationId,
      slot_id: slotId,
      time_of_day: timeOfDay,
      timezone,
      kind: kind as string[],
    });
  }
  return rows;
}

export async function runSlotClaimTick(
  deps: SlotClaimTickDeps
): Promise<SlotClaimTickResult> {
  const now = deps.now ?? new Date();
  const windowMinutes = deps.windowMinutes ?? SLOT_CLAIM_WINDOW_MINUTES;
  const result: SlotClaimTickResult = { claimed: 0, enqueuedFast: 0, enqueuedHeavy: 0 };

  const { data: slotData, error: slotError } = await deps.db.rpc(
    'list_active_facebook_posting_slots'
  );
  if (slotError) {
    const err = slotError instanceof Error ? slotError : new Error(String(slotError));
    captureWorkerError(
      deps.env ?? {},
      err,
      { site: 'runSlotClaimTick', kind: 'list_slots_rpc_error' },
      deps.waitUntil
    );
    throw err;
  }
  const slotRows = parseSlotRows(slotData);

  // Group by destination: one timezone per page, and the due-slot
  // finder works per page.
  const byDestination = new Map<string, { timezone: string; slots: ActivePostingSlotRow[] }>();
  for (const row of slotRows) {
    let group = byDestination.get(row.destination_id);
    if (!group) {
      group = { timezone: row.timezone, slots: [] };
      byDestination.set(row.destination_id, group);
    }
    group.slots.push(row);
  }

  const pendingByLane = new Map<PublishLane, PublishQueueMessage[]>();

  for (const [destinationId, group] of byDestination) {
    const due = findDueSlots({
      slots: group.slots.map((row) => ({
        id: row.slot_id,
        timeOfDay: row.time_of_day,
        isActive: true,
        allowedFormats: row.kind,
      })),
      timezone: group.timezone,
      now,
      windowMinutes,
    });

    for (const { slot, claimDate } of due) {
      // Per-slot isolation, mirroring the due claimer: one failing
      // slot must not abort the remaining slots or destinations.
      try {
        const { data, error } = await deps.db.rpc('claim_posting_slot_item', {
          p_destination_id: destinationId,
          p_slot_id: slot.id,
          p_claim_date: claimDate,
          p_now: now.toISOString(),
          p_window_minutes: windowMinutes,
        });
        if (error) throw error instanceof Error ? error : new Error(String(error));
        if (!Array.isArray(data)) {
          throw new Error(
            `claim_posting_slot_item returned a non-array payload for destination "${destinationId}" slot "${slot.id}"`
          );
        }
        for (const row of data) {
          if (!isRecord(row)) continue;
          const itemId = row.id;
          const kind = row.kind;
          const platformFormat = row.platform_format;
          if (typeof itemId !== 'string' || typeof kind !== 'string') continue;
          const lane = routePublishLaneForItem({
            platform: 'facebook',
            kind: kind as 'text' | 'image' | 'video' | 'story' | 'carousel',
            platform_format: typeof platformFormat === 'string' ? platformFormat : null,
          });
          const parsed = PublishQueueMessageSchema.safeParse({
            itemId,
            platform: 'facebook',
            lane,
          });
          if (!parsed.success) continue;
          const list = pendingByLane.get(lane) ?? [];
          list.push(parsed.data);
          pendingByLane.set(lane, list);
          result.claimed += 1;
        }
      } catch (err) {
        captureWorkerError(
          deps.env ?? {},
          err,
          {
            site: 'runSlotClaimTick',
            kind: 'slot_claim_failed',
            destinationId,
            slotId: slot.id,
          },
          deps.waitUntil
        );
        console.error(
          `[slot-claim] claim failed destination=${destinationId} slot=${slot.id}; continuing with remaining slots:`,
          err
        );
        continue;
      }
    }
  }

  for (const [lane, messages] of pendingByLane) {
    const queue = lane === PUBLISH_LANE_FAST ? deps.queues.fast : deps.queues.heavy;
    if (!queue) {
      throw new Error(`Queue producer binding for lane "${lane}" is not configured`);
    }
    for (let i = 0; i < messages.length; i += SEND_BATCH_CHUNK_SIZE) {
      const chunk = messages.slice(i, i + SEND_BATCH_CHUNK_SIZE);
      await queue.sendBatch(chunk.map((body) => ({ body })));
      if (lane === PUBLISH_LANE_FAST) {
        result.enqueuedFast += chunk.length;
      } else {
        result.enqueuedHeavy += chunk.length;
      }
    }
  }

  if (result.claimed > 0) {
    console.info(
      `[slot-claim] tick claimed=${result.claimed} enqueuedFast=${result.enqueuedFast} enqueuedHeavy=${result.enqueuedHeavy}`
    );
  }
  return result;
}
