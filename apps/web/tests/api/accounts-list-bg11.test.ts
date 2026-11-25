/**
 * Audit BG11 — list filter/sort unification across the two DB paths.
 *
 * The Supabase path's filterAndSortAccounts must use the same
 * expired model as the SQL path and the shell: 'active' means
 * connected (active + live/absent token), 'expired' means the
 * shared expired predicate, 'expiring_soon' means active with a
 * token 1–7 days out, and sort is expired-first by that same
 * predicate. The SQL path's expired filter text must likewise
 * cover a past token on any wire status, not just active rows.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  filterAndSortAccounts,
  handleListAccounts,
} from '../../src/app/api/tenant/[subdomain]/accounts/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const userId = '11111111-1111-4111-a111-111111111111';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const SOON = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

function acct(overrides: Record<string, unknown>) {
  return {
    displayName: 'Account',
    status: 'active',
    tokenExpiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as never;
}

describe('filterAndSortAccounts (BG11, Supabase path)', () => {
  const rows = [
    acct({ displayName: 'ActiveLive', status: 'active', tokenExpiresAt: FUTURE }),
    acct({ displayName: 'ActivePast', status: 'active', tokenExpiresAt: PAST }),
    acct({ displayName: 'DisconnectedPast', status: 'disconnected', tokenExpiresAt: PAST }),
    acct({ displayName: 'DisconnectedLive', status: 'disconnected', tokenExpiresAt: FUTURE }),
    acct({ displayName: 'ExpiredWire', status: 'expired', tokenExpiresAt: FUTURE }),
    acct({ displayName: 'ActiveSoon', status: 'active', tokenExpiresAt: SOON }),
    acct({ displayName: 'DisconnectedSoon', status: 'disconnected', tokenExpiresAt: SOON }),
  ];

  it("filters 'expired' by the shared predicate, not the wire status alone", () => {
    const names = filterAndSortAccounts(rows, { search: '', status: 'expired' }).map(
      (a) => (a as { displayName: string }).displayName
    );
    expect(names.sort()).toEqual(
      ['ActivePast', 'DisconnectedPast', 'ExpiredWire'].sort()
    );
  });

  it("filters 'active' to connected rows only (active + live/absent token)", () => {
    const names = filterAndSortAccounts(rows, { search: '', status: 'active' }).map(
      (a) => (a as { displayName: string }).displayName
    );
    expect(names.sort()).toEqual(['ActiveLive', 'ActiveSoon'].sort());
  });

  it("filters 'expiring_soon' to active rows with a token 1-7 days out", () => {
    const names = filterAndSortAccounts(rows, {
      search: '',
      status: 'expiring_soon',
    }).map((a) => (a as { displayName: string }).displayName);
    expect(names).toEqual(['ActiveSoon']);
  });

  it('sorts expired-first by the shared predicate, then newest first', () => {
    const sorted = filterAndSortAccounts(rows, { search: '', status: 'all' }).map(
      (a) => (a as { displayName: string }).displayName
    );
    const expiredPart = sorted.slice(0, 3);
    expect(expiredPart.sort()).toEqual(
      ['ActivePast', 'DisconnectedPast', 'ExpiredWire'].sort()
    );
  });

  it("filters 'error' to the complement of expired and connected (UX2)", () => {
    const names = filterAndSortAccounts(rows, { search: '', status: 'error' }).map(
      (a) => (a as { displayName: string }).displayName
    );
    // Neither expired (live/soon token, non-expired wire) nor
    // connected (not active): both disconnected rows with a
    // non-past token are health 'error'.
    expect(names).toEqual(['DisconnectedLive', 'DisconnectedSoon']);
  });
});

describe('SQL expired filter text (BG11)', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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

  it('covers a past token on any wire status in the expired filter', async () => {
    const seenSql: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seenSql.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts?status=expired',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    const dataQuery = seenSql.find(
      (sql) => sql.includes('FROM social_accounts sa') && sql.includes('LIMIT')
    );
    expect(dataQuery).toBeDefined();
    // Unified predicate: expired wire status OR any past token —
    // no active-only restriction on the token half.
    expect(dataQuery).toContain("sa.token_expires_at < now()");
    expect(dataQuery).not.toContain("sa.status = 'active' AND sa.token_expires_at < now()");
  });

  it('escapes ILIKE wildcards in the search term (N2)', async () => {
    const seenSql: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seenSql.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts?search=100%25',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    const dataQuery = seenSql.find(
      (sql) => sql.includes('FROM social_accounts sa') && sql.includes('LIMIT')
    );
    expect(dataQuery).toBeDefined();
    expect(dataQuery).toContain('ILIKE');
    expect(dataQuery).toContain("ESCAPE '\\'");
  });

  it('rejects an unknown status filter instead of silently listing all (N2)', async () => {
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts?status=bogus',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(400);
  });

  it('runs the workspace-wide lapse sync before the list fetch (N3)', async () => {
    const seenSql: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seenSql.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    const syncIdx = seenSql.findIndex((sql) =>
      sql.includes("SET status = 'expired'") && sql.includes('token_expires_at < now()')
    );
    const dataIdx = seenSql.findIndex(
      (sql) => sql.includes('FROM social_accounts sa') && sql.includes('LIMIT')
    );
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThan(syncIdx);
    // Workspace-wide, not page-scoped: no per-row id filter.
    expect(seenSql[syncIdx]).not.toContain('WHERE id = $1');
  });

  it("filters 'error' as neither connected nor expired (UX2)", async () => {
    const seenSql: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seenSql.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts?status=error',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    const dataQuery = seenSql.find(
      (sql) => sql.includes('FROM social_accounts sa') && sql.includes('LIMIT')
    );
    expect(dataQuery).toBeDefined();
    expect(dataQuery).toContain('NOT (sa.status = ');
    expect(dataQuery).toContain("sa.token_expires_at < now()");
  });
});

describe('Spec 249 — disconnected accounts hidden from the list', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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

  it('SQL path: the count and data queries exclude disconnected accounts', async () => {
    const seenSql: string[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        seenSql.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    const countQuery = seenSql.find((sql) => sql.includes('SELECT COUNT(*)'));
    const dataQuery = seenSql.find(
      (sql) => sql.includes('FROM social_accounts sa') && sql.includes('LIMIT')
    );
    expect(countQuery).toBeDefined();
    expect(dataQuery).toBeDefined();
    // The exclusion lives in the shared WHERE, so it covers the
    // count (health counts) and the page slice alike.
    expect(countQuery).toContain("sa.status <> 'disconnected'");
    expect(dataQuery).toContain("sa.status <> 'disconnected'");
  });

  describe('Supabase path', () => {
    type Row = Record<string, unknown>;

    // Minimal chain double for the exact query-builder surface the
    // route uses: select/eq/neq/lt/order/range/update/maybeSingle,
    // awaited via `then`. It records every neq call so the test
    // proves the exclusion happens at the query, not in memory.
    class FakeFbQuery {
      private filters: Array<(row: Row) => boolean> = [];
      private from = 0;
      private to: number | null = null;
      private updateValues: Row | null = null;
      constructor(
        private rows: Row[],
        private neqCalls: Array<[string, unknown]>
      ) {}
      select(): this {
        return this;
      }
      eq(col: string, val: unknown): this {
        this.filters.push((row) => row[col] === val);
        return this;
      }
      neq(col: string, val: unknown): this {
        this.neqCalls.push([col, val]);
        this.filters.push((row) => row[col] !== val);
        return this;
      }
      lt(col: string, val: unknown): this {
        this.filters.push(
          (row) => row[col] != null && String(row[col]) < String(val)
        );
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
      update(values: Row): this {
        this.updateValues = values;
        return this;
      }
      async maybeSingle(): Promise<{ data: Row | null; error: null }> {
        const found = this.apply();
        return { data: found[0] ?? null, error: null };
      }
      then(resolve: (v: { data: Row[] | null; error: null }) => void): void {
        const rows = this.apply();
        if (this.updateValues) {
          for (const row of rows) Object.assign(row, this.updateValues);
        }
        const sliced =
          this.to === null ? rows : rows.slice(this.from, this.to + 1);
        resolve({ data: sliced, error: null });
      }
      private apply(): Row[] {
        return this.rows.filter((row) =>
          this.filters.every((f) => f(row))
        );
      }
    }

    function fbAccountRow(
      id: string,
      displayName: string,
      status: string,
      tokenExpiresAt: string
    ): Row {
      return {
        id,
        external_account_id: `fb-${id.slice(0, 8)}`,
        display_name: displayName,
        avatar_url: null,
        metadata: {},
        status,
        token_expires_at: tokenExpiresAt,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        workspace_id: 'ws_123',
        platform: 'facebook',
        destinations: [],
      };
    }

    function fakeSupabase(accountRows: Row[]) {
      const neqCalls: Array<[string, unknown]> = [];
      const tables: Record<string, Row[]> = {
        workspaces: [
          { id: 'ws_123', subdomain: 'acme', owner_id: userId },
        ],
        social_accounts: accountRows,
      };
      const fake = {
        from: (table: string) =>
          new FakeFbQuery(tables[table] ?? [], neqCalls),
      };
      return { fake, neqCalls };
    }

    function listRequest(url: string) {
      return new NextRequest(url, {
        headers: { cookie: validSessionCookie },
      });
    }

    const fixtureRows = () => [
      fbAccountRow(
        'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        'Active Alice',
        'active',
        FUTURE
      ),
      fbAccountRow(
        'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        'Disconnected Dana',
        'disconnected',
        FUTURE
      ),
      fbAccountRow(
        'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        'Revoked Rosa',
        'revoked',
        FUTURE
      ),
      fbAccountRow(
        'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        'Expired Evan',
        'expired',
        FUTURE
      ),
    ];

    it('default list: a disconnected account is absent, and out of the health counts', async () => {
      const { fake, neqCalls } = fakeSupabase(fixtureRows());
      const res = await handleListAccounts(
        listRequest('http://localhost:3000/api/tenant/acme/accounts'),
        'acme',
        fake as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(3);
      expect(
        json.accounts.map((a: Row) => a.displayName)
      ).toEqual(['Expired Evan', 'Active Alice', 'Revoked Rosa']);
      // The revoked row still surfaces as an error (wire
      // 'disconnected'); the stored-disconnected row is gone
      // from the error bucket too.
      expect(json.healthCounts).toEqual({
        connected: 1,
        expired: 1,
        error: 1,
      });
      expect(neqCalls).toContainEqual(['status', 'disconnected']);
    });

    it('search: a disconnected account never matches', async () => {
      const { fake } = fakeSupabase(fixtureRows());
      const res = await handleListAccounts(
        listRequest(
          'http://localhost:3000/api/tenant/acme/accounts?search=Dana'
        ),
        'acme',
        fake as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(0);
      expect(json.accounts).toEqual([]);
    });

    it("error filter: a disconnected account is absent (only wire-disconnected rows remain)", async () => {
      const { fake } = fakeSupabase(fixtureRows());
      const res = await handleListAccounts(
        listRequest(
          'http://localhost:3000/api/tenant/acme/accounts?status=error'
        ),
        'acme',
        fake as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(1);
      expect(json.accounts.map((a: Row) => a.displayName)).toEqual([
        'Revoked Rosa',
      ]);
      expect(json.healthCounts).toEqual({
        connected: 0,
        expired: 0,
        error: 1,
      });
    });
  });
});
