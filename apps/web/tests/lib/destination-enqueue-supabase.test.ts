/**
 * insertDestinationQueueItem — Supabase path queue_seq assignment.
 *
 * queue_seq is the ONE queue ordering: a new item takes max+1 for its
 * destination (1 when the destination has no queued rows yet). This
 * pins the Supabase path production runs; the legacy SQL path
 * computes the same value inside its INSERT.
 */
import { describe, expect, it, vi } from 'vitest';
import { insertDestinationQueueItem } from '@/lib/publishing/destination-enqueue';

function makeItem() {
  return {
    workspaceId: '22222222-2222-4222-a222-222222222222',
    destinationId: '33333333-3333-4333-a333-333333333333',
    platform: 'instagram' as const,
    kind: 'image',
    platformFormat: null,
    caption: 'A post',
    title: null,
    firstComment: null,
    mediaItemId: null,
    mediaUrl: null,
    mediaStorageKey: null,
    linkUrl: null,
    platformOptions: {},
    scheduledTime: null,
    slotId: null,
  };
}

function makeSupabaseFake(seqRows: Array<{ queue_seq: number }>) {
  const inserted: Array<Record<string, unknown>> = [];
  const builderFor = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.insert = (payload: Record<string, unknown>) => {
      inserted.push(payload);
      return b;
    };
    b.single = () =>
      Promise.resolve({
        data: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-000000000001', ...inserted[0] },
        error: null,
      });
    b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve({ data: seqRows, error: null }).then(onOk, onErr);
    return b;
  };
  return { from: builderFor, inserted };
}

describe('insertDestinationQueueItem (Supabase path)', () => {
  it('assigns max queue_seq + 1 for the destination', async () => {
    const fake = makeSupabaseFake([{ queue_seq: 7 }]);
    const row = await insertDestinationQueueItem(fake as never, makeItem());
    expect(row?.queue_seq).toBe(8);
    expect(fake.inserted[0]?.queue_seq).toBe(8);
  });

  it('starts at 1 when the destination has no queued rows', async () => {
    const fake = makeSupabaseFake([]);
    const row = await insertDestinationQueueItem(fake as never, makeItem());
    expect(row?.queue_seq).toBe(1);
    expect(fake.inserted[0]?.queue_seq).toBe(1);
  });

  it('returns null when the insert errors', async () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.insert = () => b;
    b.single = () => Promise.resolve({ data: null, error: new Error('insert boom') });
    b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(onOk, onErr);
    const fake = { from: () => b };
    const row = await insertDestinationQueueItem(fake as never, makeItem());
    expect(row).toBeNull();
  });
});
