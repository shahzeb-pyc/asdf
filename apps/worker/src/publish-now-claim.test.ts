/**
 * Publish-now immediate claim tick (20261102140000).
 *
 * A marked row (publish_now_requested_at set) must be claimed and
 * enqueued on this tick — without waiting for any posting slot — and
 * a tick failure must never silently re-queue the row as a normal
 * item (the row stays marked; the slot claim excludes it).
 */
import { describe, expect, it, vi } from 'vitest';
import { runPublishNowClaimTick } from './publish-now-claim.js';

interface FakeQueue {
  sent: unknown[][];
  sendBatch: (messages: Iterable<{ body: unknown }>) => Promise<unknown>;
}

function fakeQueue(): FakeQueue {
  const sent: unknown[][] = [];
  return {
    sent,
    sendBatch: async (messages) => {
      sent.push([...messages].map((m) => m.body));
      return undefined;
    },
  };
}

const TEXT_ID = '11111111-1111-4111-a111-111111111111';
const REEL_ID = '22222222-2222-4222-a222-222222222222';

describe('runPublishNowClaimTick', () => {
  it('claims marked rows and enqueues them to the lane of each format', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const claimCalls: Array<Record<string, unknown>> = [];
    const db = {
      rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'claim_publish_now_items') {
          claimCalls.push(args ?? {});
          return {
            data: [
              { id: TEXT_ID, kind: 'text', platform_format: 'text', destination_id: 'dest-1' },
              { id: REEL_ID, kind: 'video', platform_format: 'reel', destination_id: 'dest-1' },
            ],
            error: null,
          };
        }
        return { data: null, error: new Error(`unexpected rpc ${fn}`) };
      }),
    };

    const result = await runPublishNowClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
    });

    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]!.p_limit).toBe(100);
    expect(result.claimed).toBe(2);
    expect(result.enqueuedFast).toBe(1);
    expect(result.enqueuedHeavy).toBe(1);
    expect(fast.sent.flat()).toEqual([
      expect.objectContaining({ itemId: TEXT_ID, platform: 'facebook' }),
    ]);
    expect(heavy.sent.flat()).toEqual([
      expect.objectContaining({ itemId: REEL_ID, platform: 'facebook' }),
    ]);
  });

  it('throws on RPC error so the tick fails its heartbeat instead of silently skipping', async () => {
    const db = {
      rpc: vi.fn(async () => ({ data: null, error: new Error('db down') })),
    };
    await expect(
      runPublishNowClaimTick({
        db: db as never,
        queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
      })
    ).rejects.toThrow('db down');
  });

  it('skips malformed rows and still enqueues the valid ones', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const db = {
      rpc: vi.fn(async () => ({
        data: [
          null,
          { id: 'not-a-uuid', kind: 'text', platform_format: 'text', destination_id: 'dest-1' },
          { id: TEXT_ID, kind: 42, platform_format: 'text', destination_id: 'dest-1' },
          { id: TEXT_ID, kind: 'text', platform_format: 'text', destination_id: 'dest-1' },
        ],
        error: null,
      })),
    };

    const result = await runPublishNowClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
    });

    expect(result.claimed).toBe(1);
    expect(result.enqueuedFast).toBe(1);
    expect(result.enqueuedHeavy).toBe(0);
  });

  it('throws when the lane queue binding is missing', async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: [{ id: TEXT_ID, kind: 'text', platform_format: 'text', destination_id: 'dest-1' }],
        error: null,
      })),
    };
    await expect(
      runPublishNowClaimTick({
        db: db as never,
        queues: {},
      })
    ).rejects.toThrow('not configured');
  });

  it('passes a caller-provided limit through to the RPC', async () => {
    const claimCalls: Array<Record<string, unknown>> = [];
    const db = {
      rpc: vi.fn(async (_fn: string, args?: Record<string, unknown>) => {
        claimCalls.push(args ?? {});
        return { data: [], error: null };
      }),
    };
    await runPublishNowClaimTick({
      db: db as never,
      queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
      limit: 25,
    });
    expect(claimCalls[0]!.p_limit).toBe(25);
  });
});
