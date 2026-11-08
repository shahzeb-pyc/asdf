import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { POST as postUsage } from '@/app/api/tenant/[subdomain]/billing/usage/route';
import { getActivePeriod, getUsageCounts } from '@/lib/billing/entitlement';

/**
 * Plan-check R4 (usage endpoint returns the read it already
 * made): POST /billing/usage builds its response from the
 * entitlement registerUsage already computed — no getActivePeriod
 * + getUsageCounts re-read after the insert. The returned
 * entitlement is the PRE-insert read, so the registered
 * platform's count is adjusted by +1 when, and only when, a row
 * was actually inserted (that adjustment is `usedCount`, which
 * registerUsage derives +1 on the clean-insert path and re-reads
 * on the already-used path).
 *
 * Pinned per case, against a fresh re-read after the call:
 * - new registration: response usage + allowedCount match the
 *   re-read (count adjusted +1), and NO query runs after the
 *   insert — the re-read is gone, not just answered the same.
 * - already-used destination: no adjustment (count unchanged),
 *   and again no query after the insert.
 * - new registration on a DISCONNECTED destination: the inserted
 *   row does not count, so the response must NOT add +1 — a bare
 *   +1 here would overstate by one versus the fresh re-read.
 *
 * In-memory Supabase stand-in, same pattern as the other billing
 * tests: filters AND together, a duplicate (user, platform, key)
 * insert fails with 23505 like the real unique index, and every
 * executed query is logged so the tests can pin that a read
 * really went away.
 */
type Row = Record<string, unknown>;

interface QueryLogEntry {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  head: boolean;
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string,
    private readonly queryLog: QueryLogEntry[],
    private readonly isUsage = false
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }

  insert(): this {
    return this;
  }

  update(): this {
    return this;
  }

  delete(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  neq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] !== value);
    return this;
  }

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  is(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  lte(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) <= value);
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) > value);
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.mode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.mode = 'maybeSingle';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: { code: string } | null; count?: number } {
    this.queryLog.push({ table: this.tableName, op: this.op, head: this.head });
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of rows) {
        const clash = this.table.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
      }
      const inserted = rows.map((row) => {
        const fresh: Row = { id: this.idSeq(), ...row };
        this.table.push(fresh);
        return { ...fresh };
      });
      return { data: inserted, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const row of this.table) {
        if (this.matches(row)) {
          Object.assign(row, patch);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    if (this.op === 'delete') {
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) this.table.splice(i, 1);
      }
      return { data: [], error: null };
    }
    let rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
    const count = rows.length;
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.head) return { data: [], error: null, count };
    if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
    if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, count };
  }

  then(
    resolve: (value: { data: unknown; error: { code: string } | null; count?: number }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeClient() {
  const tables: Record<string, Row[]> = {
    subscription_periods: [],
    subscription_usage: [],
    subscription_payments: [],
    workspaces: [],
    destinations: [],
  };
  const queryLog: QueryLogEntry[] = [];
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const isUsage = table === 'subscription_usage';
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table, queryLog, isUsage).select(cols, opts),
        insert: (payload: Row | Row[]) =>
          new FakeQuery(rows, 'insert', payload, idSeq, table, queryLog, isUsage),
        update: (payload: Row) =>
          new FakeQuery(rows, 'update', payload, idSeq, table, queryLog, isUsage),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table, queryLog, isUsage),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, tables, queryLog };
}

const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;
const USER_ID = 'user-1';
const DISCONNECTED_DESTINATION_ID = '22222222-2222-4222-8222-222222222222';

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: USER_ID,
      email: 'user@example.com',
      name: 'User',
      subdomain: 'acme',
      role: 'user',
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => holder.client,
  };
});

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) } as never;

function seedPaidPeriod(tables: Record<string, Row[]>, facebookCount = 5) {
  tables['subscription_periods'].push({
    id: 'period-1',
    user_id: USER_ID,
    facebook_count: facebookCount,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    ends_at: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedUsage(
  tables: Record<string, Row[]>,
  platform: string,
  key: string,
  feature = 'destination-queue',
  destinationId: string | null = null
) {
  tables['subscription_usage'].push({
    id: `usage-${platform}-${key}`,
    user_id: USER_ID,
    platform,
    destination_key: key,
    feature,
    destination_id: destinationId,
  });
}

function seedWorkspace(tables: Record<string, Row[]>, workspaceId = 'ws-1') {
  tables['workspaces'].push({ id: workspaceId, owner_id: USER_ID });
}

async function postRegister(body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost:3000/api/tenant/acme/billing/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await postUsage(req, ctx);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe('usage route R4 response (no post-insert re-read)', () => {
  beforeEach(() => {
    holder.client = null as unknown;
  });

  it('new registration: response usage + allowedCount match a fresh re-read, with no query after the insert', async () => {
    const { client, tables, queryLog } = makeClient();
    holder.client = client;
    seedPaidPeriod(tables);
    seedUsage(tables, 'facebook', 'page-0');

    const { res, body } = await postRegister({
      platform: 'facebook',
      destinationKey: 'page-1',
      feature: 'destination-queue',
    });
    expect(res.status).toBe(200);
    expect(body['alreadyUsed']).toBe(false);
    expect(body['usedCount']).toBe(2);
    // Snapshot the log now: the fresh re-read below logs into the
    // same log, so the "re-read is gone" assertions use this copy.
    const logAfterPost = [...queryLog];

    // Fresh re-read after the call: the response must agree with it.
    const freshUsage = await getUsageCounts(client, USER_ID);
    const freshPeriod = await getActivePeriod(client, USER_ID, NOW);
    expect(body['usage']).toEqual(freshUsage);
    expect(body['usage']).toEqual({
      facebook: 2,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
    expect(body['allowedCount']).toBe(freshPeriod?.counts['facebook']);
    expect(body['allowedCount']).toBe(5);

    // The re-read is gone: the period was read exactly once (the
    // shared getEntitlement read), and nothing at all runs after
    // the usage insert — the response is built from the returned
    // read, not from a second read.
    expect(
      logAfterPost.filter((entry) => entry.table === 'subscription_periods' && entry.op === 'select')
        .length
    ).toBe(1);
    const insertIndex = logAfterPost.findIndex(
      (entry) => entry.table === 'subscription_usage' && entry.op === 'insert'
    );
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(logAfterPost.slice(insertIndex + 1)).toEqual([]);
  });

  it('already-used destination: no +1 adjustment, response matches a fresh re-read, no period re-read after the insert', async () => {
    const { client, tables, queryLog } = makeClient();
    holder.client = client;
    seedPaidPeriod(tables);
    seedUsage(tables, 'facebook', 'page-1');

    const { res, body } = await postRegister({
      platform: 'facebook',
      destinationKey: 'page-1',
      feature: 'destination-queue',
    });
    expect(res.status).toBe(200);
    expect(body['alreadyUsed']).toBe(true);
    expect(body['usedCount']).toBe(1);
    // Snapshot the log now: the fresh re-read below logs into the
    // same log, so the "re-read is gone" assertions use this copy.
    const logAfterPost = [...queryLog];

    const freshUsage = await getUsageCounts(client, USER_ID);
    const freshPeriod = await getActivePeriod(client, USER_ID, NOW);
    expect(body['usage']).toEqual(freshUsage);
    expect(body['usage']).toEqual({
      facebook: 1,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
    expect(body['allowedCount']).toBe(freshPeriod?.counts['facebook']);
    expect(body['allowedCount']).toBe(5);

    // The re-read is gone: the period was read exactly once (the
    // shared getEntitlement read). The insert collides (23505) on
    // the existing row, so the register's own already-used handler
    // runs its lookup + exact re-count — that is pre-existing
    // register behaviour, not the response re-read: no period
    // select follows the insert.
    expect(
      logAfterPost.filter((entry) => entry.table === 'subscription_periods' && entry.op === 'select')
        .length
    ).toBe(1);
    const insertIndex = logAfterPost.findIndex(
      (entry) => entry.table === 'subscription_usage' && entry.op === 'insert'
    );
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(logAfterPost.slice(insertIndex + 1)).toEqual([
      { table: 'subscription_usage', op: 'select', head: false },
      { table: 'workspaces', op: 'select', head: false },
      { table: 'subscription_usage', op: 'select', head: true },
    ]);
  });

  it('new registration on a disconnected destination: the inserted row does not count, so no +1', async () => {
    const { client, tables, queryLog } = makeClient();
    holder.client = client;
    seedPaidPeriod(tables);
    seedWorkspace(tables);
    tables['destinations'].push({
      id: DISCONNECTED_DESTINATION_ID,
      platform: 'facebook',
      status: 'disconnected',
      workspace_id: 'ws-1',
    });

    const { res, body } = await postRegister({
      platform: 'facebook',
      destinationKey: 'page-1',
      feature: 'destination-queue',
      destinationId: DISCONNECTED_DESTINATION_ID,
    });
    expect(res.status).toBe(200);
    expect(body['alreadyUsed']).toBe(false);
    // The row was inserted, but it links to a disconnected
    // destination, so it counts for nothing: usedCount and the
    // response usage stay 0, exactly as a fresh re-read reports.
    expect(body['usedCount']).toBe(0);
    // Snapshot the log now: the fresh re-read below logs into the
    // same log, so the "re-read is gone" assertions use this copy.
    const logAfterPost = [...queryLog];

    const freshUsage = await getUsageCounts(client, USER_ID);
    const freshPeriod = await getActivePeriod(client, USER_ID, NOW);
    expect(body['usage']).toEqual(freshUsage);
    expect(body['usage']).toEqual({
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
    expect(body['allowedCount']).toBe(freshPeriod?.counts['facebook']);
    expect(body['allowedCount']).toBe(5);

    // The only post-insert queries are the disconnected-status
    // lookup and the exact re-count it forces (workspace +
    // destination map, then the raw head count and the
    // disconnected-subtraction head count) — no period re-read.
    expect(
      logAfterPost.filter((entry) => entry.table === 'subscription_periods' && entry.op === 'select')
        .length
    ).toBe(1);
    const insertIndex = logAfterPost.findIndex(
      (entry) => entry.table === 'subscription_usage' && entry.op === 'insert'
    );
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    const afterInsert = logAfterPost.slice(insertIndex + 1);
    expect(afterInsert).toEqual([
      { table: 'destinations', op: 'select', head: false },
      { table: 'workspaces', op: 'select', head: false },
      { table: 'destinations', op: 'select', head: false },
      { table: 'subscription_usage', op: 'select', head: true },
      { table: 'subscription_usage', op: 'select', head: true },
    ]);
  });
});
