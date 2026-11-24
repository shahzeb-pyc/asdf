/**
 * Spec 246 — worker DB fetch timeout.
 *
 * On 2026-11-24 Supabase's Data API hung on every table query for 2+
 * hours while direct Postgres stayed healthy, and the worker's Supabase
 * client had no fetch timeout — so each per-minute tick hung on its
 * first DB call and died silently. These tests prove, through the real
 * `initWorkerDb` client with a hung transport, that a hung call now
 * aborts within the timeout instead of hanging forever: the query
 * resolves with an abort error (postgrest-js never throws fetch
 * failures — it returns them as an error result), the poll gate fails
 * open, and the heartbeat / poll-state writes fail fast instead of
 * hanging the tick.
 *
 * The hung transport models a wedged API faithfully: the fetch never
 * resolves on its own, but it DOES reject when its abort signal fires —
 * exactly what a real hung server + client-side timeout looks like.
 * Without the fix (no timeout signal) the same tests never settle and
 * fail on their 60s vitest timeout instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_DB_FETCH_TIMEOUT_MS, initWorkerDb } from './index.js';
import { decidePollTick, markPollFullTick } from './poll-gate.js';
import { recordHeartbeat } from './heartbeat.js';

const observed = { calls: 0, sawSignal: false, sawAbort: false };

function hungFetch(): typeof fetch {
  return ((input: unknown, init?: { signal?: AbortSignal }) => {
    observed.calls += 1;
    const signal = init?.signal;
    if (signal) observed.sawSignal = true;
    return new Promise((_resolve, reject) => {
      if (!signal) return; // No abort possible: hangs forever, like the pre-fix client.
      if (signal.aborted) {
        observed.sawAbort = true;
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          observed.sawAbort = true;
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }) as typeof fetch;
}

const testEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-key',
} as never;

describe('worker DB fetch timeout (spec 246)', () => {
  beforeEach(() => {
    observed.calls = 0;
    observed.sawSignal = false;
    observed.sawAbort = false;
    vi.stubGlobal('fetch', hungFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the timeout is 15s', () => {
    expect(WORKER_DB_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it('a hung DB call aborts within the timeout instead of hanging', async () => {
    const db = initWorkerDb(testEnv);
    expect(db).not.toBeNull();
    const started = Date.now();
    // postgrest-js never throws fetch failures: it resolves them as an
    // error result. The abort is visible as success:false + an
    // AbortError with the "aborted" hint.
    const result = await db
      .from('worker_poll_state')
      .select('last_full_tick_at, last_activity_at, current_interval_seconds')
      .eq('id', 1)
      .maybeSingle();
    const elapsedMs = Date.now() - started;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(String(result.error?.message ?? '')).toMatch(/AbortError/);
    expect(String(result.error?.hint ?? '')).toMatch(/aborted/i);
    // The abort fires at the 15s timeout; 20s leaves margin for a
    // loaded runner while still proving the call did not hang.
    expect(elapsedMs).toBeLessThan(20_000);
    expect(observed.calls).toBeGreaterThanOrEqual(1);
    expect(observed.sawSignal).toBe(true);
    expect(observed.sawAbort).toBe(true);
  }, 60_000);

  it('the poll gate fails open when the state read times out', async () => {
    const db = initWorkerDb(testEnv);
    const started = Date.now();
    const decision = await decidePollTick(db, new Date(), false);
    const elapsedMs = Date.now() - started;
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe('no_state');
    expect(elapsedMs).toBeLessThan(20_000);
    expect(observed.sawAbort).toBe(true);
  }, 60_000);

  it('a heartbeat write fails fast and never throws when the API is wedged', async () => {
    const db = initWorkerDb(testEnv);
    const started = Date.now();
    const written = await recordHeartbeat(db, {
      success: false,
      skipReason: 'claim_error',
    });
    const elapsedMs = Date.now() - started;
    expect(written).toBe(false);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(observed.sawAbort).toBe(true);
  }, 60_000);

  it('a poll-state write fails fast and never throws when the API is wedged', async () => {
    const db = initWorkerDb(testEnv);
    const started = Date.now();
    const written = await markPollFullTick(db, {
      now: new Date(),
      hadActivity: false,
      lastActivityAt: null,
      currentIntervalSeconds: null,
    });
    const elapsedMs = Date.now() - started;
    expect(written).toBe(false);
    expect(elapsedMs).toBeLessThan(20_000);
    expect(observed.sawAbort).toBe(true);
  }, 60_000);
});
