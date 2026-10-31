import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, type DatabaseClient } from '@fbuploadpro/contracts';
import { handleDestinationEnqueue } from '@/app/api/tenant/[subdomain]/publishing/destination-queue/route';
import { MockStorageProvider } from '../helpers/mock-storage';

const TEST_SECRET = ['destination', 'enqueue', 'test', 'secret', 'value'].join('-');

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '99999999-9999-4999-a999-999999999999';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const otherWorkspaceId = '55555555-5555-4555-a555-555555555555';
const subdomain = 'acme';

const igDestinationId = '33333333-3333-4333-a333-333333333333';
const ttDestinationId = '66666666-6666-4666-a666-666666666666';
const ytDestinationId = '77777777-7777-4777-a777-777777777777';
const foreignDestinationId = '88888888-8888-4888-a888-888888888888';
const imageMediaId = '44444444-4444-4444-a444-444444444444';
const videoMediaId = '12121212-1212-4212-a212-121212121212';
const foreignMediaId = '34343434-3434-4343-a434-343434343434';
const slotId = '56565656-5656-4565-a656-565656565656';

interface DestinationRow {
  id: string;
  workspace_id: string;
  platform: string;
  timezone: string;
  status: string;
  account_id: string;
  account_status: string;
  account_token_expires_at: string;
}

interface MediaRow {
  id: string;
  user_id: string;
  media_type: string;
  url: string;
  storage_key: string | null;
  file_size?: number | null;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
}

interface SlotRow {
  id: string;
  destination_id: string;
  kind: string[];
  time_of_day: string;
  is_active: boolean;
}

interface QueueItemRow {
  id: string;
  workspace_id: string;
  destination_id: string;
  platform: string;
  kind: string;
  platform_format: string | null;
  caption: string;
  title: string | null;
  first_comment: string | null;
  media_item_id: string | null;
  media_url: string | null;
  media_storage_key: string | null;
  platform_options: string;
  scheduled_time: string | null;
  slot_id: string | null;
  queue_seq: number;
  status: string;
  created_at: string;
}

class FakeDb {
  destinations = new Map<string, DestinationRow>();
  media = new Map<string, MediaRow>();
  slots: SlotRow[] = [];
  queueItems: QueueItemRow[] = [];
  private seq = 0;

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM workspaces')) {
      return params[0] === subdomain ? [{ id: workspaceId }] : [];
    }
    if (sql.includes('INSERT INTO queue_items')) {
      return [this.insertQueueItem(params)];
    }
    if (sql.includes('FROM destinations')) {
      const row = this.destinations.get(String(params[0]));
      return row && row.workspace_id === params[1] ? [row] : [];
    }
    if (sql.includes('FROM media_items')) {
      const ids = params[1] as string[];
      return [...this.media.values()].filter(
        (m) => m.user_id === params[0] && ids.includes(m.id)
      );
    }
    if (sql.includes('FROM posting_slots')) {
      return this.slots.filter((s) => s.destination_id === params[0]);
    }
    if (sql.includes('FROM queue_items')) {
      return this.queueItems
        .filter((q) => q.destination_id === params[0] && q.status === 'queued')
        .map((q) => ({ scheduled_time: q.scheduled_time }));
    }
    return [];
  });

  private insertQueueItem(params: unknown[]): QueueItemRow {
    this.seq += 1;
    const row: QueueItemRow = {
      id: `aaaaaaaa-aaaa-4aaa-aaaa-${String(this.seq).padStart(12, '0')}`,
      workspace_id: String(params[0]),
      destination_id: String(params[1]),
      platform: String(params[2]),
      kind: String(params[3]),
      platform_format: (params[4] as string | null) ?? null,
      caption: String(params[5]),
      title: (params[6] as string | null) ?? null,
      first_comment: (params[7] as string | null) ?? null,
      media_item_id: (params[8] as string | null) ?? null,
      media_url: (params[9] as string | null) ?? null,
      media_storage_key: (params[10] as string | null) ?? null,
      platform_options: String(params[12]),
      scheduled_time: params[13] == null ? null : String(params[13]),
      slot_id: (params[14] as string | null) ?? null,
      queue_seq:
        Math.max(0, ...this.queueItems.filter((q) => q.destination_id === String(params[1])).map((q) => q.queue_seq)) + 1,
      status: 'queued',
      created_at: new Date().toISOString(),
    };
    this.queueItems.push(row);
    return row;
  }
}

let db: FakeDb;
let dbClient: DatabaseClient;
let sessionCookie: string;
let storage: MockStorageProvider;

function seed() {
  db.destinations.set(igDestinationId, {
    id: igDestinationId,
    workspace_id: workspaceId,
    platform: 'instagram',
    timezone: 'UTC',
    status: 'active',
    account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    account_status: 'active',
    account_token_expires_at: '2999-01-01T00:00:00.000Z',
  });
  db.destinations.set(ttDestinationId, {
    id: ttDestinationId,
    workspace_id: workspaceId,
    platform: 'tiktok',
    timezone: 'UTC',
    status: 'active',
    account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    account_status: 'active',
    account_token_expires_at: '2999-01-01T00:00:00.000Z',
  });
  db.destinations.set(ytDestinationId, {
    id: ytDestinationId,
    workspace_id: workspaceId,
    platform: 'youtube',
    timezone: 'UTC',
    status: 'active',
    account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    account_status: 'active',
    account_token_expires_at: '2999-01-01T00:00:00.000Z',
  });
  db.destinations.set(foreignDestinationId, {
    id: foreignDestinationId,
    workspace_id: otherWorkspaceId,
    platform: 'instagram',
    timezone: 'UTC',
    status: 'active',
    account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    account_status: 'active',
    account_token_expires_at: '2999-01-01T00:00:00.000Z',
  });
  db.media.set(imageMediaId, {
    id: imageMediaId,
    user_id: userId,
    media_type: 'image',
    url: 'https://cdn.example.com/photo.jpg',
    storage_key: 'media/photo.jpg',
  });
  db.media.set(videoMediaId, {
    id: videoMediaId,
    user_id: userId,
    media_type: 'video',
    url: 'https://cdn.example.com/clip.mp4',
    storage_key: 'media/clip.mp4',
  });
  db.media.set(foreignMediaId, {
    id: foreignMediaId,
    user_id: otherUserId,
    media_type: 'image',
    url: 'https://cdn.example.com/not-yours.jpg',
    storage_key: null,
  });
}

async function enqueue(
  body: unknown,
  cookie: string | null = sessionCookie,
  storageOverride?: MockStorageProvider
) {
  const store = storageOverride ?? storage;
  if (!storageOverride) {
    // Media/posting separation: the queue-time copy needs the
    // library bytes present in storage. Seed every byte the FakeDb
    // knows about (including rows seeded inside a test, like the
    // K6 media) so existing tests keep passing with the copy in
    // place. Tests that need a missing source pass their own empty
    // storage instance instead.
    for (const m of db.media.values()) {
      if (m.storage_key && !store.uploadedObjects.has(m.storage_key)) {
        await store.putObject({
          key: m.storage_key,
          body: new Uint8Array([1]),
          contentType: 'application/octet-stream',
        });
      }
    }
  }
  const req = new NextRequest(
    'http://localhost:3000/api/tenant/acme/publishing/destination-queue',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }
  );
  return handleDestinationEnqueue(req, subdomain, dbClient, store);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.SESSION_SECRET = TEST_SECRET;
  db = new FakeDb();
  seed();
  dbClient = db as unknown as DatabaseClient;
  storage = new MockStorageProvider();
  const token = await signSessionToken(
    {
      userId,
      email: 'alexander@gmail.com',
      name: 'Alex Acme',
      subdomain,
      role: 'user',
      status: 'active',
    },
    TEST_SECRET
  );
  sessionCookie = `fbup_session=${token}`;
});

describe('destination enqueue — auth and isolation', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await enqueue(
      {
        platform: 'instagram',
        destinationId: igDestinationId,
        kind: 'text',
        caption: 'x',
        intent: 'now',
      },
      null
    );
    expect(res.status).toBe(401);
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects a session from another tenant subdomain', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/other/publishing/destination-queue',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({
          platform: 'instagram',
          destinationId: igDestinationId,
          kind: 'image',
          mediaItemIds: [imageMediaId],
          intent: 'now',
        }),
      }
    );
    const res = await handleDestinationEnqueue(req, 'other', dbClient);
    expect(res.status).toBe(403);
  });

  it('hides destinations that belong to another workspace', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: foreignDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(404);
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects a platform that disagrees with the destination (no spoofing)', async () => {
    const res = await enqueue({
      platform: 'facebook',
      destinationId: igDestinationId,
      kind: 'text',
      caption: 'Hello',
      intent: 'now',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('PLATFORM_MISMATCH');
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects media owned by another user', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [foreignMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(404);
    expect(db.queueItems).toHaveLength(0);
  });
});

describe('destination enqueue — intent → row state', () => {
  it('post-now inserts a queued row claimable immediately', async () => {
    const before = Date.now();
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      caption: 'A photo',
      mediaItemIds: [imageMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      status: string;
      slotId: string | null;
      scheduledTime: string;
    };
    expect(payload.status).toBe('queued');
    expect(payload.slotId).toBeNull();
    expect(new Date(payload.scheduledTime).getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(db.queueItems).toHaveLength(1);
    const row = db.queueItems[0]!;
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.destination_id).toBe(igDestinationId);
    expect(row.media_item_id).toBe(imageMediaId);
    // Denormalised snapshot the claim RPC reads.
    expect(row.media_url).toBe('https://cdn.example.com/photo.jpg');
    expect(row.media_storage_key).toBe('media/photo.jpg');
  });

  it('scheduled inserts a queued row held at the requested time', async () => {
    const at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      intent: 'scheduled',
      scheduledAt: at,
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { scheduledTime: string };
    expect(payload.scheduledTime).toBe(at);
    expect(db.queueItems[0]!.scheduled_time).toBe(at);
  });

  it('queue resolves the next vacant posting slot, then advances a day', async () => {
    // A daily slot two hours from now (UTC), so today's occurrence is next.
    const slotTime = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const timeOfDay = slotTime.toISOString().slice(11, 19);
    db.slots.push({
      id: slotId,
      destination_id: igDestinationId,
      kind: ['text', 'image', 'video', 'story', 'carousel'],
      time_of_day: timeOfDay,
      is_active: true,
    });

    const body = {
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
    };
    const first = await enqueue(body);
    expect(first.status).toBe(201);
    const firstPayload = (await first.json()) as {
      scheduledTime: string;
      slotId: string | null;
    };
    expect(firstPayload.slotId).toBe(slotId);
    expect(firstPayload.scheduledTime.slice(11, 19)).toBe(timeOfDay);

    const second = await enqueue(body);
    expect(second.status).toBe(201);
    const secondPayload = (await second.json()) as { scheduledTime: string };
    const delta =
      new Date(secondPayload.scheduledTime).getTime() -
      new Date(firstPayload.scheduledTime).getTime();
    expect(delta).toBe(24 * 60 * 60 * 1000);
  });

  it('queue without any active slots fails plainly', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('NO_SLOTS_CONFIGURED');
  });

  it('queue with a pinned slot from another destination is not found', async () => {
    db.slots.push({
      id: slotId,
      destination_id: ttDestinationId,
      kind: ['video'],
      time_of_day: '10:00:00',
      is_active: true,
    });
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
      slotId,
    });
    expect(res.status).toBe(404);
  });
});

describe('destination enqueue — per-platform validation', () => {
  it('rejects a TikTok isDraft smuggle', async () => {
    const res = await enqueue({
      platform: 'tiktok',
      destinationId: ttDestinationId,
      kind: 'video',
      mediaItemIds: [videoMediaId],
      intent: 'now',
      platformOptions: { isDraft: true },
    });
    expect(res.status).toBe(400);
    expect(db.queueItems).toHaveLength(0);
  });

  it('stores the resolved TikTok options (privacy default materialised)', async () => {
    const res = await enqueue({
      platform: 'tiktok',
      destinationId: ttDestinationId,
      kind: 'video',
      mediaItemIds: [videoMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(db.queueItems[0]!.platform_options)).toEqual({
      privacy: 'public',
    });
  });

  it('rejects a YouTube enqueue whose options omit the audience declaration', async () => {
    const res = await enqueue({
      platform: 'youtube',
      destinationId: ytDestinationId,
      kind: 'video',
      title: 'Launch video',
      mediaItemIds: [videoMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(400);
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects media whose type disagrees with the post kind', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      mediaItemIds: [videoMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('INVALID_FORMAT');
  });
});

describe('destination enqueue — facebook publisher-driven intents', () => {
  const fbDestinationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

  function seedFacebook() {
    db.destinations.set(fbDestinationId, {
      id: fbDestinationId,
      workspace_id: workspaceId,
      platform: 'facebook',
      timezone: 'UTC',
      status: 'active',
      account_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
      account_status: 'active',
      account_token_expires_at: '2999-01-01T00:00:00.000Z',
    });
  }

  it('rejects a fixed-date scheduled intent (one-offs do not exist)', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'text',
      caption: 'Hello',
      intent: 'scheduled',
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('ONE_OFF_NOT_SUPPORTED');
    expect(db.queueItems).toHaveLength(0);
  });

  it('queues with no stored time and no slot link, even with zero active times', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'text',
      caption: 'Hello',
      intent: 'queue',
      slotId,
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      scheduledTime: string | null;
      slotId: string | null;
    };
    // The pinned slotId is ignored: Facebook posts carry no slot link.
    expect(payload.scheduledTime).toBeNull();
    expect(payload.slotId).toBeNull();
    const row = db.queueItems[0]!;
    expect(row.scheduled_time).toBeNull();
    expect(row.slot_id).toBeNull();
    expect(row.queue_seq).toBe(1);
  });

  it('keeps immediate posts working (now is not a one-off date)', async () => {
    seedFacebook();
    const before = Date.now();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'text',
      caption: 'Hello now',
      intent: 'now',
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { scheduledTime: string };
    expect(new Date(payload.scheduledTime).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('destination enqueue — expired-account gate (BG1)', () => {
  const expiredDestinationId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
  const lapsedDestinationId = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';

  function seedExpired() {
    db.destinations.set(expiredDestinationId, {
      id: expiredDestinationId,
      workspace_id: workspaceId,
      platform: 'instagram',
      timezone: 'UTC',
      status: 'active',
      account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      account_status: 'expired',
      account_token_expires_at: '2020-01-01T00:00:00.000Z',
    });
    db.destinations.set(lapsedDestinationId, {
      id: lapsedDestinationId,
      workspace_id: workspaceId,
      platform: 'instagram',
      timezone: 'UTC',
      status: 'active',
      account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      account_status: 'active',
      account_token_expires_at: '2020-01-01T00:00:00.000Z',
    });
  }

  it('rejects queueing to a stored-expired account and writes nothing', async () => {
    seedExpired();
    const res = await enqueue({
      platform: 'instagram',
      destinationId: expiredDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      caption: 'x',
      intent: 'now',
    });
    const payload = (await res.json()) as { error: string; message: string };
    expect(res.status).toBe(409);
    expect(payload.error).toBe('ACCOUNT_EXPIRED');
    expect(payload.message).toMatch(/Reconnect/);
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects queueing to a revoked account with a distinct error and writes nothing', async () => {
    const revokedDestinationId = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
    db.destinations.set(revokedDestinationId, {
      id: revokedDestinationId,
      workspace_id: workspaceId,
      platform: 'instagram',
      timezone: 'UTC',
      status: 'active',
      account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      account_status: 'revoked',
      account_token_expires_at: '2999-01-01T00:00:00.000Z',
    });
    const res = await enqueue({
      platform: 'instagram',
      destinationId: revokedDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      caption: 'x',
      intent: 'now',
    });
    const payload = (await res.json()) as { error: string; message: string };
    expect(res.status).toBe(409);
    expect(payload.error).toBe('ACCOUNT_REVOKED');
    expect(payload.message).toMatch(/Reconnect/);
    expect(db.queueItems).toHaveLength(0);
  });

  it('rejects queueing when the token has lapsed even though the stored status is still active', async () => {
    seedExpired();
    const res = await enqueue({
      platform: 'instagram',
      destinationId: lapsedDestinationId,
      kind: 'image',
      mediaItemIds: [imageMediaId],
      caption: 'x',
      intent: 'now',
    });
    expect(res.status).toBe(409);
    expect(db.queueItems).toHaveLength(0);
  });
});

describe('destination enqueue — facebook format gates (K6, K7)', () => {
  const fbDestinationId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const longVideoId = '10101010-1010-4101-a010-101010101010';
  const shortVideoId = '20202020-2020-4202-a020-202020202020';
  const bigImageId = '30303030-3030-4303-a030-303030303030';
  const longStoryVideoId = '40404040-4040-4404-a040-404040404040';

  function seedFacebookMedia() {
    db.destinations.set(fbDestinationId, {
      id: fbDestinationId,
      workspace_id: workspaceId,
      platform: 'facebook',
      timezone: 'UTC',
      status: 'active',
      // BG1 gate: the account must be live, or the enqueue is
      // refused 409 before the K6 format validation ever runs.
      account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      account_status: 'active',
      account_token_expires_at: '2999-01-01T00:00:00.000Z',
    });
    db.media.set(longVideoId, {
      id: longVideoId,
      user_id: userId,
      media_type: 'video',
      url: 'https://cdn.example.com/long.mp4',
      storage_key: 'media/long.mp4',
      duration_seconds: 120,
      aspect_ratio: '9:16',
    });
    db.media.set(shortVideoId, {
      id: shortVideoId,
      user_id: userId,
      media_type: 'video',
      url: 'https://cdn.example.com/short.mp4',
      storage_key: 'media/short.mp4',
      duration_seconds: 45,
      aspect_ratio: '9:16',
    });
    db.media.set(bigImageId, {
      id: bigImageId,
      user_id: userId,
      media_type: 'image',
      url: 'https://cdn.example.com/big.jpg',
      storage_key: 'media/big.jpg',
      file_size: 11 * 1024 * 1024,
    });
    db.media.set(longStoryVideoId, {
      id: longStoryVideoId,
      user_id: userId,
      media_type: 'video',
      url: 'https://cdn.example.com/story-long.mp4',
      storage_key: 'media/story-long.mp4',
      duration_seconds: 61,
    });
  }

  it('K7: refuses a Facebook carousel at enqueue with the worker error', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'carousel',
      caption: 'Carousel',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Unsupported post format: carousel');
    expect(db.queueItems).toHaveLength(0);
  });

  it('K6: refuses a reel over 90 seconds at enqueue', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'video',
      platformFormat: 'reel',
      caption: 'Too long reel',
      mediaItemIds: [longVideoId],
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; message: string };
    expect(payload.error).toBe('INVALID_FORMAT');
    expect(payload.message).toContain('90 seconds');
    expect(db.queueItems).toHaveLength(0);
  });

  it('K6: accepts a reel within 90 seconds', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'video',
      platformFormat: 'reel',
      caption: 'Short reel',
      mediaItemIds: [shortVideoId],
      intent: 'queue',
    });
    expect(res.status).toBe(201);
    expect(db.queueItems).toHaveLength(1);
  });

  it('K6: refuses a story photo over 10 MB at enqueue', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'story',
      caption: 'Big story',
      mediaItemIds: [bigImageId],
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('INVALID_FORMAT');
    expect(db.queueItems).toHaveLength(0);
  });

  it('K6: refuses a story video over 60 seconds at enqueue', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'story',
      caption: 'Long story',
      mediaItemIds: [longStoryVideoId],
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('INVALID_FORMAT');
    expect(db.queueItems).toHaveLength(0);
  });

  it('K6: unknown media facts do not fail a post (validator semantics)', async () => {
    seedFacebookMedia();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'video',
      platformFormat: 'reel',
      caption: 'Unknown duration reel',
      mediaItemIds: [videoMediaId],
      intent: 'queue',
    });
    expect(res.status).toBe(201);
    expect(db.queueItems).toHaveLength(1);
  });
});

describe('destination enqueue — media/posting separation', () => {
  const fbDestinationId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  const stagedKey = `users/${userId}/post-staging/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/clip.mp4`;

  function seedFacebook() {
    db.destinations.set(fbDestinationId, {
      id: fbDestinationId,
      workspace_id: workspaceId,
      platform: 'facebook',
      timezone: 'UTC',
      status: 'active',
      account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      account_status: 'active',
      account_token_expires_at: '2999-01-01T00:00:00.000Z',
    });
  }

  it('a library import queues a post-owned copy and drops the library link', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'image',
      caption: 'From the library',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
    });
    expect(res.status).toBe(201);
    expect(db.queueItems).toHaveLength(1);
    const row = db.queueItems[0];
    // The invariant: no library link, post-owned key + URL only.
    expect(row.media_item_id).toBeNull();
    expect(row.media_storage_key).toMatch(
      new RegExp(`^users/${userId}/post-media/[^/]+/photo\\.jpg$`)
    );
    expect(row.media_url).toBe(
      storage.getPublicUrl(row.media_storage_key as string)
    );
    // The copy exists in storage next to the untouched library bytes.
    expect(storage.uploadedObjects.has(row.media_storage_key as string)).toBe(true);
    expect(storage.uploadedObjects.has('media/photo.jpg')).toBe(true);
  });

  it('deleting the library file after queueing leaves the queued post intact', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'image',
      caption: 'From the library',
      mediaItemIds: [imageMediaId],
      intent: 'queue',
    });
    expect(res.status).toBe(201);
    const row = db.queueItems[0];
    // Simulate the library delete: bytes + row gone.
    await storage.deleteObject('media/photo.jpg');
    db.media.delete(imageMediaId);
    // The queued post still resolves to live bytes — it is
    // publishable, not collateral of the library delete.
    expect(row.media_item_id).toBeNull();
    expect(storage.uploadedObjects.has(row.media_storage_key as string)).toBe(true);
    expect(row.media_url).toBe(
      storage.getPublicUrl(row.media_storage_key as string)
    );
  });

  it('a failed library copy fails loud with no row written', async () => {
    seedFacebook();
    // Empty storage: the library bytes are absent, so the copy
    // cannot run. The enqueue must fail, not queue a dead link.
    const emptyStorage = new MockStorageProvider();
    const res = await enqueue(
      {
        platform: 'facebook',
        destinationId: fbDestinationId,
        kind: 'image',
        caption: 'From the library',
        mediaItemIds: [imageMediaId],
        intent: 'queue',
      },
      sessionCookie,
      emptyStorage
    );
    expect(res.status).toBe(500);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('MEDIA_COPY_FAILED');
    expect(db.queueItems).toHaveLength(0);
  });

  it('a composer staged upload is adopted as-is, never copied, never linked', async () => {
    seedFacebook();
    await storage.putObject({
      key: stagedKey,
      body: new Uint8Array([1]),
      contentType: 'video/mp4',
    });
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'video',
      platformFormat: 'reel',
      caption: 'From my device',
      mediaItemIds: [],
      stagedMedia: {
        storageKey: stagedKey,
        mediaType: 'video',
        durationSeconds: 45,
        aspectRatio: '9:16',
      },
      intent: 'queue',
    });
    expect(res.status).toBe(201);
    expect(db.queueItems).toHaveLength(1);
    const row = db.queueItems[0];
    expect(row.media_item_id).toBeNull();
    expect(row.media_storage_key).toBe(stagedKey);
    expect(row.media_url).toBe(storage.getPublicUrl(stagedKey));
    // No post-media copy was made for an already post-owned key.
    const postMediaKeys = [...storage.uploadedObjects.keys()].filter((k) =>
      k.includes('/post-media/')
    );
    expect(postMediaKeys).toHaveLength(0);
  });

  it('staged media with a library key is rejected', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'image',
      caption: 'Forged staged key',
      mediaItemIds: [],
      stagedMedia: { storageKey: 'media/photo.jpg', mediaType: 'image' },
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('INVALID_STAGED_MEDIA');
    expect(db.queueItems).toHaveLength(0);
  });

  it("staged media under another user's prefix is rejected", async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'image',
      caption: 'Not mine',
      mediaItemIds: [],
      stagedMedia: {
        storageKey: `users/${otherUserId}/post-staging/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg`,
        mediaType: 'image',
      },
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('INVALID_STAGED_MEDIA');
    expect(db.queueItems).toHaveLength(0);
  });

  it('staged media for a non-Facebook destination is rejected', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      caption: 'Staged to IG',
      mediaItemIds: [],
      stagedMedia: { storageKey: stagedKey, mediaType: 'image' },
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('STAGED_MEDIA_FACEBOOK_ONLY');
    expect(db.queueItems).toHaveLength(0);
  });

  it('staged media whose bytes are gone is rejected, not queued dead', async () => {
    seedFacebook();
    const res = await enqueue({
      platform: 'facebook',
      destinationId: fbDestinationId,
      kind: 'video',
      platformFormat: 'reel',
      caption: 'Swept draft',
      mediaItemIds: [],
      stagedMedia: {
        storageKey: stagedKey,
        mediaType: 'video',
        durationSeconds: 45,
        aspectRatio: '9:16',
      },
      intent: 'queue',
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('STAGED_MEDIA_NOT_FOUND');
    expect(db.queueItems).toHaveLength(0);
  });

  it('a non-Facebook destination keeps the historical library-linked row', async () => {
    const res = await enqueue({
      platform: 'instagram',
      destinationId: igDestinationId,
      kind: 'image',
      caption: 'IG still linked',
      mediaItemIds: [imageMediaId],
      intent: 'now',
    });
    expect(res.status).toBe(201);
    expect(db.queueItems).toHaveLength(1);
    const row = db.queueItems[0];
    expect(row.media_item_id).toBe(imageMediaId);
    expect(row.media_storage_key).toBe('media/photo.jpg');
    expect(row.media_url).toBe('https://cdn.example.com/photo.jpg');
  });
});
