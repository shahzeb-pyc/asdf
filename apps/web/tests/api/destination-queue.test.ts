import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, type DatabaseClient } from '@fbuploadpro/contracts';
import { handleDestinationPublishNow } from '@/app/api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]/publish-now/route';
import { handleDestinationRetry } from '@/app/api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]/retry/route';

/**
 * Unified destination queue routes (spec 134 PR-134-3, T24).
 *
 * K10: the list read + PATCH edit-save + DELETE describes were
 * removed with the routes they tested — no Pages UI called them
 * (the Pages section lists/edits through `publishing/queue`).
 * What remains here: publish-now + retry, still workspace /
 * destination-scoped on the unified `queue_items`, with the legacy
 * guards mirrored (published items immutable; retry only for failed
 * items, timed through the unified slot scheduler).
 */

const TEST_SECRET = ['destination','queue','test','secret','key'].join('-');

const userId = '11111111-1111-4111-a111-111111111111';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const otherWorkspaceId = '55555555-5555-4555-a555-555555555555';
const subdomain = 'acme';

const igDestinationId = '33333333-3333-4333-a333-333333333333';
const fbDestinationId = '66666666-6666-4666-a666-666666666666';
const foreignDestinationId = '88888888-8888-4888-a888-888888888888';
const slotId = '56565656-5656-4565-a656-565656565656';
const imageMediaId = '44444444-4444-4444-a444-444444444444';

interface DestinationRow {
  id: string;
  workspace_id: string;
  platform: string;
  timezone: string;
  status: string;
  rate_usage_pct: number;
  next_allowed_publish_at: string | null;
  metadata: Record<string, unknown> | null;
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
  link_url: string | null;
  platform_options: Record<string, unknown>;
  scheduled_time: string | null;
  slot_id: string | null;
  status: string;
  claimed_at: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  external_post_id: string | null;
  created_at: string;
  updated_at: string;
}

class FakeDb {
  destinations = new Map<string, DestinationRow>();
  slots: SlotRow[] = [];
  queueItems: QueueItemRow[] = [];
  media = new Map<
    string,
    {
      id: string;
      user_id: string;
      name: string;
      media_type: string;
      url: string;
      thumbnail_url: string | null;
      duration_seconds: number | null;
    }
  >();

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM workspaces')) {
      return params[0] === subdomain ? [{ id: workspaceId }] : [];
    }
    if (sql.includes('FROM destinations')) {
      const row = this.destinations.get(String(params[0]));
      return row && row.workspace_id === params[1] ? [row] : [];
    }
    if (sql.includes('SELECT scheduled_time') && sql.includes('FROM queue_items')) {
      return this.queueItems
        .filter((q) => q.destination_id === params[0] && q.status === 'queued')
        .map((q) => ({ scheduled_time: q.scheduled_time }));
    }
    if (sql.includes('FROM queue_items') && sql.includes('ORDER BY scheduled_time')) {
      return this.queueItems
        .filter((q) => q.workspace_id === params[0] && q.destination_id === params[1])
        .sort((a, b) => (a.scheduled_time ?? '').localeCompare(b.scheduled_time ?? ''));
    }
    if (sql.includes('FROM queue_items') && sql.includes('LIMIT 1')) {
      const row = this.queueItems.find(
        (q) =>
          q.workspace_id === params[0] &&
          q.destination_id === params[1] &&
          q.id === params[2]
      );
      return row ? [row] : [];
    }
    if (sql.includes('UPDATE queue_items')) {
      // R12: updateDestinationQueueItem now writes retry_count as
      // $12, shifting the WHERE params to $13/$14/$15.
      const row = this.queueItems.find(
        (q) =>
          q.id === params[12] &&
          q.workspace_id === params[13] &&
          q.destination_id === params[14]
      );
      if (!row) return [];
      row.caption = String(params[0]);
      row.title = (params[1] as string | null) ?? null;
      row.first_comment = (params[2] as string | null) ?? null;
      row.link_url = (params[3] as string | null) ?? null;
      row.kind = String(params[4]);
      row.platform_format = (params[5] as string | null) ?? null;
      row.platform_options = JSON.parse(String(params[6])) as Record<string, unknown>;
      // A nulled time stays null (publisher-driven posts carry no
      // stored time); the old String(null) stored the literal 'null'.
      row.scheduled_time = (params[7] as string | null) ?? null;
      row.slot_id = (params[8] as string | null) ?? null;
      row.status = String(params[9]);
      row.claimed_at = (params[10] as string | null) ?? null;
      row.retry_count = Number(params[11]);
      row.updated_at = new Date().toISOString();
      return [row];
    }
    if (sql.includes('DELETE FROM queue_items')) {
      this.queueItems = this.queueItems.filter(
        (q) =>
          !(
            q.id === params[0] &&
            q.workspace_id === params[1] &&
            q.destination_id === params[2]
          )
      );
      return [];
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
    return [];
  });
}

let db: FakeDb;
let dbClient: DatabaseClient;
let sessionCookie: string;
let seq = 0;

function makeItem(overrides: Partial<QueueItemRow>): QueueItemRow {
  seq += 1;
  return {
    id: `aaaaaaaa-aaaa-4aaa-aaaa-${String(seq).padStart(12, '0')}`,
    workspace_id: workspaceId,
    destination_id: igDestinationId,
    platform: 'instagram',
    kind: 'image',
    platform_format: null,
    caption: 'A post',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: new Date(Date.now() + 3_600_000).toISOString(),
    slot_id: null,
    status: 'queued',
    claimed_at: null,
    retry_count: 0,
    max_retries: 3,
    error_message: null,
    external_post_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function seed() {
  db.destinations.set(igDestinationId, {
    id: igDestinationId,
    workspace_id: workspaceId,
    platform: 'instagram',
    timezone: 'UTC',
    status: 'active',
    rate_usage_pct: 12,
    next_allowed_publish_at: null,
    metadata: null,
  });
  db.destinations.set(foreignDestinationId, {
    id: foreignDestinationId,
    workspace_id: otherWorkspaceId,
    platform: 'instagram',
    timezone: 'UTC',
    status: 'active',
    rate_usage_pct: 0,
    next_allowed_publish_at: null,
    metadata: null,
  });
  db.destinations.set(fbDestinationId, {
    id: fbDestinationId,
    workspace_id: workspaceId,
    platform: 'facebook',
    timezone: 'UTC',
    status: 'active',
    rate_usage_pct: 0,
    next_allowed_publish_at: null,
    metadata: null,
  });
  db.slots.push({
    id: slotId,
    destination_id: igDestinationId,
    kind: ['text', 'image', 'video', 'story', 'carousel'],
    time_of_day: '09:00:00',
    is_active: true,
  });
  db.media.set(imageMediaId, {
    id: imageMediaId,
    user_id: userId,
    name: 'photo.jpg',
    media_type: 'image',
    url: 'https://cdn.example.com/photo.jpg',
    thumbnail_url: 'https://cdn.example.com/photo-thumb.jpg',
    duration_seconds: null,
  });
}

function request(method: string, body?: unknown, cookie: string | null = sessionCookie) {
  return new NextRequest('http://localhost:3000/api/tenant/acme/destinations/x/queue', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.SESSION_SECRET = TEST_SECRET;
  db = new FakeDb();
  seq = 0;
  seed();
  dbClient = db as unknown as DatabaseClient;
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

describe('destination queue publish-now', () => {
  it('re-times the item to now and queues it', async () => {
    const item = makeItem({ scheduled_time: '2999-01-01T09:00:00.000Z' });
    db.queueItems.push(item);
    const before = Date.now();
    const res = await handleDestinationPublishNow(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toBe('Item dispatched for immediate publishing');
    const stored = db.queueItems[0];
    expect(stored?.status).toBe('queued');
    expect(new Date(stored?.scheduled_time ?? '').getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(stored?.scheduled_time ?? '').getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('refuses a published item (legacy guard)', async () => {
    const item = makeItem({ status: 'published' });
    db.queueItems.push(item);
    const res = await handleDestinationPublishNow(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ALREADY_PUBLISHED');
  });

  it('resets the retry budget when publishing now a failed item (R12)', async () => {
    const item = makeItem({ status: 'failed', retry_count: 3 });
    db.queueItems.push(item);
    const res = await handleDestinationPublishNow(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    expect(db.queueItems[0]?.status).toBe('queued');
    expect(db.queueItems[0]?.retry_count).toBe(0);
  });

  it('preserves the retry count when publishing now a queued item (R12)', async () => {
    const item = makeItem({ status: 'queued', retry_count: 0 });
    db.queueItems.push(item);
    const res = await handleDestinationPublishNow(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    expect(db.queueItems[0]?.retry_count).toBe(0);
  });
});

describe('destination queue retry', () => {
  it('requeues a failed slot-based post at the next vacant slot occurrence', async () => {
    const item = makeItem({
      status: 'failed',
      scheduled_time: '2000-01-01T09:00:00.000Z',
      slot_id: slotId,
      claimed_at: '2000-01-01T09:00:00.000Z',
    });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; scheduledTime: string; slotId: string };
    expect(body.status).toBe('queued');
    expect(body.slotId).toBe(slotId);
    expect(new Date(body.scheduledTime).getTime()).toBeGreaterThan(Date.now());
    expect(db.queueItems[0]?.claimed_at).toBeNull();
  });

  it('keeps a custom-scheduled failed post at its original future time', async () => {
    const future = '2999-03-04T15:30:00.000Z';
    const item = makeItem({ status: 'failed', scheduled_time: future, slot_id: null });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduledTime: string };
    expect(body.scheduledTime).toBe(future);
  });

  it('refuses to retry an item that is not failed', async () => {
    const item = makeItem({ status: 'queued' });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('ITEM_NOT_FAILED');
  });

  it('resets the retry budget on retry, so the row reads Retry 0 of 3 (R12)', async () => {
    const item = makeItem({
      status: 'failed',
      retry_count: 2,
      scheduled_time: '2000-01-01T09:00:00.000Z',
      slot_id: slotId,
      claimed_at: '2000-01-01T09:00:00.000Z',
    });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; retryCount: number; maxRetries: number };
    expect(body.status).toBe('queued');
    expect(body.retryCount).toBe(0);
    expect(body.maxRetries).toBe(3);
    expect(db.queueItems[0]?.retry_count).toBe(0);
  });

  it('returns a plain-language 400 when no slot covers the post', async () => {
    db.slots = [];
    const item = makeItem({ status: 'failed', scheduled_time: '2000-01-01T09:00:00.000Z' });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      igDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('NO_COVERING_SLOT');
    expect(body.message).toBe('No posting time covers this post yet.');
    expect(db.queueItems[0]?.status).toBe('failed');
  });

  it('retries a Facebook post with no stored time and no slot link', async () => {
    const item = makeItem({
      destination_id: fbDestinationId,
      platform: 'facebook',
      status: 'failed',
      scheduled_time: '2000-01-01T09:00:00.000Z',
      slot_id: slotId,
      claimed_at: '2000-01-01T09:00:00.000Z',
    });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      fbDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      scheduledTime: string | null;
      slotId: string | null;
    };
    expect(body.status).toBe('queued');
    // Publisher-driven: the retried post carries no time and no slot
    // link — it goes out at the next fitting posting time.
    expect(body.scheduledTime).toBeNull();
    expect(body.slotId).toBeNull();
    expect(db.queueItems[0]?.claimed_at).toBeNull();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('refresh_destination_unmatched_flag'),
      [fbDestinationId]
    );
  });

  it('blocks retry on a paused Facebook destination (409 PAGE_NOT_PUBLISHABLE, item stays failed)', async () => {
    const fb = db.destinations.get(fbDestinationId);
    if (fb) {
      fb.status = 'disconnected';
      fb.metadata = { fb_status: 'paused' };
    }
    const item = makeItem({
      destination_id: fbDestinationId,
      platform: 'facebook',
      status: 'failed',
      scheduled_time: '2000-01-01T09:00:00.000Z',
      slot_id: null,
      claimed_at: null,
    });
    db.queueItems.push(item);
    const res = await handleDestinationRetry(
      request('POST'),
      subdomain,
      fbDestinationId,
      item.id,
      dbClient
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PAGE_NOT_PUBLISHABLE');
    expect(db.queueItems[0]?.status).toBe('failed');
  });
});
