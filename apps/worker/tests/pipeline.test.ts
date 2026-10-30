import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createPublisherRegistry,
  encryptToken,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type Platform,
  type Publisher,
  type PublishOutcome,
} from '@fbuploadpro/contracts';
import {
  runClaimTick,
  MAX_CLAIM_ROUNDS_PER_PLATFORM_LANE_PER_TICK,
} from '../src/claimer.js';
import {
  handlePublishBatch,
  handleDlqBatch,
  mapPublishOutcomeToSettleArgs,
  DEFER_ACCOUNT_NOT_ACTIVE_CODE,
  DEFER_DESTINATION_COOLDOWN_CODE,
  DEFER_DESTINATION_NOT_ACTIVE_CODE,
  DEFAULT_RETRY_DELAY_SECONDS,
  DLQ_ERROR_CODE,
} from '../src/consumers.js';
import { recordHeartbeat } from '../src/heartbeat.js';
import type { PublishQueueMessage } from '../src/claimer.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// ==========================================
// Fakes (external boundaries only: DB, queues, PostHog fetch)
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

function makeQueueProducer() {
  const batches: PublishQueueMessage[][] = [];
  return {
    batches,
    sendBatch: vi.fn(async (messages: Iterable<{ body: PublishQueueMessage }>) => {
      batches.push([...messages].map((m) => m.body));
    }),
  };
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

// Real DB ids are UUIDs (spec 139 B15 boundary validation parses them);
// fixtures use fixed valid UUIDs so validated loads accept them.
const WS_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const DEST_ID = '33333333-3333-4333-8333-333333333333';
const ACCT_ID = '44444444-4444-4444-8444-444444444444';
const ITEM_LIVE_ID = '55555555-5555-4555-8555-555555555555';
const ITEM_DONE_ID = '66666666-6666-4666-8666-666666666666';
const claimRowId = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

const NON_RECOVERY_TICK = new Date(2026, 0, 1, 10, 7); // minute 7
const RECOVERY_TICK = new Date(2026, 0, 1, 10, 10); // minute 10

// ==========================================
// Claimer
// ==========================================

describe('Claimer (spec 121)', () => {
  // SUPERSEDED by the spec 122 load-proof tuning (claim round cap 4 → 1,
  // see claimer.ts): this test previously asserted multi-round looping
  // within one tick (500 + 120 = 620 claimed). At cap 1 a tick claims
  // exactly one round per lane; the remaining backlog stays queued for
  // the next tick. Chunking at 100 per sendBatch call is unchanged.
  it('claims one round per lane per tick (cap 1), chunking sendBatch at 100', async () => {
    const registry = createPublisherRegistry();
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    registry.register(publisher);

    const fastRounds: number[] = [500, 120];
    const rpc = vi.fn(async (_fn: string, args?: Record<string, unknown>) => {
      const kindSet = (args?.p_lane_kind_set as string[]) ?? [];
      if (kindSet.includes('video')) return { data: [], error: null }; // heavy lane empty
      const count = fastRounds.shift() ?? 0;
      return {
        data: Array.from({ length: count }, (_, i) => ({ id: claimRowId(i) })),
        error: null,
      };
    });
    const fastQ = makeQueueProducer();
    const heavyQ = makeQueueProducer();

    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: fastQ, heavy: heavyQ },
      now: NON_RECOVERY_TICK,
    });

    expect(result.claimed).toBe(500);
    expect(result.enqueuedFast).toBe(500);
    expect(result.enqueuedHeavy).toBe(0);
    // Chunk sizes: the single round → 5×100. The 120-item second round is
    // NOT claimed this tick (cap 1); it remains for the next tick.
    expect(fastQ.batches.map((b) => b.length)).toEqual([100, 100, 100, 100, 100]);
    expect(heavyQ.sendBatch).not.toHaveBeenCalled();
    // Message payload carries ids + derivable fields only, plus the
    // schemaVersion stamped by PublishQueueMessageSchema (spec 139 B15).
    expect(fastQ.batches[0]?.[0]).toEqual({
      itemId: claimRowId(0),
      platform: 'facebook',
      lane: 'publish-fast',
      schemaVersion: 1,
    });
    // The tick never publishes.
    expect(publisher.publish).not.toHaveBeenCalled();
    // Claim RPC call shape.
    const claimCalls = rpc.mock.calls.filter((c) => c[0] === 'claim_due_queue_items');
    expect(claimCalls.length).toBeGreaterThan(0);
    expect(claimCalls[0]?.[1]).toMatchObject({
      p_platform: 'facebook',
      p_limit: 500,
      p_max_per_destination: 3,
    });
  });

  it('stops at the per-tick round cap when every round is full', async () => {
    const registry = createPublisherRegistry();
    registry.register(fakePublisher('facebook', async () => ({ status: 'published' })));
    const rpc = vi.fn(async (_fn: string, _args?: Record<string, unknown>) => ({
      data: Array.from({ length: 500 }, (_, i) => ({ id: claimRowId(i) })),
      error: null,
    }));
    const fastQ = makeQueueProducer();
    const heavyQ = makeQueueProducer();

    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: fastQ, heavy: heavyQ },
      now: NON_RECOVERY_TICK,
    });

    const claimCalls = rpc.mock.calls.filter((c) => c[0] === 'claim_due_queue_items');
    expect(claimCalls).toHaveLength(MAX_CLAIM_ROUNDS_PER_PLATFORM_LANE_PER_TICK * 2);
    expect(result.claimed).toBe(500 * MAX_CLAIM_ROUNDS_PER_PLATFORM_LANE_PER_TICK * 2);
  });

  it('isolates a failing (lane, platform) pair: other platforms still claim (spec 139)', async () => {
    const registry = createPublisherRegistry();
    registry.register(fakePublisher('facebook', async () => ({ status: 'published' })));
    registry.register(fakePublisher('instagram', async () => ({ status: 'published' })));
    const rpc = vi.fn(async (_fn: string, args?: Record<string, unknown>) => {
      if (args?.p_platform === 'facebook') {
        return { data: null, error: new Error('facebook claim boom') };
      }
      // instagram: one row per lane
      return { data: [{ id: claimRowId(1) }], error: null };
    });
    const fastQ = makeQueueProducer();
    const heavyQ = makeQueueProducer();
    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }))
    );
    try {
      const result = await runClaimTick({
        db: { rpc },
        registry,
        queues: { fast: fastQ, heavy: heavyQ },
        now: NON_RECOVERY_TICK,
        env: { POSTHOG_KEY: 'test-key' },
        waitUntil,
      });
      // Facebook failed in both lanes, instagram still claimed in both.
      expect(result.claimed).toBe(2);
      expect(result.enqueuedFast).toBe(1);
      expect(result.enqueuedHeavy).toBe(1);
      // The claim-path failure was captured with waitUntil threaded.
      expect(waitUntil).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records per-chunk progress when sendBatch fails mid-batch and still runs the other lane (spec 139)', async () => {
    const registry = createPublisherRegistry();
    registry.register(fakePublisher('facebook', async () => ({ status: 'published' })));
    const rpc = vi.fn(async (_fn: string, args?: Record<string, unknown>) => {
      const kindSet = (args?.p_lane_kind_set as string[]) ?? [];
      if (kindSet.includes('video')) return { data: [], error: null }; // heavy empty
      return {
        data: Array.from({ length: 150 }, (_, i) => ({ id: claimRowId(i) })),
        error: null,
      };
    });
    let sendCalls = 0;
    const fastQ = {
      batches: [] as PublishQueueMessage[][],
      sendBatch: vi.fn(async (messages: Iterable<{ body: PublishQueueMessage }>) => {
        sendCalls += 1;
        if (sendCalls === 2) throw new Error('queue send boom');
        fastQ.batches.push([...messages].map((m) => m.body));
      }),
    };
    const heavyQ = makeQueueProducer();
    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: fastQ, heavy: heavyQ },
      now: NON_RECOVERY_TICK,
    });
    // First 100-chunk went out, second chunk failed: progress is exact,
    // the tick did not throw, and the heavy lane was still attempted.
    expect(result.claimed).toBe(150);
    expect(result.enqueuedFast).toBe(100);
    expect(result.enqueuedHeavy).toBe(0);
    expect(rpc.mock.calls.some((c) => ((c[1] as { p_lane_kind_set: string[] }).p_lane_kind_set ?? []).includes('video'))).toBe(true);
  });

  it('claims only platforms registered in the publisher registry', async () => {
    const registry = createPublisherRegistry(); // empty: nothing is claimable yet
    const rpc = vi.fn(async (_fn: string, _args?: Record<string, unknown>) => ({ data: [], error: null }));
    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues: { fast: makeQueueProducer(), heavy: makeQueueProducer() },
      now: NON_RECOVERY_TICK,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, enqueuedFast: 0, enqueuedHeavy: 0, recovered: 0 });
  });

  it('runs recovery only on every 5th tick, with the 2-arg RPC for all six platforms', async () => {
    const registry = createPublisherRegistry();
    const rpc = vi.fn(async (_fn: string, _args?: Record<string, unknown>) => ({ data: 0, error: null }));
    const queues = { fast: makeQueueProducer(), heavy: makeQueueProducer() };

    await runClaimTick({ db: { rpc }, registry, queues, now: NON_RECOVERY_TICK });
    expect(rpc.mock.calls.filter((c) => c[0] === 'recover_stuck_publishing_items')).toHaveLength(0);

    const result = await runClaimTick({
      db: { rpc },
      registry,
      queues,
      now: RECOVERY_TICK,
    });
    const recoverCalls = rpc.mock.calls.filter(
      (c) => c[0] === 'recover_stuck_publishing_items'
    );
    expect(recoverCalls).toHaveLength(6);
    expect(recoverCalls.map((c) => (c[1] as { p_platform: string }).p_platform).sort()).toEqual(
      ['facebook', 'instagram', 'threads', 'tiktok', 'x', 'youtube']
    );
    for (const call of recoverCalls) {
      expect(Object.keys(call[1] as object).sort()).toEqual(['p_platform', 'p_timeout_minutes']);
      expect((call[1] as { p_timeout_minutes: number }).p_timeout_minutes).toBe(10);
    }
    expect(result.recovered).toBe(0);
  });
});

// ==========================================
// Consumers
// ==========================================

async function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): Promise<DatabaseUnifiedQueueItemRow> {
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
  item: DatabaseUnifiedQueueItemRow | null;
  extraItems?: DatabaseUnifiedQueueItemRow[];
  destination?: Partial<DatabaseDestinationRow>;
  account?: Partial<DatabaseSocialAccountRow>;
  settleError?: unknown;
}) {
  const encryptedAccess = await encryptToken('plain-access-token', MASTER_KEY);
  const encryptedDest = await encryptToken('plain-page-token', MASTER_KEY);
  const destination: DatabaseDestinationRow = {
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
  const account: DatabaseSocialAccountRow = {
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
  const queueItems = new Map<string, unknown>();
  if (opts.item) queueItems.set(opts.item.id, opts.item);
  for (const extra of opts.extraItems ?? []) queueItems.set(extra.id, extra);
  const tables: Record<string, Map<string, unknown>> = {
    queue_items: queueItems,
    destinations: new Map([[destination.id, destination]]),
    social_accounts: new Map([[account.id, account]]),
  };
  const settleCalls: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'settle_queue_item_outcome') {
        settleCalls.push(args ?? {});
        return opts.settleError
          ? { data: null, error: opts.settleError }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table === 'worker_heartbeats') {
        return {
          upsert: vi.fn(async (row: Record<string, unknown>) => {
            upserts.push(row);
            return { error: null };
          }),
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
      };
      return builder;
    }),
  };
  return { db, settleCalls, upserts, destination, account };
}

function registryWith(publisher: Publisher) {
  const registry = createPublisherRegistry();
  registry.register(publisher);
  return registry;
}

describe('Publish consumers (spec 121)', () => {
  it('settles a published outcome via the unified RPC and acks', async () => {
    const item = await makeItem();
    const { db, settleCalls, upserts } = await makeConsumerDb({ item });
    let seenTokens: unknown;
    const publisher = fakePublisher('facebook', async (_item, _dest, tokens) => {
      seenTokens = tokens;
      return {
        status: 'published',
        externalPostId: 'post-42',
        externalCommentId: 'comment-7',
      } satisfies PublishOutcome;
    });
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_queue_item_id: ITEM_ID,
      p_workspace_id: WS_ID,
      p_destination_id: DEST_ID,
      p_outcome_status: 'published',
      p_external_post_id: 'post-42',
      p_external_comment_id: 'comment-7',
      p_retry_count: 0,
    });
    // Tokens were decrypted before the publisher saw them.
    expect(seenTokens).toMatchObject({
      accessToken: 'plain-access-token',
      destinationToken: 'plain-page-token',
    });
    // Settled count flows to the heartbeat as a counts-only write.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_settled_count).toBe(1);
    expect(upserts[0]?.last_run_at).toBeUndefined();
  });

  it('settles a retry outcome as queued with the publisher delay', async () => {
    const item = await makeItem({ retry_count: 1 });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'retry',
      retryDelaySeconds: 900,
      error: { kind: 'retryable', code: '4', message: 'rate limited' },
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'queued',
      p_retry_delay_seconds: 900,
      p_retry_count: 2,
      p_error_code: '4',
      p_error_message: 'rate limited',
    });
  });

  it('settles a permanent failure as failed without an account cascade', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'failed',
      error: { kind: 'permanent', code: '100', message: 'invalid parameter' },
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'failed',
      p_error_code: '100',
      p_target_account_status: null,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('cascades an auth failure to account expired via the settle args', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'failed',
      error: { kind: 'auth', code: '190', message: 'token expired' },
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    // Audit BG5: a 190 now triggers a live Graph re-discovery of
    // the page token before settling. Stub it to an empty page
    // list here so re-discovery fails and the original 190
    // settles unchanged — the re-discovery success path has its
    // own dedicated tests.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [] }),
      }))
    );
    try {
      await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: {},
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'failed',
      p_error_code: '190',
      p_target_account_status: 'expired',
    });
  });

  it('skips an item that is no longer publishing (cancelled) without publishing or settling', async () => {
    const item = await makeItem({ status: 'cancelled' });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('leaves the message un-acked and rethrows when the publisher throws', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => {
      throw new Error('unexpected boom');
    });
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await expect(
      handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: {},
      })
    ).rejects.toThrow('unexpected boom');
    expect(message.ack).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(0);
  });

  it('leaves the message un-acked when settlement fails (DB failure)', async () => {
    const item = await makeItem();
    const { db } = await makeConsumerDb({ item, settleError: new Error('db down') });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'published',
      externalPostId: 'post-1',
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await expect(
      handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(publisher),
        masterKey: MASTER_KEY,
        env: {},
      })
    ).rejects.toThrow('db down');
    expect(message.ack).not.toHaveBeenCalled();
  });
});

// ==========================================
// Publish consumers — spec 139 B12 intra-batch concurrency
// ==========================================

describe('Publish consumers — spec 139 B12 intra-batch concurrency', () => {
  it('processes a batch concurrently: wall-clock tracks the slowest item, not the sum of latencies', async () => {
    const LATENCY_MS = 200;
    const items = await Promise.all(
      [1000, 1001, 1002, 1003, 1004].map((i) => makeItem({ id: claimRowId(i) }))
    );
    const { db, settleCalls, upserts } = await makeConsumerDb({
      item: items[0] as DatabaseUnifiedQueueItemRow,
      extraItems: items.slice(1),
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const publisher = fakePublisher('facebook', async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
      inFlight--;
      return {
        status: 'published',
        externalPostId: `post-${item.id}`,
      } satisfies PublishOutcome;
    });
    const messages = items.map((item) =>
      fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' })
    );

    const startedAt = Date.now();
    await handlePublishBatch(fakeBatch('publish-fast', messages) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });
    const elapsedMs = Date.now() - startedAt;

    // Every item settled with its own outcome and was acked.
    expect(settleCalls).toHaveLength(items.length);
    expect(
      settleCalls.every((c) => c.p_outcome_status === 'published')
    ).toBe(true);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
    }
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_settled_count).toBe(items.length);
    // All items were in flight at once: the cap is the batch size.
    expect(maxInFlight).toBe(items.length);
    // Serial processing would take >= items.length * LATENCY_MS
    // (1,000ms); concurrent wall-clock is ~the slowest item plus
    // overhead — asserted with a 2.5x tolerance band under the serial
    // floor and comfortably above a single item's latency.
    expect(elapsedMs).toBeGreaterThanOrEqual(LATENCY_MS);
    expect(elapsedMs).toBeLessThan((LATENCY_MS * items.length) / 2);
  });

  it('settles every item with its own outcome in a mixed batch, even when the first item throws', async () => {
    const throwId = claimRowId(2000);
    const publishedId = claimRowId(2001);
    const failedId = claimRowId(2002);
    const retryId = claimRowId(2003);
    // The throwing item is FIRST in batch order: under the old serial
    // loop with abort-on-error semantics (or a naive Promise.all) the
    // remaining items would never settle — here every one must.
    const items = await Promise.all(
      [throwId, publishedId, failedId, retryId].map((id) => makeItem({ id }))
    );
    const { db, settleCalls, upserts } = await makeConsumerDb({
      item: items[0] as DatabaseUnifiedQueueItemRow,
      extraItems: items.slice(1),
    });
    const publisher = fakePublisher('facebook', async (item) => {
      if (item.id === throwId) throw new Error('publisher boom');
      if (item.id === failedId) {
        return {
          status: 'failed',
          error: { kind: 'permanent', code: '100', message: 'invalid parameter' },
        } satisfies PublishOutcome;
      }
      if (item.id === retryId) {
        return {
          status: 'retry',
          retryDelaySeconds: 60,
          error: { kind: 'retryable', code: '4', message: 'rate limited' },
        } satisfies PublishOutcome;
      }
      return {
        status: 'published',
        externalPostId: 'post-ok',
      } satisfies PublishOutcome;
    });
    const messages = items.map((item) =>
      fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' })
    );
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ?? '');
        return { ok: true };
      })
    );
    try {
      await expect(
        handlePublishBatch(fakeBatch('publish-fast', messages) as never, {
          db: db as never,
          registry: registryWith(publisher),
          masterKey: MASTER_KEY,
          env: { POSTHOG_KEY: 'test-key' },
        })
      ).rejects.toThrow('publisher boom');
    } finally {
      vi.unstubAllGlobals();
    }

    // Every non-throwing item settled with its OWN outcome mapping.
    const settleByItem = new Map(
      settleCalls.map((c) => [c.p_queue_item_id as string, c])
    );
    expect(settleByItem.size).toBe(3);
    expect(settleByItem.get(publishedId)).toMatchObject({
      p_outcome_status: 'published',
      p_external_post_id: 'post-ok',
    });
    expect(settleByItem.get(failedId)).toMatchObject({
      p_outcome_status: 'failed',
      p_error_code: '100',
    });
    expect(settleByItem.get(retryId)).toMatchObject({
      p_outcome_status: 'queued',
      p_retry_delay_seconds: 60,
      p_error_code: '4',
    });
    // The throwing item never settled and stays un-acked for retry;
    // the other three were acked exactly once.
    expect(settleByItem.has(throwId)).toBe(false);
    const ackCountByItemId = new Map(
      messages.map((m) => [m.body.itemId, m.ack.mock.calls.length])
    );
    expect(ackCountByItemId.get(throwId)).toBe(0);
    expect(ackCountByItemId.get(publishedId)).toBe(1);
    expect(ackCountByItemId.get(failedId)).toBe(1);
    expect(ackCountByItemId.get(retryId)).toBe(1);
    // The settled heartbeat counts only the three settled items, and
    // the throwing item's error went through the capture path.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_settled_count).toBe(3);
    expect(
      bodies.some((b) => b.includes('$exception') && b.includes('publish_message_failed'))
    ).toBe(true);
  });
});

// ==========================================
// Publish consumers — spec 139 publish safety
// ==========================================

describe('Publish consumers — spec 139 publish safety', () => {
  it('does not re-publish an item already carrying external_post_id; settles published from the stored ids', async () => {
    const item = await makeItem({
      external_post_id: 'post-existing',
      external_comment_id: 'comment-existing',
      retry_count: 2,
    });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'published',
      externalPostId: 'post-NEW',
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'published',
      p_external_post_id: 'post-existing',
      p_external_comment_id: 'comment-existing',
      p_retry_count: 2,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('threads a publisher detail into p_detail, and omits p_detail when no detail was supplied', async () => {
    const item = await makeItem();
    const withDetail = mapPublishOutcomeToSettleArgs(item, {
      status: 'published',
      externalPostId: 'post-1',
      detail: { containerId: 'container-9' },
    });
    expect(withDetail.p_detail).toEqual({ containerId: 'container-9' });

    const withoutDetail = mapPublishOutcomeToSettleArgs(item, {
      status: 'published',
      externalPostId: 'post-1',
    });
    expect('p_detail' in withoutDetail).toBe(false);
  });

  it('defers without publishing while the destination is in cooldown, delaying until the cooldown ends', async () => {
    const item = await makeItem();
    const cooldownEnd = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { status: 'rate_limited', next_allowed_publish_at: cooldownEnd },
    });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'deferred',
      p_error_code: DEFER_DESTINATION_COOLDOWN_CODE,
      // No publish attempt was made: the retry budget is untouched.
      p_retry_count: 0,
    });
    const delay = settleCalls[0]?.p_retry_delay_seconds as number;
    expect(delay).toBeGreaterThan(500);
    expect(delay).toBeLessThanOrEqual(600);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('defers without publishing when the destination is no longer claimable', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { status: 'disconnected' },
    });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'deferred',
      p_error_code: DEFER_DESTINATION_NOT_ACTIVE_CODE,
      p_retry_delay_seconds: DEFAULT_RETRY_DELAY_SECONDS,
      p_retry_count: 0,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('defers without publishing when the account is not active', async () => {
    const item = await makeItem();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      account: { status: 'expired' },
    });
    const publisher = fakePublisher('facebook', async () => ({ status: 'published' }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'deferred',
      p_error_code: DEFER_ACCOUNT_NOT_ACTIVE_CODE,
      p_retry_count: 0,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('settles a publisher deferral via the deferred outcome with the retry count unchanged (spec 139 defer outcome)', async () => {
    const item = await makeItem({ retry_count: 2 });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'deferred',
      error: {
        kind: 'retryable',
        code: 'publishing_limit_reached',
        message: 'This account has reached its publishing limit for now.',
      },
      retryDelaySeconds: 3600,
      detail: { platform: 'facebook', publishingLimit: { usage: 50 } },
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'deferred',
      p_error_code: 'publishing_limit_reached',
      p_retry_delay_seconds: 3600,
      // The deferral is not the item's fault: the count is NOT advanced.
      p_retry_count: 2,
      p_detail: { platform: 'facebook', publishingLimit: { usage: 50 } },
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('repeated deferrals never advance the retry count, while a real retry does (spec 139 defer outcome)', async () => {
    const item = await makeItem({ retry_count: 2 });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const deferring = fakePublisher('facebook', async () => ({
      status: 'deferred',
      error: {
        kind: 'retryable',
        code: 'publishing_limit_reached',
        message: 'This account has reached its publishing limit for now.',
      },
      retryDelaySeconds: 3600,
    }));

    // Three consecutive claim → publish → defer cycles. The mock row
    // keeps retry_count = 2 because the real RPC's deferred branch
    // leaves the stored count untouched (proven in the settle-rpc rig);
    // the worker must therefore hand the RPC the same count every time.
    for (let pass = 0; pass < 3; pass += 1) {
      const message = fakeMessage({
        itemId: item.id,
        platform: 'facebook',
        lane: 'publish-fast',
      });
      await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
        db: db as never,
        registry: registryWith(deferring),
        masterKey: MASTER_KEY,
        env: {},
      });
      expect(message.ack).toHaveBeenCalledTimes(1);
    }

    expect(settleCalls).toHaveLength(3);
    for (const call of settleCalls) {
      expect(call).toMatchObject({
        p_outcome_status: 'deferred',
        p_retry_count: 2,
      });
    }

    // Control: a genuine failed attempt DOES advance the count.
    const retrying = fakePublisher('facebook', async () => ({
      status: 'retry',
      error: { kind: 'retryable', code: 'transient', message: 'boom' },
      retryDelaySeconds: 300,
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });
    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(retrying),
      masterKey: MASTER_KEY,
      env: {},
    });
    expect(settleCalls).toHaveLength(4);
    expect(settleCalls[3]).toMatchObject({
      p_outcome_status: 'queued',
      p_retry_count: 3,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('still publishes when a rate_limited destination cooldown has already elapsed (claim-mirroring)', async () => {
    const item = await makeItem();
    const elapsed = new Date(Date.now() - 60 * 1000).toISOString();
    const { db, settleCalls } = await makeConsumerDb({
      item,
      destination: { status: 'rate_limited', next_allowed_publish_at: elapsed },
    });
    const publisher = fakePublisher('facebook', async () => ({
      status: 'published',
      externalPostId: 'post-after-cooldown',
    }));
    const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

    await handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      env: {},
    });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(settleCalls[0]).toMatchObject({
      p_outcome_status: 'published',
      p_external_post_id: 'post-after-cooldown',
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('captures a PostHog exception when publish processing throws (previously console-only)', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(init?.body ?? '');
        return { ok: true };
      })
    );
    try {
      const item = await makeItem();
      const { db } = await makeConsumerDb({ item });
      const publisher = fakePublisher('facebook', async () => {
        throw new Error('unexpected boom');
      });
      const message = fakeMessage({ itemId: item.id, platform: 'facebook', lane: 'publish-fast' });

      await expect(
        handlePublishBatch(fakeBatch('publish-fast', [message]) as never, {
          db: db as never,
          registry: registryWith(publisher),
          masterKey: MASTER_KEY,
          env: { POSTHOG_KEY: 'test-key' },
        })
      ).rejects.toThrow('unexpected boom');
      expect(message.ack).not.toHaveBeenCalled();
      expect(
        bodies.some((b) => b.includes('$exception') && b.includes('publish_message_failed'))
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ==========================================
// DLQ consumers
// ==========================================

describe('DLQ consumers (spec 121)', () => {
  const fetchCalls: string[] = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        fetchCalls.push(init?.body ?? '');
        return { ok: true };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles a non-terminal DLQ item failed with the DLQ reason, raises PostHog, counts the heartbeat DLQ counter, and acks', async () => {
    const item = await makeItem({ status: 'publishing' });
    const { db, settleCalls, upserts } = await makeConsumerDb({ item });
    const message = fakeMessage(
      { itemId: item.id, platform: 'facebook', lane: 'publish-fast' },
      4
    );

    await handleDlqBatch(fakeBatch('publish-fast-dlq', [message]) as never, {
      db: db as never,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({
      p_queue_item_id: ITEM_ID,
      p_outcome_status: 'failed',
      p_error_code: DLQ_ERROR_CODE,
    });
    expect(String(settleCalls[0]?.p_error_message)).toContain('publish-fast-dlq');
    // PostHog $exception raised for the DLQ arrival.
    expect(fetchCalls.some((body) => body.includes('$exception'))).toBe(true);
    // Heartbeat DLQ counter written counts-only.
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_dlq_fast).toBe(1);
    expect(upserts[0]?.last_run_at).toBeUndefined();
  });

  it('does not re-settle an already-terminal DLQ item but still acks and raises PostHog', async () => {
    const item = await makeItem({ status: 'failed' });
    const { db, settleCalls } = await makeConsumerDb({ item });
    const message = fakeMessage(
      { itemId: item.id, platform: 'facebook', lane: 'publish-heavy' },
      4
    );

    await handleDlqBatch(fakeBatch('publish-heavy-dlq', [message]) as never, {
      db: db as never,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(settleCalls).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(fetchCalls.some((body) => body.includes('$exception'))).toBe(true);
  });

  it('acks a DLQ message even when its settlement attempt fails', async () => {
    const item = await makeItem({ status: 'publishing' });
    const { db } = await makeConsumerDb({ item, settleError: new Error('db down') });
    const message = fakeMessage(
      { itemId: item.id, platform: 'facebook', lane: 'publish-fast' },
      4
    );

    await expect(
      handleDlqBatch(fakeBatch('publish-fast-dlq', [message]) as never, {
        db: db as never,
        env: { POSTHOG_KEY: 'test-key' },
      })
    ).resolves.toBeUndefined();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('does not settle a DLQ item the recovery sweep already reclaimed to queued, and writes no DLQ heartbeat count', async () => {
    const item = await makeItem({ status: 'queued' });
    const { db, settleCalls, upserts } = await makeConsumerDb({ item });
    const message = fakeMessage(
      { itemId: item.id, platform: 'facebook', lane: 'publish-fast' },
      4
    );

    await handleDlqBatch(fakeBatch('publish-fast-dlq', [message]) as never, {
      db: db as never,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(settleCalls).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    // Stale arrivals are not settlements: no counts-only heartbeat write.
    expect(upserts).toHaveLength(0);
    // The arrival itself is still loud.
    expect(fetchCalls.some((body) => body.includes('$exception'))).toBe(true);
  });

  it('counts only actual settlements in the heartbeat DLQ counter for a mixed batch', async () => {
    const live = await makeItem({ id: ITEM_LIVE_ID, status: 'publishing' });
    const done = await makeItem({ id: ITEM_DONE_ID, status: 'published' });
    const { db, settleCalls, upserts } = await makeConsumerDb({
      item: live,
      extraItems: [done],
    });
    const liveMsg = fakeMessage(
      { itemId: live.id, platform: 'facebook', lane: 'publish-fast' },
      4
    );
    const doneMsg = fakeMessage(
      { itemId: done.id, platform: 'facebook', lane: 'publish-fast' },
      4
    );

    await handleDlqBatch(fakeBatch('publish-fast-dlq', [liveMsg, doneMsg]) as never, {
      db: db as never,
      env: { POSTHOG_KEY: 'test-key' },
    });

    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]).toMatchObject({ p_queue_item_id: ITEM_LIVE_ID });
    expect(liveMsg.ack).toHaveBeenCalledTimes(1);
    expect(doneMsg.ack).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_dlq_fast).toBe(1);
  });
});

// ==========================================
// Heartbeat lane counters
// ==========================================

describe('Heartbeat lane counters (spec 121)', () => {
  function captureDb(error: unknown = null) {
    const upserts: Record<string, unknown>[] = [];
    return {
      upserts,
      db: {
        from: vi.fn(() => ({
          upsert: vi.fn(async (row: Record<string, unknown>) => {
            upserts.push(row);
            return { error };
          }),
        })),
      },
    };
  }

  it('writes per-lane enqueued counters on a full tick record', async () => {
    const { db, upserts } = captureDb();
    const ok = await recordHeartbeat(db as never, {
      success: true,
      claimed: 12,
      enqueuedFast: 9,
      enqueuedHeavy: 3,
    });
    expect(ok).toBe(true);
    expect(upserts[0]).toMatchObject({
      last_claimed_count: 12,
      last_enqueued_fast: 9,
      last_enqueued_heavy: 3,
    });
  });

  it('full tick writes omit last_settled_count when unset, preserving consumer counts (spec 139)', async () => {
    const { db, upserts } = captureDb();
    await recordHeartbeat(db as never, {
      success: true,
      claimed: 5,
      enqueuedFast: 5,
    });
    expect(upserts[0]?.last_claimed_count).toBe(5);
    expect('last_settled_count' in (upserts[0] ?? {})).toBe(false);
  });

  it('full tick writes still carry last_settled_count when explicitly supplied (spec 139)', async () => {
    const { db, upserts } = captureDb();
    await recordHeartbeat(db as never, {
      success: true,
      claimed: 5,
      settled: 7,
    });
    expect(upserts[0]?.last_settled_count).toBe(7);
  });

  it('counts-only writes touch only the counters they carry', async () => {
    const { db, upserts } = captureDb();
    await recordHeartbeat(db as never, {
      success: true,
      countsOnly: true,
      dlqHeavy: 2,
    });
    expect(upserts[0]?.last_dlq_heavy).toBe(2);
    expect(upserts[0]?.last_run_at).toBeUndefined();
    expect(upserts[0]?.last_success_at).toBeUndefined();
    expect(upserts[0]?.last_claimed_count).toBeUndefined();
  });

  it('swallows heartbeat write errors (e.g. lane columns not yet migrated) without throwing', async () => {
    const { db } = captureDb(new Error('column last_enqueued_fast does not exist'));
    await expect(
      recordHeartbeat(db as never, { success: true, claimed: 1, enqueuedFast: 1 })
    ).resolves.toBe(false);
  });
});
