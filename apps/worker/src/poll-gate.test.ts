/**
 * Spec 212 — poll gate unit tests.
 *
 * The gate is the only thing standing between an idle system and a
 * stalled one, so these tests prove the numbers, not the shape:
 * the interval progression, the hard cap, the recovery-minute force,
 * and — the property that matters — that a full tick never goes more
 * than POLL_IDLE_CAP_SECONDS without running, so no slot can age past
 * its 5-minute window.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  POLL_IDLE_CAP_SECONDS,
  decidePollTick,
  markPollFullTick,
  nextPollIntervalSeconds,
  shouldRunFullTick,
  summariseTickActivity,
  type PollStateDb,
  type TickActivityInput,
} from './poll-gate.js';

const MIN = 60_000;
const T0 = new Date('2026-11-20T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function zeroActivity(): TickActivityInput {
  return {
    claim: { claimed: 0, recovered: 0 },
    downgrade: { activated: 0, failed: 0 },
    publishNow: { claimed: 0 },
    slot: { claimed: 0 },
    mirrorJob: { claimed: 0, completed: 0 },
    adu: { intakeJobsCreated: 0, published: 0, retried: 0, failed: 0 },
  };
}

describe('nextPollIntervalSeconds', () => {
  it('resets to 60s on activity', () => {
    expect(nextPollIntervalSeconds(240, true)).toBe(60);
    expect(nextPollIntervalSeconds(60, true)).toBe(60);
  });

  it('doubles on an idle tick up to the 240s cap', () => {
    expect(nextPollIntervalSeconds(60, false)).toBe(120);
    expect(nextPollIntervalSeconds(120, false)).toBe(240);
    expect(nextPollIntervalSeconds(240, false)).toBe(240);
  });

  it('the cap is strictly below the 5-minute slot window', () => {
    expect(POLL_IDLE_CAP_SECONDS).toBeLessThan(300);
  });
});

describe('shouldRunFullTick', () => {
  it('runs when there is no state yet', () => {
    const d = shouldRunFullTick({
      now: at(0),
      lastFullTickAt: null,
      currentIntervalSeconds: null,
      isRecoveryMinute: false,
    });
    expect(d).toEqual({ run: true, reason: 'no_state', nextFullTickInSeconds: 0 });
  });

  it('skips inside the interval and reports when the next full tick is due', () => {
    const d = shouldRunFullTick({
      now: at(30_000),
      lastFullTickAt: at(0),
      currentIntervalSeconds: 60,
      isRecoveryMinute: false,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe('idle_backoff');
    expect(d.nextFullTickInSeconds).toBe(30);
  });

  it('runs once the interval has elapsed', () => {
    const d = shouldRunFullTick({
      now: at(60_000),
      lastFullTickAt: at(0),
      currentIntervalSeconds: 60,
      isRecoveryMinute: false,
    });
    expect(d.run).toBe(true);
    expect(d.reason).toBe('interval_elapsed');
  });

  it('forces a full tick on a recovery minute even inside the interval', () => {
    const d = shouldRunFullTick({
      now: at(30_000),
      lastFullTickAt: at(0),
      currentIntervalSeconds: 60,
      isRecoveryMinute: true,
    });
    expect(d).toEqual({ run: true, reason: 'recovery_tick', nextFullTickInSeconds: 0 });
  });
});

describe('idle simulation: gaps between full ticks', () => {
  /**
   * Drives the gate minute by minute from a full tick at T0 that found
   * work (interval 60s), with every later full tick finding nothing,
   * so the interval doubles 60 → 120 → 240 and then caps. Recovery
   * minutes are excluded here to test the pure interval path; the
   * recovery force only ever ADDS full ticks.
   */
  function simulateIdleFullTicks(untilMs: number): Date[] {
    let lastFull = T0;
    let interval = 60;
    const fullTicks: Date[] = [T0];
    for (let t = MIN; t <= untilMs; t += MIN) {
      const now = at(t);
      if (
        shouldRunFullTick({
          now,
          lastFullTickAt: lastFull,
          currentIntervalSeconds: interval,
          isRecoveryMinute: false,
        }).run
      ) {
        fullTicks.push(now);
        lastFull = now;
        interval = nextPollIntervalSeconds(interval, false);
      }
    }
    return fullTicks;
  }

  it('graduates 60s → 120s → 240s and then holds the cap', () => {
    const fullTicks = simulateIdleFullTicks(30 * MIN);
    // Full ticks at 0, 1, 3, 7, 11, 15, 19, 23, 27 minutes: the first
    // gap is the 60s base, the second the doubled 120s, then the cap.
    expect(fullTicks.map((d) => (d.getTime() - T0.getTime()) / MIN)).toEqual([
      0, 1, 3, 7, 11, 15, 19, 23, 27,
    ]);
    const gaps = fullTicks
      .slice(1)
      .map((d, i) => d.getTime() - fullTicks[i]!.getTime());
    expect(Math.max(...gaps)).toBeLessThanOrEqual(POLL_IDLE_CAP_SECONDS * 1000);
  });

  it('picks up an item due at any idle moment within the cap', () => {
    // Simulate one minute past the checked window so every due time
    // has a later full tick to be picked up by.
    const fullTicks = simulateIdleFullTicks(31 * MIN);
    let worstPickupMs = 0;
    for (let s = 0; s <= 30 * MIN; s += 1000) {
      const due = T0.getTime() + s;
      const pickup = fullTicks.find((d) => d.getTime() >= due);
      expect(pickup).toBeDefined();
      worstPickupMs = Math.max(worstPickupMs, pickup!.getTime() - due);
    }
    expect(worstPickupMs).toBeLessThanOrEqual(POLL_IDLE_CAP_SECONDS * 1000);
    // And the slot bound: the worst pickup delay is inside the
    // 5-minute slot window, so no slot is lost to the backoff.
    expect(worstPickupMs).toBeLessThan(300 * 1000);
  });
});

describe('decidePollTick (state-backed)', () => {
  function stubDb(state: unknown, error: unknown = null): PollStateDb {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state, error }),
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    };
  }

  const freshState = {
    last_full_tick_at: T0.toISOString(),
    last_activity_at: T0.toISOString(),
    current_interval_seconds: 60,
  };

  it('runs with reason no_state when there is no state row', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = await decidePollTick(stubDb(null), at(0), false);
      expect(d.run).toBe(true);
      expect(d.reason).toBe('no_state');
      expect(d.lastActivityAt).toBeNull();
      expect(d.currentIntervalSeconds).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('runs with reason no_state when the state read fails (fail-open)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const d = await decidePollTick(
        stubDb(null, new Error('PGRST205 table not found')),
        at(0),
        false
      );
      expect(d.run).toBe(true);
      expect(d.reason).toBe('no_state');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips when the state says the interval has not elapsed', async () => {
    const d = await decidePollTick(stubDb(freshState), at(30_000), false);
    expect(d.run).toBe(false);
    expect(d.reason).toBe('idle_backoff');
    expect(d.nextFullTickInSeconds).toBe(30);
    expect(d.lastActivityAt).toEqual(T0);
    expect(d.currentIntervalSeconds).toBe(60);
  });
});

describe('markPollFullTick', () => {
  function recordingDb(upserted: Record<string, unknown>[]): PollStateDb {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        upsert: async (row) => {
          upserted.push(row);
          return { error: null };
        },
      }),
    };
  }

  it('advances last_activity_at and resets the interval on work', async () => {
    const upserted: Record<string, unknown>[] = [];
    await markPollFullTick(recordingDb(upserted), {
      now: at(60_000),
      hadActivity: true,
      lastActivityAt: at(0),
      currentIntervalSeconds: 240,
    });
    expect(upserted[0]!['last_full_tick_at']).toBe(at(60_000).toISOString());
    expect(upserted[0]!['last_activity_at']).toBe(at(60_000).toISOString());
    expect(upserted[0]!['current_interval_seconds']).toBe(60);
  });

  it('preserves last_activity_at and doubles the interval on an idle tick', async () => {
    const upserted: Record<string, unknown>[] = [];
    await markPollFullTick(recordingDb(upserted), {
      now: at(120_000),
      hadActivity: false,
      lastActivityAt: at(0),
      currentIntervalSeconds: 60,
    });
    expect(upserted[0]!['last_full_tick_at']).toBe(at(120_000).toISOString());
    // Idle tick preserves the old activity time, so the interval keeps growing.
    expect(upserted[0]!['last_activity_at']).toBe(at(0).toISOString());
    expect(upserted[0]!['current_interval_seconds']).toBe(120);
  });

  it('never throws when the write fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db: PollStateDb = {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          upsert: async () => ({ error: new Error('write boom') }),
        }),
      };
      await expect(
        markPollFullTick(db, {
          now: at(0),
          hadActivity: false,
          lastActivityAt: null,
          currentIntervalSeconds: null,
        })
      ).resolves.toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('summariseTickActivity', () => {
  it('is false when every sub-tick found nothing', () => {
    expect(summariseTickActivity(zeroActivity())).toBe(false);
  });

  it.each([
    ['claim.claimed', (a: TickActivityInput) => { a.claim.claimed = 1; }],
    ['claim.recovered', (a: TickActivityInput) => { a.claim.recovered = 1; }],
    ['downgrade.activated', (a: TickActivityInput) => { a.downgrade.activated = 1; }],
    ['downgrade.failed', (a: TickActivityInput) => { a.downgrade.failed = 1; }],
    ['publishNow.claimed', (a: TickActivityInput) => { a.publishNow.claimed = 1; }],
    ['slot.claimed', (a: TickActivityInput) => { a.slot.claimed = 1; }],
    ['mirrorJob.claimed', (a: TickActivityInput) => { a.mirrorJob.claimed = 1; }],
    ['mirrorJob.completed', (a: TickActivityInput) => { a.mirrorJob.completed = 1; }],
    ['adu.intakeJobsCreated', (a: TickActivityInput) => { a.adu.intakeJobsCreated = 1; }],
    ['adu.published', (a: TickActivityInput) => { a.adu.published = 1; }],
    ['adu.retried', (a: TickActivityInput) => { a.adu.retried = 1; }],
    ['adu.failed', (a: TickActivityInput) => { a.adu.failed = 1; }],
  ])('is true when %s is non-zero', (_name, mutate) => {
    const activity = zeroActivity();
    mutate(activity);
    expect(summariseTickActivity(activity)).toBe(true);
  });
});
