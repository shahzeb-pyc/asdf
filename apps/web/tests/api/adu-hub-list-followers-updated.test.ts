/**
 * Facebook ADU hub GET + single-create: the followers_updated_at
 * timestamp must reach the view (spec 162, round-2 send-back fix).
 *
 * The bug: adu_hub_list's RETURNS TABLE had no followers_updated_at,
 * so the hub route handed rows without the column to
 * buildAduConfigView, which reads the timestamp only from the row it
 * is handed — followersUpdatedAt was null forever on the Facebook
 * ADU hub and the "Updated …" line never rendered. The SQL-level
 * half is proved by the adu-rpc-grants rig (the RPC returns the
 * column); these route tests prove the wiring half: a stamped RPC
 * row surfaces as a real followersUpdatedAt on the view, and the
 * FB creation path stamps the column like the Threads one already
 * did.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn() };
});

import { aduContext } from '@/lib/server/adu';
import {
  GET as hubGET,
  POST as hubPOST,
} from '../../src/app/api/tenant/[subdomain]/auto-download-upload/route';

const mockedAduContext = aduContext as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, unknown>;

interface Filter {
  op: 'eq' | 'in' | 'gte';
  col: string;
  val: unknown;
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      if (f.op === 'eq') return row[f.col] === f.val;
      if (f.op === 'gte') return String(row[f.col] ?? '') >= String(f.val);
      return (f.val as unknown[]).includes(row[f.col]);
    })
  );
}

/** Minimal in-memory Supabase stand-in (same shape as the IG route tests'). */
class FakeBuilder {
  filters: Filter[] = [];
  inserted: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
  ) {}

  select() {
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

  insert(row: Row) {
    const inserted = { ...row, id: `cfg-${this.db[this.table].length + 1}` };
    this.db[this.table].push(inserted);
    this.inserted = inserted;
    return this;
  }

  maybeSingle() {
    const rows = applyFilters(this.db[this.table], this.filters);
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single() {
    if (this.inserted) return Promise.resolve({ data: this.inserted, error: null });
    const rows = applyFilters(this.db[this.table], this.filters);
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then(
    resolve: (value: { data: Row[] | Row | null; count: number | null; error: null }) => void,
  ) {
    const rows = applyFilters(this.db[this.table], this.filters);
    resolve({ data: rows, count: rows.length, error: null });
  }
}

function params() {
  return { params: Promise.resolve({ subdomain: 'acme' }) };
}

const STAMPED_AT = '2026-11-10T22:00:00.000Z';

function hubRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    workspace_id: 'ws-1',
    destination_id: '33333333-3333-4333-a333-333333333333',
    source_platform: 'tiktok',
    source_username: 'alpha_source',
    timezone: 'UTC',
    posts_per_day: 1,
    schedule_type: 'dailyrandom',
    posting_times: [],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 100,
    current_followers: 150,
    followers_updated_at: STAMPED_AT,
    display_name: 'Alpha Page',
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    total_count: 1,
    ...overrides,
  };
}

describe('Facebook ADU hub GET (followers_updated_at wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getHub(rows: Row[]) {
    const db: Record<string, Row[]> = {
      destinations: [
        {
          id: '33333333-3333-4333-a333-333333333333',
          name: 'Alpha Page',
          external_destination_id: 'alpha-ext',
          avatar_url: null,
          status: 'active',
          account_id: '22222222-2222-4222-a222-222222222222',
          handle: null,
          platform: 'facebook',
          social_accounts: { display_name: 'Rig Account', avatar_url: null },
        },
      ],
      adu_reels: [],
      adu_posting_jobs: [],
    };
    const supabase = {
      rpc: vi.fn(async (name: string, args?: { p_config_ids?: string[] }) => {
        if (name === 'adu_hub_list') return { data: rows, error: null };
        if (name === 'adu_config_counts') {
          // Fixtures here seed no reels or jobs, so every count is 0.
          return {
            data: (args?.p_config_ids ?? []).map((id) => ({
              config_id: id,
              in_pipeline: 0,
              published: 0,
              failed: 0,
              failed_in_pipeline: 0,
              published_today: 0,
              failed_today: 0,
            })),
            error: null,
          };
        }
        return {
          data: [{ total_count: rows.length, total_followers_sum: 150, net_gained_sum: 50 }],
          error: null,
        };
      }),
      from: (table: string) => new FakeBuilder(table, db),
    };
    mockedAduContext.mockResolvedValue({ context: { workspaceId: 'ws-1', supabase } });
    const res = await hubGET(
      new NextRequest('http://localhost:3000/api/tenant/acme/auto-download-upload'),
      params(),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { configs: Array<Record<string, unknown>> };
  }

  it('a stamped RPC row surfaces as a real followersUpdatedAt on the view', async () => {
    const body = await getHub([hubRow()]);
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0]?.followersUpdatedAt).toBe(STAMPED_AT);
  });

  it('an unstamped RPC row surfaces as null, never a faked time', async () => {
    const body = await getHub([hubRow({ followers_updated_at: null })]);
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0]?.followersUpdatedAt).toBeNull();
  });
});

describe('Facebook ADU single create (followers_updated_at stamp)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps followers_updated_at on the inserted config', async () => {
    const db: Record<string, Row[]> = {
      destinations: [
        {
          id: '33333333-3333-4333-a333-333333333333',
          workspace_id: 'ws-1',
          platform: 'facebook',
          name: 'Alpha Page',
          external_destination_id: 'alpha-ext',
          avatar_url: null,
          status: 'active',
          // Spec 174 1B: the Facebook create loads the ADU copy.
          section: 'adu',
          account_id: '22222222-2222-4222-a222-222222222222',
          handle: null,
          metadata: { current_followers: 900 },
          social_accounts: { display_name: 'Alpha Page', avatar_url: null },
        },
      ],
      adu_configs: [],
    };
    const supabase = { from: (table: string) => new FakeBuilder(table, db) };
    // Admin role skips the plan cap gate and the usage registration,
    // so the create path is exercised with no billing client.
    mockedAduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase, role: 'admin', userId: 'user-1' },
    });
    const res = await hubPOST(
      new NextRequest('http://localhost:3000/api/tenant/acme/auto-download-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destinationId: '33333333-3333-4333-a333-333333333333',
          sourcePlatform: 'tiktok',
          sourceUsername: 'creator_new',
          timezone: 'UTC',
          postsPerDay: 1,
          scheduleType: 'dailyrandom',
        }),
      }),
      params(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe('string');
    expect(db['adu_configs']).toHaveLength(1);
    // Spec 162 (send-back fix): the creation path writes
    // current_followers, so it stamps followers_updated_at too —
    // the timestamp must mean "last successful follower check"
    // from the moment the config exists, not only after the first
    // daily worker run. Same assertion as the Threads creation test.
    const config = db['adu_configs'][0] as Record<string, unknown>;
    expect(config['starting_followers']).toBe(900);
    expect(config['current_followers']).toBe(900);
    expect(typeof config['followers_updated_at']).toBe('string');
    expect(Number.isNaN(Date.parse(config['followers_updated_at'] as string))).toBe(false);
  });
});
