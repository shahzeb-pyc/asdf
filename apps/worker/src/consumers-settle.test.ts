/**
 * callSettleRpc — unmatched-flag refresh is best-effort.
 *
 * Every settle recomputes the destination's unmatched-posts flag, but
 * a refresh failure must never fail the settle itself: the error is
 * logged loudly and the message still settles (and acks). These tests
 * reach the settle through the publish idempotency guard — an item
 * that already carries an external post id settles `published` from
 * the stored ids without touching destinations, accounts, tokens, or
 * any publisher — so the refresh branches are exercised in isolation.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { InternalError } from '@fbuploadpro/contracts';
import { handlePublishBatch } from './consumers.js';

const ITEM_ID = '11111111-1111-4111-a111-111111111111';
const DEST_ID = '22222222-2222-4222-a222-222222222222';
const WS_ID = '33333333-3333-4333-a333-333333333333';

const ITEM_ROW = {
  id: ITEM_ID,
  workspace_id: WS_ID,
  destination_id: DEST_ID,
  platform: 'facebook',
  kind: 'text',
  platform_format: 'text',
  caption: '',
  title: null,
  first_comment: null,
  media_item_id: null,
  media_url: null,
  media_storage_key: null,
  link_url: null,
  platform_options: {},
  scheduled_time: '2026-10-27T08:00:00.000Z',
  slot_id: null,
  status: 'publishing',
  claimed_at: null,
  retry_count: 0,
  max_retries: 3,
  error_code: null,
  error_subcode: null,
  error_message: null,
  external_post_id: 'fb_post_123',
  external_comment_id: null,
  created_at: '2026-10-27T07:00:00.000Z',
  updated_at: '2026-10-27T07:00:00.000Z',
};

function makeDb(refresh: () => Promise<unknown>) {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.upsert = () => Promise.resolve({ error: null });
    b.maybeSingle = () =>
      Promise.resolve(
        table === 'queue_items' ? { data: ITEM_ROW, error: null } : { data: null, error: null }
      );
    return b;
  };
  return {
    from: chain,
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'settle_queue_item_outcome') return { error: null };
      if (fn === 'refresh_destination_unmatched_flag') return refresh();
      return { data: null, error: null };
    }),
  };
}

function makeBatch() {
  const ack = vi.fn();
  return {
    batch: {
      messages: [
        {
          id: 'msg-1',
          body: { itemId: ITEM_ID, platform: 'facebook', lane: 'fast' },
          ack,
        },
      ],
      queue: 'publish-fast',
    } as never,
    ack,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settle unmatched-flag refresh failures', () => {
  it('settles and acks when the refresh RPC returns an error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb(async () => ({ error: new Error('refresh boom') }));
    const { batch, ack } = makeBatch();

    await handlePublishBatch(batch, { db: db as never, registry: {} as never, env: {} });

    expect(ack).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('unmatched-flag refresh failed'),
      expect.anything()
    );
  });

  it('settles and acks when the refresh RPC throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb(async () => {
      throw new InternalError('refresh threw');
    });
    const { batch, ack } = makeBatch();

    await handlePublishBatch(batch, { db: db as never, registry: {} as never, env: {} });

    expect(ack).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('unmatched-flag refresh threw'),
      expect.anything()
    );
  });
});
