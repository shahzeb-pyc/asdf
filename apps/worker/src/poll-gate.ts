/**
 * Poll gate (spec 212) — back off the per-minute tick while idle.
 *
 * The Cloudflare cron fires every minute and its schedule cannot change
 * at runtime, so the gate decides inside `handleScheduled` whether this
 * invocation runs the full sub-tick block (claim, downgrade,
 * publish-now, slot, mirror-job, ADU) or skips it. State is durable in
 * the `worker_poll_state` singleton row: Cloudflare may route
 * consecutive crons to different isolates, so module-level state could
 * never enforce the cap.
 *
 * Interval progression while full ticks keep finding nothing:
 * 60s → 120s → 240s (HARD CAP). The cap is 240s, NOT the 300s the
 * brief proposed: the slot window is 5 minutes (`SLOT_CLAIM_WINDOW_MINUTES`
 * in slot-claim.ts; `findDueSlots` treats a slot as due only while
 * `0 <= age <= 5 min`), so a 5-minute gap would lose a slot whose
 * occurrence falls just after a full tick. At 240s the worst-case slot
 * age at pickup is 4 minutes + cron jitter — inside the window with
 * ~1 minute of margin. The interval is STORED in the state row
 * (`current_interval_seconds`), doubled after each idle full tick and
 * reset to 60s on activity: deriving it from idle time does not work,
 * because the interval would grow as the elapsed time grows and the
 * 60s/120s steps would never fire (every idle gap would be the cap
 * from the start).
 *
 * Fail-open, never fail-silent: no state row, an unreadable state row,
 * or an unwritable state row all mean "run the full tick" — loudly
 * logged. The gate can only ever cause MORE full ticks than the
 * schedule, never fewer.
 *
 * This module never imports the claimer (spec 211 owns claimer.ts):
 * the recovery-minute force arrives as a boolean from the caller,
 * which already imports `isRecoveryTick` from the claimer.
 */

// Base interval: per-minute polling while active or recently active.
export const POLL_BASE_INTERVAL_SECONDS = 60;

// HARD CAP on the idle interval (seconds). Must stay strictly below
// the 5-minute slot window — see the module doc above.
export const POLL_IDLE_CAP_SECONDS = 240;

export const POLL_STATE_TABLE = 'worker_poll_state';
export const POLL_STATE_ID = 1;

export type PollDecisionReason =
  | 'no_state'
  | 'recovery_tick'
  | 'interval_elapsed'
  | 'idle_backoff';

export interface PollGateDecision {
  run: boolean;
  reason: PollDecisionReason;
  /** Seconds until the next full tick is due (0 when this tick runs). */
  nextFullTickInSeconds: number;
  /** Last activity seen, from state (null when no state row exists). */
  lastActivityAt: Date | null;
  /** Last full tick, from state (null when no state row exists). */
  lastFullTickAt: Date | null;
  /** Current backoff interval, from state (null when no state row). */
  currentIntervalSeconds: number | null;
}

/**
 * Interval for the NEXT full tick after one that ran at the current
 * interval: work resets it to per-minute; an idle tick doubles it up
 * to the hard cap. Pure.
 */
export function nextPollIntervalSeconds(
  currentIntervalSeconds: number,
  hadActivity: boolean
): number {
  if (hadActivity) return POLL_BASE_INTERVAL_SECONDS;
  return Math.min(currentIntervalSeconds * 2, POLL_IDLE_CAP_SECONDS);
}

/**
 * Pure run/skip decision. `isRecoveryMinute` is `isRecoveryTick(now)`
 * from the claimer, passed in by the caller: recovery minutes always
 * run a full tick so the stuck-item recovery keeps its 5-minute
 * cadence and can never phase-lock away from the backoff.
 */
export function shouldRunFullTick(params: {
  now: Date;
  lastFullTickAt: Date | null;
  currentIntervalSeconds: number | null;
  isRecoveryMinute: boolean;
}): { run: boolean; reason: PollDecisionReason; nextFullTickInSeconds: number } {
  const { now, lastFullTickAt, currentIntervalSeconds, isRecoveryMinute } =
    params;
  if (lastFullTickAt === null || currentIntervalSeconds === null) {
    return { run: true, reason: 'no_state', nextFullTickInSeconds: 0 };
  }
  if (isRecoveryMinute) {
    return { run: true, reason: 'recovery_tick', nextFullTickInSeconds: 0 };
  }
  const intervalSeconds = Math.min(
    Math.max(currentIntervalSeconds, POLL_BASE_INTERVAL_SECONDS),
    POLL_IDLE_CAP_SECONDS
  );
  const elapsedMs = now.getTime() - lastFullTickAt.getTime();
  if (elapsedMs >= intervalSeconds * 1000) {
    return { run: true, reason: 'interval_elapsed', nextFullTickInSeconds: 0 };
  }
  return {
    run: false,
    reason: 'idle_backoff',
    nextFullTickInSeconds: Math.ceil(
      (intervalSeconds * 1000 - elapsedMs) / 1000
    ),
  };
}

/** Minimal PostgREST shape the gate needs (mirrors heartbeat.ts). */
export interface PollStateDb {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown
      ) => {
        maybeSingle: () => Promise<{
          data: unknown;
          error: unknown;
        }>;
      };
    };
    upsert: (
      row: Record<string, unknown>,
      options: { onConflict: string }
    ) => Promise<{ error: unknown }>;
  };
}

export interface PollState {
  lastFullTickAt: Date;
  lastActivityAt: Date;
  currentIntervalSeconds: number;
}

function parsePollStateRow(data: unknown): PollState | null {
  if (typeof data !== 'object' || data === null) return null;
  const row = data as Record<string, unknown>;
  const lastFullTickAt = row['last_full_tick_at'];
  const lastActivityAt = row['last_activity_at'];
  const currentIntervalSeconds = row['current_interval_seconds'];
  if (typeof lastFullTickAt !== 'string' || typeof lastActivityAt !== 'string') {
    return null;
  }
  if (
    typeof currentIntervalSeconds !== 'number' ||
    !Number.isFinite(currentIntervalSeconds)
  ) {
    return null;
  }
  const full = new Date(lastFullTickAt);
  const activity = new Date(lastActivityAt);
  if (Number.isNaN(full.getTime()) || Number.isNaN(activity.getTime())) {
    return null;
  }
  return {
    lastFullTickAt: full,
    lastActivityAt: activity,
    // Clamped defensively; the column CHECK bounds it to 60–240.
    currentIntervalSeconds: Math.min(
      Math.max(currentIntervalSeconds, POLL_BASE_INTERVAL_SECONDS),
      POLL_IDLE_CAP_SECONDS
    ),
  };
}

/**
 * Reads the singleton state row. Returns null when there is no row yet,
 * the row is malformed, or the read fails for any reason (including a
 * migration that has not landed yet) — the caller treats null as
 * "run the full tick" and logs the cause loudly.
 */
export async function readPollState(
  db: PollStateDb | null | undefined
): Promise<PollState | null> {
  if (!db || typeof db.from !== 'function') return null;
  try {
    const { data, error } = await db
      .from(POLL_STATE_TABLE)
      .select('last_full_tick_at, last_activity_at, current_interval_seconds')
      .eq('id', POLL_STATE_ID)
      .maybeSingle();
    if (error) {
      console.error('[poll-gate] state read failed; running full tick:', error);
      return null;
    }
    const state = parsePollStateRow(data);
    if (!state) {
      console.warn('[poll-gate] no usable state row; running full tick');
    }
    return state;
  } catch (err) {
    console.error('[poll-gate] state read threw; running full tick:', err);
    return null;
  }
}

/**
 * Decides run-vs-skip for one per-minute invocation. Never throws and
 * never returns "skip" unless a usable state row says the interval has
 * not elapsed: any read problem is fail-open to a full tick.
 */
export async function decidePollTick(
  db: PollStateDb | null | undefined,
  now: Date,
  isRecoveryMinute: boolean
): Promise<PollGateDecision> {
  const state = await readPollState(db);
  if (state === null) {
    return {
      run: true,
      reason: 'no_state',
      nextFullTickInSeconds: 0,
      lastActivityAt: null,
      lastFullTickAt: null,
      currentIntervalSeconds: null,
    };
  }
  const decision = shouldRunFullTick({
    now,
    lastFullTickAt: state.lastFullTickAt,
    currentIntervalSeconds: state.currentIntervalSeconds,
    isRecoveryMinute,
  });
  return {
    ...decision,
    lastActivityAt: state.lastActivityAt,
    lastFullTickAt: state.lastFullTickAt,
    currentIntervalSeconds: state.currentIntervalSeconds,
  };
}

/** Sub-tick results, as the shapes `handleScheduled` already holds. */
export interface TickActivityInput {
  claim: { claimed: number; recovered: number };
  downgrade: { activated: number; failed: number };
  publishNow: { claimed: number };
  slot: { claimed: number };
  mirrorJob: { claimed: number; completed: number };
  adu: {
    intakeJobsCreated: number;
    published: number;
    retried: number;
    failed: number;
  };
}

/**
 * True when any sub-tick did work. A failed sub-tick counts as activity
 * too (downgrade `failed`, ADU `failed`): something is due and retrying
 * it next minute, not in 4, is the safe direction.
 */
export function summariseTickActivity(results: TickActivityInput): boolean {
  return (
    results.claim.claimed > 0 ||
    results.claim.recovered > 0 ||
    results.downgrade.activated > 0 ||
    results.downgrade.failed > 0 ||
    results.publishNow.claimed > 0 ||
    results.slot.claimed > 0 ||
    results.mirrorJob.claimed > 0 ||
    results.mirrorJob.completed > 0 ||
    results.adu.intakeJobsCreated > 0 ||
    results.adu.published > 0 ||
    results.adu.retried > 0 ||
    results.adu.failed > 0
  );
}

/**
 * Records a full tick in the state row: `last_full_tick_at` advances
 * every full tick; `last_activity_at` advances only when the tick found
 * work, so an idle stretch keeps stretching the interval; the interval
 * itself resets to 60s on work and doubles (to the cap) on an idle
 * tick. Never throws: a failed write is logged loudly and the next
 * tick re-derives from the old state (more full ticks, never fewer).
 */
export async function markPollFullTick(
  db: PollStateDb | null | undefined,
  params: {
    now: Date;
    hadActivity: boolean;
    lastActivityAt: Date | null;
    currentIntervalSeconds: number | null;
  }
): Promise<boolean> {
  if (!db || typeof db.from !== 'function') return false;
  const nowIso = params.now.toISOString();
  const row: Record<string, unknown> = {
    id: POLL_STATE_ID,
    last_full_tick_at: nowIso,
    last_activity_at: (
      params.hadActivity
        ? params.now
        : (params.lastActivityAt ?? params.now)
    ).toISOString(),
    current_interval_seconds: nextPollIntervalSeconds(
      params.currentIntervalSeconds ?? POLL_BASE_INTERVAL_SECONDS,
      params.hadActivity
    ),
    updated_at: nowIso,
  };
  try {
    const { error } = await db
      .from(POLL_STATE_TABLE)
      .upsert(row, { onConflict: 'id' });
    if (error) {
      console.error('[poll-gate] state write failed; next tick re-derives:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[poll-gate] state write threw; next tick re-derives:', err);
    return false;
  }
}
