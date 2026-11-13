/**
 * Instagram Auto Download/Upload API routes — platform-filtering tests.
 *
 * The Instagram hub must NEVER leak Facebook configs: the Facebook hub
 * RPCs (adu_hub_list / adu_hub_stats) have no platform filter, so the IG
 * hub route lists through its own instagram_adu_hub_list /
 * instagram_adu_hub_stats RPCs (20261113130000), which filter to this
 * workspace's Instagram destinations. These tests prove that with a
 * Facebook config sitting in the same workspace: it never appears in
 * the IG hub, and the IG detail route refuses it with 404. Create paths
 * prove a non-Instagram destination is rejected with the plain
 * Instagram-account error. The fake Supabase below emulates the two
 * RPCs against the in-memory tables.
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

  updateData: Row | null = null;

  update(row: Row) {
    this.updateData = row;
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
    // The ADU copy helper refreshes identity on an existing copy:
    // apply the update payload to the matched rows, like PostgREST.
    if (this.updateData) {
      for (const row of rows) {
        Object.assign(row, this.updateData);
      }
    }
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
    social_accounts: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        workspace_id: 'ws-1',
        platform: 'instagram',
        external_account_id: '17841400008460056',
        display_name: 'My IG Account',
        avatar_url: null,
        status: 'active',
      },
    ] as Row[],
    destinations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        workspace_id: 'ws-1',
        platform: 'instagram',
        name: 'My IG Account',
        external_destination_id: '17841400008460056',
        avatar_url: null,
        status: 'connected',
        // Spec 174 1B: the IG hub/config view load the ADU copy.
        section: 'adu',
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
        starting_followers: 1000,
        current_followers: 1250,
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
        starting_followers: 2000,
        current_followers: 2600,
        created_at: '2026-10-21T00:00:00.000Z',
        display_name: null,
      },
    ] as Row[],
    adu_reels: [] as Row[],
    adu_posting_jobs: [] as Row[],
  };
}

let db: ReturnType<typeof makeDb>;

/**
 * In-memory emulation of the instagram_adu_hub_list /
 * instagram_adu_hub_stats RPCs (20261113130000): same predicates as
 * the SQL — workspace + Instagram ADU destination join, status
 * filter, ILIKE search over source_username / destination name /
 * external id, follower sorts, limit clamped 1–50, offset >= 0 —
 * with total_count on every list row, and the stats sums over the
 * same filtered set.
 */
function igHubFiltered(args: {
  p_workspace_id: string;
  p_search: string | null;
  p_status: string | null;
}): Row[] {
  const destById = new Map(db.destinations.map((d) => [d.id as string, d]));
  let rows = db.adu_configs.filter((c) => {
    const d = destById.get(c.destination_id as string);
    return (
      c.workspace_id === args.p_workspace_id &&
      d !== undefined &&
      d.platform === 'instagram' &&
      d.section === 'adu'
    );
  });
  if (args.p_status) rows = rows.filter((c) => c.status === args.p_status);
  if (args.p_search) {
    const q = args.p_search.toLowerCase();
    rows = rows.filter((c) => {
      const d = destById.get(c.destination_id as string);
      return (
        String(c.source_username ?? '').toLowerCase().includes(q) ||
        String(d?.name ?? '').toLowerCase().includes(q) ||
        String(d?.external_destination_id ?? '').toLowerCase().includes(q)
      );
    });
  }
  return rows;
}

function igHubRpc(name: string, args: Record<string, unknown>) {
  const filtered = igHubFiltered({
    p_workspace_id: args['p_workspace_id'] as string,
    p_search: (args['p_search'] as string | null) ?? null,
    p_status: (args['p_status'] as string | null) ?? null,
  });
  if (name === 'instagram_adu_hub_stats') {
    return {
      data: [
        {
          total_count: filtered.length,
          total_followers_sum: filtered.reduce(
            (sum, r) => sum + Number(r.current_followers ?? 0),
            0
          ),
          net_gained_sum: filtered.reduce(
            (sum, r) =>
              sum +
              Math.max(
                Number(r.current_followers ?? 0) - Number(r.starting_followers ?? 0),
                0
              ),
            0
          ),
        },
      ],
      error: null,
    };
  }
  const total = filtered.length;
  const sorted = [...filtered].sort(
    (a, b) =>
      new Date(String(b.created_at ?? '')).getTime() -
      new Date(String(a.created_at ?? '')).getTime()
  );
  const sort = args['p_sort'] as string | null;
  if (sort === 'Most Followers' || sort === 'Least Followers') {
    const dir = sort === 'Most Followers' ? -1 : 1;
    sorted.sort(
      (a, b) =>
        dir * (Number(a.current_followers ?? 0) - Number(b.current_followers ?? 0)) ||
        new Date(String(b.created_at ?? '')).getTime() -
          new Date(String(a.created_at ?? '')).getTime()
    );
  }
  const limit = Math.min(Math.max(Number(args['p_limit'] ?? 9) || 9, 1), 50);
  const offset = Math.max(Number(args['p_offset'] ?? 0) || 0, 0);
  return {
    data: sorted
      .slice(offset, offset + limit)
      .map((row) => ({ ...row, total_count: total })),
    error: null,
  };
}

const fakeSupabase = {
  // The grouped-counts RPC (adu-opt-f1), answered from the same canned
  // rows the old count queries read. Fixtures here have no reels or
  // jobs, so every count is 0; the midnight rule is the same UTC /
  // invalid-timezone fallback as the real function. The IG hub RPCs
  // (instagram_adu_hub_list / instagram_adu_hub_stats) are answered by
  // igHubRpc below; any other RPC name fails loud with 42883, as the
  // real PostgREST does for a missing function.
  rpc: (name: string, args: Record<string, unknown>) => {
    if (name === 'adu_config_counts') {
      const store = db as unknown as Record<string, Row[]>;
      const data = ((args['p_config_ids'] as string[] | undefined) ?? []).map((id) => {
        const timezone = String(
          (store['adu_configs'] ?? []).find((c) => c.id === id)?.['timezone'] ?? 'UTC',
        );
        let midnight: string;
        try {
          const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: timezone,
          }).formatToParts(new Date());
          const year = parts.find((x) => x.type === 'year')?.value ?? '1970';
          const month = parts.find((x) => x.type === 'month')?.value ?? '01';
          const day = parts.find((x) => x.type === 'day')?.value ?? '01';
          midnight = new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
        } catch {
          const now = new Date();
          midnight = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
          ).toISOString();
        }
        const reels = (store['adu_reels'] ?? []).filter((r) => r['config_id'] === id);
        const jobs = (store['adu_posting_jobs'] ?? []).filter((j) => j['config_id'] === id);
        const pipeline = ['pending', 'processing', 'downloaded'];
        const failedStatuses = ['failed_to_publish', 'publish_error', 'integrity_error'];
        const inPipeline = reels.filter((r) => pipeline.includes(String(r['status']))).length;
        const published = jobs.filter((j) => j['status'] === 'published');
        const failed = jobs.filter((j) => failedStatuses.includes(String(j['status'])));
        const failedInPipeline = failed.filter((j) => {
          const reel = reels.find((r) => r['id'] === j['reel_id']);
          return reel && pipeline.includes(String(reel['status']));
        }).length;
        return {
          config_id: id,
          in_pipeline: inPipeline,
          published: published.length,
          failed: failed.length,
          failed_in_pipeline: failedInPipeline,
          published_today: published.filter((j) => String(j['created_at']) >= midnight).length,
          failed_today: failed.filter((j) => String(j['created_at']) >= midnight).length,
        };
      });
      return Promise.resolve({ data, error: null });
    }
    if (name === 'instagram_adu_hub_list' || name === 'instagram_adu_hub_stats') {
      return Promise.resolve(igHubRpc(name, args));
    }
    return Promise.resolve({ data: null, error: { code: '42883', message: 'not found' } });
  },
  from: (table: string) => new FakeBuilder(table, db as unknown as Record<string, Row[]>),
};

function hubRequest(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) {
  return new NextRequest(
    `http://localhost:3000/api/tenant/acme/instagram/auto-download-upload${path}`,
    init,
  ) as never;
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

  it('single create succeeds for an Instagram account (spec 174 2A: posts the account id, config attaches to the adu copy)', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '55555555-5555-4555-8555-555555555555',
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
    // The config attaches to the adu copy (the existing one), not
    // to the account id the Add dialog posted.
    expect(inserted?.destination_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(inserted?.starting_followers).toBe(500);
    expect(inserted?.current_followers).toBe(500);
    // Spec 162 (send-back fix): the creation path writes
    // current_followers, so it stamps followers_updated_at too —
    // the timestamp must mean "last successful follower check"
    // from the moment the config exists, not only after the first
    // daily worker run. Same assertion as the Threads creation test.
    expect(typeof inserted?.followers_updated_at).toBe('string');
    expect(
      Number.isNaN(Date.parse(inserted?.followers_updated_at as string))
    ).toBe(false);
  });

  it('single create rejects a Facebook account id with the Instagram-account error', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: '66666666-6666-4666-8666-666666666666',
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

  it('bulk create reports per-item failure for a Facebook account id without failing the IG item', async () => {
    const res = await hubPOST(
      hubRequest('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { accountId: '55555555-5555-4555-8555-555555555555', sourcePlatform: 'tiktok', sourceUsername: 'creator_bulk' },
            { accountId: '66666666-6666-4666-8666-666666666666', sourcePlatform: 'tiktok', sourceUsername: 'creator_bulk' },
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
    expect(body.failed[0].accountId).toBe('66666666-6666-4666-8666-666666666666');
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
