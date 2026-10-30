/**
 * @file threads-accounts.test.ts
 * @description Route tests for the Threads accounts list + disconnect.
 * Uses an in-memory fake Supabase builder that implements the exact
 * query-builder surface the route uses (eq / ilike / or / neq /
 * order / range / maybeSingle / update / delete). These tests can
 * catch the two regressions that matter most here: a Facebook
 * account leaking into the Threads list, and expired-first ordering
 * breaking across the page slice.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListThreadsAccounts } from '../../src/app/api/tenant/[subdomain]/threads/accounts/route';
import { handleDisconnectThreadsAccount } from '../../src/app/api/tenant/[subdomain]/threads/accounts/[accountId]/route';

const TEST_SECRET = 'test-session-secret-for-threads-accounts';
const USER_ID = '11111111-1111-4111-a111-111111111111';

type Row = Record<string, unknown>;

function evalCond(row: Row, cond: string): boolean {
  const m = cond.match(/^([^.]+)\.(eq|lt|gte|is)\.(.+)$/);
  if (!m) return false;
  const [, field, op, raw] = m as [string, string, string, string];
  const value = row[field];
  if (op === 'is') return raw === 'null' ? value == null : value === raw;
  if (op === 'eq') return String(value) === raw;
  if (value == null) return false;
  const a = Date.parse(String(value));
  const b = Date.parse(raw);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return op === 'lt' ? a < b : a >= b;
}

class FakeBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private head = false;
  private mode: 'select' | 'update' | 'delete' = 'select';
  private updateValues: Row = {};

  constructor(
    private dataset: { tables: Record<string, Row[]> },
    private table: string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push((row) => row[col] !== val);
    return this;
  }

  ilike(col: string, pattern: string): this {
    const needle = pattern.replace(/%/g, '').toLowerCase();
    this.filters.push((row) =>
      String(row[col] ?? '').toLowerCase().includes(needle)
    );
    return this;
  }

  or(orStr: string): this {
    const conds = orStr.split(',');
    this.filters.push((row) => conds.some((c) => evalCond(row, c)));
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  update(values: Row): this {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  private filtered(): Row[] {
    return this.dataset.tables[this.table]!.filter((row) =>
      this.filters.every((f) => f(row))
    );
  }

  private resolve(): {
    data: Row[] | Row | null;
    count: number | null;
    error: null;
  } {
    const rows = this.filtered();
    if (this.mode === 'update') {
      for (const row of rows) Object.assign(row, this.updateValues);
      return { data: rows, count: rows.length, error: null };
    }
    if (this.mode === 'delete') {
      const table = this.dataset.tables[this.table]!;
      for (const row of rows) {
        const idx = table.indexOf(row);
        if (idx >= 0) table.splice(idx, 1);
      }
      return { data: rows, count: rows.length, error: null };
    }
    if (this.head) {
      return { data: [], count: rows.length, error: null };
    }
    let out = [...rows];
    if (this.orderCol) {
      const col = this.orderCol;
      out.sort((a, b) => {
        const cmp = String(a[col]).localeCompare(String(b[col]));
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      out = out.slice(this.rangeFrom, this.rangeTo + 1);
    }
    return { data: out, count: rows.length, error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const { data } = this.resolve();
    const arr = data as Row[];
    return { data: arr[0] ?? null, error: null };
  }

  then<TResult>(
    onFulfilled?: (value: {
      data: Row[] | Row | null;
      count: number | null;
      error: null;
    }) => TResult
  ): Promise<TResult> {
    return Promise.resolve(this.resolve()).then(onFulfilled);
  }
}

function makeFake() {
  const tables: Record<string, Row[]> = {
    workspaces: [
      { id: 'ws-1', subdomain: 'acme', owner_id: USER_ID },
    ],
    social_accounts: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        workspace_id: 'ws-1',
        platform: 'threads',
        external_account_id: 'th-exp',
        display_name: 'Expired Willow',
        avatar_url: null,
        status: 'expired',
        token_expires_at: '2020-01-01T00:00:00Z',
        created_at: '2026-09-03T10:00:00Z',
        updated_at: '2026-09-03T10:00:00Z',
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
        workspace_id: 'ws-1',
        platform: 'threads',
        external_account_id: 'th-past',
        display_name: 'Past Token Paul',
        avatar_url: null,
        status: 'active',
        token_expires_at: '2020-06-01T00:00:00Z',
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
      },
      {
        id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        workspace_id: 'ws-1',
        platform: 'threads',
        external_account_id: 'th-con',
        display_name: 'Connected Cedar',
        avatar_url: null,
        status: 'active',
        token_expires_at: '2027-01-01T00:00:00Z',
        created_at: '2026-10-12T10:00:00Z',
        updated_at: '2026-10-12T10:00:00Z',
      },
      {
        id: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
        workspace_id: 'ws-1',
        platform: 'threads',
        external_account_id: 'th-dis',
        display_name: 'Disconnected Dana',
        avatar_url: null,
        status: 'disconnected',
        token_expires_at: '2027-01-01T00:00:00Z',
        created_at: '2026-10-05T10:00:00Z',
        updated_at: '2026-10-05T10:00:00Z',
      },
      {
        id: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee',
        workspace_id: 'ws-1',
        platform: 'facebook',
        external_account_id: 'fb-1',
        display_name: 'Facebook Felix',
        avatar_url: null,
        status: 'active',
        token_expires_at: '2027-01-01T00:00:00Z',
        created_at: '2026-10-20T10:00:00Z',
        updated_at: '2026-10-20T10:00:00Z',
      },
    ],
    destinations: [
      {
        id: 'dest-1',
        account_id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
        workspace_id: 'ws-1',
        platform: 'threads',
      },
    ],
  };
  const fake = {
    from: (table: string) => new FakeBuilder({ tables }, table),
  };
  return { fake, tables };
}

describe('Threads accounts list route', () => {
  let cookie: string;

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
    cookie = `fbup_session=${token}`;
  });

  it('lists Threads accounts expired-first and never Facebook accounts', async () => {
    const { fake } = makeFake();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts',
      { headers: { cookie } }
    );
    const res = await handleListThreadsAccounts(req, 'acme', fake as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(4);
    expect(json.healthCounts).toEqual({
      connected: 1,
      expired: 2,
      error: 1,
    });
    // Expired first (newest expired first), then the rest newest first.
    expect(json.accounts.map((a: Row) => a.displayName)).toEqual([
      'Past Token Paul',
      'Expired Willow',
      'Connected Cedar',
      'Disconnected Dana',
    ]);
    expect(
      json.accounts.some((a: Row) => a.displayName === 'Facebook Felix')
    ).toBe(false);
    // The past-token account is reported expired, not active.
    expect(json.accounts[0].status).toBe('expired');
  });

  it('status=expired returns only the expired bucket', async () => {
    const { fake } = makeFake();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts?status=expired',
      { headers: { cookie } }
    );
    const res = await handleListThreadsAccounts(req, 'acme', fake as never);
    const json = await res.json();
    expect(json.total).toBe(2);
    expect(json.accounts.map((a: Row) => a.displayName)).toEqual([
      'Past Token Paul',
      'Expired Willow',
    ]);
  });

  it('search filters by display name', async () => {
    const { fake } = makeFake();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts?search=cedar',
      { headers: { cookie } }
    );
    const res = await handleListThreadsAccounts(req, 'acme', fake as never);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.accounts[0].displayName).toBe('Connected Cedar');
  });

  it('rejects unauthenticated requests', async () => {
    const { fake } = makeFake();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts'
    );
    const res = await handleListThreadsAccounts(req, 'acme', fake as never);
    expect(res.status).toBe(401);
  });

  it('disconnect removes only the Threads account and counts its destinations', async () => {
    const { fake, tables } = makeFake();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/threads/accounts/cccccccc-cccc-4ccc-cccc-cccccccccccc',
      { method: 'DELETE', headers: { cookie } }
    );
    const res = await handleDisconnectThreadsAccount(
      req,
      'acme',
      'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      fake as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.disconnectedDestinationsCount).toBe(1);
    expect(
      tables.social_accounts.some(
        (a) => a.id === 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
      )
    ).toBe(false);
    // The Facebook account is untouched.
    expect(
      tables.social_accounts.some((a) => a.id === 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee')
    ).toBe(true);
  });
});
