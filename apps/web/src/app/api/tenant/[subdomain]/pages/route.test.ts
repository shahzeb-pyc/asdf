/**
 * Pages list `statusDetail` filter — spec 155 SEND BACK (PR 199,
 * item 6).
 *
 * The detail Select narrows the list to one exact wire status in
 * BOTH paths: the SQL path binds the detail as a query parameter
 * inside the wire-status CASE (`buildStatusDetailCondition`), the
 * Supabase path applies the PostgREST form
 * (`applySupabaseStatusDetail`). These tests drive the exported
 * `handleListPages` seam with fake clients and assert the filter
 * actually reaches the query — not just that the UI sends it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveTenantWorkspaceId: vi.fn(),
}));

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...actual,
    getSessionSecret: () => 'test-secret',
    verifySessionToken: vi.fn(async () => ({
      userId: 'user-1',
      role: 'admin',
      subdomain: 'acme',
      status: 'active',
    })),
    canAccessTenant: () => ({ allowed: true }),
  };
});
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(() => null),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: mocks.resolveTenantWorkspaceId,
}));

import { handleListPages } from './route';

const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function request(statusDetail?: string): NextRequest {
  const url = `http://localhost/api/tenant/acme/pages${
    statusDetail === undefined ? '' : `?statusDetail=${statusDetail}`
  }`;
  return new NextRequest(url, {
    headers: { cookie: 'fbup_session=test-session' },
  });
}

const SQL_ROW = {
  id: PAGE_ID,
  facebook_account_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  account_display_name: 'Acct',
  account_avatar_url: null,
  fb_page_id: '123',
  page_name: 'Page',
  profile_picture_url: null,
  timezone: 'Asia/Karachi',
  category: null,
  starting_followers: 0,
  current_followers: 0,
  status: 'missing_permission',
  tasks: [],
  unmatched_post_types: [],
  rate_limited_at: null,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
};

const SUPABASE_ROW = {
  id: PAGE_ID,
  account_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  external_destination_id: '123',
  name: 'Page',
  avatar_url: null,
  timezone: 'Asia/Karachi',
  metadata: { fb_status: 'missing_permission' },
  status: 'error',
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  social_accounts: { display_name: 'Acct', avatar_url: null },
};

function fakeSqlDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return [{ total: 1, attention_total: 1 }];
    if (sql.includes('FROM destinations d')) return [SQL_ROW];
    return [];
  });
  return { query, calls };
}

/** Minimal thenable PostgREST builder recording every filter call. */
class FakeSupabaseQuery {
  calls: Array<{ method: string; args: unknown[] }> = [];
  table: string;
  isCount = false;
  private countShared: { n: number };

  constructor(table: string, countShared: { n: number }) {
    this.table = table;
    this.countShared = countShared;
  }

  select(_columns: string, opts?: { count?: string; head?: boolean }) {
    this.calls.push({ method: 'select', args: [_columns, opts] });
    this.isCount = opts?.head === true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.calls.push({ method: 'eq', args: [column, value] });
    return this;
  }

  or(filters: string) {
    this.calls.push({ method: 'or', args: [filters] });
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.calls.push({ method: 'not', args: [column, operator, value] });
    return this;
  }

  in(column: string, values: unknown) {
    this.calls.push({ method: 'in', args: [column, values] });
    return this;
  }

  order(_column: string, _opts?: unknown) {
    this.calls.push({ method: 'order', args: [_column, _opts] });
    return this;
  }

  range(_from: number, _to: number) {
    this.calls.push({ method: 'range', args: [_from, _to] });
    return this;
  }

  then(
    onFulfilled: (value: { data: unknown[] | null; error: null; count: number | null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) {
    let result: { data: unknown[] | null; error: null; count: number | null };
    if (this.table === 'queue_items') {
      result = { data: [], error: null, count: 0 };
    } else if (this.isCount) {
      // First count query (attention group) carries the row; the
      // other groups are empty, so the page slice is one page.
      const count = this.countShared.n === 0 ? 1 : 0;
      this.countShared.n += 1;
      result = { data: [], error: null, count };
    } else {
      result = { data: [SUPABASE_ROW], error: null, count: null };
    }
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

function fakeSupabaseDb() {
  const countShared = { n: 0 };
  const queries: FakeSupabaseQuery[] = [];
  const from = vi.fn((table: string) => {
    const q = new FakeSupabaseQuery(table, countShared);
    queries.push(q);
    return q;
  });
  return { from, queries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantWorkspaceId.mockResolvedValue(WORKSPACE_ID);
});

describe('handleListPages statusDetail (spec 155)', () => {
  it('SQL path: binds missing_permission as a parameter in the wire-status condition', async () => {
    const db = fakeSqlDb();
    const res = await handleListPages(request('missing_permission'), 'acme', db as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.pages[0]?.status).toBe('missing_permission');
    const dataQuery = db.calls.find((c) => c.sql.includes('FROM destinations d') && !c.sql.includes('COUNT(*)'));
    expect(dataQuery).toBeDefined();
    expect(dataQuery?.params).toContain('missing_permission');
    expect(dataQuery?.sql).toContain('fb_status');
  });

  it('SQL path: fb_rate_limited uses the freshness-aware condition (no bound param)', async () => {
    const db = fakeSqlDb();
    const res = await handleListPages(request('fb_rate_limited'), 'acme', db as never);
    expect(res.status).toBe(200);
    const dataQuery = db.calls.find((c) => c.sql.includes('FROM destinations d') && !c.sql.includes('COUNT(*)'));
    expect(dataQuery).toBeDefined();
    expect(dataQuery?.sql).toContain('rate_limited_at');
    expect(dataQuery?.sql).toContain('3 days');
    expect(dataQuery?.params).not.toContain('fb_rate_limited');
  });

  it('SQL path: an unknown statusDetail value narrows nothing', async () => {
    const db = fakeSqlDb();
    const res = await handleListPages(request('not_a_status'), 'acme', db as never);
    expect(res.status).toBe(200);
    const dataQuery = db.calls.find((c) => c.sql.includes('FROM destinations d') && !c.sql.includes('COUNT(*)'));
    expect(dataQuery?.params).not.toContain('not_a_status');
  });

  it('Supabase path: applies the missing_permission detail predicate', async () => {
    const db = fakeSupabaseDb();
    const res = await handleListPages(request('missing_permission'), 'acme', db as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: Array<{ id: string; status: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.pages[0]?.status).toBe('missing_permission');
    const destQueries = db.queries.filter((q) => q.table === 'destinations');
    expect(destQueries.length).toBeGreaterThan(0);
    expect(
      destQueries.some((q) =>
        q.calls.some(
          (c) => c.method === 'eq' && c.args[0] === 'metadata->>fb_status' && c.args[1] === 'missing_permission'
        )
      )
    ).toBe(true);
    expect(
      destQueries.some((q) =>
        q.calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'error')
      )
    ).toBe(true);
  });

  it('Supabase path: fb_rate_limited uses the fresh-anchor predicate', async () => {
    const db = fakeSupabaseDb();
    const res = await handleListPages(request('fb_rate_limited'), 'acme', db as never);
    expect(res.status).toBe(200);
    const destQueries = db.queries.filter((q) => q.table === 'destinations');
    expect(
      destQueries.some((q) =>
        q.calls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'rate_limited')
      )
    ).toBe(true);
    expect(
      destQueries.some((q) =>
        q.calls.some(
          (c) => c.method === 'or' && typeof c.args[0] === 'string' && (c.args[0] as string).includes('metadata->>rate_limited_at.gt.')
        )
      )
    ).toBe(true);
  });

  it('Supabase path: an unknown statusDetail value narrows nothing', async () => {
    const db = fakeSupabaseDb();
    const res = await handleListPages(request('not_a_status'), 'acme', db as never);
    expect(res.status).toBe(200);
    const destQueries = db.queries.filter((q) => q.table === 'destinations');
    // The only fb_status eq in any group query is the paused-group
    // predicate (fb_status='paused'); the unknown detail adds none.
    const fbStatusValues = destQueries.flatMap((q) =>
      q.calls
        .filter((c) => c.method === 'eq' && c.args[0] === 'metadata->>fb_status')
        .map((c) => c.args[1])
    );
    expect(fbStatusValues).not.toContain('not_a_status');
    expect(fbStatusValues.every((v) => v === 'paused')).toBe(true);
  });
});
