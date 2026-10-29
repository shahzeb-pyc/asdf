/**
 * @file destination-enqueue-branches.test.ts
 * @description Branch coverage for the destination-enqueue helpers
 * that the route tests do not reach: the wire-status mapping, the
 * metadata JSON parsing in toDestination, the Supabase paths of
 * fetch/find, and both pre-migration insert fallbacks (legacy SQL
 * and Supabase 42703). These branches are the ones Sonar counts
 * on this PR's new code in src/lib/publishing — components and
 * routes are excluded from Sonar coverage by sonar-project.properties,
 * so only this file's production code moves the gate.
 */

import { describe, expect, it } from 'vitest';
import {
  destinationWireStatus,
  fetchDestinationForEnqueue,
  findQueueItemByIdempotencyKey,
  insertDestinationQueueItem,
  type DestinationForEnqueue,
} from '@/lib/publishing/destination-enqueue';

const WS = '22222222-2222-4222-a222-222222222222';
const DEST = '33333333-3333-4333-a333-333333333333';

function baseDestination(overrides: Partial<DestinationForEnqueue> = {}): DestinationForEnqueue {
  return {
    id: DEST,
    platform: 'facebook',
    timezone: 'UTC',
    status: 'active',
    metadata: null,
    ...overrides,
  };
}

function makeItem() {
  return {
    workspaceId: WS,
    destinationId: DEST,
    platform: 'facebook' as const,
    kind: 'text',
    platformFormat: null,
    caption: 'hello',
    title: null,
    firstComment: null,
    mediaItemId: null,
    mediaUrl: null,
    mediaStorageKey: null,
    linkUrl: null,
    platformOptions: {},
    scheduledTime: null,
    slotId: null,
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  };
}

/** Minimal thenable Supabase query builder. */
function chainable(result: () => Promise<{ data: unknown; error: unknown }>) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.order = () => b;
  b.limit = () => b;
  b.maybeSingle = () => result();
  b.single = () => result();
  b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
    result().then(onOk, onErr);
  return b;
}

describe('destinationWireStatus', () => {
  it.each([
    ['paused', baseDestination({ status: 'disconnected', metadata: { fb_status: 'paused' } })],
    ['page_checkpoint', baseDestination({ status: 'error', metadata: { fb_status: 'checkpoint' } })],
    ['active', baseDestination({ status: 'active' })],
    ['fb_rate_limited', baseDestination({ status: 'rate_limited' })],
    ['invalid_token', baseDestination({ status: 'error' })],
    ['disconnected', baseDestination({ status: 'disconnected' })],
    ['disconnected', baseDestination({ status: 'something-else' })],
  ])('maps to %s', (expected, destination) => {
    expect(destinationWireStatus(destination)).toBe(expected);
  });
});

describe('fetchDestinationForEnqueue', () => {
  it('parses string metadata, and falls back on invalid or non-object JSON', async () => {
    const rows = [
      { id: DEST, platform: 'facebook', timezone: null, status: 'active', metadata: '{"fb_status":"paused"}' },
      { id: DEST, platform: 'facebook', timezone: 'Asia/Karachi', status: 'active', metadata: 'not json' },
      { id: DEST, platform: 'facebook', timezone: null, status: 'active', metadata: '"just a string"' },
    ];
    let call = 0;
    const legacy = {
      query: async () => [rows[call++]],
    };
    const parsed = await fetchDestinationForEnqueue(legacy as never, WS, DEST);
    expect(parsed?.metadata).toEqual({ fb_status: 'paused' });
    expect(parsed?.timezone).toBe('UTC');
    const invalid = await fetchDestinationForEnqueue(legacy as never, WS, DEST);
    expect(invalid?.metadata).toBeNull();
    expect(invalid?.timezone).toBe('Asia/Karachi');
    const nonObject = await fetchDestinationForEnqueue(legacy as never, WS, DEST);
    expect(nonObject?.metadata).toBeNull();
  });

  it('returns the row on the Supabase path, null on error, null without data, null without a client', async () => {
    const row = { id: DEST, platform: 'facebook', timezone: null, status: 'active', metadata: {} };
    const ok = { from: () => chainable(() => Promise.resolve({ data: row, error: null })) };
    expect(await fetchDestinationForEnqueue(ok as never, WS, DEST)).toMatchObject({ id: DEST });
    const err = {
      from: () => chainable(() => Promise.resolve({ data: null, error: new Error('boom') })),
    };
    expect(await fetchDestinationForEnqueue(err as never, WS, DEST)).toBeNull();
    const empty = { from: () => chainable(() => Promise.resolve({ data: null, error: null })) };
    expect(await fetchDestinationForEnqueue(empty as never, WS, DEST)).toBeNull();
    expect(await fetchDestinationForEnqueue({} as never, WS, DEST)).toBeNull();
  });
});

describe('insertDestinationQueueItem fallbacks', () => {
  it('retries without the idempotency column when the legacy insert reports it missing', async () => {
    let call = 0;
    const legacy = {
      query: async () => {
        call += 1;
        if (call === 1) throw new Error('column "idempotency_key" does not exist');
        return [{ id: 'row-1', queue_seq: 1 }];
      },
    };
    const row = await insertDestinationQueueItem(legacy as never, makeItem());
    expect(row).toMatchObject({ id: 'row-1' });
    expect(call).toBe(2);
  });

  it('returns null when the legacy insert fails for any other reason', async () => {
    const legacy = { query: async () => { throw new Error('connection reset'); } };
    expect(await insertDestinationQueueItem(legacy as never, makeItem())).toBeNull();
  });

  it('retries without the idempotency column on Supabase 42703, and returns null otherwise', async () => {
    const seq = () => Promise.resolve({ data: [], error: null });
    // The counter lives outside from(): the seq select, the first
    // insert, and the fallback insert are three separate builders.
    let fallbackOkInserts = 0;
    const fallbackOk = {
      from: () => {
        const b = chainable(seq);
        (b as Record<string, unknown>).insert = () => {
          fallbackOkInserts += 1;
          const attempt = fallbackOkInserts;
          return {
            select: () => ({
              single: () =>
                attempt === 1
                  ? Promise.resolve({ data: null, error: { code: '42703', message: 'no column' } })
                  : Promise.resolve({ data: { id: 'row-2', queue_seq: 1 }, error: null }),
            }),
          };
        };
        return b;
      },
    };
    expect(await insertDestinationQueueItem(fallbackOk as never, makeItem())).toMatchObject({
      id: 'row-2',
    });

    const otherError = {
      from: () => {
        const b = chainable(seq);
        (b as Record<string, unknown>).insert = () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: null, error: { code: '23505', message: 'conflict' } }),
          }),
        });
        return b;
      },
    };
    expect(await insertDestinationQueueItem(otherError as never, makeItem())).toBeNull();

    const fallbackError = {
      from: () => {
        const b = chainable(seq);
        (b as Record<string, unknown>).insert = () => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: null, error: { code: '42703', message: 'no column' } }),
          }),
        });
        return b;
      },
    };
    expect(await insertDestinationQueueItem(fallbackError as never, makeItem())).toBeNull();
  });
});

describe('findQueueItemByIdempotencyKey (Supabase path)', () => {
  const key = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  it('returns the row, null without data, throws on error, null without a client', async () => {
    const row = { id: 'row-3' };
    const ok = { from: () => chainable(() => Promise.resolve({ data: row, error: null })) };
    expect(await findQueueItemByIdempotencyKey(ok as never, WS, key)).toBe(row);
    const empty = { from: () => chainable(() => Promise.resolve({ data: null, error: null })) };
    expect(await findQueueItemByIdempotencyKey(empty as never, WS, key)).toBeNull();
    const err = {
      from: () => chainable(() => Promise.resolve({ data: null, error: new Error('boom') })),
    };
    await expect(findQueueItemByIdempotencyKey(err as never, WS, key)).rejects.toThrow('boom');
    expect(await findQueueItemByIdempotencyKey({} as never, WS, key)).toBeNull();
  });
});
