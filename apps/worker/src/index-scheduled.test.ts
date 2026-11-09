/**
 * handleScheduled — slot-claim tick isolation + honest heartbeat.
 *
 * A tick-level slot-claim failure (e.g. the slot-list RPC errors)
 * must not fail the tick: the failure is captured and logged, the
 * tick still completes, and the slot simply retries next tick (a
 * slot whose window has passed by then is lost, exactly like a
 * publisher outage).
 *
 * It MUST fail the tick's heartbeat: the heartbeat still reports
 * the due-based claim counts, but with success:false and the
 * slot_claim_tick_failed skip reason, so last_success_at stays at
 * the last fully healthy tick and the health tier degrades instead
 * of reporting a broken pipeline healthy (P1-13).
 *
 * Plan-check C3: the downgrade-activation tick runs FIRST on the
 * every-minute tick and reads through `db.from`, so every test db
 * below provides a healthy `from` stub (empty scan) — without it
 * the tick would fail and steal the first-failure heartbeat slot
 * from the failure under test.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleScheduled } from './index.js';

function fakeQueue() {
  return {
    sent: [] as unknown[][],
    sendBatch: async (messages: Iterable<{ body: unknown }>) => {
      return undefined;
    },
  };
}

/**
 * Minimal `from()` stub for handleScheduled tests: every query
 * resolves to an empty store, heartbeat upserts are recorded, and
 * every table touched is logged (so a test can prove the
 * downgrade-activation scan ran — or did not). `failPaymentsScan`
 * makes ONLY the subscription_payments scan error, the way a
 * broken tick scan would.
 */
function stubFrom(
  upsertRows: Record<string, unknown>[],
  fromTables: string[],
  opts?: { failPaymentsScan?: boolean }
) {
  const emptyChain: any = {
    select: () => emptyChain,
    eq: () => emptyChain,
    neq: () => emptyChain,
    is: () => emptyChain,
    lte: () => emptyChain,
    lt: () => emptyChain,
    gt: () => emptyChain,
    gte: () => emptyChain,
    order: () => emptyChain,
    limit: () => emptyChain,
    range: () => emptyChain,
    update: () => emptyChain,
    insert: () => emptyChain,
    delete: () => emptyChain,
    in: () => emptyChain,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    upsert: (row: Record<string, unknown>) => {
      upsertRows.push(row);
      return Promise.resolve({ error: null });
    },
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: [], error: null });
    },
  };
  const failingChain: any = {
    select: () => failingChain,
    eq: () => failingChain,
    neq: () => failingChain,
    is: () => failingChain,
    lte: () => failingChain,
    lt: () => failingChain,
    gt: () => failingChain,
    gte: () => failingChain,
    order: () => failingChain,
    limit: () => failingChain,
    range: () => failingChain,
    update: () => failingChain,
    insert: () => failingChain,
    delete: () => failingChain,
    in: () => failingChain,
    single: () => Promise.resolve({ data: null, error: new Error('scan boom') }),
    maybeSingle: () => Promise.resolve({ data: null, error: new Error('scan boom') }),
    upsert: () => Promise.resolve({ error: new Error('scan boom') }),
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: new Error('scan boom') });
    },
  };
  return (table: string) => {
    fromTables.push(table);
    return opts?.failPaymentsScan && table === 'subscription_payments'
      ? failingChain
      : emptyChain;
  };
}

describe('handleScheduled slot-claim isolation', () => {
  it('survives a failing slot-claim tick, still writes the heartbeat, but reports the tick failed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([]);
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'claim_due_queue_items') {
        return { data: [], error: null };
      }
      // The publish-now tick runs before the slot tick and must stay
      // healthy here, or its failure would claim the first-failure
      // heartbeat slot the slot failure is meant to occupy. The
      // downgrade tick (C3, first of all) is healthy too: its scan
      // reads through the `from` stub below and finds nothing due.
      if (fn === 'claim_publish_now_items') {
        return { data: [], error: null };
      }
      if (fn === 'list_active_facebook_posting_slots') {
        return { data: null, error: new Error('list boom') };
      }
      return { data: null, error: null };
    });
    const upsertRows: Record<string, unknown>[] = [];
    const fromTables: string[] = [];

    await expect(
      handleScheduled(
        { cron: '* * * * *', scheduledTime: Date.now() } as never,
        { TOKEN_ENCRYPTION_KEY: 'test-key' } as never,
        undefined,
        {
          db: { rpc, query, from: stubFrom(upsertRows, fromTables) } as never,
          queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
          now: new Date('2026-10-27T08:03:00.000Z'),
          waitUntil: () => {},
        }
      )
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('slot claim tick failed'),
      expect.anything()
    );
    // The downgrade tick ran (its scan touched subscription_payments)
    // and stayed healthy, so the slot failure owns the first-failure
    // heartbeat slot.
    expect(fromTables).toContain('subscription_payments');
    // The heartbeat is still written with the due-based claim counts
    // (0 here) — but as a FAILURE: last_success_at stays unset so
    // the health tier stops reporting this pipeline healthy.
    const heartbeatRow = upsertRows[upsertRows.length - 1];
    expect(heartbeatRow).toBeDefined();
    expect(heartbeatRow!.last_success_at).toBeUndefined();
    expect(heartbeatRow!.last_skip_reason).toBe('slot_claim_tick_failed');
    errSpy.mockRestore();
  });

  it('reports success when every sub-tick is healthy', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([]);
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'claim_due_queue_items') {
        return { data: [], error: null };
      }
      // Array payloads, not null: the mirror claim throws on a
      // non-array payload, and the slot claim needs an array too.
      return { data: [], error: null };
    });
    // ADU tick talks Supabase (.from chains), not rpc: an empty
    // store makes every ADU stage a no-op success. The stub also
    // records heartbeat upserts: with `from` present, the heartbeat
    // takes the upsert branch, not the raw-SQL query branch.
    const upsertRows: Record<string, unknown>[] = [];
    const fromTables: string[] = [];

    await expect(
      handleScheduled(
        { cron: '* * * * *', scheduledTime: Date.now() } as never,
        { TOKEN_ENCRYPTION_KEY: 'test-key' } as never,
        undefined,
        {
          db: { rpc, query, from: stubFrom(upsertRows, fromTables) } as never,
          queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
          now: new Date('2026-10-27T08:03:00.000Z'),
          waitUntil: () => {},
        }
      )
    ).resolves.toBeUndefined();

    const heartbeatRow = upsertRows[upsertRows.length - 1];
    expect(heartbeatRow).toBeDefined();
    expect(heartbeatRow!.last_success_at).not.toBeNull();
    expect(heartbeatRow!.last_skip_reason).toBeNull();
    errSpy.mockRestore();
  });
});

describe('handleScheduled downgrade-activation tick wiring (C3)', () => {
  const NOW = new Date('2026-10-27T08:03:00.000Z');

  function minuteDb(opts?: { failPaymentsScan?: boolean }) {
    const upsertRows: Record<string, unknown>[] = [];
    const fromTables: string[] = [];
    const query = vi.fn().mockResolvedValue([]);
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'claim_due_queue_items') {
        return { data: [], error: null };
      }
      return { data: [], error: null };
    });
    return {
      db: {
        rpc,
        query,
        from: stubFrom(upsertRows, fromTables, opts),
      } as never,
      upsertRows,
      fromTables,
    };
  }

  async function runCron(cron: string, db: unknown) {
    await handleScheduled(
      { cron, scheduledTime: Date.now() } as never,
      { TOKEN_ENCRYPTION_KEY: 'test-key' } as never,
      undefined,
      {
        db: db as never,
        queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
        now: NOW,
        waitUntil: () => {},
      }
    );
  }

  it('minute cron runs the downgrade tick', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, upsertRows, fromTables } = minuteDb();
    await expect(runCron('* * * * *', db)).resolves.toBeUndefined();
    expect(fromTables).toContain('subscription_payments');
    const heartbeatRow = upsertRows[upsertRows.length - 1];
    expect(heartbeatRow).toBeDefined();
    expect(heartbeatRow!.last_success_at).not.toBeNull();
    expect(heartbeatRow!.last_skip_reason).toBeNull();
    errSpy.mockRestore();
  });

  it.each(['*/15 * * * *', '0 2 * * *', '*/10 * * * *'])(
    'cron %s does not run the downgrade tick',
    async (cron) => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { db, fromTables } = minuteDb();
      await expect(runCron(cron, db)).resolves.toBeUndefined();
      expect(fromTables).not.toContain('subscription_payments');
      errSpy.mockRestore();
    }
  );

  it('scan failure is captured, does not throw, and fails the heartbeat', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, upsertRows } = minuteDb({ failPaymentsScan: true });
    await expect(runCron('* * * * *', db)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('downgrade activation tick failed'),
      expect.anything()
    );
    const heartbeatRow = upsertRows[upsertRows.length - 1];
    expect(heartbeatRow).toBeDefined();
    expect(heartbeatRow!.last_success_at).toBeUndefined();
    expect(heartbeatRow!.last_skip_reason).toBe('downgrade_tick_failed');
    errSpy.mockRestore();
  });
});
