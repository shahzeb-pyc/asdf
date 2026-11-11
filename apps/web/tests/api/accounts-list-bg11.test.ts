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
import type { DatabaseClient, Database } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

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
        if (sql.includes('SELECT 1 AS one')) {
          // F3: the lapse-sync existence probe finds a lapsed row,
          // so the UPDATE below must run.
          return Promise.resolve([{ one: 1 }]);
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

  it('skips the lapse-sync UPDATE when nothing is lapsed (F3)', async () => {
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
        // The existence probe finds nothing lapsed.
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/accounts',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(req, 'acme', db);
    expect(res.status).toBe(200);
    expect(
      seenSql.some((sql) => sql.includes("SET status = 'expired'"))
    ).toBe(false);
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

/**
 * F3 (spec 170) — prod (Supabase) path tests. The fake below is a
 * small in-memory PostgREST emulator: it applies the filters the
 * route pushes down (eq/neq/or/ilike/gt/gte/lt/lte/in/order/range)
 * to fixture rows, so a filter the route forgot to push down shows
 * up as wrong rows, and every call is recorded so the tests can
 * prove the list is fetched as bounded ranges + head counts — never
 * as a full-set fetch.
 */
type FakeRow = Record<string, unknown>;

interface FakeCall {
  table: string;
  op: string;
  args: unknown[];
}

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count: number | null;
}

function fakeValue(row: FakeRow, column: string): unknown {
  const arrow = column.indexOf('->>');
  if (arrow >= 0) {
    const base = column.slice(0, arrow);
    const key = column.slice(arrow + 3);
    const holder = row[base];
    if (holder !== null && typeof holder === 'object' && !Array.isArray(holder)) {
      return (holder as Record<string, unknown>)[key];
    }
    return undefined;
  }
  return row[column];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ilikeMatches(value: string, pattern: string): boolean {
  // LIKE pattern → RegExp: \% / \_ / \\ are literals, % is .*, _ is .
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '\\' && i + 1 < pattern.length) {
      re += escapeRegExp(pattern.charAt(i + 1));
      i++;
    } else if (ch === '%') {
      re += '.*';
    } else if (ch === '_') {
      re += '.';
    } else {
      re += escapeRegExp(ch);
    }
  }
  re += '$';
  return new RegExp(re, 'i').test(value);
}

function compareValues(actual: unknown, operator: string, expected: string): boolean {
  if (operator === 'is') {
    return expected === 'null' ? actual === null || actual === undefined : false;
  }
  if (actual === null || actual === undefined) return false;
  const a = String(actual);
  switch (operator) {
    case 'eq':
      return a === expected;
    case 'neq':
      return a !== expected;
    case 'lt':
      return a < expected;
    case 'lte':
      return a <= expected;
    case 'gt':
      return a > expected;
    case 'gte':
      return a >= expected;
    case 'ilike':
      return ilikeMatches(a, expected);
    default:
      throw new Error(`FakePostgrest: unsupported operator ${operator}`);
  }
}

function parseOrClause(clause: string): (row: FakeRow) => boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith('and(') || trimmed.startsWith('or(')) {
    throw new Error(`FakePostgrest: nested or() clause not supported: ${trimmed}`);
  }
  const firstDot = trimmed.indexOf('.');
  const secondDot = trimmed.indexOf('.', firstDot + 1);
  if (firstDot < 0 || secondDot < 0) {
    throw new Error(`FakePostgrest: cannot parse or() clause ${clause}`);
  }
  const column = trimmed.slice(0, firstDot);
  const operator = trimmed.slice(firstDot + 1, secondDot);
  const value = trimmed.slice(secondDot + 1);
  return (row) => compareValues(fakeValue(row, column), operator, value);
}

class FakePostgrestQuery {
  private filters: Array<(row: FakeRow) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private headCount = false;
  private updatePatch: Record<string, unknown> | null = null;

  constructor(
    private readonly table: string,
    private readonly store: Record<string, FakeRow[]>,
    private readonly calls: FakeCall[]
  ) {}

  private record(op: string, ...args: unknown[]): this {
    this.calls.push({ table: this.table, op, args });
    return this;
  }

  select(columns: string, opts?: { count?: string; head?: boolean }): this {
    this.headCount = opts?.head === true && opts?.count === 'exact';
    return this.record('select', columns, opts ?? null);
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => fakeValue(row, column) === value);
    return this.record('eq', column, value);
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => fakeValue(row, column) !== value);
    return this.record('neq', column, value);
  }

  gt(column: string, value: unknown): this {
    this.filters.push((row) =>
      compareValues(fakeValue(row, column), 'gt', String(value))
    );
    return this.record('gt', column, value);
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) =>
      compareValues(fakeValue(row, column), 'gte', String(value))
    );
    return this.record('gte', column, value);
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) =>
      compareValues(fakeValue(row, column), 'lt', String(value))
    );
    return this.record('lt', column, value);
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) =>
      compareValues(fakeValue(row, column), 'lte', String(value))
    );
    return this.record('lte', column, value);
  }

  ilike(column: string, pattern: string): this {
    this.filters.push((row) => {
      const v = fakeValue(row, column);
      return typeof v === 'string' && ilikeMatches(v, pattern);
    });
    return this.record('ilike', column, pattern);
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(fakeValue(row, column)));
    return this.record('in', column, values);
  }

  or(filters: string): this {
    const clauses = filters.split(',').map(parseOrClause);
    this.filters.push((row) => clauses.some((fn) => fn(row)));
    return this.record('or', filters);
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this.record('order', column, options ?? null);
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this.record('range', from, to);
  }

  update(patch: Record<string, unknown>): this {
    this.updatePatch = patch;
    return this.record('update', patch);
  }

  async maybeSingle(): Promise<FakeResult> {
    const rows = this.executeRows();
    return { data: rows[0] ?? null, error: null, count: null };
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?:
      | ((value: FakeResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private executeRows(): FakeRow[] {
    const table = this.store[this.table] ?? [];
    const rows = table.filter((row) => this.filters.every((fn) => fn(row)));
    if (this.updatePatch) {
      // Mutate the store rows in place so later reads see the flip.
      const patch = this.updatePatch;
      for (const row of rows) {
        Object.assign(row, patch);
      }
    }
    return rows;
  }

  private execute(): FakeResult {
    let rows = this.executeRows();
    if (this.headCount) {
      return { data: [], error: null, count: rows.length };
    }
    // First .order() call is the primary key: apply in reverse so
    // the stable sorts compose in call order.
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const order = this.orders[i];
      if (!order) continue;
      const { column, ascending } = order;
      rows = [...rows].sort((a, b) => {
        const av = fakeValue(a, column);
        const bv = fakeValue(b, column);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    }
    return { data: rows, error: null, count: null };
  }
}

function createFakeSupabase(store: Record<string, FakeRow[]>, calls: FakeCall[]) {
  return {
    from: (table: string) => new FakePostgrestQuery(table, store, calls),
  };
}

const SUPABASE_WS_ID = 'ws_123';

/**
 * Five accounts covering every health bucket, plus linked pages
 * covering the destinations predicate (active, disconnected,
 * disconnected+paused). Expired-first order over the whole set:
 * Moonlight (expired, Jan 4), Moonbeam (expired, Jan 2), Sunrise
 * (Jan 5), Starlight (Jan 3), Comet (Jan 1).
 */
function supabaseFixture(): Record<string, FakeRow[]> {
  const accounts: FakeRow[] = [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      external_account_id: 'fb_a1',
      display_name: 'Sunrise Media',
      avatar_url: null,
      metadata: {},
      status: 'active',
      token_expires_at: FUTURE,
      created_at: '2026-01-05T00:00:00.000Z',
      updated_at: '2026-01-05T00:00:00.000Z',
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      external_account_id: 'fb_a2',
      display_name: 'Moonlight Pages',
      avatar_url: null,
      metadata: {},
      status: 'active',
      token_expires_at: PAST,
      created_at: '2026-01-04T00:00:00.000Z',
      updated_at: '2026-01-04T00:00:00.000Z',
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      external_account_id: 'fb_a3',
      display_name: 'Starlight Hub',
      avatar_url: null,
      metadata: {},
      status: 'disconnected',
      token_expires_at: FUTURE,
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000004',
      external_account_id: 'fb_a4',
      display_name: 'Moonbeam Studio',
      avatar_url: null,
      metadata: {},
      status: 'expired',
      token_expires_at: FUTURE,
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000005',
      external_account_id: 'fb_a5',
      display_name: 'Comet Works',
      avatar_url: null,
      metadata: {},
      status: 'active',
      token_expires_at: SOON,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
    },
  ];
  const destinations: FakeRow[] = [
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000011',
      account_id: accounts[0]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Alpha Page',
      avatar_url: 'https://example.com/a.jpg',
      status: 'active',
      metadata: {},
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000012',
      account_id: accounts[0]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Beta Page',
      avatar_url: 'https://example.com/b.jpg',
      status: 'active',
      metadata: {},
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000013',
      account_id: accounts[1]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Gamma Page',
      avatar_url: null,
      status: 'active',
      metadata: {},
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000014',
      account_id: accounts[3]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Delta Page',
      avatar_url: null,
      status: 'active',
      metadata: {},
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000015',
      account_id: accounts[3]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Epsilon Page',
      avatar_url: null,
      status: 'disconnected',
      metadata: {},
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000016',
      account_id: accounts[3]?.id,
      workspace_id: SUPABASE_WS_ID,
      platform: 'facebook',
      name: 'Zeta Page',
      avatar_url: null,
      status: 'disconnected',
      metadata: { fb_status: 'paused' },
    },
  ];
  return {
    workspaces: [{ id: SUPABASE_WS_ID, subdomain: 'acme', owner_id: userId }],
    social_accounts: accounts,
    destinations,
  };
}

describe('Supabase (prod) path — DB-side paging (F3)', () => {
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

  async function listAccounts(
    query: string,
    store: Record<string, FakeRow[]> = supabaseFixture()
  ) {
    const calls: FakeCall[] = [];
    const fake = createFakeSupabase(store, calls);
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/accounts${query}`,
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListAccounts(
      req,
      'acme',
      fake as unknown as SupabaseClient<Database>
    );
    return { res, body: await res.json(), calls };
  }

  function accountNames(body: { accounts: Array<{ displayName: string }> }) {
    return body.accounts.map((a) => a.displayName);
  }

  it('fetches only the requested page as bounded ranges with full-set counts', async () => {
    const { res, body, calls } = await listAccounts('?page=1&limit=2');
    expect(res.status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(3);
    expect(body.healthCounts).toEqual({ connected: 2, expired: 2, error: 1 });
    expect(accountNames(body)).toEqual(['Moonlight Pages', 'Moonbeam Studio']);
    // Every social_accounts data select carried a .range() — no
    // unbounded full-set fetch — and the counts were head-only.
    const accountSelects = calls.filter(
      (c) => c.table === 'social_accounts' && c.op === 'select'
    );
    const dataSelects = accountSelects.filter(
      (c) => !((c.args[1] as { head?: boolean } | null) ?? {}).head
    );
    const ranges = calls.filter(
      (c) => c.table === 'social_accounts' && c.op === 'range'
    );
    expect(dataSelects.length).toBe(1);
    expect(ranges.length).toBe(dataSelects.length);
    expect(ranges).toEqual([expect.objectContaining({ args: [0, 1] })]);
    const headCounts = accountSelects.filter(
      (c) => ((c.args[1] as { head?: boolean } | null) ?? {}).head
    );
    // Three bucket counts + the lapse-sync existence probe.
    expect(headCounts.length).toBe(4);
  });

  it('page 2 returns the next slice with the same full-set counts', async () => {
    const { res, body, calls } = await listAccounts('?page=2&limit=2');
    expect(res.status).toBe(200);
    expect(accountNames(body)).toEqual(['Sunrise Media', 'Starlight Hub']);
    expect(body.total).toBe(5);
    expect(body.healthCounts).toEqual({ connected: 2, expired: 2, error: 1 });
    const ranges = calls.filter(
      (c) => c.table === 'social_accounts' && c.op === 'range'
    );
    // The expired slice is exhausted on page 1; page 2 is entirely
    // the non-expired slice (offset 2 - expired 2 = 0..1).
    expect(ranges).toEqual([expect.objectContaining({ args: [0, 1] })]);
  });

  it('a page straddling the expired boundary concatenates both slices in rank order', async () => {
    const { body } = await listAccounts('?page=1&limit=3');
    expect(accountNames(body)).toEqual([
      'Moonlight Pages',
      'Moonbeam Studio',
      'Sunrise Media',
    ]);
  });

  it("pushes the status filter down: 'expired' returns only expired rows", async () => {
    const { body } = await listAccounts('?status=expired');
    expect(accountNames(body)).toEqual(['Moonlight Pages', 'Moonbeam Studio']);
    expect(body.total).toBe(2);
    expect(body.healthCounts).toEqual({ connected: 0, expired: 2, error: 0 });
  });

  it("pushes the status filter down: 'active' returns only connected rows", async () => {
    const { body } = await listAccounts('?status=active');
    expect(accountNames(body)).toEqual(['Sunrise Media', 'Comet Works']);
    expect(body.total).toBe(2);
    expect(body.healthCounts).toEqual({ connected: 2, expired: 0, error: 0 });
  });

  it("pushes the status filter down: 'error' returns only error rows", async () => {
    const { body } = await listAccounts('?status=error');
    expect(accountNames(body)).toEqual(['Starlight Hub']);
    expect(body.total).toBe(1);
    expect(body.healthCounts).toEqual({ connected: 0, expired: 0, error: 1 });
  });

  it("pushes the status filter down: 'expiring_soon' returns only soon rows", async () => {
    const { body } = await listAccounts('?status=expiring_soon');
    expect(accountNames(body)).toEqual(['Comet Works']);
    expect(body.total).toBe(1);
    expect(body.healthCounts).toEqual({ connected: 1, expired: 0, error: 0 });
  });

  it('pushes the search filter down (case-insensitive, display name)', async () => {
    const { body } = await listAccounts('?search=moon');
    expect(accountNames(body)).toEqual(['Moonlight Pages', 'Moonbeam Studio']);
    expect(body.total).toBe(2);
  });

  it('trims connectedPages to id + pageName (no page avatar URLs)', async () => {
    const { body } = await listAccounts('?page=1&limit=30');
    const sunrise = body.accounts.find(
      (a: { displayName: string }) => a.displayName === 'Sunrise Media'
    );
    expect(sunrise.connectedPagesCount).toBe(2);
    expect(sunrise.connectedPages).toEqual([
      { id: 'bbbbbbbb-0000-4000-8000-000000000011', pageName: 'Alpha Page' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000012', pageName: 'Beta Page' },
    ]);
    const moonbeam = body.accounts.find(
      (a: { displayName: string }) => a.displayName === 'Moonbeam Studio'
    );
    // Delta (active) + Zeta (disconnected but paused); Epsilon
    // (disconnected, not paused) is excluded.
    expect(moonbeam.connectedPagesCount).toBe(2);
    expect(moonbeam.connectedPages.map((p: { pageName: string }) => p.pageName)).toEqual([
      'Delta Page',
      'Zeta Page',
    ]);
    // No page avatar URL anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain('example.com');
  });

  it('skips the lapse-sync UPDATE when nothing is lapsed', async () => {
    const store = supabaseFixture();
    for (const acc of store.social_accounts) {
      acc.token_expires_at = FUTURE;
      if (acc.status === 'expired') acc.status = 'active';
    }
    const { res, calls } = await listAccounts('', store);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('flips lapsed accounts before the list fetch', async () => {
    const { res, body, calls } = await listAccounts('');
    expect(res.status).toBe(200);
    const updates = calls.filter(
      (c) => c.op === 'update' && c.table === 'social_accounts'
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args[0]).toEqual(
      expect.objectContaining({ status: 'expired' })
    );
    const moonlight = body.accounts.find(
      (a: { displayName: string }) => a.displayName === 'Moonlight Pages'
    );
    expect(moonlight.status).toBe('expired');
    expect(moonlight.connectedPagesCount).toBe(1);
  });

  it('matches the JS predicate model (filterAndSortAccounts) on the same rows', async () => {
    const { body } = await listAccounts('?page=1&limit=30');
    const { body: expiredBody } = await listAccounts('?status=expired');
    const oracleExpired = filterAndSortAccounts(body.accounts, {
      search: '',
      status: 'expired',
    });
    expect(oracleExpired.map((a) => a.id)).toEqual(
      expiredBody.accounts.map((a: { id: string }) => a.id)
    );
    const oracleActive = filterAndSortAccounts(body.accounts, {
      search: '',
      status: 'active',
    });
    const { body: activeBody } = await listAccounts('?status=active');
    expect(oracleActive.map((a) => a.id)).toEqual(
      activeBody.accounts.map((a: { id: string }) => a.id)
    );
  });
});
