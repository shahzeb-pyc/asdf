/**
 * Facebook ADU hub list GET (adu-opt-a F2 + F6 + F7).
 *
 * - Default (no `stats` param): the combined response — slim hub
 *   views, totals, and stats — exactly as before, with list + stats
 *   RPCs issued concurrently (F2).
 * - `stats=only`: `{ stats }` only, no list RPC, no per-config views.
 * - `stats=none`: the list payload without the `stats` key, no stats RPC.
 * - A stats-only failure is loud (500 / migrationMissing), never
 *   silent zeros; a stats failure on the default path keeps the old
 *   logged-and-zero behaviour.
 *
 * Runs the REAL buildAduConfigView against an in-memory Supabase
 * stand-in; only the tenant context is mocked (same pattern as the
 * Threads ADU route tests).
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

function configRow(id: string, followers: number): Row {
  return {
    id,
    workspace_id: 'ws-1',
    destination_id: `dest-${id}`,
    source_platform: 'facebook',
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
    total_count: 2,
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
      // lookup still reads a single row.
      const rowFor = (id: string) => ({
        id,
        name: 'Test Page',
        external_destination_id: 'page-1',
        avatar_url: null,
        status: 'active',
        account_id: 'acc-1',
        handle: null,
        platform: 'facebook',
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
  statsRows?: Row[];
  listError?: { message: string; code?: string } | null;
  statsError?: { message: string; code?: string } | null;
  gateRpcs?: boolean;
}

function makeRouteFake(options: RouteFakeOptions = {}) {
  const rpcCalls: string[] = [];
  const rpcArgs: Array<{ name: string; args: unknown }> = [];
  const listRows = options.listRows ?? [configRow('c1', 100), configRow('c2', 300)];
  const statsRows = options.statsRows ?? [{ total_count: 2, total_followers_sum: 400, net_gained_sum: 380 }];
  const counts = { pipeline: 2, published: 1, failed: 0 };
  let gate: Promise<void> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  if (options.gateRpcs) {
    let openGate: (() => void) | null = null;
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    poll = setInterval(() => {
      if (rpcCalls.length >= 2) {
        if (poll) clearInterval(poll);
        openGate?.();
      }
    }, 0);
  }
  const db = {
    rpcCalls,
    rpcArgs,
    rpc: (name: string, args: unknown) => {
      rpcCalls.push(name);
      rpcArgs.push({ name, args });
      const result =
        name === 'adu_hub_list'
          ? { data: listRows, error: options.listError ?? null }
          : name === 'adu_config_counts'
            ? {
                data: (
                  (args as { p_config_ids?: string[] }).p_config_ids ?? []
                ).map((id) => ({
                  config_id: id,
                  in_pipeline: counts.pipeline,
                  published: counts.published,
                  failed: counts.failed,
                  failed_in_pipeline: 0,
                  published_today: 1,
                  failed_today: 0,
                })),
                error: null,
              }
            : { data: statsRows, error: options.statsError ?? null };
      if (gate) return gate.then(() => result);
      return Promise.resolve(result);
    },
    from: (table: string) => new FakeQuery(table, counts),
    _stopGate: () => {
      if (poll) clearInterval(poll);
    },
  };
  return db as unknown as SupabaseClient & {
    rpcCalls: string[];
    rpcArgs: Array<{ name: string; args: unknown }>;
    _stopGate: () => void;
  };
}

function getRequest(url: string): NextRequest {
  return new NextRequest(url);
}

function getParams() {
  return { params: Promise.resolve({ subdomain: 'ws1' }) };
}

describe('ADU hub list GET (adu-opt-a F2/F6/F7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('default: combined response with slim hub views and stats', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
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
    for (const key of [
      'scheduleType',
      'postingTimes',
      'syncStatus',
      'alert',
      'displayName',
      'updatedAt',
      'destinationHandle',
      'destinationPlatform',
      'accountAvatarUrl',
      'destinationStatus',
    ]) {
      expect(body.configs[0]).not.toHaveProperty(key);
    }
    expect(db.rpcCalls).toEqual(['adu_hub_list', 'adu_hub_stats', 'adu_config_counts']);
  });

  it('passes p_platform facebook to both hub RPCs (F21 unified pair)', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    expect(res.status).toBe(200);
    // The platform literal is the leak fix: without it the unified
    // function would need a default, and the Facebook hub would see
    // every platform's configs again.
    expect(db.rpcArgs.find((c) => c.name === 'adu_hub_list')?.args).toMatchObject({
      p_workspace_id: 'ws-1',
      p_platform: 'facebook',
    });
    expect(db.rpcArgs.find((c) => c.name === 'adu_hub_stats')?.args).toMatchObject({
      p_workspace_id: 'ws-1',
      p_platform: 'facebook',
    });
  });

  it('a malformed list row fails loud (F21 boundary validation)', async () => {
    const { total_count: _dropped, ...badRow } = configRow('c1', 100);
    const db = makeRouteFake({ listRows: [badRow, configRow('c2', 300)] });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load pages.' });
  });

  it('a malformed stats row reads as zeros on the default path (F21 boundary validation)', async () => {
    const db = makeRouteFake({
      statsRows: [{ total_count: 2, total_followers_sum: '400', net_gained_sum: 380 }],
    });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configs).toHaveLength(2);
    expect(body.stats).toEqual({ totalPages: 2, followersGained: 0, totalFollowers: 0 });
  });

  it('stats=only: stats alone, no list RPC, no configs key', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload?stats=only'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      stats: { totalPages: 2, followersGained: 380, totalFollowers: 400 },
    });
    expect(db.rpcCalls).toEqual(['adu_hub_stats']);
  });

  it('stats=none: list payload without stats, no stats RPC', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload?stats=none'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('stats');
    expect(body.configs).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(db.rpcCalls).toEqual(['adu_hub_list', 'adu_config_counts']);
  });

  it('an unknown stats value behaves like the default', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload?stats=bogus'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configs).toHaveLength(2);
    expect(body.stats).toEqual({ totalPages: 2, followersGained: 380, totalFollowers: 400 });
    expect(db.rpcCalls).toEqual(['adu_hub_list', 'adu_hub_stats', 'adu_config_counts']);
  });

  it('issues list + stats concurrently (F2)', async () => {
    const db = makeRouteFake({ gateRpcs: true });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    try {
      const body = await Promise.race([
        GET(
          getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
          getParams(),
        ).then((res) => res.json()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('list + stats ran serially: gate never opened')),
            3000,
          ),
        ),
      ]);
      expect(body.configs).toHaveLength(2);
      expect(body.stats).toEqual({ totalPages: 2, followersGained: 380, totalFollowers: 400 });
    } finally {
      db._stopGate();
    }
  });

  it('issues exactly one grouped-counts RPC for the page (F1)', async () => {
    const db = makeRouteFake();
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configs).toHaveLength(2);
    expect(db.rpcCalls.filter((name) => name === 'adu_config_counts')).toHaveLength(1);
    // The grouped counts land on the views: pipeline 2, published 1,
    // publishedToday 1 of a 2/day quota.
    expect(body.configs[0].pendingCount).toBe(2);
    expect(body.configs[0].postedCount).toBe(1);
    expect(body.configs[0].pendingToday).toBe(1);
  });

  it('missing list RPC returns migrationMissing', async () => {
    const db = makeRouteFake({ listError: { message: 'not found', code: 'PGRST202' } });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(body).toEqual({ configs: [], total: 0, page: 1, migrationMissing: true });
  });

  it('a stats failure on the default path stays logged-and-zero (existing behaviour)', async () => {
    const db = makeRouteFake({ statsError: { message: 'boom', code: 'XX000' } });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configs).toHaveLength(2);
    expect(body.stats).toEqual({ totalPages: 2, followersGained: 0, totalFollowers: 0 });
  });

  it('stats=only fails loud on a stats error', async () => {
    const db = makeRouteFake({ statsError: { message: 'boom', code: 'XX000' } });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload?stats=only'),
      getParams(),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load pages.' });
  });

  it('stats=only with a missing RPC returns migrationMissing and zero stats', async () => {
    const db = makeRouteFake({ statsError: { message: 'not found', code: 'PGRST202' } });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: db },
    });
    const res = await GET(
      getRequest('http://localhost/api/tenant/ws1/auto-download-upload?stats=only'),
      getParams(),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
      migrationMissing: true,
    });
  });
});
