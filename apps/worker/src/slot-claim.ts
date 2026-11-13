import { findDueSlots, InternalError } from '@fbuploadpro/contracts';
import { captureWorkerError, type PostHogEnv } from './analytics.js';
import {
  enqueueClaimedRows,
  type ClaimerDbClient,
  type ClaimerQueues,
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

  // Spec 174 3A: the slot lister is section-scoped — the Schedule
  // tick lists schedule-section slots only, so an Auto Download or
  // mirror copy of the same page can never be slot-claimed here.
  const { data: slotData, error: slotError } = await deps.db.rpc(
    'list_active_facebook_posting_slots',
    { p_section: 'schedule' }
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

  // Claimed rows accumulate across slots; the shared enqueue step
  // below validates, lanes, and sendBatches them exactly as the
  // inline loop did before the publish-now tick shared it.
  const claimedRows: unknown[] = [];

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
          // Spec 174 3A: the RPC refuses a destination whose section
          // is not 'schedule' — the same slot cannot be claimed
          // twice across sections.
          p_section: 'schedule',
        });
        if (error) throw error instanceof Error ? error : new Error(String(error));
        if (!Array.isArray(data)) {
          throw new InternalError(
            `claim_posting_slot_item returned a non-array payload for destination "${destinationId}" slot "${slot.id}"`
          );
        }
        // Malformed rows are filtered by the shared enqueue step,
        // exactly as the inline loop filtered them before.
        claimedRows.push(...data);
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

  const enqueued = await enqueueClaimedRows(claimedRows, 'facebook', deps.queues);
  result.claimed += enqueued.claimed;
  result.enqueuedFast += enqueued.enqueuedFast;
  result.enqueuedHeavy += enqueued.enqueuedHeavy;

  if (result.claimed > 0) {
    console.info(
      `[slot-claim] tick claimed=${result.claimed} enqueuedFast=${result.enqueuedFast} enqueuedHeavy=${result.enqueuedHeavy}`
    );
  }
  return result;
}
