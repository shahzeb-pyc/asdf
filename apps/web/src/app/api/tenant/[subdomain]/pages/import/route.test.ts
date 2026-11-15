/**
 * Spec 193 — Schedule import registers the page toward the paid cap.
 *
 * Before this fix the import route only CHECKED the cap
 * (assertFeatureAddWithinCap) and registration happened only at
 * first queue, so an imported-but-never-queued page was never
 * counted (23 such rows found live, 2026-11-15). These tests drive
 * the exported `handleImportPages` seam with an in-memory fake
 * Supabase client and the REAL registerUsage / assertFeatureAddWithinCap,
 * and assert the usage row is actually written — not just that the
 * route called a function. The fake mirrors the billing-test
 * pattern in `entitlement-section.test.ts`: the `get_entitlement`
 * RPC answer is computed from the fixture tables, and a duplicate
 * (user, platform, section, key) insert fails with 23505 like the
 * real unique index. It additionally supports the destinations
 * upsert the import route uses, and a fault-injection flag for the
 * registration-failure rollback test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  fetchAllFacebookPages: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  getBillingAdminClient: vi.fn(),
  resolveWorkspaceIdFromSession: vi.fn(),
}));

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...actual,
    getSessionSecret: () => 'test-secret',
    getTokenEncryptionKey: () => 'test-encryption-key',
    verifySessionToken: vi.fn(async () => ({
      userId: 'user-1',
      role: 'user',
      subdomain: 'acme',
      status: 'active',
    })),
    canAccessTenant: () => ({ allowed: true }),
    decryptToken: vi.fn(async () => 'raw-token'),
    encryptToken: vi.fn(async (token: string) => `enc:${token}`),
    fetchAllFacebookPages: mocks.fetchAllFacebookPages,
  };
});
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: mocks.getSupabaseAdminClient,
}));
vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: mocks.getBillingAdminClient,
  };
});
vi.mock('@/lib/auth/session', () => ({
  validateSessionActive: vi.fn(async () => true),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
  trackServerEvent: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: mocks.resolveWorkspaceIdFromSession,
}));
vi.mock('@/lib/connect/account-probe', () => ({
  isTokenDeadGraphStatus: () => false,
  markAccountConnectionError: vi.fn(),
}));

import { handleImportPages } from './route';

type Row = Record<string, unknown>;

const RPC_PLATFORMS = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'tiktok',
  'youtube',
] as const;
const RPC_LEGACY_FEATURES = [
  'publish-now',
  'instagram-publish-now',
  'threads-publish-now',
];

const WORKSPACE_ID = 'ws-1';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'user-1';

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
      const set =
        disconnectedByPlatform.get(dest['platform'] as string) ??
        new Set<string>();
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

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete' | 'upsert',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string,
    private readonly onConflict: string | null,
    private readonly faults: { failNextUsageInsert: { code: string } | null }
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }

  insert(): this {
    return this;
  }

  upsert(): this {
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
    this.filters.push(
      (row) => typeof row[key] === 'string' && (row[key] as string) <= value
    );
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push(
      (row) => typeof row[key] === 'string' && (row[key] as string) > value
    );
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

  private run(): {
    data: unknown;
    error: { code: string } | null;
    count?: number;
  } {
    if (this.op === 'insert') {
      if (
        this.tableName === 'subscription_usage' &&
        this.faults.failNextUsageInsert
      ) {
        const fault = this.faults.failNextUsageInsert;
        this.faults.failNextUsageInsert = null;
        return { data: null, error: fault };
      }
      const rows = Array.isArray(this.payload)
        ? this.payload
        : [this.payload as Row];
      for (const row of rows) {
        // The fake unique index mirrors the real one:
        // (user, platform, section, key).
        const clash = this.table.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['section'] === row['section'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
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
    if (this.op === 'upsert') {
      const rows = Array.isArray(this.payload)
        ? this.payload
        : [this.payload as Row];
      const keys = (this.onConflict ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0);
      const out: Row[] = [];
      for (const row of rows) {
        const existing =
          keys.length > 0
            ? this.table.find((candidate) =>
                keys.every((key) => candidate[key] === row[key])
              )
            : undefined;
        if (existing) {
          Object.assign(existing, row);
          out.push({ ...existing });
        } else {
          const fresh: Row = { id: this.idSeq(), ...row };
          this.table.push(fresh);
          out.push({ ...fresh });
        }
      }
      if (this.mode === 'single' || this.mode === 'maybeSingle') {
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null };
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
      const deleted: Row[] = [];
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) {
          deleted.push({ ...(this.table[i] as Row) });
          this.table.splice(i, 1);
        }
      }
      return { data: deleted, error: null };
    }
    let rows = this.table
      .filter((row) => this.matches(row))
      .map((row) => ({ ...row }));
    const count = rows.length;
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.head) return { data: [], error: null, count };
    if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
    if (this.mode === 'maybeSingle')
      return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, count };
  }

  then(
    resolve: (value: {
      data: unknown;
      error: { code: string } | null;
      count?: number;
    }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeClient() {
  const tables: Record<string, Row[]> = {
    social_accounts: [],
    destinations: [],
    posting_slots: [],
    queue_items: [],
    subscription_periods: [],
    subscription_usage: [],
    workspaces: [],
  };
  const faults: { failNextUsageInsert: { code: string } | null } = {
    failNextUsageInsert: null,
  };
  let seq = 0;
  // UUID-shaped ids: the import response schema requires uuid ids.
  const idSeq = () =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const client = {
    from(table: string) {
      if (!Object.hasOwn(tables, table)) tables[table] = [];
      const rows = tables[table] as Row[];
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table, null, faults).select(
            cols,
            opts
          ),
        insert: (payload: Row | Row[]) =>
          new FakeQuery(rows, 'insert', payload, idSeq, table, null, faults),
        upsert: (payload: Row | Row[], opts?: { onConflict?: string }) =>
          new FakeQuery(
            rows,
            'upsert',
            payload,
            idSeq,
            table,
            opts?.onConflict ?? null,
            faults
          ),
        update: (payload: Row) =>
          new FakeQuery(rows, 'update', payload, idSeq, table, null, faults),
        delete: () =>
          new FakeQuery(rows, 'delete', null, idSeq, table, null, faults),
      };
    },
    rpc(fn: string, args: { p_user_id: string; p_now: string }) {
      if (fn !== 'get_entitlement') {
        return Promise.resolve({
          data: null,
          error: { message: `unknown function ${fn}` },
        });
      }
      return Promise.resolve({
        data: computeEntitlementRpc(tables, args.p_user_id, args.p_now),
        error: null,
      });
    },
  };
  return { client, tables, faults };
}

const NOW = new Date();
const DAY = 86_400_000;

function seedPaidPeriod(
  tables: Record<string, Row[]>,
  userId = USER_ID,
  facebookCount = 5
) {
  tables['subscription_periods'].push({
    id: `period-${userId}`,
    user_id: userId,
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

function fbPage(id: string, name: string) {
  return {
    id,
    name,
    category: 'Test',
    tasks: ['CREATE_CONTENT'],
    access_token: `page-token-${id}`,
    followers_count: 42,
    picture: { data: { url: 'https://example.com/pic.jpg' } },
  };
}

function importRequest(pageIds: string[], accountId = ACCOUNT_ID): NextRequest {
  return new NextRequest('http://localhost/api/tenant/acme/pages/import', {
    method: 'POST',
    headers: {
      cookie: 'fbup_session=test-session',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      accountId,
      selectedPageIds: pageIds,
    }),
  });
}

describe('Schedule import registers usage (spec 193)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceIdFromSession.mockResolvedValue(WORKSPACE_ID);
  });

  function setup() {
    const { client, tables, faults } = makeClient();
    seedPaidPeriod(tables);
    tables['workspaces'].push({ id: WORKSPACE_ID, owner_id: USER_ID });
    tables['social_accounts'].push({
      id: ACCOUNT_ID,
      workspace_id: WORKSPACE_ID,
      platform: 'facebook',
      encrypted_access_token: 'enc-token',
    });
    mocks.getSupabaseAdminClient.mockReturnValue(client);
    mocks.getBillingAdminClient.mockReturnValue(client);
    return { client, tables, faults };
  }

  it('A1: a fresh import creates one subscription_usage row', async () => {
    const { tables } = setup();
    mocks.fetchAllFacebookPages.mockResolvedValue({
      pages: [fbPage('111', 'Page One')],
      truncated: false,
    });

    const res = await handleImportPages(importRequest(['111']), 'acme');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.importedCount).toBe(1);
    const usage = tables['subscription_usage'];
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      user_id: USER_ID,
      platform: 'facebook',
      destination_key: '111',
      feature: 'destination-queue',
      section: 'schedule',
    });
    expect(usage[0]?.['destination_id']).toBe(tables['destinations'][0]?.['id']);
  });

  it('A2: re-importing the same page registers no second row', async () => {
    const { tables } = setup();
    mocks.fetchAllFacebookPages.mockResolvedValue({
      pages: [fbPage('111', 'Page One')],
      truncated: false,
    });

    const first = await handleImportPages(importRequest(['111']), 'acme');
    expect(first.status).toBe(200);
    const second = await handleImportPages(importRequest(['111']), 'acme');
    expect(second.status).toBe(200);
    expect((await second.json()).importedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('A3: importing two pages registers two rows', async () => {
    const { tables } = setup();
    mocks.fetchAllFacebookPages.mockResolvedValue({
      pages: [fbPage('111', 'Page One'), fbPage('222', 'Page Two')],
      truncated: false,
    });

    const res = await handleImportPages(importRequest(['111', '222']), 'acme');

    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    const usage = tables['subscription_usage'];
    expect(usage).toHaveLength(2);
    expect(
      usage.map((row) => row['destination_key']).sort()
    ).toEqual(['111', '222']);
  });

  it('A7: importing the same page under a second account registers no second row', async () => {
    const { tables } = setup();
    const ACCOUNT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    tables['social_accounts'].push({
      id: ACCOUNT_ID_2,
      workspace_id: WORKSPACE_ID,
      platform: 'facebook',
      encrypted_access_token: 'enc-token-2',
    });
    mocks.fetchAllFacebookPages.mockResolvedValue({
      pages: [fbPage('111', 'Page One')],
      truncated: false,
    });

    const first = await handleImportPages(importRequest(['111']), 'acme');
    expect(first.status).toBe(200);
    const second = await handleImportPages(
      importRequest(['111'], ACCOUNT_ID_2),
      'acme'
    );
    expect(second.status).toBe(200);
    expect((await second.json()).importedCount).toBe(1);
    // Same page under a second account: a second destination row (a
    // separate connection, kept by owner decision 2026-11-15) but
    // still one usage row for the page-section — the usage unique
    // key is the Facebook page id, not the destination row id.
    expect(tables['destinations']).toHaveLength(2);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('a registration failure rolls the import back (spec 193 §3)', async () => {
    const { tables, faults } = setup();
    faults.failNextUsageInsert = { code: 'XX000' };
    mocks.fetchAllFacebookPages.mockResolvedValue({
      pages: [fbPage('111', 'Page One')],
      truncated: false,
    });

    const res = await handleImportPages(importRequest(['111']), 'acme');

    expect(res.status).toBe(500);
    expect(tables['subscription_usage']).toHaveLength(0);
    expect(tables['destinations']).toHaveLength(1);
    const destination = tables['destinations'][0] as Row;
    expect(destination['status']).toBe('disconnected');
    expect(destination['encrypted_destination_token']).toBeNull();
  });
});
