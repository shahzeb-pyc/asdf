/**
 * Instagram Auto Download/Upload API routes — platform-filtering tests.
 *
 * The Instagram hub must NEVER leak Facebook configs: the Facebook hub
 * RPCs (adu_hub_list / adu_hub_stats) have no platform filter, so the IG
 * hub route lists configs only for this workspace's Instagram
 * destinations. These tests prove that with a Facebook config sitting in
 * the same workspace: it never appears in the IG hub, and the IG detail
 * route refuses it with 404. Create paths prove a non-Instagram
 * destination is rejected with the plain Instagram-account error.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn() };
});

import { aduContext } from '@/lib/server/adu';
import { GET as hubGET, POST as hubPOST } from '../../src/app/api/tenant/[subdomain]/instagram/auto-download-upload/route';
import { GET as detailGET } from '../../src/app/api/tenant/[subdomain]/instagram/auto-download-upload/[id]/route';

type Row = Record<string, unknown>;

interface Filter {
  op: 'eq' | 'in' | 'gte' | 'or';
  col: string;
  val: unknown;
  terms?: Array<{ col: string; val: string }>;
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const value = row[f.col];
      if (f.op === 'eq') return value === f.val;
      if (f.op === 'in') return (f.val as unknown[]).includes(value);
      if (f.op === 'gte') return String(value) >= String(f.val);
      // Remaining op is 'or': at least one ilike term must match.
      return (f.terms ?? []).some(
        (t) => String(row[t.col] ?? '').toLowerCase().includes(t.val.toLowerCase())
      );
    })
  );
}

class FakeBuilder {
  filters: Filter[] = [];
  orders: Array<{ col: string; ascending: boolean }> = [];
  rangeFrom: number | null = null;
  rangeTo: number | null = null;
  limitN: number | null = null;
  head = false;
  wantCount = false;
  inserted: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
  ) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }) {
    this.head = Boolean(opts?.head);
    this.wantCount = opts?.count === 'exact';
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ op: 'gte', col, val });
    return this;
  }

  or(pattern: string) {
    const terms = pattern.split(',').map((part) => {
      const m = part.match(/^(\w+)\.ilike\.%(.*)%$/);
      return m ? { col: m[1], val: m[2] } : { col: '', val: '' };
    });
    this.filters.push({ op: 'or', col: '', val: null, terms });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }

  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  insert(row: Row) {
    const inserted = { ...row, id: `cfg-${this.db[this.table].length + 1}` };
    this.db[this.table].push(inserted);
    this.inserted = inserted;
    return this;
  }

  delete() {
    const rows = applyFilters(this.db[this.table], this.filters);
    for (const row of rows) {
      const idx = this.db[this.table].indexOf(row);
      if (idx >= 0) this.db[this.table].splice(idx, 1);
    }
    return this;
  }

  private result(): { data: Row[] | Row | null; count: number | null; error: null } {
    let rows = applyFilters(this.db[this.table], this.filters);
    const total = rows.length;
    // Last order call is the tie-breaker in PostgREST order lists.
    for (const spec of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = a[spec.col];
        const bv = b[spec.col];
        if (typeof av === 'number' && typeof bv === 'number') {
          return spec.ascending ? av - bv : bv - av;
        }
        const cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return spec.ascending ? cmp : -cmp;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return { data: this.head ? [] : rows, count: this.wantCount ? total : null, error: null };
  }

  maybeSingle() {
    const { data } = this.result();
    const rows = data as Row[];
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single() {
    if (this.inserted) return Promise.resolve({ data: this.inserted, error: null });
    const { data } = this.result();
    const rows = data as Row[];
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then(
    resolve: (value: { data: Row[] | Row | null; count: number | null; error: null }) => void,
    reject?: (reason: unknown) => void,
  ) {
    try {
      resolve(this.result());
    } catch (err) {
      reject?.(err);
    }
  }
}

function makeDb() {
  return {
    destinations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspace_id: 'ws-1',
        platform: 'instagram',
        name: 'My IG Account',
        external_destination_id: '17841400008460056',
        avatar_url: null,
        status: 'connected',
        account_id: '55555555-5555-4555-8555-555555555555',
        handle: 'myigaccount',
        metadata: { current_followers: 500 },
        social_accounts: { display_name: 'My IG Account', avatar_url: null },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        workspace_id: 'ws-1',
        platform: 'facebook',
        name: 'My FB Page',
        external_destination_id: '123456789',
        avatar_url: null,
        status: 'connected',
        account_id: '66666666-6666-4666-8666-666666666666',
        handle: null,
        metadata: { current_followers: 900 },
        social_accounts: { display_name: 'My FB Page', avatar_url: null },
      },
    ] as Row[],
    adu_configs: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        workspace_id: 'ws-1',
        destination_id: '11111111-1111-4111-8111-111111111111',
        source_platform: 'instagram',
        source_username: 'creator_one',
        timezone: 'Asia/Karachi',
        posts_per_day: 2,
        schedule_type: 'dailyrandom',
        posting_times: [],
        status: 'active',
        sync_status: 'synced',
        followers_count: 1000,
        followers_gained: 1250,
        created_at: '2026-10-20T00:00:00.000Z',
        display_name: null,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        workspace_id: 'ws-1',
        destination_id: '22222222-2222-4222-8222-222222222222',
        source_platform: 'tiktok',
        source_username: 'creator_fb',
        timezone: 'Asia/Karachi',
        posts_per_day: 1,
        schedule_type: 'dailyrandom',
        posting_times: [],
        status: 'active',
        sync_status: 'synced',
        followers_count: 2000,
        followers_gained: 2600,
        created_at: '2026-10-21T00:00:00.000Z',
        display_name: null,
      },
    ] as Row[],
    adu_reels: [] as Row[],
    adu_posting_jobs: [] as Row[],
  };
}

let db: ReturnType<typeof makeDb>;
const fakeSupabase = {
  from: (table: string) => new FakeBuilder(table, db as unknown as Record<string, Row[]>),
};

function hubRequest(path: string, init?: RequestInit) {
  return new NextRequest(`http://localhost:3000/api/tenant/acme/instagram/auto-download-upload${path}`, init) as never;
}

describe('Instagram ADU hub route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    vi.mocked(aduContext).mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: fakeSupabase as never, user: { id: 'u-1' } as never },
    } as never);
  });

  it('lists only the Instagram config, never the Facebook config in the same workspace', async () => {
    const res = await hubGET(hubRequest(''), { params: Promise.resolve({ subdomain: 'acme' }) } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0].id).toBe('33333333-3333-4333-8333-333333333333');
    expect(body.configs[0].destinationName).toBe('My IG Account');
    expect(body.configs[0].destinationPlatform).toBe('instagram');
    // Stats follow Facebook's definitions, over the IG set only.
    expect(body.stats).toEqual({ totalPages: 1, followersGained: 250, totalFollowers: 1250 });
  });

  it('returns an empty hub when the workspace has no Instagram destinations', async () => {
    db.destinations = db.destinations.filter((d) => d.platform !== 'instagram');
    const res = await hubGET(hubRequest(''), { params: Promise.resolve({ subdomain: 'acme' }) } as never);
    const body = await res.json();
    expect(body).toEqual({
      configs: [],
      total: 0,
      page: 1,
      totalPages: 0,
      stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
    });
  });

  it('search by source username matches the IG config only', async () => {
    const res = await hubGET(hubRequest('?q=creator_one'), { params: Promise.resolve({ subdomain: 'acme' }) } as never);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.configs[0].id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('search for the Facebook source finds nothing in the Instagram hub', async () => {
    const res = await hubGET(hubRequest('?q=creator_fb'), { params: Promise.resolve({ subdomain: 'acme' }) } as never);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.configs).toHaveLength(0);
  });

  it('single create succeeds for an Instagram destination', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationId: '11111111-1111-4111-8111-111111111111',
          sourcePlatform: 'tiktok',
          sourceUsername: 'creator_new',
          timezone: 'Asia/Karachi',
          postsPerDay: 1,
          scheduleType: 'dailyrandom',
        }),
      }),
      { params: Promise.resolve({ subdomain: 'acme' }) } as never,
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.id).toBeTruthy();
    const inserted = db.adu_configs.find((c) => c.id === body.id);
    expect(inserted?.destination_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(inserted?.followers_count).toBe(500);
  });

  it('single create rejects a Facebook destination with the Instagram-account error', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationId: '22222222-2222-4222-8222-222222222222',
          sourcePlatform: 'tiktok',
          sourceUsername: 'creator_new',
          timezone: 'Asia/Karachi',
          postsPerDay: 1,
          scheduleType: 'dailyrandom',
        }),
      }),
      { params: Promise.resolve({ subdomain: 'acme' }) } as never,
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('That Instagram account was not found in this workspace.');
  });

  it('bulk create reports per-item failure for a Facebook destination without failing the IG item', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { destinationId: '11111111-1111-4111-8111-111111111111', sourcePlatform: 'tiktok', sourceUsername: 'creator_bulk' },
            { destinationId: '22222222-2222-4222-8222-222222222222', sourcePlatform: 'tiktok', sourceUsername: 'creator_bulk' },
          ],
          timezone: 'Asia/Karachi',
          postsPerDay: 1,
          scheduleType: 'dailyrandom',
        }),
      }),
      { params: Promise.resolve({ subdomain: 'acme' }) } as never,
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.created).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].destinationId).toBe('22222222-2222-4222-8222-222222222222');
  });
});

describe('Instagram ADU detail route guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    vi.mocked(aduContext).mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: fakeSupabase as never, user: { id: 'u-1' } as never },
    } as never);
  });

  it('returns the IG config view', async () => {
    const res = await detailGET(hubRequest(''), {
      params: Promise.resolve({ subdomain: 'acme', id: '33333333-3333-4333-8333-333333333333' }),
    } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.config.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(body.config.destinationPlatform).toBe('instagram');
  });

  it('refuses a Facebook config with 404 through the Instagram route', async () => {
    const res = await detailGET(hubRequest(''), {
      params: Promise.resolve({ subdomain: 'acme', id: '44444444-4444-4444-8444-444444444444' }),
    } as never);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe('Account not found.');
  });
});
