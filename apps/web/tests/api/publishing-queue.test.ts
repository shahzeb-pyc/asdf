import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListQueueItems } from '../../src/app/api/tenant/[subdomain]/publishing/queue/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Publishing Queue Route Handlers (T125, T126, T127)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const pageId = '22222222-2222-4222-a222-222222222222';
  const mediaId = '33333333-3333-4333-a333-333333333333';
  const slotId = '44444444-4444-4444-a444-444444444444';
  const queueItemId = '55555555-5555-4555-a555-555555555555';
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

  // The POST create handler that used to live on this route was
  // deleted in the Phase 7 drop: creates (single + bulk, all formats)
  // go through the unified destination enqueue since spec 131/G4 and
  // are covered by the destination-enqueue suites. This route is
  // GET-only now.

  describe('GET /api/tenant/[subdomain]/publishing/queue (T127)', () => {
    it('returns 401 Unauthorized when missing session cookie', async () => {
      const req = new NextRequest('http://localhost:3000/api/tenant/acme/publishing/queue');
      const res = await handleListQueueItems(req, 'acme');
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest('http://localhost:3000/api/tenant/other-tenant/publishing/queue', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleListQueueItems(req, 'other-tenant');
      expect(res.status).toBe(403);
    });

    it('returns 400 Bad Request on invalid query parameters', async () => {
      const req = new NextRequest('http://localhost:3000/api/tenant/acme/publishing/queue?status=not_a_valid_status', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleListQueueItems(req, 'acme');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('INVALID_QUERY');
    });

    it('returns 200 with list of queue items and joined media information', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 1 }]);
          }
          return Promise.resolve([
            {
              id: queueItemId,
              destination_id: pageId,
              slot_id: slotId,
              media_item_id: mediaId,
              kind: 'video',
              platform_format: 'reel',
              link_url: null,
              scheduled_time: new Date('2026-10-07T18:00:00Z'),
              caption: 'Scheduled Reel',
              first_comment: 'Check out bio',
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
              external_post_id: null,
              external_comment_id: null,
              published_at: null,
              created_at: new Date('2026-10-07T12:00:00Z'),
              updated_at: new Date('2026-10-07T12:00:00Z'),
              media_name: 'video1.mp4',
              media_type: 'video',
              media_thumbnail_url: 'https://cdn.example.com/thumb.webp',
              media_url: 'https://cdn.example.com/video1.mp4',
              media_aspect_ratio: '9:16',
              media_duration_seconds: '29.5',
            },
          ]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/publishing/queue?pageId=' + pageId + '&status=queued', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListQueueItems(req, 'acme', mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total).toBe(1);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].id).toBe(queueItemId);
      expect(data.items[0].media).toBeDefined();
      expect(data.items[0].media.name).toBe('video1.mp4');
      expect(data.items[0].media.durationSeconds).toBe(29.5);
    });

    it('returns the row media_url for a post-owned row with no library link', async () => {
      const postOwnedUrl =
        'https://media.fbuploadpro.com/users/11111111-1111-4111-a111-111111111111/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg';
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 1 }]);
          }
          return Promise.resolve([
            {
              id: queueItemId,
              destination_id: pageId,
              slot_id: slotId,
              media_item_id: null,
              kind: 'image',
              platform_format: null,
              link_url: null,
              scheduled_time: new Date('2026-10-07T18:00:00Z'),
              caption: 'Post-owned image',
              first_comment: null,
              status: 'queued',
              retry_count: 0,
              max_retries: 3,
              external_post_id: null,
              external_comment_id: null,
              published_at: null,
              created_at: new Date('2026-10-07T12:00:00Z'),
              updated_at: new Date('2026-10-07T12:00:00Z'),
              media_name: null,
              media_type: null,
              media_thumbnail_url: null,
              media_url: null,
              media_aspect_ratio: null,
              media_duration_seconds: null,
              queue_media_url: postOwnedUrl,
            },
          ]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/publishing/queue?pageId=' + pageId + '&status=queued', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListQueueItems(req, 'acme', mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toHaveLength(1);
      // Regression (PR #74 send-back 1): the list used to return
      // media: undefined for post-owned rows, so the queue UI
      // showed no thumbnail/name for them.
      expect(data.items[0].media).toBeDefined();
      expect(data.items[0].media.url).toBe(postOwnedUrl);
      expect(data.items[0].media.name).toBe('photo.jpg');
      expect(data.items[0].media.mediaType).toBe('image');
      expect(data.items[0].media.thumbnailUrl).toBeNull();
    });
  });
});
