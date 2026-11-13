/**
 * Threads ADU POST route (plan-check B1).
 *
 * The route must REGISTER the Threads cap unit when a config is
 * created — before B1 it only cap-checked at add, so a user could
 * add unlimited Threads configs. These tests run the REAL
 * registerAduConfigUsage / assertFeatureAddWithinCap against an
 * in-memory Supabase stand-in (same fake pattern as
 * usage-publish-now.test.ts), with only the tenant context mocked:
 * a successful add leaves a usage row, an at-cap add is blocked
 * before any config row is created, and a bulk add registers one
 * unit per config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  threadsAduContext: vi.fn(),
  getBillingAdminClient: vi.fn(),
}));

const ctxHolder: { client: SupabaseClient | null } = { client: null };

vi.mock('@/lib/server/threads-adu', () => ({
  threadsAduContext: mocks.threadsAduContext,
  threadsAduMissingTable: () => false,
  loadThreadsAduConfigView: vi.fn(),
  loadThreadsAduDestination: vi.fn(),
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: mocks.getBillingAdminClient,
  subscriptionGateResponse: (err: unknown) => {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SUBSCRIPTION_CAP_REACHED' || code === 'SUBSCRIPTION_REQUIRED') {
      return new Response(JSON.stringify({ error: code }), { status: 403 });
    }
    return null;
  },
}));
vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(),
  getRouteSupabase: vi.fn(() => null),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: vi.fn(),
}));
vi.mock('@/lib/connect/account-probe', () => ({
  isTokenDeadGraphStatus: vi.fn(() => false),
  markAccountConnectionError: vi.fn(),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { POST } from './route';

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;
  private selectCalled = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectCalled = true;
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
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of rows) {
        if (this.tableName === 'subscription_usage') {
          // Spec 174 PR 2B: the fake unique index mirrors the real
          // one — (user, platform, section, key).
          const clash = this.table.some(
            (existing) =>
              existing['user_id'] === row['user_id'] &&
              existing['platform'] === row['platform'] &&
              existing['section'] === row['section'] &&
              existing['destination_key'] === row['destination_key']
          );
          if (clash) return { data: null, error: { code: '23505' } };
        }
        // Mirrors idx_adu_configs_destination_unique (one config per
        // destination page). Spec 161 dropped the source-uniqueness
        // index, so the same source on two destinations must NOT clash.
        if (this.tableName === 'adu_configs') {
          const clash = this.table.some(
            (existing) => existing['destination_id'] === row['destination_id']
          );
          if (clash) return { data: null, error: { code: '23505' } };
        }
      }
      const inserted = rows.map((row) => {
        const fresh: Row = { id: this.idSeq(), ...row };
        this.table.push(fresh);
        return { ...fresh };
      });
      if (this.mode === 'single' || this.mode === 'maybeSingle') {
        return { data: inserted[0] ?? null, error: null };
      }
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
      return { data: this.selectCalled ? updated : [], error: null };
    }
    if (this.op === 'delete') {
      const deleted: Row[] = [];
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) {
          deleted.push({ ...(this.table[i] as Row) });
          this.table.splice(i, 1);
        }
      }
      return { data: this.selectCalled ? deleted : [], error: null };
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

/**
 * Plan-check C2 fix-up — the `get_entitlement` RPC answer,
 * computed straight from the fixture tables the way the SQL
 * function does (active period window, per-platform counts with
 * the disconnected exclusion and the legacy publish-now
 * exclusion, ever-paid flag). A real implementation against the
 * tables, not a canned success — a broken RPC still fails the
 * parity tests.
 */
const RPC_PLATFORMS = ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube'] as const;
const RPC_LEGACY_FEATURES = ['publish-now', 'instagram-publish-now', 'threads-publish-now'];

function computeEntitlementRpc(
  tables: Record<string, Row[]>,
  userId: string,
  nowIso: string
): Row {
  const periods = (tables['subscription_periods'] ?? []).filter(
    (row) => row['user_id'] === userId
  );
  const sortedActive = periods
    .filter(
      (row) =>
        row['superseded_at'] === null &&
        typeof row['starts_at'] === 'string' &&
        (row['starts_at'] as string) <= nowIso &&
        typeof row['ends_at'] === 'string' &&
        (row['ends_at'] as string) > nowIso
    )
    .sort((a, b) => String(b['ends_at']).localeCompare(String(a['ends_at'])));
  const active: Row | null = sortedActive.length > 0 ? sortedActive[0] : null;
  const workspaceIds = new Set(
    (tables['workspaces'] ?? [])
      .filter((row) => row['owner_id'] === userId)
      .map((row) => row['id'] as string)
  );
  const disconnectedByPlatform = new Map<string, Set<string>>();
  for (const dest of tables['destinations'] ?? []) {
    if (
      dest['status'] === 'disconnected' &&
      workspaceIds.has(dest['workspace_id'] as string) &&
      (RPC_PLATFORMS as readonly string[]).includes(dest['platform'] as string)
    ) {
      const set = disconnectedByPlatform.get(dest['platform'] as string) ?? new Set<string>();
      set.add(dest['id'] as string);
      disconnectedByPlatform.set(dest['platform'] as string, set);
    }
  }
  const usage: Row = {};
  for (const platform of RPC_PLATFORMS) {
    usage[platform] = (tables['subscription_usage'] ?? []).filter(
      (row) =>
        row['user_id'] === userId &&
        row['platform'] === platform &&
        !RPC_LEGACY_FEATURES.includes(row['feature'] as string) &&
        !(
          typeof row['destination_id'] === 'string' &&
          (disconnectedByPlatform.get(platform) ?? new Set<string>()).has(
            row['destination_id'] as string
          )
        )
    ).length;
  }
  return {
    period: active ? { ...active } : null,
    usage,
    has_prior_period: periods.length > 0,
  };
}

function makeClient() {
  const tables: Record<string, Row[]> = {
    subscription_periods: [],
    subscription_usage: [],
    destinations: [],
    social_accounts: [],
    workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
    adu_configs: [],
    adu_reels: [],
    subscription_payments: [],
    seller_commissions: [],
  };
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table).select(cols, opts),
        insert: (payload: Row | Row[]) => new FakeQuery(rows, 'insert', payload, idSeq, table),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload, idSeq, table),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table),
      };
    },
    rpc(fn: string, args: { p_user_id: string; p_now: string }) {
      if (fn !== 'get_entitlement') {
        return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
      }
      return Promise.resolve({
        data: computeEntitlementRpc(tables, args.p_user_id, args.p_now),
        error: null,
      });
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

const DAY = 86_400_000;
const DEST_9 = '99999999-9999-4999-8999-999999999999';
// Spec 174 2A: the ADU add takes the ACCOUNT id (a UUID — the
// account schemas validate it as one); the config attaches to the
// adu copy created from that account, never to a posted destination.
const ACCT_1 = '33333333-3333-4333-8333-333333333333';
const ACCT_2 = '44444444-4444-4444-8444-444444444444';

function seedActivePeriod(tables: Record<string, Row[]>, threadsCount: number) {
  const now = Date.now();
  tables['subscription_periods'].push({
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 0,
    instagram_count: 0,
    threads_count: threadsCount,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(now - 10 * DAY).toISOString(),
    ends_at: new Date(now + 20 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedDestination(tables: Record<string, Row[]>, id: string, externalId: string) {
  tables['destinations'].push({
    id,
    workspace_id: 'ws-1',
    platform: 'threads',
    external_destination_id: externalId,
    metadata: { current_followers: 0 },
    status: 'active',
  });
}

function seedThreadsAccount(tables: Record<string, Row[]>, id: string, externalId: string) {
  tables['social_accounts'].push({
    id,
    workspace_id: 'ws-1',
    platform: 'threads',
    external_account_id: externalId,
    display_name: `Threads ${externalId}`,
    avatar_url: null,
    status: 'active',
  });
}

function postRequest(body: unknown): NextRequest {
  return new Request('http://localhost/api/tenant/ws/threads/auto-download-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function params() {
  return { params: Promise.resolve({ subdomain: 'ws' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxHolder.client = null;
  mocks.threadsAduContext.mockImplementation(() => ({
    context: {
      workspaceId: 'ws-1',
      supabase: ctxHolder.client,
      userId: 'user-1',
      role: 'user',
    },
  }));
  mocks.getBillingAdminClient.mockImplementation(() => ctxHolder.client);
});

describe('POST /threads/auto-download-upload (plan-check B1)', () => {
  it('a single add registers one Threads cap unit', async () => {
    const { client, tables } = makeClient();
    ctxHolder.client = client;
    seedActivePeriod(tables, 2);
    seedThreadsAccount(tables, ACCT_1, 'threads-acct-1');

    const res = await POST(
      postRequest({
        accountId: ACCT_1,
        sourcePlatform: 'instagram',
        sourceUsername: 'someone',
        timezone: 'UTC',
        postsPerDay: 1,
        scheduleType: 'dailyrandom',
      }),
      params()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe('string');
    expect(tables['adu_configs']).toHaveLength(1);
    // Spec 162 (send-back fix): the creation path writes
    // current_followers, so it stamps followers_updated_at too —
    // the timestamp must mean "last successful follower check"
    // from the moment the config exists, not only after the first
    // daily worker run.
    const config = tables['adu_configs'][0] as Record<string, unknown>;
    expect(config['starting_followers']).toBe(0);
    expect(config['current_followers']).toBe(0);
    expect(typeof config['followers_updated_at']).toBe('string');
    expect(
      Number.isNaN(Date.parse(config['followers_updated_at'] as string))
    ).toBe(false);
    expect(tables['subscription_usage']).toHaveLength(1);
    // Spec 174 2A: the usage registers against the adu COPY the
    // config attaches to (created from the account here), not the
    // posted account id.
    const copy = tables['destinations'].find((row) => row['section'] === 'adu');
    expect(copy?.['external_destination_id']).toBe('threads-acct-1');
    expect(tables['subscription_usage'][0]).toMatchObject({
      user_id: 'user-1',
      platform: 'threads',
      destination_key: 'threads-acct-1',
      feature: 'auto-download-upload',
      // Spec 174 PR 2B: the row carries the section its feature maps to.
      section: 'adu',
      destination_id: copy?.['id'],
    });
  });

  it('an at-cap add is blocked by the gate before any config is created', async () => {
    const { client, tables } = makeClient();
    ctxHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsAccount(tables, ACCT_1, 'threads-acct-1');
    seedDestination(tables, DEST_9, 'threads-acct-9');
    tables['subscription_usage'].push({
      id: 'usage-9',
      user_id: 'user-1',
      platform: 'threads',
      destination_key: 'threads-acct-9',
      feature: 'auto-download-upload',
      // Spec 174 PR 2B: the seeded row carries its section.
      section: 'adu',
      destination_id: DEST_9,
    });

    const res = await POST(
      postRequest({
        accountId: ACCT_1,
        sourcePlatform: 'instagram',
        sourceUsername: 'someone',
        timezone: 'UTC',
        postsPerDay: 1,
        scheduleType: 'dailyrandom',
      }),
      params()
    );
    expect(res.status).toBe(403);
    expect(tables['adu_configs']).toHaveLength(0);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('the same source on two pages succeeds (spec 161)', async () => {
    const { client, tables } = makeClient();
    ctxHolder.client = client;
    seedActivePeriod(tables, 2);
    seedThreadsAccount(tables, ACCT_1, 'threads-acct-1');
    seedThreadsAccount(tables, ACCT_2, 'threads-acct-2');

    const res = await POST(
      postRequest({
        items: [
          { accountId: ACCT_1, sourcePlatform: 'instagram', sourceUsername: 'someone' },
          { accountId: ACCT_2, sourcePlatform: 'instagram', sourceUsername: 'someone' },
        ],
        timezone: 'UTC',
        postsPerDay: 1,
        scheduleType: 'dailyrandom',
      }),
      params()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created?: string[]; failed?: unknown[] };
    expect(body.created).toHaveLength(2);
    expect(body.failed).toHaveLength(0);
    expect(tables['adu_configs']).toHaveLength(2);
    expect(tables['subscription_usage']).toHaveLength(2);
    expect(
      (tables['subscription_usage'] as Row[])
        .map((row) => row['destination_key'])
        .sort()
    ).toEqual(['threads-acct-1', 'threads-acct-2']);
  });

  it('the same destination twice is rejected with the destination-only message (spec 161)', async () => {
    const { client, tables } = makeClient();
    ctxHolder.client = client;
    seedActivePeriod(tables, 2);
    seedThreadsAccount(tables, ACCT_1, 'threads-acct-1');

    const body = {
      accountId: ACCT_1,
      sourcePlatform: 'instagram',
      sourceUsername: 'someone',
      timezone: 'UTC',
      postsPerDay: 1,
      scheduleType: 'dailyrandom',
    };
    const first = await POST(postRequest(body), params());
    expect(first.status).toBe(201);
    const second = await POST(postRequest(body), params());
    expect(second.status).toBe(400);
    expect((await second.json()) as { error?: string }).toEqual({
      error: 'This account is already configured.',
    });
    expect(tables['adu_configs']).toHaveLength(1);
    expect(tables['subscription_usage']).toHaveLength(1);
  });
});
