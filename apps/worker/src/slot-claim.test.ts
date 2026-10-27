/**
 * Slot-claim tick (publisher-driven posting times).
 *
 * These tests fail on any stored-time claim model: a slot fires only
 * inside its claim window, one post per slot per day (a second claim
 * for the same slot+day enqueues nothing), a failing slot does not
 * abort the remaining slots, and missed slots are never caught up.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSlotClaimTick } from './slot-claim.js';

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

const NOW = new Date('2026-10-27T08:03:00.000Z');

const SLOT_ROWS = [
  {
    destination_id: 'dest-1',
    slot_id: 'slot-8am',
    time_of_day: '08:00:00',
    timezone: 'UTC',
    kind: ['reel'],
  },
  {
    destination_id: 'dest-1',
    slot_id: 'slot-12pm',
    time_of_day: '12:00:00',
    timezone: 'UTC',
    kind: ['text'],
  },
];

describe('runSlotClaimTick', () => {
  it('claims the due slot and enqueues to the lane of the claimed format', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const claimCalls: Array<Record<string, unknown>> = [];
    const db = {
      rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: SLOT_ROWS, error: null };
        }
        if (fn === 'claim_posting_slot_item') {
          claimCalls.push(args ?? {});
          // Only the 08:00 slot is due at 08:03; it claims a reel.
          // The id must be a UUID: the queue message schema rejects
          // anything else, exactly like production rows.
          return {
            data: [{ id: '11111111-1111-4111-a111-111111111111', kind: 'video', platform_format: 'reel', destination_id: 'dest-1' }],
            error: null,
          };
        }
        return { data: null, error: new Error(`unexpected rpc ${fn}`) };
      }),
    };

    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: NOW,
    });

    // One claim call, for the due slot only — the 12:00 slot is future.
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]!.p_slot_id).toBe('slot-8am');
    expect(claimCalls[0]!.p_claim_date).toBe('2026-10-27');
    expect(result.claimed).toBe(1);
    // A reel routes heavy (byte-streaming platform format).
    expect(heavy.sent.flat()).toHaveLength(1);
    expect(fast.sent.flat()).toHaveLength(0);
  });

  it('claims nothing for a missed slot (outside the window, no catch-up)', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const claimCalls: unknown[] = [];
    const db = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: SLOT_ROWS, error: null };
        }
        claimCalls.push(fn);
        return { data: [], error: null };
      }),
    };

    // 08:10 is past the 5-minute window for the 08:00 slot; the
    // 12:00 slot is still future. Nothing is due.
    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: new Date('2026-10-27T08:10:00.000Z'),
    });

    expect(claimCalls).toHaveLength(0);
    expect(result.claimed).toBe(0);
    expect(fast.sent.flat()).toHaveLength(0);
    expect(heavy.sent.flat()).toHaveLength(0);
  });

  it('enqueues nothing on a second claim for the same slot+day (claim row exists)', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const db = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: SLOT_ROWS, error: null };
        }
        // The RPC returns no row when the claim row already exists.
        return { data: [], error: null };
      }),
    };

    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: NOW,
    });

    expect(result.claimed).toBe(0);
    expect(fast.sent.flat()).toHaveLength(0);
    expect(heavy.sent.flat()).toHaveLength(0);
  });

  it('skips malformed slot rows and still claims the valid due slot', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const rows = [
      // destination_id must be a string; this row is skipped.
      {
        destination_id: 42,
        slot_id: 'slot-bad',
        time_of_day: '08:00:00',
        timezone: 'UTC',
        kind: ['text'],
      },
      {
        destination_id: 'dest-1',
        slot_id: 'slot-8am',
        time_of_day: '08:00:00',
        timezone: 'UTC',
        kind: ['text'],
      },
    ];
    const db = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: rows, error: null };
        }
        return {
          data: [{ id: '33333333-3333-4333-a333-333333333333', kind: 'text', platform_format: 'text', destination_id: 'dest-1' }],
          error: null,
        };
      }),
    };

    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: NOW,
    });

    expect(result.claimed).toBe(1);
    expect(fast.sent.flat()).toHaveLength(1);
  });

  it('throws when the slot-list RPC errors', async () => {
    const db = {
      rpc: vi.fn(async () => ({ data: null, error: new Error('list boom') })),
    };

    await expect(
      runSlotClaimTick({
        db: db as never,
        queues: { fast: fakeQueue() as never, heavy: fakeQueue() as never },
        now: NOW,
      }),
    ).rejects.toThrow('list boom');
  });

  it('isolates a slot whose claim RPC returns a non-array payload', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const db = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: SLOT_ROWS, error: null };
        }
        return { data: { not: 'an array' }, error: null };
      }),
    };

    // The non-array throw is caught by per-slot isolation: the tick
    // resolves, claims nothing, and enqueues nothing.
    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: NOW,
    });

    expect(result.claimed).toBe(0);
    expect(fast.sent.flat()).toHaveLength(0);
    expect(heavy.sent.flat()).toHaveLength(0);
  });

  it('throws when the claimed lane has no queue binding', async () => {
    const db = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: SLOT_ROWS, error: null };
        }
        return {
          data: [{ id: '44444444-4444-4444-a444-444444444444', kind: 'text', platform_format: 'text', destination_id: 'dest-1' }],
          error: null,
        };
      }),
    };

    // Text routes to the fast lane, which is deliberately unbound.
    await expect(
      runSlotClaimTick({
        db: db as never,
        queues: { fast: undefined as never, heavy: fakeQueue() as never },
        now: NOW,
      }),
    ).rejects.toThrow('not configured');
  });

  it('isolates a failing slot: the other due slot still claims', async () => {
    const fast = fakeQueue();
    const heavy = fakeQueue();
    const twoDueRows = [
      {
        destination_id: 'dest-1',
        slot_id: 'slot-a',
        time_of_day: '08:00:00',
        timezone: 'UTC',
        kind: ['text'],
      },
      {
        destination_id: 'dest-1',
        slot_id: 'slot-b',
        time_of_day: '08:01:00',
        timezone: 'UTC',
        kind: ['text'],
      },
    ];
    const db = {
      rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'list_active_facebook_posting_slots') {
          return { data: twoDueRows, error: null };
        }
        if (args?.p_slot_id === 'slot-a') {
          return { data: null, error: new Error('boom') };
        }
        return {
          data: [{ id: '22222222-2222-4222-a222-222222222222', kind: 'text', platform_format: 'text', destination_id: 'dest-1' }],
          error: null,
        };
      }),
    };

    const result = await runSlotClaimTick({
      db: db as never,
      queues: { fast: fast as never, heavy: heavy as never },
      now: NOW,
    });

    expect(result.claimed).toBe(1);
    expect(fast.sent.flat()).toHaveLength(1);
  });
});
