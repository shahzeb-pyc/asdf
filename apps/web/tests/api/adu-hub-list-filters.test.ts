/**
 * IG + Threads ADU hub list GET (status filter mapping, Builder B — B4).
 *
 * The filter labels the hub pages show must reach the database as the
 * new status values: `Paused` → `paused`, `Missing Page Access` →
 * `missing_page_access`, `Missing Permission` → `missing_permission`.
 * The retired `Inactive` label must map to no filter. IG filters via
 * the query builder (`.eq('status', ...)`); Threads passes `p_status`
 * to its hub RPCs, like Facebook.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getIgHubList } from '../../src/app/api/tenant/[subdomain]/instagram/auto-download-upload/route';
import { GET as getThreadsHubList } from '../../src/app/api/tenant/[subdomain]/threads/auto-download-upload/route';

vi.mock('@/lib/server/adu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/adu')>();
  return { ...actual, aduContext: vi.fn() };
});
vi.mock('@/lib/server/threads-adu', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/threads-adu')>();
  return { ...actual, threadsAduContext: vi.fn() };
});

import { aduContext } from '@/lib/server/adu';
import { threadsAduContext } from '@/lib/server/threads-adu';

const mockedAduContext = aduContext as unknown as ReturnType<typeof vi.fn>;
const mockedThreadsAduContext = threadsAduContext as unknown as ReturnType<typeof vi.fn>;

type Row = Record<string, unknown>;

class FakeBuilder {
  filters: Array<{ col: string; val: unknown }> = [];

  constructor(
    readonly table: string,
    private readonly store: Record<string, Row[]>,
    private readonly allBuilders: FakeBuilder[]
  ) {
    allBuilders.push(this);
  }

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }

  in() {
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  async range() {
    return { data: this.matched(), error: null };
  }

  private matched(): Row[] {
    return (this.store[this.table] ?? []).filter((row) =>
      this.filters.every((f) => row[f.col] === f.val)
    );
  }

  then(resolve: (value: { data: Row[]; count: number; error: null }) => void) {
    const rows = this.matched();
    resolve({ data: rows, count: rows.length, error: null });
  }
}

function params() {
  return { params: Promise.resolve({ subdomain: 'acme' }) };
}

describe('IG ADU hub list GET (status filter mapping)', () => {
  let builders: FakeBuilder[];
  let store: Record<string, Row[]>;

  beforeEach(() => {
    vi.clearAllMocks();
    builders = [];
    store = { destinations: [{ id: 'dest-1', platform: 'instagram', workspace_id: 'ws-1' }] };
    const supabase = {
      from: (table: string) => new FakeBuilder(table, store, builders),
    };
    mockedAduContext.mockResolvedValue({ context: { workspaceId: 'ws-1', supabase } });
  });

  async function getWithStatus(filter: string) {
    const res = await getIgHubList(
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/instagram/auto-download-upload?status=${encodeURIComponent(filter)}`
      ),
      params()
    );
    expect(res.status).toBe(200);
    return builders.filter((b) => b.table === 'adu_configs');
  }

  it.each([
    ['Paused', 'paused'],
    ['Missing Page Access', 'missing_page_access'],
    ['Missing Permission', 'missing_permission'],
    ['Active', 'active'],
  ])('filters adu_configs by status=%s', async (filter, value) => {
    const configQueries = await getWithStatus(filter);
    expect(configQueries.length).toBeGreaterThan(0);
    for (const q of configQueries) {
      expect(q.filters).toContainEqual({ col: 'status', val: value });
    }
  });

  it('no longer maps the retired Inactive label — no status filter is applied', async () => {
    const configQueries = await getWithStatus('Inactive');
    expect(configQueries.length).toBeGreaterThan(0);
    for (const q of configQueries) {
      expect(q.filters.some((f) => f.col === 'status')).toBe(false);
    }
  });
});

describe('Threads ADU hub list GET (status filter mapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getWithStatus(filter: string) {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    mockedThreadsAduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: { rpc } },
    });
    const res = await getThreadsHubList(
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/threads/auto-download-upload?status=${encodeURIComponent(filter)}`
      ),
      params()
    );
    expect(res.status).toBe(200);
    return rpc;
  }

  it.each([
    ['Paused', 'paused'],
    ['Missing Page Access', 'missing_page_access'],
    ['Missing Permission', 'missing_permission'],
    ['Active', 'active'],
  ])('maps ?status=%s to p_status=%s on both RPCs', async (filter, value) => {
    const rpc = await getWithStatus(filter);
    expect(rpc).toHaveBeenCalledWith(
      'threads_adu_hub_list',
      expect.objectContaining({ p_status: value })
    );
    expect(rpc).toHaveBeenCalledWith(
      'threads_adu_hub_stats',
      expect.objectContaining({ p_status: value })
    );
  });

  it('no longer maps the retired Inactive label — it behaves as no filter', async () => {
    const rpc = await getWithStatus('Inactive');
    expect(rpc).toHaveBeenCalledWith(
      'threads_adu_hub_list',
      expect.objectContaining({ p_status: null })
    );
  });
});
