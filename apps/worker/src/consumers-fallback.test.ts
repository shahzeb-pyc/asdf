/**
 * Audit BG5 — stale page-token fallback.
 *
 * A 190 from the stored page token re-discovers the page token
 * from the live user token, persists it, and retries the publish
 * once. When re-discovery cannot find the page, the original 190
 * failure settles loudly and nothing is persisted.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  decryptToken,
  encryptToken,
} from '@fbuploadpro/contracts';
import {
  handlePublishBatch,
  rediscoverFacebookPageToken,
} from './consumers.js';

const MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ITEM_ID = '11111111-1111-4111-a111-111111111111';
const DEST_ID = '22222222-2222-4222-a222-222222222222';
const ACCT_ID = '44444444-4444-4444-a444-444444444444';
const WS_ID = '33333333-3333-4333-a333-333333333333';
const NOW = '2026-10-30T12:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function graphFetch(pages: Array<{ id: string; access_token?: string }>) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: pages }),
  })) as unknown as typeof fetch;
}

async function makeRows() {
  const item = {
    id: ITEM_ID,
    workspace_id: WS_ID,
    destination_id: DEST_ID,
    platform: 'facebook',
    kind: 'text',
    platform_format: 'text',
    caption: 'hello',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: '2026-10-30T08:00:00.000Z',
    slot_id: null,
    status: 'publishing',
    claimed_at: null,
    retry_count: 0,
    max_retries: 3,
    error_code: null,
    error_subcode: null,
    error_message: null,
    external_post_id: null,
    external_comment_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const destination = {
    id: DEST_ID,
    workspace_id: WS_ID,
    account_id: ACCT_ID,
    platform: 'facebook',
    external_destination_id: 'page_123',
    name: 'Test Page',
    handle: null,
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: await encryptToken('stale_page_token', MASTER_KEY),
    next_allowed_publish_at: null,
    rate_usage_pct: 0,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
  };
  const account = {
    id: ACCT_ID,
    workspace_id: WS_ID,
    platform: 'facebook',
    external_account_id: 'user_1',
    display_name: 'User',
    avatar_url: null,
    encrypted_access_token: await encryptToken('live_user_token', MASTER_KEY),
    encrypted_refresh_token: null,
    token_expires_at: '2027-01-01T00:00:00.000Z',
    scopes: null,
    status: 'active',
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
  };
  return { item, destination, account };
}

function makeDb(rows: Awaited<ReturnType<typeof makeRows>>) {
  const updates: Array<{ table: string; values: Record<string, unknown>; id: unknown }> = [];
  const settles: Array<Record<string, unknown>> = [];
  const byTable: Record<string, Record<string, unknown>> = {
    queue_items: rows.item,
    destinations: rows.destination,
    social_accounts: rows.account,
  };
  const chain = (table: string) => {
    const b: Record<string, unknown> = {};
    let wantedId: unknown;
    b.select = () => b;
    b.eq = (_column: string, value: unknown) => {
      wantedId = value;
      return b;
    };
    b.maybeSingle = async () => {
      const row = byTable[table];
      return {
        data: row && (row as { id: string }).id === wantedId ? row : null,
        error: null,
      };
    };
    b.upsert = async () => ({ error: null });
    b.update = (values: Record<string, unknown>) => ({
      eq: async (_column: string, value: unknown) => {
        updates.push({ table, values, id: value });
        return { data: [{ id: value }], error: null };
      },
    });
    return b;
  };
  const db = {
    from: chain,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'settle_queue_item_outcome') settles.push(args);
      return { data: null, error: null };
    }),
  };
  return { db, updates, settles };
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

describe('rediscoverFacebookPageToken', () => {
  it('returns the fresh token for the matching page', async () => {
    const token = await rediscoverFacebookPageToken(
      'live_user_token',
      'page_123',
      graphFetch([{ id: 'page_999', access_token: 'other' }, { id: 'page_123', access_token: 'fresh' }])
    );
    expect(token).toBe('fresh');
  });

  it('returns null when the page is absent — never a partial-list guess', async () => {
    const token = await rediscoverFacebookPageToken(
      'live_user_token',
      'page_123',
      graphFetch([{ id: 'page_999', access_token: 'other' }])
    );
    expect(token).toBeNull();
  });

  it('returns null when Graph fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const token = await rediscoverFacebookPageToken('live_user_token', 'page_123', failing);
    expect(token).toBeNull();
  });
});

describe('BG5 publish fallback in handlePublishBatch', () => {
  it('retries once with the re-discovered token, persists it, and settles published', async () => {
    vi.stubGlobal('fetch', graphFetch([{ id: 'page_123', access_token: 'fresh_page_token' }]));
    const rows = await makeRows();
    const { db, updates, settles } = makeDb(rows);
    const publish = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        error: { kind: 'auth', code: '190', message: 'Invalid OAuth access token' },
      })
      .mockResolvedValueOnce({ status: 'published', externalPostId: 'fb_new_post' });
    const publisher = { platform: 'facebook', publish } as never;
    const { batch, ack } = makeBatch();

    await handlePublishBatch(batch, {
      db: db as never,
      registry: { get: () => publisher } as never,
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ destinationToken: 'fresh_page_token' })
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe('destinations');
    const persisted = String(updates[0]?.values['encrypted_destination_token']);
    expect(await decryptToken(persisted, MASTER_KEY)).toBe('fresh_page_token');
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({
      p_outcome_status: 'published',
      p_external_post_id: 'fb_new_post',
    });
    expect(ack).toHaveBeenCalled();
  });

  it('settles the original 190 loudly when re-discovery finds no page', async () => {
    vi.stubGlobal('fetch', graphFetch([{ id: 'page_999', access_token: 'other' }]));
    const rows = await makeRows();
    const { db, updates, settles } = makeDb(rows);
    const publish = vi.fn().mockResolvedValue({
      status: 'failed',
      error: { kind: 'auth', code: '190', message: 'Invalid OAuth access token' },
    });
    const publisher = { platform: 'facebook', publish } as never;
    const { batch, ack } = makeBatch();

    await handlePublishBatch(batch, {
      db: db as never,
      registry: { get: () => publisher } as never,
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ p_outcome_status: 'failed' });
    expect(ack).toHaveBeenCalled();
  });
});
