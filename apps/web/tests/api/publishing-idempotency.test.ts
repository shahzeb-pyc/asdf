import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  IDEMPOTENCY_KEY_HEADER,
  signSessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { handleDestinationEnqueue } from '@/app/api/tenant/[subdomain]/publishing/destination-queue/route';
import { handlePublishNow } from '@/app/api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now/route';
import { handleDestinationPublishNow } from '@/app/api/tenant/[subdomain]/destinations/[destinationId]/queue/[itemId]/publish-now/route';
import { parseIdempotencyKeyHeader } from '@/lib/publishing/idempotency';

/**
 * Publishing idempotency keys: a retry with a known key returns
 * the stored response without re-executing. These tests prove the
 * response-lost case end to end at the route level — first call
 * succeeds, second call with the same key replays the ORIGINAL
 * result and creates no duplicate — plus the boundaries: a
 * different key executes, an expired key executes, another user's
 * or workspace's key never replays, an invalid key is rejected,
 * and a failed request stores nothing.
 */

const TEST_SECRET = 'test-secret-for-idempotency-tests';

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '99999999-9999-4999-a999-999999999999';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const otherWorkspaceId = '55555555-5555-4555-a555-555555555555';
const subdomain = 'acme';

const fbDestinationId = '66666666-6666-4666-a666-666666666666';
const queueItemId = '77777777-7777-4777-a777-777777777777';

const KEY_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2';

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
  platform_options: string;
  scheduled_time: string | null;
  slot_id: string | null;
  queue_seq: number;
  status: string;
  claimed_at: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  external_post_id: string | null;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  workspace_id: string;
  user_id: string;
  action: string;
  idempotency_key: string;
  response_status: number;
  response_body: unknown;
  expires_at: string;
}

function fullQueueItemRow(partial: Partial<QueueItemRow>): QueueItemRow {
  return {
    id: queueItemId,
    workspace_id: workspaceId,
    destination_id: fbDestinationId,
    platform: 'facebook',
    kind: 'text',
    platform_format: null,
    caption: 'seeded-item',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: '{}',
    scheduled_time: null,
    slot_id: null,
    queue_seq: 1,
    status: 'queued',
    claimed_at: null,
    retry_count: 0,
    max_retries: 3,
    error_message: null,
    external_post_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

class FakeDb {
  destinations = new Map<
    string,
    {
      id: string;
      workspace_id: string;
      platform: string;
      timezone: string;
      status: string;
      rate_usage_pct: number;
      next_allowed_publish_at: string | null;
      metadata: Record<string, unknown> | null;
    }
  >();
  queueItems: QueueItemRow[] = [];
  idempotencyKeys: IdempotencyRow[] = [];
  private seq = 0;

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // Idempotency store.
    if (sql.includes('FROM idempotency_keys')) {
      const now = new Date().toISOString();
      const row = this.idempotencyKeys.find(
        (r) =>
          r.workspace_id === params[0] &&
          r.user_id === params[1] &&
          r.action === params[2] &&
          r.idempotency_key === params[3] &&
          r.expires_at > now
      );
      return row
        ? [
            {
              response_status: row.response_status,
              response_body: row.response_body,
            },
          ]
        : [];
    }
    if (sql.includes('INSERT INTO idempotency_keys')) {
      const tuple = [params[0], params[1], params[2], params[3]].map(String);
      const exists = this.idempotencyKeys.some(
        (r) =>
          r.workspace_id === tuple[0] &&
          r.user_id === tuple[1] &&
          r.action === tuple[2] &&
          r.idempotency_key === tuple[3]
      );
      if (!exists) {
        this.idempotencyKeys.push({
          workspace_id: tuple[0],
          user_id: tuple[1],
          action: tuple[2],
          idempotency_key: tuple[3],
          response_status: Number(params[4]),
          response_body: JSON.parse(String(params[5])) as unknown,
          expires_at: String(params[6]),
        });
      }
      return [];
    }
    if (sql.includes('DELETE FROM idempotency_keys')) {
      const now = new Date().toISOString();
      this.idempotencyKeys = this.idempotencyKeys.filter(
        (r) =>
          !(
            r.workspace_id === params[0] &&
            r.user_id === params[1] &&
            r.expires_at < now
          )
      );
      return [];
    }
    if (sql.includes('FROM workspaces')) {
      if (params[0] !== subdomain) return [];
      // Admin lookup (subdomain only) or owner lookup (subdomain + owner).
      if (params.length === 1) return [{ id: workspaceId }];
      return params[1] === userId ? [{ id: workspaceId }] : [];
    }
    if (sql.includes('INSERT INTO queue_items')) {
      this.seq += 1;
      const row = fullQueueItemRow({
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
          Math.max(
            0,
            ...this.queueItems
              .filter((q) => q.destination_id === String(params[1]))
              .map((q) => q.queue_seq)
          ) + 1,
      });
      this.queueItems.push(row);
      return [row];
    }
    if (sql.includes('UPDATE queue_items')) {
      if (sql.includes('SET caption')) {
        // updateDestinationQueueItem: params[9]=status, [11]=id.
        const row = this.queueItems.find((q) => q.id === params[11]);
        if (!row) return [];
        row.caption = String(params[0]);
        row.status = String(params[9]);
        row.scheduled_time = params[7] == null ? null : String(params[7]);
        return [row];
      }
      // Publish-now legacy update: params[0]=id, [1]=workspace.
      const row = this.queueItems.find(
        (q) => q.id === params[0] && q.workspace_id === params[1]
      );
      if (row) {
        row.status = 'queued';
        row.scheduled_time = new Date().toISOString();
        row.claimed_at = null;
      }
      return [];
    }
    if (sql.includes('FROM destinations')) {
      const row = this.destinations.get(String(params[0]));
      return row && row.workspace_id === params[1] ? [row] : [];
    }
    if (sql.includes('FROM queue_items')) {
      if (sql.includes('SELECT destination_id')) {
        const row = this.queueItems.find(
          (q) => q.id === params[0] && q.workspace_id === params[1]
        );
        return row ? [{ destination_id: row.destination_id }] : [];
      }
      if (sql.includes('SELECT id, status')) {
        const row = this.queueItems.find(
          (q) => q.id === params[0] && q.workspace_id === params[1]
        );
        return row ? [{ id: row.id, status: row.status }] : [];
      }
      if (params.length === 3) {
        const row = this.queueItems.find(
          (q) =>
            q.workspace_id === params[0] &&
            q.destination_id === params[1] &&
            q.id === params[2]
        );
        return row ? [row] : [];
      }
      return this.queueItems
        .filter((q) => q.destination_id === params[0] && q.status === 'queued')
        .map((q) => ({ scheduled_time: q.scheduled_time }));
    }
    return [];
  });
}

let db: FakeDb;
let dbClient: DatabaseClient;
let sessionCookie: string;

function seed() {
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
  db.queueItems.push(fullQueueItemRow({}));
}

async function enqueue(
  body: unknown,
  key?: string,
  cookie: string | null = sessionCookie
) {
  const req = new NextRequest(
    'http://localhost:3000/api/tenant/acme/publishing/destination-queue',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}),
      },
      body: JSON.stringify(body),
    }
  );
  return handleDestinationEnqueue(req, subdomain, dbClient);
}

async function publishNow(
  itemId: string,
  key?: string,
  handler: 'publishing' | 'destination' = 'publishing'
) {
  const url =
    handler === 'publishing'
      ? `http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`
      : `http://localhost:3000/api/tenant/acme/destinations/${fbDestinationId}/queue/${itemId}/publish-now`;
  const req = new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: sessionCookie,
      ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}),
    },
  });
  if (handler === 'publishing') {
    return handlePublishNow(req, subdomain, itemId, dbClient);
  }
  return handleDestinationPublishNow(req, subdomain, fbDestinationId, itemId, dbClient);
}

function updateCallCount() {
  return db.query.mock.calls.filter(([sql]) =>
    (sql as string).includes('UPDATE queue_items')
  ).length;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  process.env.SESSION_SECRET = TEST_SECRET;
  db = new FakeDb();
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

const facebookTextPost = {
  platform: 'facebook',
  destinationId: fbDestinationId,
  kind: 'text',
  caption: 'hello',
  intent: 'queue',
};

describe('idempotency key header parsing', () => {
  it('returns null when the header is absent', () => {
    const headers = new Headers();
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: null,
      invalid: false,
    });
  });

  it('accepts a UUID key', () => {
    const headers = new Headers({ [IDEMPOTENCY_KEY_HEADER]: KEY_A });
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: KEY_A,
      invalid: false,
    });
  });

  it('flags a non-UUID key as invalid', () => {
    const headers = new Headers({ [IDEMPOTENCY_KEY_HEADER]: 'not-a-uuid' });
    expect(parseIdempotencyKeyHeader(headers)).toEqual({
      key: null,
      invalid: true,
    });
  });
});

describe('destination enqueue idempotency', () => {
  it('replays the original result on a same-key retry and creates no duplicate', async () => {
    const first = await enqueue(facebookTextPost, KEY_A);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);

    // The response-lost case: the client never saw the 201, retries
    // the same block with the same key.
    const retry = await enqueue(facebookTextPost, KEY_A);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    const retryBody = await retry.json();
    expect(retryBody).toEqual(firstBody);
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });

  it('executes normally with a different key', async () => {
    const first = await enqueue(facebookTextPost, KEY_A);
    const second = await enqueue(facebookTextPost, KEY_B);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(2);
  });

  it('executes normally when the stored key expired', async () => {
    db.idempotencyKeys.push({
      workspace_id: workspaceId,
      user_id: userId,
      action: 'destination-queue',
      idempotency_key: KEY_A,
      response_status: 201,
      response_body: { id: 'stale-item', caption: 'old' },
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await enqueue(facebookTextPost, KEY_A);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe('stale-item');
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });

  it('never replays a key stored for another user', async () => {
    db.idempotencyKeys.push({
      workspace_id: workspaceId,
      user_id: otherUserId,
      action: 'destination-queue',
      idempotency_key: KEY_A,
      response_status: 201,
      response_body: { id: 'other-users-item' },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const res = await enqueue(facebookTextPost, KEY_A);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe('other-users-item');
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });

  it('never replays a key stored for another workspace', async () => {
    db.idempotencyKeys.push({
      workspace_id: otherWorkspaceId,
      user_id: userId,
      action: 'destination-queue',
      idempotency_key: KEY_A,
      response_status: 201,
      response_body: { id: 'other-workspace-item' },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const res = await enqueue(facebookTextPost, KEY_A);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe('other-workspace-item');
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });

  it('rejects an invalid key and creates nothing', async () => {
    const res = await enqueue(facebookTextPost, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(0);
    expect(db.idempotencyKeys).toHaveLength(0);
  });

  it('enqueues normally without a key', async () => {
    const res = await enqueue(facebookTextPost);
    expect(res.status).toBe(201);
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });

  it('does not store a failed request, so a fixed retry executes fresh', async () => {
    const failed = await enqueue(
      {
        platform: 'facebook',
        destinationId: '00000000-0000-4000-8000-000000000000',
        kind: 'text',
        caption: 'hello',
        intent: 'queue',
      },
      KEY_A
    );
    expect(failed.status).toBe(404);
    expect(db.idempotencyKeys).toHaveLength(0);

    const retried = await enqueue(facebookTextPost, KEY_A);
    expect(retried.status).toBe(201);
    expect(db.queueItems.filter((q) => q.caption === 'hello')).toHaveLength(1);
  });
});

describe('publish-now idempotency', () => {
  it('replays the acknowledgement on a same-key retry without re-dispatching', async () => {
    const first = await publishNow(queueItemId, KEY_A, 'publishing');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(updateCallCount()).toBe(1);

    const retry = await publishNow(queueItemId, KEY_A, 'publishing');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await retry.json()).toEqual(firstBody);
    expect(updateCallCount()).toBe(1);
  });

  it('replays on the destination-scoped publish-now twin as well', async () => {
    const first = await publishNow(queueItemId, KEY_A, 'destination');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(updateCallCount()).toBe(1);

    const retry = await publishNow(queueItemId, KEY_A, 'destination');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await retry.json()).toEqual(firstBody);
    expect(updateCallCount()).toBe(1);
  });
});
