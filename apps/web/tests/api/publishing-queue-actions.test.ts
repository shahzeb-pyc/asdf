import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleUpdateQueueItem,
  handleDeleteQueueItem,
  PATCH,
  DELETE,
} from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/route';
import {
  handlePublishNow,
  POST as POSTPublishNow,
} from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import { MockStorageProvider } from '../helpers/mock-storage';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Publishing Queue Actions Route Handlers (T128, T129)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const pageId = '22222222-2222-4222-a222-222222222222';
  const mediaId = '33333333-3333-4333-a333-333333333333';
  const slotId = '44444444-4444-4444-a444-444444444444';
  const itemId = '55555555-5555-4555-a555-555555555555';
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;

    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  describe('PATCH /api/tenant/[subdomain]/publishing/queue/[itemId] (T128)', () => {
    const validPatchBody = {
      caption: 'Updated caption',
      firstComment: 'Updated first comment',
      scheduledTime: '2026-10-08T20:00:00.000Z',
      status: 'skipped' as const,
    };

    it('returns 401 Unauthorized when missing session cookie', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(validPatchBody),
        headers: { 'content-type': 'application/json' },
      });
      const res = await handleUpdateQueueItem(req, 'acme', itemId);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 403 Forbidden on cross-tenant subdomain mismatch', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/other-tenant/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(validPatchBody),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });
      const res = await handleUpdateQueueItem(req, 'other-tenant', itemId);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('Forbidden');
    });

    it('returns 400 Bad Request on invalid request body schema', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'invalid_status' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });
      const res = await handleUpdateQueueItem(req, 'acme', itemId);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('INVALID_REQUEST');
    });

    it('returns 400 Bad Request if scheduledTime is an unparseable timestamp', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ scheduledTime: 'not-a-valid-timestamp' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });
      const res = await handleUpdateQueueItem(req, 'acme', itemId);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('INVALID_REQUEST');
    });

    it('returns 404 Not Found if queue item does not belong to user or does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM queue_items')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(validPatchBody),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Queue item not found');
    });

    it('returns 400 Bad Request if trying to update an already published queue item', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'published',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: 'New caption' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('CANNOT_UPDATE_PUBLISHED_ITEM');
    });

    it('returns 400 Bad Request if trying to update a publishing queue item (K1 fail-closed)', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'publishing',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: 'New caption' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('CANNOT_UPDATE_PUBLISHING_ITEM');
    });

    it('returns 400 Bad Request if trying to update a cancelled queue item (nit: cancelled is terminal)', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'cancelled',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: 'New caption' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('CANNOT_UPDATE_CANCELLED_ITEM');
    });

    it('returns 400 Bad Request for a reel caption over 2,200 on an existing reel (R13)', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                destination_id: pageId,
                kind: 'video',
                platform_format: 'reel',
                caption: 'Short reel',
                first_comment: null,
                scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
                status: 'queued',
                retry_count: 0,
                max_retries: 3,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: 'R'.repeat(2201) }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('INVALID_REQUEST');
      expect(json.message).toBe('Reel captions are limited to 2,200 characters');
    });

    it('returns 200 OK for a long feed caption and refreshes the unmatched flag (R13, R25)', async () => {
      const longCaption = 'L'.repeat(60000);
      const query = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
          return Promise.resolve([
            {
              id: itemId,
              user_id: userId,
              destination_id: pageId,
              kind: 'text',
              platform_format: null,
              caption: 'Original caption',
              first_comment: null,
              scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
            },
          ]);
        }
        if (sql.includes('UPDATE queue_items')) {
          return Promise.resolve([
            {
              id: itemId,
              user_id: userId,
              destination_id: pageId,
              slot_id: slotId,
              media_item_id: null,
              scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
              caption: longCaption,
              first_comment: null,
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
              external_post_id: null,
              external_comment_id: null,
              created_at: new Date('2026-10-07T12:00:00.000Z'),
              updated_at: new Date('2026-10-07T13:00:00.000Z'),
            },
          ]);
        }
        return Promise.resolve([]);
      });
      const mockDb: Partial<DatabaseClient> = { query };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: longCaption }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.caption).toBe(longCaption);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('refresh_destination_unmatched_flag'),
        [pageId]
      );
    });

    it('resets the retry budget when requeueing a failed item (R12)', async () => {
      const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
          return Promise.resolve([
            {
              id: itemId,
              user_id: userId,
              destination_id: pageId,
              kind: 'text',
              platform_format: null,
              caption: 'Failed post',
              first_comment: null,
              scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
              status: 'failed',
              retry_count: 2,
              max_retries: 3,
            },
          ]);
        }
        if (sql.includes('UPDATE queue_items')) {
          return Promise.resolve([
            {
              id: itemId,
              user_id: userId,
              destination_id: pageId,
              slot_id: slotId,
              media_item_id: null,
              scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
              caption: 'Failed post',
              first_comment: null,
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
              external_post_id: null,
              external_comment_id: null,
              created_at: new Date('2026-10-07T12:00:00.000Z'),
              updated_at: new Date('2026-10-07T13:00:00.000Z'),
            },
          ]);
        }
        return Promise.resolve([]);
      });
      const mockDb: Partial<DatabaseClient> = { query };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'queued' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.retryCount).toBe(0);
      const updateCall = query.mock.calls.find(([sql]) =>
        (sql as string).includes('UPDATE queue_items')
      );
      // retry_count is $8 in the requeue UPDATE.
      expect(updateCall?.[1]?.[7]).toBe(0);
    });

    it('returns 200 OK updating caption, firstComment, scheduledTime, and status', async () => {
      const updatedTime = '2026-10-08T20:00:00.000Z';
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                destination_id: pageId,
                slot_id: slotId,
                media_item_id: mediaId,
                scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
                caption: 'Original caption',
                first_comment: 'Original comment',
                status: 'queued',
                retry_count: 0,
                max_retries: 3,
                external_post_id: null,
                external_comment_id: null,
                published_at: null,
                created_at: new Date('2026-10-07T12:00:00.000Z'),
                updated_at: new Date('2026-10-07T12:00:00.000Z'),
                name: 'video.mp4',
                media_type: 'video',
                url: 'https://cdn.example.com/video.mp4',
                thumbnail_url: null,
                aspect_ratio: '9:16',
                duration_seconds: 30,
              },
            ]);
          }
          if (sql.includes('UPDATE queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                destination_id: pageId,
                slot_id: slotId,
                media_item_id: mediaId,
                scheduled_time: new Date(updatedTime),
                caption: 'Updated caption',
                first_comment: 'Updated first comment',
                // Unified storage: the wire 'skipped' PATCH writes
                // 'cancelled' (the unified vocabulary has no
                // 'skipped'); the response reports the stored
                // unified status, 'cancelled'.
                status: 'cancelled',
                retry_count: 0,
                max_retries: 3,
                external_post_id: null,
                external_comment_id: null,
                published_at: null,
                created_at: new Date('2026-10-07T12:00:00.000Z'),
                updated_at: new Date('2026-10-07T13:00:00.000Z'),
              },
            ]);
          }
          if (sql.includes('FROM media_items')) {
            return Promise.resolve([
              {
                id: mediaId,
                name: 'video.mp4',
                media_type: 'video',
                url: 'https://cdn.example.com/video.mp4',
                thumbnail_url: null,
                aspect_ratio: '9:16',
                duration_seconds: 30,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(validPatchBody),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(itemId);
      expect(data.caption).toBe('Updated caption');
      expect(data.firstComment).toBe('Updated first comment');
      expect(data.scheduledTime).toBe(updatedTime);
      expect(data.status).toBe('cancelled');
      expect(data.media).toBeDefined();
      expect(data.media.name).toBe('video.mp4');
    });

    it('works with the Next.js PATCH route handler wrapper', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'queued',
              },
            ]);
          }
          if (sql.includes('UPDATE queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                destination_id: pageId,
                slot_id: slotId,
                media_item_id: mediaId,
                scheduled_time: new Date('2026-10-08T18:00:00.000Z'),
                caption: 'Updated via wrapper',
                first_comment: null,
                status: 'queued',
                retry_count: 0,
                max_retries: 3,
                external_post_id: null,
                external_comment_id: null,
                published_at: null,
                created_at: new Date('2026-10-07T12:00:00.000Z'),
                updated_at: new Date('2026-10-07T13:00:00.000Z'),
              },
            ]);
          }
          if (sql.includes('FROM media_items')) {
            return Promise.resolve([
              {
                id: mediaId,
                name: 'clip.mp4',
                media_type: 'video',
                url: 'https://cdn.example.com/clip.mp4',
                thumbnail_url: null,
                aspect_ratio: '9:16',
                duration_seconds: 15,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption: 'Updated via wrapper' }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      });

      const context = {
        params: Promise.resolve({ subdomain: 'acme', itemId }),
      };

      // Call handleUpdateQueueItem with mockDb to ensure handler logic
      const res = await handleUpdateQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.caption).toBe('Updated via wrapper');
    });
  });

  describe('DELETE /api/tenant/[subdomain]/publishing/queue/[itemId] (T128)', () => {
    it('returns 401 Unauthorized when missing session cookie', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
      });
      const res = await handleDeleteQueueItem(req, 'acme', itemId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant subdomain mismatch', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/other-tenant/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });
      const res = await handleDeleteQueueItem(req, 'other-tenant', itemId);
      expect(res.status).toBe(403);
    });

    it('returns 404 Not Found if item does not belong to user or does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Queue item not found');
    });

    it('returns 400 Bad Request if trying to delete an already published queue item', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'published',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('CANNOT_DELETE_PUBLISHED_ITEM');
    });

    it('returns 400 Bad Request if trying to delete a publishing queue item (K1 fail-closed)', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'publishing',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('CANNOT_DELETE_PUBLISHING_ITEM');
    });

    it('returns 200 OK removing item from queue', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'queued',
              },
            ]);
          }
          if (sql.includes('DELETE FROM queue_items')) {
            return Promise.resolve([{ id: itemId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ success: true, itemId });
    });

    it('deletes the post-owned bytes with the queue item (media/posting separation)', async () => {
      const postOwnedKey = `users/${userId}/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg`;
      const libraryKey = `users/${userId}/media/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/photo.jpg`;
      const store = new MockStorageProvider();
      await store.putObject({
        key: postOwnedKey,
        body: new Uint8Array([1]),
        contentType: 'image/jpeg',
      });
      await store.putObject({
        key: libraryKey,
        body: new Uint8Array([1]),
        contentType: 'image/jpeg',
      });
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'queued',
                media_storage_key: postOwnedKey,
              },
            ]);
          }
          if (sql.includes('DELETE FROM queue_items')) {
            return Promise.resolve([{ id: itemId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(
        req,
        'acme',
        itemId,
        mockDb as DatabaseClient,
        store
      );
      expect(res.status).toBe(200);
      expect(store.uploadedObjects.has(postOwnedKey)).toBe(false);
      // The library bytes are untouched: a queue delete never
      // deletes library files.
      expect(store.uploadedObjects.has(libraryKey)).toBe(true);
    });

    it('never deletes library bytes when the row still points at a library key', async () => {
      const libraryKey = `users/${userId}/media/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/photo.jpg`;
      const store = new MockStorageProvider();
      await store.putObject({
        key: libraryKey,
        body: new Uint8Array([1]),
        contentType: 'image/jpeg',
      });
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'queued',
                media_storage_key: libraryKey,
              },
            ]);
          }
          if (sql.includes('DELETE FROM queue_items')) {
            return Promise.resolve([{ id: itemId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(
        req,
        'acme',
        itemId,
        mockDb as DatabaseClient,
        store
      );
      expect(res.status).toBe(200);
      expect(store.uploadedObjects.has(libraryKey)).toBe(true);
    });

    it('refreshes the unmatched flag on delete (R25)', async () => {
      const query = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
          return Promise.resolve([
            {
              id: itemId,
              user_id: userId,
              status: 'queued',
              destination_id: pageId,
            },
          ]);
        }
        if (sql.includes('DELETE FROM queue_items')) {
          return Promise.resolve([{ id: itemId }]);
        }
        return Promise.resolve([]);
      });
      const mockDb: Partial<DatabaseClient> = { query };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDeleteQueueItem(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('refresh_destination_unmatched_flag'),
        [pageId]
      );
    });
  });

  describe('POST /api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now (T129)', () => {
    it('returns 401 Unauthorized when missing session cookie', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
      });
      const res = await handlePublishNow(req, 'acme', itemId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant subdomain mismatch', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/other-tenant/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });
      const res = await handlePublishNow(req, 'other-tenant', itemId);
      expect(res.status).toBe(403);
    });

    it('returns 404 Not Found if item does not belong to user or does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });

      const res = await handlePublishNow(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Queue item not found');
    });

    it('returns 400 Bad Request if trying to publish-now an already published queue item', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'published',
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });

      const res = await handlePublishNow(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('ALREADY_PUBLISHED');
    });

    it('returns 200 OK resetting scheduled_time = now() and status = queued', async () => {
      let updateExecutedWithNow = false;
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'cancelled', // unified form of a previously skipped item
                destination_id: pageId,
              },
            ]);
          }
          if (sql.includes('FROM destinations')) {
            // SEND BACK fix for PR #44: the gate must not proceed on
            // a missing destination row. This happy-path test
            // previously relied on that fail-open (its mock returned
            // no destination row); it now models an active
            // destination explicitly. Test intent unchanged.
            return Promise.resolve([
              { status: 'active', metadata: {}, updated_at: new Date().toISOString() },
            ]);
          }
          if (sql.includes('UPDATE queue_items') && sql.includes("status = 'queued'")) {
            updateExecutedWithNow = true;
            return Promise.resolve([{ id: itemId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });

      const res = await handlePublishNow(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      expect(updateExecutedWithNow).toBe(true);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        message: 'Item dispatched for immediate publishing',
      });
    });

    it('resets the retry budget when publishing now a failed item (R12)', async () => {
      let updateSql = '';
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT') && sql.includes('FROM queue_items')) {
            return Promise.resolve([
              {
                id: itemId,
                user_id: userId,
                status: 'failed',
                destination_id: pageId,
              },
            ]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([
              { status: 'active', metadata: {}, updated_at: new Date().toISOString() },
            ]);
          }
          if (sql.includes('UPDATE queue_items')) {
            updateSql = sql;
            return Promise.resolve([{ id: itemId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });

      const res = await handlePublishNow(req, 'acme', itemId, mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      // The failed-only reset lives in the UPDATE itself, so the
      // budget cannot survive a re-queue even if the caller forgets.
      expect(updateSql).toContain("retry_count = CASE WHEN status = 'failed' THEN 0 ELSE retry_count END");
    });

    it('returns 200 via the Supabase path and refreshes the unmatched flag', async () => {
      const rpc = vi.fn().mockResolvedValue({ error: null });
      const builderFor = (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.update = () => b;
        b.maybeSingle = () =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: { id: 'ws_123' }, error: null }
              : table === 'destinations'
                ? {
                    // The Publish Now status gate reads the RAW
                    // destinations row (unified 'active'), not the
                    // queue item row the old fake returned for every
                    // table (status 'queued' would map to
                    // 'disconnected' and wrongly 409).
                    data: {
                      status: 'active',
                      metadata: {},
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  }
                : {
                    data: { id: itemId, status: 'queued', destination_id: pageId },
                    error: null,
                  }
          );
        b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(onOk, onErr);
        return b;
      };
      const fake = { from: builderFor, rpc };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`, {
        method: 'POST',
        headers: { cookie: validSessionCookie },
      });

      const res = await handlePublishNow(req, 'acme', itemId, fake as never);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        message: 'Item dispatched for immediate publishing',
      });
      expect(rpc).toHaveBeenCalledWith('refresh_destination_unmatched_flag', {
        p_destination_id: pageId,
      });
    });
  });
});
