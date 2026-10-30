import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleListQueueSlots,
  handleCreateQueueSlot,
  handleUpdateQueueScheduleTimezone,
} from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/slots/route';
import {
  handleUpdateQueueSlot,
  handleDeleteQueueSlot,
} from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/slots/[slotId]/route';
import { handleListQueueItems } from '../../src/app/api/tenant/[subdomain]/publishing/queue/route';
import { handleDestinationEnqueue } from '../../src/app/api/tenant/[subdomain]/publishing/destination-queue/route';
import {
  handleUpdateQueueItem,
  handleDeleteQueueItem,
} from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/route';
import { handlePublishNow } from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Multi-Tenant Publishing Security & Isolation Audit (T144)', () => {
  const userA = {
    id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    subdomain: 'tenant-a',
    pageId: '11111111-1111-4111-a111-111111111111',
    slotId: '22222222-2222-4222-a222-222222222222',
    mediaId: '33333333-3333-4333-a333-333333333333',
    queueItemId: '44444444-4444-4444-a444-444444444444',
  };

  const userB = {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    subdomain: 'tenant-b',
    pageId: '55555555-5555-4555-b555-555555555555',
    slotId: '66666666-6666-4666-b666-666666666666',
    mediaId: '77777777-7777-4777-b777-777777777777',
    queueItemId: '88888888-8888-4888-b888-888888888888',
  };

  let tokenCookieUserB: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;

    const tokenB = await signSessionToken(
      {
        userId: userB.id,
        email: 'bobbrown@gmail.com',
        name: 'Bob Tenant B',
        subdomain: userB.subdomain,
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    tokenCookieUserB = `fbup_session=${tokenB}`;
  });

  describe('1. Route-Level Tenant Boundary Isolation Guards', () => {
    it('blocks User B from viewing User A queue slots via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/pages/${userA.pageId}/slots`,
        { headers: { cookie: tokenCookieUserB } }
      );
      const res = await handleListQueueSlots(req, 'tenant-a', userA.pageId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from creating queue slot in User A tenant route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/pages/${userA.pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ slotTime: '09:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(req, 'tenant-a', userA.pageId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from updating User A page schedule timezone via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/pages/${userA.pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(req, 'tenant-a', userA.pageId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from updating User A queue slot via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/pages/${userA.pageId}/slots/${userA.slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ slotTime: '10:00' }),
        }
      );
      const res = await handleUpdateQueueSlot(req, 'tenant-a', userA.pageId, userA.slotId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from deleting User A queue slot via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/pages/${userA.pageId}/slots/${userA.slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handleDeleteQueueSlot(req, 'tenant-a', userA.pageId, userA.slotId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from accessing User A publishing queue list with 403 Forbidden', async () => {
      const req = new NextRequest('http://localhost:3000/api/tenant/tenant-a/publishing/queue', {
        headers: { cookie: tokenCookieUserB },
      });
      const res = await handleListQueueItems(req, 'tenant-a');
      expect(res.status).toBe(403);
    });

    it('blocks User B from enqueuing media via User A tenant route with 403 Forbidden', async () => {
      // Creates run through the unified destination enqueue since the
      // Phase 7 drop removed the legacy queue POST handler.
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/tenant-a/publishing/destination-queue',
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'facebook',
            destinationId: userA.pageId,
            kind: 'video',
            mediaItemIds: [userA.mediaId],
            caption: 'Cross-tenant breach attempt',
            intent: 'now',
          }),
        }
      );
      const res = await handleDestinationEnqueue(req, 'tenant-a');
      expect(res.status).toBe(403);
    });

    it('blocks User B from updating User A queue item via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/publishing/queue/${userA.queueItemId}`,
        {
          method: 'PATCH',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ caption: 'Tampered caption' }),
        }
      );
      const res = await handleUpdateQueueItem(req, 'tenant-a', userA.queueItemId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from deleting User A queue item via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/publishing/queue/${userA.queueItemId}`,
        {
          method: 'DELETE',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handleDeleteQueueItem(req, 'tenant-a', userA.queueItemId);
      expect(res.status).toBe(403);
    });

    it('blocks User B from triggering publish-now on User A queue item via tenant-a route with 403 Forbidden', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-a/publishing/queue/${userA.queueItemId}/publish-now`,
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handlePublishNow(req, 'tenant-a', userA.queueItemId);
      expect(res.status).toBe(403);
    });
  });

  describe('2. Object-Level IDOR Guards (Queue Slots)', () => {
    it('blocks User B from listing slots for User A page via tenant-b route with 404 Not Found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM destinations')) {
            // Destination check enforces WHERE id = $1 AND workspace_id = $2;
            // User A's page lives in ws_a, so ws_b sees nothing.
            if (params && params[0] === userA.pageId && params[1] === 'ws_b') {
              return Promise.resolve([]);
            }
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/pages/${userA.pageId}/slots`,
        { headers: { cookie: tokenCookieUserB } }
      );
      const res = await handleListQueueSlots(
        req,
        'tenant-b',
        userA.pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Page not found');
    });

    it('blocks User B from creating slot under User A page with 404 Not Found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM destinations')) {
            if (params && params[0] === userA.pageId && params[1] === 'ws_b') {
              return Promise.resolve([]);
            }
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/pages/${userA.pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ slotTime: '12:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(
        req,
        'tenant-b',
        userA.pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Page not found');
    });

    it('blocks User B from updating User A slot by ID with 404 Not Found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: userB.pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('UPDATE posting_slots')) {
            // WHERE id = $4 AND destination_id = $5 — the slot id
            // belongs to User A's page, not User B's, so no row moves.
            if (params && params[3] === userA.slotId && params[4] === userB.pageId) {
              return Promise.resolve([]);
            }
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/pages/${userB.pageId}/slots/${userA.slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ slotTime: '14:00' }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'tenant-b',
        userB.pageId,
        userA.slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Slot not found');
    });

    it('blocks User B from deleting User A slot by ID with 404 Not Found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: userB.pageId }]);
          }
          if (sql.includes('DELETE FROM posting_slots')) {
            // WHERE id = $1 AND destination_id = $2
            if (params && params[0] === userA.slotId && params[1] === userB.pageId) {
              return Promise.resolve([]);
            }
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/pages/${userB.pageId}/slots/${userA.slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'tenant-b',
        userB.pageId,
        userA.slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Slot not found');
    });
  });

  describe('3. Cross-Tenant Enqueuing & Foreign Key IDOR Guards', () => {
    // The unified destination enqueue is the only create path since
    // the Phase 7 drop. Its guards: the destination must belong to
    // the caller's workspace, every media id must belong to the
    // session user, and a pinned slot must be one of the
    // destination's own posting_slots.
    function createEnqueueDb() {
      const destinations = new Map([
        [
          userA.pageId,
          { id: userA.pageId, workspace_id: 'ws_a', platform: 'facebook', timezone: 'UTC', status: 'active', account_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1', account_status: 'active', account_token_expires_at: new Date(Date.now() + 86400000).toISOString() },
        ],
        [
          userB.pageId,
          { id: userB.pageId, workspace_id: 'ws_b', platform: 'facebook', timezone: 'UTC', status: 'active', account_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2', account_status: 'active', account_token_expires_at: new Date(Date.now() + 86400000).toISOString() },
        ],
      ]);
      const media = new Map([
        [
          userA.mediaId,
          { id: userA.mediaId, user_id: userA.id, media_type: 'video', url: 'https://cdn.example.com/a.mp4', storage_key: null },
        ],
        [
          userB.mediaId,
          { id: userB.mediaId, user_id: userB.id, media_type: 'video', url: 'https://cdn.example.com/b.mp4', storage_key: null },
        ],
      ]);
      const slots = [
        { id: userB.slotId, destination_id: userB.pageId, kind: ['video'], time_of_day: '09:00:00', is_active: true },
      ];
      return {
        query: vi.fn().mockImplementation((sql: string, params: any[] = []) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve(params[0] === 'tenant-b' ? [{ id: 'ws_b' }] : []);
          }
          if (sql.includes('FROM destinations')) {
            const row = destinations.get(String(params[0]));
            return Promise.resolve(row && row.workspace_id === params[1] ? [row] : []);
          }
          if (sql.includes('FROM media_items')) {
            const ids = (params[1] as string[]) ?? [];
            return Promise.resolve(
              [...media.values()].filter((m) => m.user_id === params[0] && ids.includes(m.id))
            );
          }
          if (sql.includes('FROM posting_slots')) {
            return Promise.resolve(slots.filter((s) => s.destination_id === params[0]));
          }
          // NOTE: the INSERT branch must precede FROM queue_items:
          // the insert carries a queue_seq subquery that itself
          // reads FROM queue_items.
          if (sql.includes('INSERT INTO queue_items')) {
            return Promise.resolve([
              {
                id: userB.queueItemId,
                workspace_id: '22222222-2222-4222-a222-222222222222',
                destination_id: userB.pageId,
                platform: 'facebook',
                kind: 'video',
                platform_format: null,
                status: 'queued',
                scheduled_time: null,
                slot_id: null,
                created_at: new Date().toISOString(),
              },
            ]);
          }
          if (sql.includes('FROM queue_items')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
    }

    it('blocks User B from enqueuing media targeting User A destination with 404 Not Found', async () => {
      const mockDb = createEnqueueDb();

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/tenant-b/publishing/destination-queue',
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'facebook',
            destinationId: userA.pageId,
            kind: 'video',
            mediaItemIds: [userB.mediaId],
            caption: 'Hijack destination queue',
            intent: 'now',
          }),
        }
      );
      const res = await handleDestinationEnqueue(req, 'tenant-b', mockDb as never);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Destination not found');
    });

    it('blocks User B from enqueuing User A media asset with 404 Not Found', async () => {
      const mockDb = createEnqueueDb();

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/tenant-b/publishing/destination-queue',
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'facebook',
            destinationId: userB.pageId,
            kind: 'video',
            mediaItemIds: [userA.mediaId],
            caption: 'Steal User A media',
            intent: 'now',
          }),
        }
      );
      const res = await handleDestinationEnqueue(req, 'tenant-b', mockDb as never);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Media not found');
    });

    it('ignores a foreign slotId on enqueue: no cross-tenant slot pinning exists anymore', async () => {
      // Publisher-driven scheduling removed slot pinning for
      // Facebook entirely: a pinned slotId is ignored, so passing
      // another tenant's slot id confers nothing — the post lands
      // in the caller's own destination queue with no slot link.
      // The guards that still apply are the neighbouring ones:
      // foreign destinations and foreign media stay 404.
      const mockDb = createEnqueueDb();

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/tenant-b/publishing/destination-queue',
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: 'facebook',
            destinationId: userB.pageId,
            kind: 'video',
            mediaItemIds: [userB.mediaId],
            slotId: userA.slotId,
            caption: 'Steal User A slot',
            intent: 'queue',
          }),
        }
      );
      const res = await handleDestinationEnqueue(req, 'tenant-b', mockDb as never);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.destinationId).toBe(userB.pageId);
      expect(body.slotId).toBeNull();
      expect(body.scheduledTime).toBeNull();
    });
  });

  describe('4. Object-Level IDOR Guards (Queue Items & Actions)', () => {
    function createItemDb() {
      return {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          // Every queue_items read/write is scoped by workspace_id;
          // User A's item lives in ws_a, so ws_b finds nothing.
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
    }

    it('blocks User B from updating User A queue item by ID with 404 Not Found', async () => {
      const mockDb = createItemDb();

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/publishing/queue/${userA.queueItemId}`,
        {
          method: 'PATCH',
          headers: { cookie: tokenCookieUserB, 'content-type': 'application/json' },
          body: JSON.stringify({ caption: 'Tampered' }),
        }
      );
      const res = await handleUpdateQueueItem(
        req,
        'tenant-b',
        userA.queueItemId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Queue item not found');
    });

    it('blocks User B from deleting User A queue item by ID with 404 Not Found', async () => {
      const mockDb = createItemDb();

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/publishing/queue/${userA.queueItemId}`,
        {
          method: 'DELETE',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handleDeleteQueueItem(
        req,
        'tenant-b',
        userA.queueItemId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Queue item not found');
    });

    it('blocks User B from triggering publish-now on User A queue item with 404 Not Found', async () => {
      const mockDb = createItemDb();

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/publishing/queue/${userA.queueItemId}/publish-now`,
        {
          method: 'POST',
          headers: { cookie: tokenCookieUserB },
        }
      );
      const res = await handlePublishNow(
        req,
        'tenant-b',
        userA.queueItemId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Queue item not found');
    });
  });

  describe('5. Zero Cross-Tenant Data Leakage in Listings & Logs', () => {
    it('returns empty list when User B queries queue filtered by User A pageId (zero leakage)', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM queue_items')) {
            // Unified scoping: $1 is the caller's workspace, $2 the
            // page filter — User A's items live in ws_a, never ws_b.
            expect(params?.[0]).toBe('ws_b');
            expect(params?.[1]).toBe(userA.pageId);
          }
          if (sql.includes('COUNT(*)')) {
            return Promise.resolve([{ total: 0 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/tenant-b/publishing/queue?pageId=${userA.pageId}`,
        { headers: { cookie: tokenCookieUserB } }
      );
      const res = await handleListQueueItems(req, 'tenant-b', mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('ensures User B queue list query is strictly parameterized by User B workspace', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_b' }]);
          }
          if (sql.includes('FROM queue_items') && !sql.includes('GROUP BY')) {
            // Parameter 1 of every item query is the caller's
            // workspace id — the unified isolation boundary.
            expect(params?.[0]).toBe('ws_b');
          }

          if (sql.includes('COUNT(*)')) {
            return Promise.resolve([{ total: 1 }]);
          }
          if (sql.includes('GROUP BY')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([
            {
              id: userB.queueItemId,
              destination_id: userB.pageId,
              slot_id: userB.slotId,
              media_item_id: userB.mediaId,
              kind: 'video',
              platform_format: 'reel',
              link_url: null,
              scheduled_time: new Date().toISOString(),
              caption: 'User B post',
              first_comment: null,
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
              external_post_id: null,
              external_comment_id: null,
              published_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              media_name: 'b_video.mp4',
              media_type: 'video',
              media_thumbnail_url: null,
              media_url: 'https://cdn.example.com/b_video.mp4',
              media_aspect_ratio: '16:9',
              media_duration_seconds: 15,
            },
          ]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/tenant-b/publishing/queue', {
        headers: { cookie: tokenCookieUserB },
      });
      const res = await handleListQueueItems(req, 'tenant-b', mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].id).toBe(userB.queueItemId);
      expect(body.items[0].userId).toBe(userB.id);
    });
  });
});
