/**
 * Instagram ADU hub list GET (Stream D, F20).
 *
 * The route lists through the unified adu_hub_list / adu_hub_stats
 * RPCs (20261113170000, F21), called with p_platform 'instagram':
 * search, status, sort and page are all applied in the database.
 * The old direct-query list is gone — the search path used to load
 * every matching config into memory and filter/sort/paginate in JS.
 *
 * - Default: the combined response — views, totals, stats — with
 *   list + stats RPCs issued concurrently.
 * - Page 2 passes p_offset 9 and trusts the RPC's total_count (25
 *   fixtures prove the route never slices in memory).
 * - Search passes p_search to the RPCs and never calls
 *   .from('adu_configs') — no PostgREST list path remains.
 * - A missing RPC (PGRST202) returns migrationMissing; a stats
 *   failure is logged and reads as zeros.
 *
 * Runs the REAL buildAduConfigView against an in-memory Supabase
 * stand-in; only the tenant context is mocked (same pattern as the
 * Facebook ADU route tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  aduContext: vi.fn(),
}));

vi.mock('@/lib/server/adu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/adu')>()),
  aduContext: mocks.aduContext,
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: vi.fn(),
  subscriptionGateResponse: () => null,
}));
vi.mock('@/lib/billing/entitlement', () => ({
  getEntitlement: vi.fn(),
  assertFeatureAddWithinCap: vi.fn(),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { GET } from './route';

type Row = Record<string, unknown>;

interface Op {
  kind: string;
  args: unknown[];
}

function configRow(id: string, followers: number, totalCount = 2): Row {
  return {
    id,
    workspace_id: 'ws-1',
    destination_id: `dest-${id}`,
    source_platform: 'instagram',
    source_username: `source-${id}`,
    timezone: 'UTC',
    posts_per_day: 2,
    schedule_type: 'dailyrandom',
    posting_times: ['09:00'],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 10,
    current_followers: followers,
    followers_updated_at: null,
    display_name: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    total_count: totalCount,
  };
}

class FakeQuery {
  private ops: Op[] = [];
  constructor(
    private readonly table: string,
    private readonly counts: { pipeline: number; published: number; failed: number },
  ) {}

  select(...args: unknown[]) {
    this.ops.push({ kind: 'select', args });
    return this;
  }

  eq(col: string, val: unknown) {
    this.ops.push({ kind: 'eq', args: [col, val] });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.ops.push({ kind: 'in', args: [col, val] });
    return this;
  }

  gte(col: string, val: unknown) {
    this.ops.push({ kind: 'gte', args: [col, val] });
    return this;
  }

  maybeSingle() {
    this.ops.push({ kind: 'maybeSingle', args: [] });
    return this;
  }

  then(resolve: (value: unknown) => void) {
    if (this.table === 'destinations') {
      // The batch path (F1) queries .in('id', [...]) and reads an
      // array — one row per requested destination id. A maybeSingle
      // lookup still reads a single row. (Same shape as the Facebook
      // route test's fake.)
      const rowFor = (id: string) => ({
        id,
        name: 'Test Account',
        external_destination_id: 'ig-test',
        avatar_url: null,
        status: 'active',
        account_id: 'acc-1',
        handle: null,
        platform: 'instagram',
        social_accounts: { display_name: 'Test Account', avatar_url: null },
      });
      const single = this.ops.some((o) => o.kind === 'maybeSingle');
      if (single) {
        resolve({ data: rowFor('dest-1'), error: null });
        return;
      }
      const inIds = this.ops.find(
        (o) => o.kind === 'in' && o.args[0] === 'id',
      )?.args[1] as string[] | undefined;
      const eqId = this.ops.find(
        (o) => o.kind === 'eq' && o.args[0] === 'id',
      )?.args[1] as string | undefined;
      const ids = inIds ?? (eqId ? [eqId] : ['dest-1']);
      resolve({ data: ids.map(rowFor), error: null });
      return;
    }
    const hasReelFilter = this.ops.some(
      (o) => o.kind === 'in' && o.args[0] === 'adu_reels.status',
    );
    const eqStatus = this.ops.find(
      (o) => o.kind === 'eq' && o.args[0] === 'status',
    )?.args[1] as string | undefined;
    let count = 0;
    if (this.table === 'adu_reels') count = this.counts.pipeline;
    else if (hasReelFilter) count = 0;
    else if (eqStatus === 'published') count = this.counts.published;
    else count = this.counts.failed;
    resolve({ count, error: null });
  }
}

interface RouteFakeOptions {
  listRows?: Row[];
  listError?: { message: string; code?: string } | null;
  statsError?: { message: string; code?: string } | null;
}

function makeRouteFake(options: RouteFakeOptions = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const fromCalls: string[] = [];
  const listRows = options.listRows ?? [configRow('c1', 100), configRow('c2', 300)];
  const statsRows = [{ total_count: 2, total_followers_sum: 400, net_gained_sum: 380 }];
  const counts = { pipeline: 2, published: 1, failed: 0 };
  const db = {
    rpcCalls,
    fromCalls,
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      // F1 grouped counts: the shared view builder answers every
      // config's six counts from one `adu_config_counts` RPC per
      // config (the route builds views one row at a time), using the
      // same canned counts the legacy FakeQuery below used to answer
      // the per-config count queries. Same shape as the Facebook
      // route test's fake.
      if (name === 'adu_config_counts') {
        return Promise.resolve({
          data: ((args as { p_config_ids?: string[] }).p_config_ids ?? []).map((id) => ({
            config_id: id,
            in_pipeline: counts.pipeline,
            published: counts.published,
            failed: counts.failed,
            failed_in_pipeline: 0,
            published_today: 1,
            failed_today: 0,
          })),
          error: null,
        });
      }
      const result =
        name === 'adu_hub_list'
          ? { data: listRows, error: options.listError ?? null }
          : { data: statsRows, error: options.statsError ?? null };
      return Promise.resolve(result);
    },
    from: (table: string) => {
      fromCalls.push(table);
      return new FakeQuery(table, counts);
    },
  };
  return db as unknown as SupabaseClient & {
    rpcCalls: Array<{ name: string; args: unknown }>;
    fromCalls: string[];
  };
}

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function getParams() {
  return { params: Promise.resolve({ subdomain: 'ws1' }) };
}

describe('IG ADU hub list GET (stream D F20)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('default: combined response from the IG RPCs, views + stats', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(1);
    expect(body.stats).toEqual({ totalPages: 2, followersGained: 380, totalFollowers: 400 });
    expect(body.configs).toHaveLength(2);
    expect(body.configs[0].accountName).toBe('Test Account');
    expect(body.configs[0].pendingCount).toBe(2);
    // List + stats run concurrently; the view builder then issues one
    // grouped-counts RPC per config row (two rows in this fixture).
    expect(db.rpcCalls.map((c) => c.name)).toEqual([
      'adu_hub_list',
      'adu_hub_stats',
      'adu_config_counts',
      'adu_config_counts',
    ]);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_workspace_id: 'ws-1',
      p_platform: 'instagram',
      p_search: null,
      p_status: null,
      p_sort: 'Newest First',
      p_limit: 9,
      p_offset: 0,
    });
    expect(db.rpcCalls[1].args).toMatchObject({
      p_workspace_id: 'ws-1',
      p_platform: 'instagram',
    });
  });

  it('a malformed list row fails loud (F21 boundary validation)', async () => {
    const { total_count: _dropped, ...badRow } = configRow('c1', 100);
    const db = makeRouteFake({ listRows: [badRow, configRow('c2', 300)] });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload'),
      getParams(),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load accounts.' });
  });

  it('page 2: offset 9 with a 25-row total from the database', async () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      configRow(`p2-${i}`, 100 + i, 25),
    );
    const db = makeRouteFake({ listRows: rows });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload?page=2'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.page).toBe(2);
    expect(body.total).toBe(25);
    expect(body.totalPages).toBe(3);
    expect(body.configs).toHaveLength(9);
    expect(db.rpcCalls[0].args).toMatchObject({ p_limit: 9, p_offset: 9 });
  });

  it('search goes to the RPCs; no adu_configs select remains', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest(
        'http://localhost/api/tenant/ws1/instagram/auto-download-upload?q=yoga&status=Paused&sort=Most%20Followers',
      ),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_search: 'yoga',
      p_status: 'paused',
      p_sort: 'Most Followers',
    });
    expect(db.rpcCalls[1].args).toMatchObject({ p_search: 'yoga', p_status: 'paused' });
    expect(db.fromCalls).not.toContain('adu_configs');
  });

  it('missing list RPC returns migrationMissing', async () => {
    const db = makeRouteFake({
      listError: { message: 'Could not find the function', code: 'PGRST202' },
    });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ configs: [], total: 0, page: 1, migrationMissing: true });
  });

  it('a stats failure is logged and reads as zeros', async () => {
    const db = makeRouteFake({ statsError: { message: 'boom', code: 'XX000' } });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/instagram/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configs).toHaveLength(2);
    expect(body.stats).toEqual({ totalPages: 2, followersGained: 0, totalFollowers: 0 });
  });
});
