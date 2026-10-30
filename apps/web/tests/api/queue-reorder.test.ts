/**
 * Queue reorder route (Queue section rebuild): POST
 * …/publishing/queue/reorder with the full new order for one page.
 *
 * Covered: auth (401/403), body validation (bad UUIDs, empty list,
 * duplicate ids), workspace 404, non-queued rejection, incomplete-list
 * rejection, and the order rewrite itself — legacy path (single CASE
 * UPDATE inside a transaction) and Supabase path (two-pass offset
 * then dense updates). No migration: queue_seq already exists.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleReorderQueueItems } from '../../src/app/api/tenant/[subdomain]/publishing/queue/reorder/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-that-is-long-enough';

const userId = '11111111-1111-4111-a111-111111111111';
const pageId = '22222222-2222-4222-a222-222222222222';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let validSessionCookie: string;

function reorderRequest(body: unknown, cookie = validSessionCookie): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/publishing/queue/reorder', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      cookie,
      'content-type': 'application/json',
    },
  });
}

describe('POST …/publishing/queue/reorder', () => {
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

  it('returns 401 Unauthorized when missing session cookie', async () => {
    const req = reorderRequest({ pageId, itemIds: [ID_A] }, '');
    const res = await handleReorderQueueItems(req, 'acme');
    expect(res.status).toBe(401);
  });

  it('returns 403 Forbidden on cross-tenant subdomain mismatch', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/other-tenant/publishing/queue/reorder',
      {
        method: 'POST',
        body: JSON.stringify({ pageId, itemIds: [ID_A] }),
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
      }
    );
    const res = await handleReorderQueueItems(req, 'other-tenant');
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid body: bad UUIDs, empty list, duplicate ids', async () => {
    for (const body of [
      { pageId: 'nope', itemIds: [ID_A] },
      { pageId, itemIds: ['nope'] },
      { pageId, itemIds: [] },
      { pageId, itemIds: [ID_A, ID_A] },
    ]) {
      const res = await handleReorderQueueItems(reorderRequest(body), 'acme');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('INVALID_REQUEST');
    }
  });

  describe('legacy path', () => {
    function mockDb(queuedIds: string[]): {
      db: Partial<DatabaseClient>;
      calls: Array<{ sql: string; params: unknown[] }>;
    } {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const db: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM queue_items')) {
            return Promise.resolve(queuedIds.map((id) => ({ id })));
          }
          return Promise.resolve([]);
        }),
      };
      return { db, calls };
    }

    it('returns 404 when the workspace cannot be resolved', async () => {
      const db: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) return Promise.resolve([]);
          return Promise.resolve([]);
        }),
      };
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_A] }),
        'acme',
        db as DatabaseClient
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 NON_QUEUED_ITEM for an id outside the queued set', async () => {
      const { db } = mockDb([ID_A, ID_B]);
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_A, ID_C] }),
        'acme',
        db as DatabaseClient
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('NON_QUEUED_ITEM');
    });

    it('returns 400 INCOMPLETE_ORDER for a partial list', async () => {
      const { db } = mockDb([ID_A, ID_B]);
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_A] }),
        'acme',
        db as DatabaseClient
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('INCOMPLETE_ORDER');
    });

    it('rewrites queue_seq densely in one CASE UPDATE inside a transaction', async () => {
      const { db, calls } = mockDb([ID_A, ID_B]);
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_B, ID_A] }),
        'acme',
        db as DatabaseClient
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, itemIds: [ID_B, ID_A] });

      const statements = calls.map((call) => call.sql.trim());
      // Workspace resolution runs before the transaction opens.
      const beginIndex = statements.indexOf('BEGIN');
      const commitIndex = statements.indexOf('COMMIT');
      expect(beginIndex).toBeGreaterThan(-1);
      expect(commitIndex).toBeGreaterThan(beginIndex);
      const update = calls.find((call) => call.sql.includes('UPDATE queue_items'));
      expect(update).toBeDefined();
      expect(update!.sql).toContain('CASE id');
      // Position 1 = ID_B, position 2 = ID_A, then workspace + page scope.
      expect(update!.params).toEqual([ID_B, ID_A, 'ws_123', pageId]);
      expect(statements.some((sql) => sql === 'ROLLBACK')).toBe(false);
    });

    it('rolls back and returns 500 when the update fails', async () => {
      const db: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_123' }]);
          if (sql.includes('FROM queue_items') && sql.includes('SELECT')) {
            return Promise.resolve([{ id: ID_A }, { id: ID_B }]);
          }
          if (sql.includes('UPDATE queue_items')) {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve([]);
        }),
      };
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_B, ID_A] }),
        'acme',
        db as DatabaseClient
      );
      expect(res.status).toBe(500);
    });
  });

  describe('Supabase path', () => {
    type Row = Record<string, unknown>;
    class FakeSupabaseQuery {
      private filters: Array<[string, unknown]> = [];
      private patch: Row | null = null;
      private from = 0;
      private to: number | null = null;
      constructor(
        private store: { rows: Row[] },
        private table: string
      ) {}
      select(): this {
        return this;
      }
      eq(col: string, val: unknown): this {
        this.filters.push([col, val]);
        return this;
      }
      order(): this {
        return this;
      }
      range(from: number, to: number): this {
        this.from = from;
        this.to = to;
        return this;
      }
      update(patch: Row): this {
        this.patch = patch;
        return this;
      }
      async maybeSingle(): Promise<{ data: Row | null; error: null }> {
        const found = this.applyFilters();
        return { data: found[0] ?? null, error: null };
      }
      then(resolve: (value: { data?: Row[]; error: null }) => void): void {
        if (this.patch) {
          for (const row of this.applyFilters()) Object.assign(row, this.patch);
          resolve({ error: null });
        } else {
          const all = this.applyFilters();
          const sliced =
            this.to === null ? all : all.slice(this.from, this.to + 1);
          resolve({ data: sliced, error: null });
        }
      }
      private applyFilters(): Row[] {
        return this.store.rows.filter((row) =>
          this.filters.every(([col, val]) => row[col] === val)
        );
      }
    }
    class FakeSupabase {
      constructor(private store: { rows: Row[] }) {}
      from(table: string): FakeSupabaseQuery {
        return new FakeSupabaseQuery(this.store, table);
      }
    }

    function storeWith(queued: Array<{ id: string; queue_seq: number }>): { rows: Row[] } {
      return {
        rows: [
          { id: 'ws_123', subdomain: 'acme', owner_id: userId },
          ...queued.map((item) => ({
            ...item,
            workspace_id: 'ws_123',
            destination_id: pageId,
            status: 'queued',
          })),
        ],
      };
    }

    it('rewrites queue_seq densely via two-pass updates', async () => {
      const store = storeWith([
        { id: ID_A, queue_seq: 1 },
        { id: ID_B, queue_seq: 2 },
      ]);
      const fake = new FakeSupabase(store);
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_B, ID_A] }),
        'acme',
        fake as never
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, itemIds: [ID_B, ID_A] });
      const byId = new Map(store.rows.map((row) => [row.id as string, row]));
      expect(byId.get(ID_B)?.queue_seq).toBe(1);
      expect(byId.get(ID_A)?.queue_seq).toBe(2);
    });

    it('rejects a non-queued id and an incomplete list', async () => {
      const store = storeWith([
        { id: ID_A, queue_seq: 1 },
        { id: ID_B, queue_seq: 2 },
      ]);
      const fake = new FakeSupabase(store);
      const nonQueued = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_A, ID_C] }),
        'acme',
        fake as never
      );
      expect(nonQueued.status).toBe(400);
      expect((await nonQueued.json()).error).toBe('NON_QUEUED_ITEM');
      const incomplete = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: [ID_A] }),
        'acme',
        fake as never
      );
      expect(incomplete.status).toBe(400);
      expect((await incomplete.json()).error).toBe('INCOMPLETE_ORDER');
    });

    it('validates against the full queued set past the first 1,000-row page (P1-6)', async () => {
      const ids = Array.from(
        { length: 1001 },
        (_, i) => `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`
      );
      const store = storeWith(ids.map((id, index) => ({ id, queue_seq: index + 1 })));
      const fake = new FakeSupabase(store);
      const reversed = [...ids].reverse();
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: reversed }),
        'acme',
        fake as never
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, itemIds: reversed });
      const byId = new Map(store.rows.map((row) => [row.id as string, row]));
      expect(byId.get(reversed[0])?.queue_seq).toBe(1);
      expect(byId.get(reversed[1000])?.queue_seq).toBe(1001);
    });

    it('fails loud past 10 full pages instead of validating a truncated set (P1-6)', async () => {
      const ids = Array.from(
        { length: 10001 },
        (_, i) => `11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`
      );
      const store = storeWith(ids.map((id, index) => ({ id, queue_seq: index + 1 })));
      const fake = new FakeSupabase(store);
      const res = await handleReorderQueueItems(
        reorderRequest({ pageId, itemIds: ids }),
        'acme',
        fake as never
      );
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('QUEUE_TOO_LARGE');
    });
  });
});
