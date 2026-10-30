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

describe('handleScheduled slot-claim isolation', () => {
  it('survives a failing slot-claim tick, still writes the heartbeat, but reports the tick failed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi.fn().mockResolvedValue([]);
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'claim_due_queue_items') {
        return { data: [], error: null };
      }
      if (fn === 'list_active_facebook_posting_slots') {
        return { data: null, error: new Error('list boom') };
      }
      return { data: null, error: null };
    });

    await expect(
      handleScheduled(
        { cron: '* * * * *', scheduledTime: Date.now() } as never,
        { TOKEN_ENCRYPTION_KEY: 'test-key' } as never,
        undefined,
        {
          db: { rpc, query } as never,
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
    // The heartbeat is still written with the due-based claim counts
    // (0 here) — but as a FAILURE: last_success_at stays null so the
    // health tier stops reporting this pipeline healthy.
    const heartbeatCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_heartbeats')
    );
    expect(heartbeatCall).toBeDefined();
    // Params: [worker_name, now, last_success_at, last_claimed_count, last_skip_reason]
    expect(heartbeatCall![1][2]).toBeNull();
    expect(heartbeatCall![1][4]).toBe('slot_claim_tick_failed');
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
    const aduChain: any = {
      select: () => aduChain,
      eq: () => aduChain,
      lt: () => aduChain,
      gt: () => aduChain,
      order: () => aduChain,
      limit: () => aduChain,
      update: () => aduChain,
      insert: () => aduChain,
      delete: () => aduChain,
      in: () => aduChain,
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

    await expect(
      handleScheduled(
        { cron: '* * * * *', scheduledTime: Date.now() } as never,
        { TOKEN_ENCRYPTION_KEY: 'test-key' } as never,
        undefined,
        {
          db: { rpc, query, from: () => aduChain } as never,
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
