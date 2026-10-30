/**
 * Instagram accounts API — list + disconnect, tenant-scoped.
 *
 * The two guards this suite pins: (1) every query is scoped to
 * `platform = 'instagram'` — a Facebook account sharing an id must
 * never be listed or deleted here; (2) another tenant's subdomain is
 * forbidden and a missing session is unauthorized, never a silent
 * empty list. The SQL path is exercised through a DatabaseClient
 * double, mirroring the existing Facebook disconnect suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListInstagramAccounts } from '../../src/app/api/tenant/[subdomain]/instagram/accounts/route';
import { handleDisconnectInstagramAccount } from '../../src/app/api/tenant/[subdomain]/instagram/accounts/[accountId]/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-only-instagram-accounts-session-secret-1234567890';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-a222-222222222222';
const EXPIRED_ID = '33333333-3333-4333-a333-333333333333';

let validSessionCookie: string;

const listRows = [
  {
    id: ACCOUNT_ID,
    external_account_id: 'ig-123',
    display_name: 'Sunset Bakery',
    avatar_url: null,
    status: 'active',
    token_expires_at: '2027-01-01T00:00:00Z',
    created_at: '2026-10-12T00:00:00Z',
    updated_at: '2026-10-12T00:00:00Z',
    destination_count: 1,
    destination_handle: 'sunset.bakery',
    destination_name: 'Sunset Bakery',
  },
  {
    id: EXPIRED_ID,
    external_account_id: 'ig-456',
    display_name: 'River Yoga',
    avatar_url: null,
    status: 'expired',
    token_expires_at: '2026-10-01T00:00:00Z',
    created_at: '2026-09-03T00:00:00Z',
    updated_at: '2026-09-03T00:00:00Z',
  },
];

function mockListDb(capturedSql: string[]) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      capturedSql.push(sql);
      if (sql.includes('FROM workspaces')) {
        return Promise.resolve([{ id: 'ws_123' }]);
      }
      if (sql.includes('COUNT(*)::int AS total')) {
        return Promise.resolve([
          { total: 2, connected_count: 1, expired_count: 1, error_count: 0 },
        ]);
      }
      if (sql.includes('FROM social_accounts sa')) {
        return Promise.resolve(listRows);
      }
      return Promise.resolve([]);
    }),
  } as unknown as DatabaseClient;
}

describe('Instagram accounts API', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId: USER_ID,
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

  describe('GET /api/tenant/[subdomain]/instagram/accounts', () => {
    it('lists Instagram accounts expired-first, scoped to platform instagram', async () => {
      const capturedSql: string[] = [];
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts',
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleListInstagramAccounts(req, 'acme', mockListDb(capturedSql));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(2);
      expect(json.accounts).toHaveLength(2);
      // Expired first, regardless of the row order the query returned.
      expect(json.accounts[0].id).toBe(EXPIRED_ID);
      expect(json.accounts[0].status).toBe('expired');
      expect(json.accounts[1].status).toBe('active');
      expect(json.healthCounts).toEqual({ connected: 1, expired: 1, error: 0 });
      // Destinations join: the connected account carries its real
      // destination count + handle (the linked-pages analogue).
      const connected = json.accounts.find((a: { id: string }) => a.id === ACCOUNT_ID);
      expect(connected.destinationCount).toBe(1);
      expect(connected.destinationHandle).toBe('sunset.bakery');
      expect(connected.destinationName).toBe('Sunset Bakery');
      // No token material ever leaves the route.
      expect(JSON.stringify(json)).not.toContain('encrypted');
      expect(capturedSql.some((sql) => sql.includes("platform = 'instagram'"))).toBe(true);
      expect(capturedSql.some((sql) => sql.includes("platform = 'facebook'"))).toBe(false);
    });

    it('returns 401 without a session and 403 for another tenant', async () => {
      const noSession = new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts'
      );
      const res401 = await handleListInstagramAccounts(noSession, 'acme', mockListDb([]));
      expect(res401.status).toBe(401);

      const wrongTenant = new NextRequest(
        'http://localhost:3000/api/tenant/other/instagram/accounts',
        { headers: { cookie: validSessionCookie } }
      );
      const res403 = await handleListInstagramAccounts(wrongTenant, 'other', mockListDb([]));
      expect(res403.status).toBe(403);
    });
  });

  describe('DELETE /api/tenant/[subdomain]/instagram/accounts/[accountId]', () => {
    function mockDeleteDb(capturedSql: string[], deleteRows: unknown[]) {
      return {
        query: vi.fn().mockImplementation((sql: string) => {
          capturedSql.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ count: 1 }]);
          }
          if (sql.includes('DELETE FROM social_accounts')) {
            return Promise.resolve(deleteRows);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
    }

    it('deletes only the Instagram account and reports its destination count', async () => {
      const capturedSql: string[] = [];
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/instagram/accounts/${ACCOUNT_ID}`,
        { method: 'DELETE', headers: { cookie: validSessionCookie } }
      );
      const res = await handleDisconnectInstagramAccount(
        req,
        'acme',
        ACCOUNT_ID,
        mockDeleteDb(capturedSql, [{ id: ACCOUNT_ID }])
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.accountId).toBe(ACCOUNT_ID);
      expect(json.disconnectedDestinationsCount).toBe(1);
      const deleteSql = capturedSql.find((sql) =>
        sql.includes('DELETE FROM social_accounts')
      );
      expect(deleteSql).toContain("platform = 'instagram'");
    });

    it('returns 404 when no such Instagram account exists in this workspace', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/instagram/accounts/${ACCOUNT_ID}`,
        { method: 'DELETE', headers: { cookie: validSessionCookie } }
      );
      const res = await handleDisconnectInstagramAccount(
        req,
        'acme',
        ACCOUNT_ID,
        mockDeleteDb([], [])
      );
      expect(res.status).toBe(404);
    });

    it('returns 401 without a session', async () => {
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/instagram/accounts/${ACCOUNT_ID}`,
        { method: 'DELETE' }
      );
      const res = await handleDisconnectInstagramAccount(
        req,
        'acme',
        ACCOUNT_ID,
        mockDeleteDb([], [{ id: ACCOUNT_ID }])
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET Supabase path — range paging (P1-1)', () => {
    type Row = Record<string, unknown>;
    const ranges: Array<{ table: string; from: number; to: number }> = [];
    class FakeQuery {
      private filters: Array<[string, unknown]> = [];
      private from = 0;
      private to: number | null = null;
      constructor(
        private rows: Row[],
        private table: string,
        private destinationsError?: string
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
        ranges.push({ table: this.table, from, to });
        return this;
      }
      async maybeSingle(): Promise<{ data: Row | null; error: null }> {
        const found = this.apply();
        return { data: found[0] ?? null, error: null };
      }
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => void): void {
        if (this.table === 'destinations' && this.destinationsError) {
          resolve({ data: null, error: { message: this.destinationsError } });
          return;
        }
        const all = this.apply();
        const sliced = this.to === null ? all : all.slice(this.from, this.to + 1);
        resolve({ data: sliced, error: null });
      }
      private apply(): Row[] {
        return this.rows.filter((row) =>
          this.filters.every(([col, val]) => row[col] === val)
        );
      }
    }
    class FakeSupabase {
      constructor(
        private tables: Record<string, Row[]>,
        private destinationsError?: string
      ) {}
      from(table: string): FakeQuery {
        return new FakeQuery(this.tables[table] ?? [], table, this.destinationsError);
      }
    }

    function uuidFor(i: number): string {
      return `22222222-2222-4222-8222-${i.toString(16).padStart(12, '0')}`;
    }
    function accountRow(id: string, createdAt: string): Row {
      return {
        id,
        external_account_id: `ig-${id.slice(0, 8)}`,
        display_name: `Account ${id.slice(0, 8)}`,
        avatar_url: null,
        status: 'active',
        token_expires_at: '2027-01-01T00:00:00Z',
        created_at: createdAt,
        updated_at: createdAt,
        workspace_id: 'ws_123',
        platform: 'instagram',
      };
    }
    function supabaseWith(accountRows: Row[], destinations: Row[], destinationsError?: string) {
      return new FakeSupabase(
        {
          workspaces: [{ id: 'ws_123', subdomain: 'acme', owner_id: USER_ID }],
          social_accounts: accountRows,
          destinations,
        },
        destinationsError
      );
    }
    function listRequest() {
      return new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts',
        { headers: { cookie: validSessionCookie } }
      );
    }

    it('lists accounts with destinations through the range-paged Supabase path', async () => {
      ranges.length = 0;
      const fake = supabaseWith(
        [accountRow(ACCOUNT_ID, '2026-10-12T00:00:00Z')],
        [
          {
            account_id: ACCOUNT_ID,
            name: 'Sunset Bakery',
            handle: 'sunset.bakery',
            created_at: '2026-10-12T00:00:00Z',
            workspace_id: 'ws_123',
            platform: 'instagram',
          },
        ]
      );
      const res = await handleListInstagramAccounts(listRequest(), 'acme', fake as never);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(1);
      expect(json.accounts[0].destinationHandle).toBe('sunset.bakery');
      // Both selects went through .range().
      expect(ranges.some((r) => r.table === 'social_accounts')).toBe(true);
      expect(ranges.some((r) => r.table === 'destinations')).toBe(true);
    });

    it('fetches past the first 1,000-row page instead of truncating', async () => {
      ranges.length = 0;
      const rows = Array.from({ length: 1001 }, (_, i) =>
        accountRow(uuidFor(i), '2026-10-12T00:00:00Z')
      );
      const fake = supabaseWith(rows, []);
      const res = await handleListInstagramAccounts(listRequest(), 'acme', fake as never);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(1001);
      const accountRanges = ranges.filter((r) => r.table === 'social_accounts');
      expect(accountRanges).toHaveLength(2);
      expect(accountRanges[1]).toEqual({ table: 'social_accounts', from: 1000, to: 1999 });
    });

    it('fails loud past 10 full pages instead of returning wrong totals', async () => {
      const rows = Array.from({ length: 10001 }, (_, i) =>
        accountRow(uuidFor(i), '2026-10-12T00:00:00Z')
      );
      const fake = supabaseWith(rows, []);
      const res = await handleListInstagramAccounts(listRequest(), 'acme', fake as never);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe(
        'Too many accounts to list reliably; please contact support.'
      );
    });

    it('surfaces a destinations error instead of rendering accounts without destinations', async () => {
      const fake = supabaseWith(
        [accountRow(ACCOUNT_ID, '2026-10-12T00:00:00Z')],
        [],
        'destinations boom'
      );
      const res = await handleListInstagramAccounts(listRequest(), 'acme', fake as never);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('destinations boom');
    });
  });
});
