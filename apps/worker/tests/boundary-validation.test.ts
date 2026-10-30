import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createPublisherRegistry,
  encryptToken,
  ValidationError,
  type DatabaseDestinationRow,
  type DatabaseUnifiedQueueItemRow,
  type Platform,
  type Publisher,
} from '@fbuploadpro/contracts';
import { runClaimTick } from '../src/claimer.js';
import { handlePublishBatch, handleDlqBatch } from '../src/consumers.js';
import { runRefreshCycle, type RefreshDbClient } from '../src/refresh.js';
import type { PublishQueueMessage } from '../src/claimer.js';

// ==========================================
// Boundary validation (spec 139 B15)
// ==========================================
//
// Every unified row the worker loads is validated ONCE, at load,
// against its contracts Database*RowSchema:
//   - claimer: each claim RPC row, via the PublishQueueMessageSchema
//     parse of the queue message it becomes;
//   - consumers: queue_items / destinations / social_accounts rows
//     loaded by id (publish path AND DLQ path);
//   - refresh: every social_accounts row the scan returns.
// A malformed row fails LOUDLY — a typed ValidationError plus a
// PostHog capture — and is never silently skipped or cast into shape.
// Real-row shapes the schemas must ACCEPT are pinned here too:
//   - a queue item whose platform_credentials_id is NULL (managed /
//     global-app platforms hold no per-workspace credentials row);
//   - a queue item whose platform_options carry platform keys the
//     contracts do not model (e.g. a TikTok soundId);
//   - a destination row carrying an unmodelled platform_options
//     record (passed through, not stripped).

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const WS_ID = '11111111-1111-4111-8111-111111111111';
const ACCT_ID = '22222222-2222-4222-8222-222222222222';
const DEST_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const CREDS_ID = '77777777-7777-4777-8777-777777777777';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const NON_RECOVERY_TICK = new Date(2026, 0, 1, 10, 7); // minute 7

const fetchBodies: string[] = [];

beforeEach(() => {
  fetchBodies.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      fetchBodies.push(init?.body ?? '');
      return { ok: true };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureWith(kind: string): boolean {
  return fetchBodies.some((body) => body.includes(kind));
}

// ==========================================
// Fakes
// ==========================================

function fakePublisher(
  platform: Platform,
  publishImpl: Publisher['publish']
): Publisher & { publish: ReturnType<typeof vi.fn> } {
  return {
    platform,
    publish: vi.fn(publishImpl),
    refreshTokens: vi.fn(async (_account: unknown, tokens: { accessToken: string }) => ({
      accessToken: tokens.accessToken,
    })) as unknown as Publisher['refreshTokens'],
    mapError: () => ({ kind: 'permanent', code: 'unknown', message: 'unknown' }),
  } as Publisher & { publish: ReturnType<typeof vi.fn> };
}

function registryWith(publisher: Publisher) {
  const registry = createPublisherRegistry();
  registry.register(publisher);
  return registry;
}

function fakeMessage(body: PublishQueueMessage, attempts = 1) {
  return {
    id: `msg-${body.itemId}-${attempts}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(queue: string, messages: ReturnType<typeof fakeMessage>[]) {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

function makeQueueProducer() {
  const batches: PublishQueueMessage[][] = [];
  return {
    batches,
    sendBatch: vi.fn(async (messages: Iterable<{ body: PublishQueueMessage }>) => {
      batches.push([...messages].map((m) => m.body));
    }),
  };
}

async function makeItem(
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return {
    id: ITEM_ID,
    workspace_id: WS_ID,
    destination_id: DEST_ID,
    platform: 'facebook',
    kind: 'text',
    platform_format: null,
    caption: 'Hello',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: new Date().toISOString(),
    slot_id: null,
    status: 'publishing',
    claimed_at: new Date().toISOString(),
    retry_count: 0,
    max_retries: 3,
    error_code: null,
    error_subcode: null,
    error_message: null,
    external_post_id: null,
    external_comment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function makeConsumerDb(opts: {
  item: Record<string, unknown> | null;
  destination?: Record<string, unknown>;
  account?: Record<string, unknown>;
}) {
  const encryptedAccess = await encryptToken('plain-access-token', MASTER_KEY);
  const encryptedDest = await encryptToken('plain-page-token', MASTER_KEY);
  const destination: Record<string, unknown> = {
    id: DEST_ID,
    workspace_id: WS_ID,
    account_id: ACCT_ID,
    platform: 'facebook',
    external_destination_id: 'page-123',
    name: 'Page',
    handle: null,
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: encryptedDest,
    next_allowed_publish_at: null,
    rate_usage_pct: 0,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...opts.destination,
  };
  const account: Record<string, unknown> = {
    id: ACCT_ID,
    workspace_id: WS_ID,
    platform: 'facebook',
    external_account_id: 'user-123',
    display_name: 'User',
    avatar_url: null,
    encrypted_access_token: encryptedAccess,
    encrypted_refresh_token: null,
    token_expires_at: null,
    scopes: null,
    status: 'active',
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...opts.account,
  };
  const tables: Record<string, Map<string, unknown>> = {
    queue_items: new Map(opts.item ? [[opts.item.id as string, opts.item]] : []),
    destinations: new Map([[destination.id as string, destination]]),
    social_accounts: new Map([[account.id as string, account]]),
  };
  const settleCalls: Record<string, unknown>[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'settle_queue_item_outcome') {
        settleCalls.push(args ?? {});
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === 'worker_heartbeats') {
        return {
          upsert: vi.fn(async () => ({ error: null })),
        };
      }
      let eqValue: unknown;
      const builder = {
        select: () => builder,
        eq: (_col: string, value: unknown) => {
          eqValue = value;
          return builder;
        },
        maybeSingle: async () => ({
          data: tables[table]?.get(eqValue as string) ?? null,
          error: null,
        }),
        // The publish path persists the platform post id on the queue
        // row before settling: update().eq() resolves after eq supplies
        // the id, mirroring the real RowQueryBuilder chain.
        update: (values: Record<string, unknown>) => ({
          eq: async (_col: string, value: unknown) => {
            const row = tables[table]?.get(value as string) as
              | Record<string, unknown>
              | undefined;
            if (row) Object.assign(row, values);
            return { data: null, error: null };
          },
        }),
      };
      return builder;
    }),
  };
  return { db, settleCalls };
}

// ==========================================
// Claimer boundary
// ==========================================

describe('Boundary validation — claimer (spec 139 B15)', () => {
  it('fails loudly on a malformed claim row: nothing enqueued, ValidationError captured', async () => {
    const registry = registryWith(
      fakePublisher('facebook', async () => ({ status: 'published' }))
    );
    const rpc = vi.fn(async () => ({
      data: [{ id: 'not-a-uuid' }],
      error: null,
    }));
    const fastQ = makeQueueProducer();
    const heavyQ = makeQueueProducer();

    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: fastQ, heavy: heavyQ },
      now: NON_RECOVERY_TICK,
      env: { POSTHOG_KEY: 'test-key' },
    });

    // Per-pair isolation keeps the tick alive, but the malformed row is
    // never enqueued and never silently skipped: it was captured with
    // the boundary-validation kind in BOTH lanes the pair ran under.
    expect(fastQ.sendBatch).not.toHaveBeenCalled();
    expect(heavyQ.sendBatch).not.toHaveBeenCalled();
    expect(result.enqueuedFast).toBe(0);
    expect(result.enqueuedHeavy).toBe(0);
    expect(captureWith('claim_row_validation_failed')).toBe(true);
    expect(
      fetchBodies.some((body) => body.includes('failed boundary validation'))
    ).toBe(true);
  });

  it('fails loudly on a non-array claim payload', async () => {
    const registry = registryWith(
      fakePublisher('facebook', async () => ({ status: 'published' }))
    );
    const rpc = vi.fn(async () => ({ data: { id: ITEM_ID }, error: null }));
    const fastQ = makeQueueProducer();
    const heavyQ = makeQueueProducer();

    await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: fastQ, heavy: heavyQ },
      now: NON_RECOVERY_TICK,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(fastQ.sendBatch).not.toHaveBeenCalled();
    expect(heavyQ.sendBatch).not.toHaveBeenCalled();
    expect(captureWith('claim_row_validation_failed')).toBe(true);
  });
});

// ==========================================
// Consumer boundaries (publish + DLQ)
// ==========================================

describe('Boundary validation — consumers (spec 139 B15)', () => {
  it('malformed queue item row: message left un-acked, publisher never called, capture is loud', async () => {
    // 'skipped' is legacy vocabulary the unified table cannot hold.
    const item = await makeItem({ status: 'skipped' });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await expect(
      handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: { POSTHOG_KEY: 'test-key' },
      })
    ).rejects.toBeInstanceOf(ValidationError);

    expect(message.ack).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
    expect(captureWith('row_validation_failed')).toBe(true);
    expect(captureWith('queue_items')).toBe(true);
  });

  it('malformed destination row: fails loudly before any publish attempt', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { rate_usage_pct: 101 },
    });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await expect(
      handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: { POSTHOG_KEY: 'test-key' },
      })
    ).rejects.toBeInstanceOf(ValidationError);

    expect(message.ack).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
    expect(captureWith('row_validation_failed')).toBe(true);
    expect(captureWith('destinations')).toBe(true);
  });

  it('malformed social account row: fails loudly before any publish attempt', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      // 'disconnected' is the pre-unification account vocabulary.
      account: { status: 'disconnected' },
    });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await expect(
      handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: { POSTHOG_KEY: 'test-key' },
      })
    ).rejects.toBeInstanceOf(ValidationError);

    expect(message.ack).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
    expect(captureWith('row_validation_failed')).toBe(true);
    expect(captureWith('social_accounts')).toBe(true);
  });

  it('DLQ path validates the item row too: malformed row is loud, acked, and never settled', async () => {
    const item = await makeItem({ retry_count: -1 });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await handleDlqBatch(fakeBatch('publish-fast-dlq', [message]) as never, {
      db: db as never,
      env: { POSTHOG_KEY: 'test-key' },
    });

    // DLQ messages are always acked (they must not loop forever), but
    // the malformed row is captured at the boundary and nothing is
    // settled from a row that failed validation.
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(0);
    expect(captureWith('row_validation_failed')).toBe(true);
  });

  it('accepts a queue item with NULL platform_credentials_id and platform platform_options keys', async () => {
    const item = await makeItem({
      platform: 'tiktok',
      platform_credentials_id: null,
      platform_options: { soundId: 'sound-123', autoAddMusic: true },
    });
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { platform: 'tiktok' },
      account: { platform: 'tiktok' },
    });
    let seenOptions: unknown;
    const publisher = fakePublisher('tiktok', async (seenItem) => {
      seenOptions = (seenItem as DatabaseUnifiedQueueItemRow).platform_options;
      return { status: 'published', externalPostId: 'tt-1' };
    });
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'tiktok', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    // The platform keys survived the boundary untouched.
    expect(seenOptions).toEqual({ soundId: 'sound-123', autoAddMusic: true });
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({ p_outcome_status: 'published' });
    expect(captureWith('row_validation_failed')).toBe(false);
  });

  it('accepts a queue item carrying a platform_credentials_id value', async () => {
    const item = await makeItem({ platform_credentials_id: CREDS_ID });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'published',
      externalPostId: 'post-1',
    }));
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({ p_outcome_status: 'published' });
  });

  it('accepts a destination row carrying an unmodelled platform_options record', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { platform_options: { soundId: 'sound-123' } } as Record<string, unknown>,
    });
    let seenDestination: unknown;
    const publisher = fakePublisher('facebook', async (_item, seenDest) => {
      seenDestination = seenDest;
      return { status: 'published', externalPostId: 'post-2' };
    });
    const message = fakeMessage({ itemId: ITEM_ID, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    // Passthrough: the unmodelled record reaches the publisher intact
    // instead of being stripped at the boundary.
    expect(
      (seenDestination as Record<string, unknown>).platform_options
    ).toEqual({ soundId: 'sound-123' });
    expect((seenDestination as DatabaseDestinationRow).id).toBe(DEST_ID);
  });
});

// ==========================================
// Refresh boundary
// ==========================================

describe('Boundary validation — refresh scan (spec 139 B15)', () => {
  function makeRefreshDb(rows: Array<Record<string, unknown>>) {
    return {
      from: vi.fn((_table: string) => ({
        select: (_columns: string) => {
          const ops: Array<{ op: string; column: string; value: unknown }> = [];
          let orderColumn: string | null = null;
          let limitCount: number | null = null;
          const builder = {
            eq(column: string, value: unknown) {
              ops.push({ op: 'eq', column, value });
              return builder;
            },
            lte(column: string, value: unknown) {
              ops.push({ op: 'lte', column, value });
              return builder;
            },
            gt(column: string, value: unknown) {
              ops.push({ op: 'gt', column, value });
              return builder;
            },
            order(column: string, _options: { ascending: boolean }) {
              orderColumn = column;
              return builder;
            },
            limit(count: number) {
              limitCount = count;
              return builder;
            },
            then<TResult1 = unknown, TResult2 = never>(
              onFulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
              onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
            ): Promise<TResult1 | TResult2> {
              let matched = rows.filter((row) =>
                ops.every(({ op, column, value }) => {
                  const cell: unknown = row[column];
                  if (op === 'eq') return cell === value;
                  if (cell === null || cell === undefined) return false;
                  return op === 'lte'
                    ? (cell as string) <= (value as string)
                    : (cell as string) > (value as string);
                })
              );
              if (orderColumn !== null) {
                const col = orderColumn;
                matched = matched.sort((a, b) =>
                  String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0
                );
              }
              if (limitCount !== null) matched = matched.slice(0, limitCount);
              return Promise.resolve({ data: matched, error: null }).then(
                onFulfilled,
                onRejected
              );
            },
          };
          return builder;
        },
      })),
    };
  }

  it('malformed scanned social_accounts row aborts the cycle loudly and is never marked expired', async () => {
    const malformed = {
      id: ACCT_ID,
      workspace_id: 'not-a-uuid',
      platform: 'x',
      external_account_id: 'user-1',
      display_name: 'User',
      avatar_url: null,
      encrypted_access_token: await encryptToken('old-access', MASTER_KEY),
      encrypted_refresh_token: await encryptToken('old-refresh', MASTER_KEY),
      token_expires_at: '2026-10-22T12:10:00.000Z',
      scopes: null,
      status: 'active',
      metadata: {},
      created_at: '2026-10-20T12:00:00.000Z',
      updated_at: '2026-10-20T12:00:00.000Z',
      refresh_lease_owner: null,
      refresh_lease_expires_at: null,
    };
    const db = makeRefreshDb([malformed]);
    const publisher = fakePublisher('x', async () => ({ status: 'published' }));

    await expect(
      runRefreshCycle(
        db as unknown as RefreshDbClient,
        registryWith(publisher),
        { TOKEN_ENCRYPTION_KEY: MASTER_KEY, POSTHOG_KEY: 'test-key' },
        NOW
      )
    ).rejects.toBeInstanceOf(ValidationError);

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(captureWith('scan_row_validation_failed')).toBe(true);
    // The malformed row was never rewritten (e.g. to 'expired').
    expect(malformed.status).toBe('active');
  });
});
