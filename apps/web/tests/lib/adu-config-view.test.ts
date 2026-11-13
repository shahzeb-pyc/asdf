/**
 * ADU config view counts (SEND BACK fix, PR #43 blocker C).
 *
 * buildAduConfigView used to load every reel and every job for a
 * config and count in memory — past PostgREST's 1,000-row limit the
 * card totals silently went wrong. It then issued bounded count
 * queries only; since adu-opt-f1 the six counts come from ONE grouped
 * `adu_config_counts` RPC per page (the fake below answers the RPC
 * from the same canned rows, with the same midnight rule). These
 * tests drive it with a fake Supabase client and prove the card
 * numbers (posted / pending / failed, today variants, pendingToday)
 * come from those counts, including a case where the job history is
 * far larger than any page — the old code would have truncated it.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildAduConfigView, loadAduConfigView } from '../../src/lib/server/adu';

// aduContext's collaborators are mocked (established web-test pattern):
// the auth/workspace modules are replaced, the ADU module under test is real.
vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(),
  getRouteSupabase: vi.fn(),
}));
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: vi.fn(),
}));

type Row = Record<string, unknown>;

interface Filter {
  op: 'eq' | 'in' | 'gte';
  col: string;
  val: unknown;
}

function applyFilters(
  rows: Row[],
  filters: Filter[],
  db: Record<string, Row[]>,
): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      // Embedded-join filter (buildAduConfigView's failed-in-pipeline
      // count selects `adu_reels!inner(status)` and filters on
      // `adu_reels.status`): resolve the reel through the job's
      // reel_id, exactly as the join does. A plain row lookup would
      // read `undefined` for every job and count zero.
      const value =
        f.col === 'adu_reels.status'
          ? (db['adu_reels'] ?? []).find((r) => r.id === row['reel_id'])?.status
          : row[f.col];
      if (f.op === 'eq') return value === f.val;
      if (f.op === 'in') return (f.val as unknown[]).includes(value);
      if (f.op === 'gte') return String(value) >= String(f.val);
      return true;
    }),
  );
}

class FakeBuilder {
  filters: Filter[] = [];
  head = false;
  single = false;
  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
    private readonly calls: string[],
    private readonly errors: Record<string, string> = {},
  ) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }) {
    this.head = Boolean(opts?.head);
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

  maybeSingle() {
    this.single = true;
    return this;
  }

  then(resolve: (value: unknown) => void) {
    this.calls.push(`${this.table}:${this.head ? 'count' : 'rows'}`);
    const code = this.errors[this.table];
    if (code) {
      resolve(this.head ? { count: null, error: { code } } : { data: null, error: { code } });
      return;
    }
    const rows = applyFilters(this.db[this.table] ?? [], this.filters, this.db);
    if (this.head) resolve({ count: rows.length, error: null });
    else if (this.single) resolve({ data: rows[0] ?? null, error: null });
    else resolve({ data: rows, error: null });
  }
}

const ADU_FAILED_STATUSES = ['failed_to_publish', 'publish_error', 'integrity_error'];
const ADU_PIPELINE_STATUSES = ['pending', 'processing', 'downloaded'];

/** Page-local midnight for a timezone, exactly like startOfDayInTimezone. */
function aduMidnightIso(timezone: string): string {
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
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
  } catch {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
}

/**
 * The grouped-counts RPC, answered from the same canned rows the old
 * count queries read (same statuses, same join for failed-in-pipeline,
 * same midnight rule). The config timezone comes from the seeded
 * adu_configs row when present, else UTC — every fixture here is UTC
 * (or invalid, whose fallback IS UTC), so the default is exact.
 */
function aduCountsRows(db: Record<string, Row[]>, configIds: string[]): Row[] {
  return configIds.map((id) => {
    const timezone = String(
      (db['adu_configs'] ?? []).find((c) => c.id === id)?.['timezone'] ?? 'UTC',
    );
    const midnight = aduMidnightIso(timezone);
    const reels = (db['adu_reels'] ?? []).filter((r) => r['config_id'] === id);
    const jobs = (db['adu_posting_jobs'] ?? []).filter((j) => j['config_id'] === id);
    const inPipeline = reels.filter((r) => ADU_PIPELINE_STATUSES.includes(String(r['status']))).length;
    const published = jobs.filter((j) => j['status'] === 'published');
    const failed = jobs.filter((j) => ADU_FAILED_STATUSES.includes(String(j['status'])));
    const failedInPipeline = failed.filter((j) => {
      const reel = reels.find((r) => r['id'] === j['reel_id']);
      return reel && ADU_PIPELINE_STATUSES.includes(String(reel['status']));
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
}

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function fakeSupabase(
  db: Record<string, Row[]>,
  errors: Record<string, string> = {},
  rpcOverride?: (name: string, params: { p_workspace_id: string; p_config_ids: string[] }) => RpcResult,
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      rpc: (name: string, params: { p_workspace_id: string; p_config_ids: string[] }) => {
        calls.push(`rpc:${name}`);
        if (rpcOverride) return Promise.resolve(rpcOverride(name, params));
        if (name !== 'adu_config_counts') {
          return Promise.resolve({ data: null, error: { code: '42883', message: 'not found' } });
        }
        return Promise.resolve({ data: aduCountsRows(db, params.p_config_ids ?? []), error: null });
      },
      from: (table: string) => new FakeBuilder(table, db, calls, errors),
    },
  };
}

const todayNoonUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)).toISOString();
};
const daysAgoNoonUtc = (days: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, 12),
  ).toISOString();
};

function configRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'cfg-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    source_platform: 'instagram',
    source_username: 'ronaldo',
    timezone: 'UTC',
    posts_per_day: 3,
    schedule_type: 'dailyrandom',
    posting_times: [],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 100,
    current_followers: 150,
    display_name: null,
    created_at: daysAgoNoonUtc(10),
    updated_at: daysAgoNoonUtc(1),
    ...overrides,
  };
}

describe('buildAduConfigView counts', () => {
  it('counts posted/pending/failed and today variants from bounded count queries', async () => {
    const db: Record<string, Row[]> = {
      destinations: [
        {
          id: 'dest-1',
          name: 'Test Page',
          external_destination_id: '12345',
          avatar_url: null,
          status: 'active',
          // Spec 174 1B: the config view loads the ADU copy.
          section: 'adu',
          account_id: 'acc-1',
          social_accounts: { display_name: 'Owner', avatar_url: null },
        },
      ],
      adu_reels: [
        { id: 'r-1', config_id: 'cfg-1', status: 'downloaded' },
        { id: 'r-2', config_id: 'cfg-1', status: 'downloaded' },
        { id: 'r-3', config_id: 'cfg-1', status: 'downloaded' },
        // Crash window: the failed job settled but its reel is still
        // 'pending', so it subtracts from Pending (spec §3.5).
        { id: 'r-4', config_id: 'cfg-1', status: 'pending' },
        { id: 'r-5', config_id: 'cfg-1', status: 'posted' },
      ],
      adu_posting_jobs: [
        { config_id: 'cfg-1', status: 'published', created_at: todayNoonUtc() },
        { config_id: 'cfg-1', status: 'published', created_at: daysAgoNoonUtc(3) },
        { config_id: 'cfg-1', reel_id: 'r-4', status: 'failed_to_publish', created_at: todayNoonUtc() },
        { config_id: 'cfg-1', status: 'pending_publish', created_at: todayNoonUtc() },
      ],
    };
    const { client, calls } = fakeSupabase(db);
    const view = await buildAduConfigView(client as never, configRow() as never);
    expect(view.postedCount).toBe(2);
    expect(view.pendingCount).toBe(3);
    expect(view.failedCount).toBe(1);
    expect(view.postedToday).toBe(1);
    expect(view.failedToday).toBe(1);
    expect(view.pendingToday).toBe(2); // posts_per_day 3 - published today 1
    expect(view.destinationName).toBe('Test Page');
    // No unbounded row loads and no per-config count queries: the six
    // counts arrive in ONE grouped RPC (F1); the reels/jobs tables
    // are never queried row-by-row for this view.
    expect(calls.filter((c) => c.startsWith('adu_reels:'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('adu_posting_jobs:'))).toEqual([]);
    expect(calls.filter((c) => c === 'rpc:adu_config_counts')).toEqual([
      'rpc:adu_config_counts',
    ]);
  });

  it('stays correct with a job history far past one page (no truncation)', async () => {
    const jobs: Row[] = [];
    for (let i = 0; i < 2500; i += 1) {
      jobs.push({ config_id: 'cfg-1', status: 'published', created_at: daysAgoNoonUtc(5) });
    }
    jobs.push({ config_id: 'cfg-1', status: 'published', created_at: todayNoonUtc() });
    const { client } = fakeSupabase({
      destinations: [],
      adu_reels: [],
      adu_posting_jobs: jobs,
    });
    const view = await buildAduConfigView(client as never, configRow() as never);
    expect(view.postedCount).toBe(2501);
    expect(view.postedToday).toBe(1);
    expect(view.destinationName).toBe('Facebook Page');
  });

  it('loadAduConfigView returns null for a config outside the workspace', async () => {
    const { client } = fakeSupabase({ adu_configs: [], destinations: [], adu_reels: [], adu_posting_jobs: [] });
    const view = await loadAduConfigView(client as never, 'ws-1', 'cfg-missing');
    expect(view).toBeNull();
  });

  it('a failing count query degrades to 0 for that bucket, never a fabricated total', async () => {
    // The per-bucket degradation lives on the legacy path now: the
    // counts RPC is missing (migration not applied), so the fallback
    // runs the per-config count queries and the failing jobs bucket
    // degrades to 0 while the reels bucket still works.
    const { client } = fakeSupabase(
      {
        destinations: [],
        adu_reels: [{ config_id: 'cfg-1', status: 'downloaded' }],
        adu_posting_jobs: [{ config_id: 'cfg-1', status: 'published', created_at: todayNoonUtc() }],
      },
      { adu_posting_jobs: '23505' },
      () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }),
    );
    const view = await buildAduConfigView(client as never, configRow() as never);
    expect(view.postedCount).toBe(0);
    expect(view.failedCount).toBe(0);
    expect(view.pendingToday).toBe(3); // posts_per_day 3 - published today 0
    expect(view.pendingCount).toBe(1); // reels count still works
  });

  it('a failing counts RPC fails loud instead of degrading to zeros', async () => {
    const { client } = fakeSupabase(
      {
        destinations: [],
        adu_reels: [{ config_id: 'cfg-1', status: 'downloaded' }],
        adu_posting_jobs: [{ config_id: 'cfg-1', status: 'published', created_at: todayNoonUtc() }],
      },
      {},
      () => ({ data: null, error: { code: 'XX000', message: 'boom' } }),
    );
    await expect(buildAduConfigView(client as never, configRow() as never)).rejects.toThrow(
      /ADU counts failed/,
    );
  });

  it('loadAduConfigView returns null when the config query itself fails', async () => {
    const { client } = fakeSupabase(
      { adu_configs: [configRow()], destinations: [], adu_reels: [], adu_posting_jobs: [] },
      { adu_configs: '23505' },
    );
    const view = await loadAduConfigView(client as never, 'ws-1', 'cfg-1');
    expect(view).toBeNull();
  });

  it('an invalid timezone falls back to UTC midnight instead of throwing', async () => {
    const { client } = fakeSupabase({
      destinations: [],
      adu_reels: [],
      adu_posting_jobs: [
        { config_id: 'cfg-1', status: 'published', created_at: todayNoonUtc() },
        { config_id: 'cfg-1', status: 'published', created_at: daysAgoNoonUtc(3) },
      ],
    });
    const view = await buildAduConfigView(
      client as never,
      configRow({ timezone: 'Invalid/Zone' }) as never,
    );
    expect(view.postedCount).toBe(2);
    expect(view.postedToday).toBe(1);
  });
});

describe('adu helpers', () => {
  it('aduMissingTable matches only the missing-table code', async () => {
    const { aduMissingTable, sanitizeAduSource } = await import('../../src/lib/server/adu');
    expect(aduMissingTable({ code: '42P01' })).toBe(true);
    expect(aduMissingTable({ code: '23505' })).toBe(false);
    expect(aduMissingTable(null)).toBe(false);
    expect(aduMissingTable(undefined)).toBe(false);
    expect(sanitizeAduSource('instagram', '@creator')).toBe('creator');
    expect(sanitizeAduSource('facebook', 'https://www.facebook.com/profile.php?id=123')).toBe('123');
  });
});

describe('aduContext', () => {
  it('returns the workspace context on success and plain errors otherwise', async () => {
    const routeAuth = await import('@/lib/route-auth');
    const clients = await import('@/lib/auth/clients');
    const resolver = await import('@/lib/server/workspace-resolver');
    const { aduContext } = await import('../../src/lib/server/adu');
    const auth = vi.mocked(routeAuth.authenticateTenantRoute);
    const getSupabase = vi.mocked(routeAuth.getRouteSupabase);
    const getAdmin = vi.mocked(clients.getSupabaseAdminClient);
    const resolveWorkspace = vi.mocked(resolver.resolveWorkspaceIdFromSession);

    getAdmin.mockReturnValue({ admin: true } as never);
    getSupabase.mockReturnValue({ fake: 'supabase' } as never);
    auth.mockResolvedValue({ session: { userId: 'u-1', role: 'owner' } } as never);
    resolveWorkspace.mockResolvedValue('ws-1');
    const ok = await aduContext({} as never, 'acme');
    expect('context' in ok && ok.context.workspaceId).toBe('ws-1');

    auth.mockResolvedValue({ errorResponse: { status: 401 } } as never);
    const authed = await aduContext({} as never, 'acme');
    expect('errorResponse' in authed).toBe(true);

    auth.mockResolvedValue({ session: { userId: 'u-1', role: 'owner' } } as never);
    getSupabase.mockReturnValue(null as never);
    const noDb = await aduContext({} as never, 'acme');
    expect('errorResponse' in noDb).toBe(true);

    getSupabase.mockReturnValue({ fake: 'supabase' } as never);
    resolveWorkspace.mockResolvedValue(null);
    const noWs = await aduContext({} as never, 'acme');
    expect('errorResponse' in noWs).toBe(true);
  });
});
