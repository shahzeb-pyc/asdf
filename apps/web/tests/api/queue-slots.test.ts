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
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Page Queue Slots CRUD (T121, T122, T123)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const pageId = '22222222-2222-4222-a222-222222222222';
  const slotId = '33333333-3333-4333-a333-333333333333';
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

  describe('GET /api/tenant/[subdomain]/pages/[pageId]/slots', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`
      );
      const res = await handleListQueueSlots(req, 'acme', pageId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/othercorp/pages/${pageId}/slots`,
        {
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleListQueueSlots(req, 'othercorp', pageId);
      expect(res.status).toBe(403);
    });

    it('returns 404 when page does not exist or does not belong to user', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleListQueueSlots(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Page not found');
    });

    it('returns 200 with list of slots for the page', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'America/New_York' }]);
          }
          if (sql.includes('FROM posting_slots')) {
            return Promise.resolve([
              {
                id: slotId,
                user_id: userId,
                fb_page_id: pageId,
                slot_time: '09:30:00',
                timezone: 'America/New_York',
                is_active: true,
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T10:00:00Z'),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleListQueueSlots(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.slots).toHaveLength(1);
      expect(data.slots[0].id).toBe(slotId);
      expect(data.slots[0].pageId).toBe(pageId);
      expect(data.slots[0].slotTime).toBe('09:30:00');
      expect(data.slots[0].timezone).toBe('America/New_York');
      expect(data.slots[0].isActive).toBe(true);
      expect(data.total).toBe(1);
    });
  });

  describe('POST /api/tenant/[subdomain]/pages/[pageId]/slots', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(req, 'acme', pageId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/othercorp/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(req, 'othercorp', pageId);
      expect(res.status).toBe(403);
    });

    it('returns 400 Bad Request on invalid slotTime format', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '25:99', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(req, 'acme', pageId);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('INVALID_REQUEST');
    });

    it('returns 404 when page does not exist or does not belong to user', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
    });

    it('returns 201 Created on valid slot creation', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('INSERT INTO posting_slots')) {
            return Promise.resolve([
              {
                id: slotId,
                user_id: userId,
                fb_page_id: pageId,
                slot_time: '14:00',
                timezone: 'UTC',
                is_active: true,
                created_at: new Date('2026-10-07T12:00:00Z'),
                updated_at: new Date('2026-10-07T12:00:00Z'),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe(slotId);
      expect(data.pageId).toBe(pageId);
      expect(data.slotTime).toBe('14:00');
      expect(data.timezone).toBe('UTC');
      expect(data.isActive).toBe(true);
    });

    it('returns 409 Conflict on duplicate slot_time for page', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('INSERT INTO posting_slots')) {
            const err: any = new Error('duplicate key value');
            err.code = '23505';
            return Promise.reject(err);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('SLOT_ALREADY_EXISTS');
    });
  });

  describe('PATCH /api/tenant/[subdomain]/pages/[pageId]/slots/[slotId]', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isActive: false }),
        }
      );
      const res = await handleUpdateQueueSlot(req, 'acme', pageId, slotId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/othercorp/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ isActive: false }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'othercorp',
        pageId,
        slotId
      );
      expect(res.status).toBe(403);
    });

    it('returns 404 when page does not exist or does not belong to user', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ isActive: false }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 when slot does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('UPDATE posting_slots')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ isActive: false }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Slot not found');
    });

    it('returns 200 and updates slot active state, slotTime, or timezone', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('UPDATE posting_slots')) {
            return Promise.resolve([
              {
                id: slotId,
                user_id: userId,
                fb_page_id: pageId,
                slot_time: '18:00:00',
                timezone: 'UTC',
                is_active: false,
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T13:00:00Z'),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ isActive: false, slotTime: '18:00' }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(slotId);
      expect(data.isActive).toBe(false);
      expect(data.slotTime).toBe('18:00:00');
    });

    it('returns 409 Conflict if updated slot_time conflicts with existing slot on page', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId, timezone: 'UTC' }]);
          }
          if (sql.includes('UPDATE posting_slots')) {
            const err: any = new Error('duplicate key value');
            err.code = '23505';
            return Promise.reject(err);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '09:30' }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('SLOT_ALREADY_EXISTS');
    });
  });

  describe('DELETE /api/tenant/[subdomain]/pages/[pageId]/slots/[slotId]', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
        }
      );
      const res = await handleDeleteQueueSlot(req, 'acme', pageId, slotId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/othercorp/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'othercorp',
        pageId,
        slotId
      );
      expect(res.status).toBe(403);
    });

    it('returns 404 when page does not exist or does not belong to user', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 when slot does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId }]);
          }
          if (sql.includes('DELETE FROM posting_slots')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Slot not found');
    });

    it('returns 200 with { success: true, slotId } on successful deletion', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: pageId }]);
          }
          if (sql.includes('DELETE FROM posting_slots')) {
            return Promise.resolve([{ id: slotId }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.slotId).toBe(slotId);
    });
  });

  describe('PATCH /api/tenant/[subdomain]/pages/[pageId]/slots (Schedule Timezone)', () => {
    it('returns 401 Unauthorized when unauthenticated', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(req, 'acme', pageId);
      expect(res.status).toBe(401);
    });

    it('returns 403 Forbidden on tenant mismatch', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/othercorp/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(req, 'othercorp', pageId);
      expect(res.status).toBe(403);
    });

    it('returns 400 on invalid payload', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: '' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(req, 'acme', pageId);
      expect(res.status).toBe(400);
    });

    it('returns 404 when workspace not found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Workspace not found');
    });

    it('returns 404 when page not found on timezone update', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Page not found');
    });

    it('returns 200 with { success: true, timezone, updatedCount } and no realigned count when updating timezone', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([{ id: pageId }]);
          }
          if (sql.includes('SELECT count(*)::int as count FROM posting_slots')) {
            return Promise.resolve([{ count: 3 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: 'Asia/Karachi' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.timezone).toBe('Asia/Karachi');
      expect(data.updatedCount).toBe(3);
      // Publisher-driven: no realignment exists anymore, so the
      // response carries no realigned count at all.
      expect(data).not.toHaveProperty('realignedQueueCount');
    });

    it('touches no queue_items rows on a timezone change (nothing is realigned)', async () => {
      const seenSql: string[] = [];
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          seenSql.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([{ id: pageId }]);
          }
          if (sql.includes('SELECT count(*)::int as count FROM posting_slots')) {
            return Promise.resolve([{ count: 2 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ timezone: 'America/New_York' }),
        }
      );
      const res = await handleUpdateQueueScheduleTimezone(
        req,
        'acme',
        pageId,
        mockDb as DatabaseClient
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.timezone).toBe('America/New_York');
      expect(data.updatedCount).toBe(2);
      // Queued posts store no times, so a timezone change must not
      // read or write queue_items at all.
      expect(seenSql.some((sql) => sql.includes('queue_items'))).toBe(false);
    });
  });

  describe('Supabase path (production client shape)', () => {
    /**
     * Minimal chainable PostgREST double: every mutator returns the
     * builder, maybeSingle/single resolve per table + selected
     * columns, and the builder itself is thenable for chains awaited
     * directly (the slot DELETE's `.delete().eq().select('id')`).
     */
    function makeSupabaseFake(
      resolve: (
        table: string,
        op: 'maybeSingle' | 'single' | 'select',
        columns?: string
      ) => { data: unknown; error: unknown },
    ) {
      const rpc = vi.fn().mockResolvedValue({ error: null });
      const builderFor = (table: string) => {
        const b: Record<string, unknown> = {};
        let columns: string | undefined;
        b.select = (cols?: string) => {
          columns = cols;
          return b;
        };
        b.eq = () => b;
        b.insert = () => b;
        b.update = () => b;
        b.delete = () => b;
        b.single = () => Promise.resolve(resolve(table, 'single', columns));
        b.maybeSingle = () => Promise.resolve(resolve(table, 'maybeSingle', columns));
        b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve(resolve(table, 'select', columns)).then(onOk, onErr);
        return b;
      };
      return {
        from: (table: string) => builderFor(table),
        rpc,
      };
    }

    function workspaceAndOwner(pageTimezone = 'UTC') {
      return (
        table: string,
        op: 'maybeSingle' | 'single' | 'select',
        columns?: string
      ) => {
        if (table === 'workspaces') {
          if (columns === 'owner_id') {
            return { data: { owner_id: userId }, error: null };
          }
          return { data: { id: 'ws_123' }, error: null };
        }
        if (table === 'destinations') {
          return { data: { id: pageId, timezone: pageTimezone }, error: null };
        }
        return { data: null, error: null };
      };
    }

    it('POST creates a slot and refreshes the unmatched flag', async () => {
      const fake = makeSupabaseFake((table, op, columns) => {
        if (table === 'posting_slots' && op === 'single') {
          return {
            data: {
              id: slotId,
              destination_id: pageId,
              time_of_day: '14:00',
              is_active: true,
              kind: ['text'],
              created_at: new Date('2026-10-07T12:00:00Z').toISOString(),
              updated_at: new Date('2026-10-07T12:00:00Z').toISOString(),
            },
            error: null,
          };
        }
        return workspaceAndOwner()(table, op, columns);
      });

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots`,
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ slotTime: '14:00', timezone: 'UTC' }),
        }
      );
      const res = await handleCreateQueueSlot(
        req,
        'acme',
        pageId,
        fake as never
      );
      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: string; slotTime: string };
      expect(data.id).toBe(slotId);
      expect(data.slotTime).toBe('14:00');
      expect(fake.rpc).toHaveBeenCalledWith('refresh_destination_unmatched_flag', {
        p_destination_id: pageId,
      });
    });

    it('PATCH updates a slot and refreshes the unmatched flag', async () => {
      const fake = makeSupabaseFake((table, op, columns) => {
        if (table === 'posting_slots' && op === 'maybeSingle') {
          return {
            data: {
              id: slotId,
              destination_id: pageId,
              time_of_day: '18:00:00',
              is_active: false,
              kind: ['text'],
              created_at: new Date('2026-10-07T10:00:00Z').toISOString(),
              updated_at: new Date('2026-10-07T13:00:00Z').toISOString(),
            },
            error: null,
          };
        }
        return workspaceAndOwner()(table, op, columns);
      });

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'PATCH',
          headers: { cookie: validSessionCookie },
          body: JSON.stringify({ isActive: false }),
        }
      );
      const res = await handleUpdateQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        fake as never
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { isActive: boolean };
      expect(data.isActive).toBe(false);
      expect(fake.rpc).toHaveBeenCalledWith('refresh_destination_unmatched_flag', {
        p_destination_id: pageId,
      });
    });

    it('DELETE removes a slot and refreshes the unmatched flag', async () => {
      const fake = makeSupabaseFake((table, op, columns) => {
        if (table === 'posting_slots' && op === 'select') {
          return { data: [{ id: slotId }], error: null };
        }
        return workspaceAndOwner()(table, op, columns);
      });

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}/slots/${slotId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await handleDeleteQueueSlot(
        req,
        'acme',
        pageId,
        slotId,
        fake as never
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; slotId: string };
      expect(data.success).toBe(true);
      expect(data.slotId).toBe(slotId);
      expect(fake.rpc).toHaveBeenCalledWith('refresh_destination_unmatched_flag', {
        p_destination_id: pageId,
      });
    });
  });
});

