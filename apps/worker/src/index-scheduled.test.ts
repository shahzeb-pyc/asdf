/**
 * handleScheduled — slot-claim tick isolation.
 *
 * A tick-level slot-claim failure (e.g. the slot-list RPC errors)
 * must not fail the tick or its heartbeat: the failure is captured
 * and logged, the heartbeat still reports the due-based claim
 * counts, and the slot simply retries next tick (a slot whose window
 * has passed by then is lost, exactly like a publisher outage).
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
  it('survives a failing slot-claim tick and still writes the heartbeat', async () => {
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
    // The heartbeat still reports the due-based claim counts (0 here).
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO worker_heartbeats'),
      expect.anything()
    );
    errSpy.mockRestore();
  });
});
