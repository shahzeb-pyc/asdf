import { describe, expect, it } from 'vitest';
import {
  CountikPacer,
  COUNTIK_FALLBACK_DELAY_MS,
  COUNTIK_MAX_FALLBACKS_PER_TICK,
  COUNTIK_429_BACKOFF_MS,
  type CountikPacingState,
} from './countik-pacing.js';

/** Manual clock + recording sleep: pacing is proven by the sleeps
 * recorded, not by waiting out real delays. The fake sleep advances
 * the clock, as a real sleep would. */
function manualPacer(shared: CountikPacingState = { blockedUntilMs: 0 }) {
  let nowMs = 0;
  const sleeps: number[] = [];
  const pacer = new CountikPacer(
    shared,
    () => nowMs,
    async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  );
  return {
    pacer,
    sleeps,
    advance(ms: number) {
      nowMs += ms;
    },
    get now() {
      return nowMs;
    },
  };
}

describe('CountikPacer', () => {
  it('lets the first call through immediately, with no sleep', async () => {
    const { pacer, sleeps } = manualPacer();
    expect(await pacer.acquire()).toEqual({ allowed: true });
    expect(sleeps).toEqual([]);
    expect(pacer.callsMade).toBe(1);
    expect(pacer.rateLimitedCount).toBe(0);
  });

  it('delays consecutive calls by the inter-call spacing', async () => {
    const { pacer, sleeps } = manualPacer();
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    expect(sleeps).toEqual([
      COUNTIK_FALLBACK_DELAY_MS,
      COUNTIK_FALLBACK_DELAY_MS,
    ]);
    expect(pacer.callsMade).toBe(3);
  });

  it('skips the delay once enough time has passed between calls', async () => {
    const { pacer, sleeps, advance } = manualPacer();
    await pacer.acquire();
    advance(COUNTIK_FALLBACK_DELAY_MS + 500);
    await pacer.acquire();
    expect(sleeps).toEqual([]);
    expect(pacer.callsMade).toBe(2);
  });

  it('caps the tick and refuses further calls without sleeping', async () => {
    const { pacer, sleeps } = manualPacer();
    const results = [];
    for (let i = 0; i < COUNTIK_MAX_FALLBACKS_PER_TICK + 2; i += 1) {
      results.push(await pacer.acquire());
    }
    expect(results.slice(0, COUNTIK_MAX_FALLBACKS_PER_TICK)).toEqual(
      Array.from({ length: COUNTIK_MAX_FALLBACKS_PER_TICK }, () => ({ allowed: true })),
    );
    expect(results.slice(COUNTIK_MAX_FALLBACKS_PER_TICK)).toEqual([
      { allowed: false, reason: 'cap' },
      { allowed: false, reason: 'cap' },
    ]);
    expect(pacer.callsMade).toBe(COUNTIK_MAX_FALLBACKS_PER_TICK);
    // The cap refuses, it never waits: 4 gaps between 5 calls.
    expect(sleeps).toHaveLength(COUNTIK_MAX_FALLBACKS_PER_TICK - 1);
  });

  it('blocks the rest of the tick after a 429 and arms the backoff', async () => {
    const shared: CountikPacingState = { blockedUntilMs: 0 };
    const { pacer, now } = manualPacer(shared);
    await pacer.acquire();
    pacer.noteRateLimited();
    expect(pacer.rateLimitedCount).toBe(1);
    expect(await pacer.acquire()).toEqual({ allowed: false, reason: 'rate_limited' });
    expect(pacer.callsMade).toBe(1);
    expect(shared.blockedUntilMs).toBe(now + COUNTIK_429_BACKOFF_MS);
  });

  it('makes the next tick wait out the remaining backoff, then allows the call', async () => {
    const shared: CountikPacingState = { blockedUntilMs: 0 };
    const first = manualPacer(shared);
    await first.pacer.acquire();
    first.pacer.noteRateLimited();
    // A new tick, 30 s later, sharing the same cross-tick state.
    const second = manualPacer(shared);
    second.advance(30_000);
    expect(await second.pacer.acquire()).toEqual({ allowed: true });
    expect(second.sleeps).toEqual([COUNTIK_429_BACKOFF_MS - 30_000]);
    expect(second.pacer.callsMade).toBe(1);
  });

  it('does not wait once the backoff has expired', async () => {
    const shared: CountikPacingState = { blockedUntilMs: 0 };
    const first = manualPacer(shared);
    await first.pacer.acquire();
    first.pacer.noteRateLimited();
    const second = manualPacer(shared);
    second.advance(COUNTIK_429_BACKOFF_MS + 1000);
    expect(await second.pacer.acquire()).toEqual({ allowed: true });
    expect(second.sleeps).toEqual([]);
  });

  it('does not carry the within-tick block into the next tick, only the backoff', async () => {
    const shared: CountikPacingState = { blockedUntilMs: 0 };
    const first = manualPacer(shared);
    await first.pacer.acquire();
    first.pacer.noteRateLimited();
    // Past the backoff, a fresh pacer is unblocked: the block is
    // per-tick, the backoff is the only cross-tick effect.
    const second = manualPacer(shared);
    second.advance(COUNTIK_429_BACKOFF_MS + 1000);
    expect(await second.pacer.acquire()).toEqual({ allowed: true });
    expect(second.pacer.rateLimitedCount).toBe(0);
  });
});
