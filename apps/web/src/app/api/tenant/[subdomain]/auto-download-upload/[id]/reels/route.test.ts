/**
 * ADU reels list route — pagination (adu-opt-c F15).
 *
 * The route must page 24 rows at a time with a server-side count,
 * select only the six columns the Reels tab renders, keep the
 * `?view=` semantics, and treat a missing/invalid `page` as page 1.
 * The Supabase stand-in records the query chain instead of
 * emulating PostgREST, so these tests pin the real query shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ aduContext: vi.fn() }));

vi.mock('@/lib/server/adu', () => ({ aduContext: mocks.aduContext }));

import { GET } from './route';

type Row = Record<string, unknown>;

interface RecordedCall {
  table: string;
  selectCols?: string | undefined;
  selectOpts?: { count?: string } | undefined;
  eqs: Array<[string, unknown]>;
  orders: Array<[string, unknown]>;
  range?: [number, number];
}

class FakeQuery {
  readonly call: RecordedCall;
  private readonly rows: Row[];
  private readonly count: number;
  private readonly configRow: Row | null;

  constructor(table: string, db: { reels: Row[]; count: number; configRow: Row | null }) {
    this.call = { table, eqs: [], orders: [] };
    this.rows = db.reels;
    this.count = db.count;
    this.configRow = db.configRow;
  }

  select(cols?: string, opts?: { count?: string }): this {
    this.call.selectCols = cols;
    this.call.selectOpts = opts;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.call.eqs.push([col, value]);
    return this;
  }

  order(col: string, opts?: unknown): this {
    this.call.orders.push([col, opts]);
    return this;
  }

  range(from: number, to: number): this {
    this.call.range = [from, to];
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null }> {
    return { data: this.configRow };
  }

  then<TResult1 = { data: Row[]; error: null; count: number }, TResult2 = never>(
    resolve: (value: { data: Row[]; error: null; count: number }) => TResult1 | PromiseLike<TResult1>,
  ): Promise<TResult1> {
    return Promise.resolve({ data: this.rows, error: null, count: this.count }).then(resolve);
  }
}

function makeSupabase(db: { reels: Row[]; count: number; configRow: Row | null }) {
  const queries: FakeQuery[] = [];
  return {
    queries,
    client: {
      from: (table: string) => {
        const q = new FakeQuery(table, db);
        queries.push(q);
        return q;
      },
    },
  };
}

function makeRequest(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

const BASE_URL = 'http://localhost/api/tenant/testws/auto-download-upload/cfg-1/reels';

const REEL_ROWS: Row[] = [
  { id: 'r1', source_reel_id: 'sr-1', caption: 'First', media_url: null, downloaded_at: '2026-11-12T10:00:00.000Z', status: 'downloaded', created_at: '2026-11-12T10:00:00.000Z', media_object_key: 'k1' },
];

describe('GET adu reels (adu-opt-c F15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function arrange(db: { reels?: Row[]; count?: number; configRow?: Row | null } = {}) {
    const supabase = makeSupabase({
      reels: db.reels ?? REEL_ROWS,
      count: db.count ?? 27,
      configRow: db.configRow === undefined ? { id: 'cfg-1' } : db.configRow,
    });
    mocks.aduContext.mockResolvedValue({
      context: { workspaceId: 'ws-1', supabase: supabase.client },
    });
    return supabase;
  }

  it('page 1 (no page param): 24-row range, six columns only, server count', async () => {
    const supabase = arrange();
    const res = await GET(makeRequest(BASE_URL), {
      params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      reels: REEL_ROWS,
      page: 1,
      pageSize: 24,
      total: 27,
      totalPages: 2,
    });
    const reelsQuery = supabase.queries.find((q) => q.call.table === 'adu_reels');
    expect(reelsQuery?.call.selectCols).toBe(
      'id, source_reel_id, caption, media_url, downloaded_at, status'
    );
    expect(reelsQuery?.call.selectOpts).toEqual({ count: 'exact' });
    expect(reelsQuery?.call.range).toEqual([0, 23]);
    expect(reelsQuery?.call.eqs).toContainEqual(['status', 'downloaded']);
  });

  it('page 2 ranges over the next 24 rows', async () => {
    const supabase = arrange();
    const res = await GET(makeRequest(`${BASE_URL}?page=2`), {
      params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
    });
    const body = await res.json();
    expect(body.page).toBe(2);
    expect(body.totalPages).toBe(2);
    const reelsQuery = supabase.queries.find((q) => q.call.table === 'adu_reels');
    expect(reelsQuery?.call.range).toEqual([24, 47]);
  });

  it('missing, zero, negative and non-numeric page all clamp to page 1', async () => {
    for (const query of ['?page=0', '?page=-3', '?page=abc']) {
      const supabase = arrange();
      const res = await GET(makeRequest(`${BASE_URL}${query}`), {
        params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
      });
      const body = await res.json();
      expect(body.page).toBe(1);
      const reelsQuery = supabase.queries.find((q) => q.call.table === 'adu_reels');
      expect(reelsQuery?.call.range).toEqual([0, 23]);
    }
  });

  it('view=posted selects posted rows; default view selects downloaded', async () => {
    const posted = arrange();
    await GET(makeRequest(`${BASE_URL}?view=posted`), {
      params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
    });
    expect(
      posted.queries.find((q) => q.call.table === 'adu_reels')?.call.eqs
    ).toContainEqual(['status', 'posted']);

    const queued = arrange();
    await GET(makeRequest(`${BASE_URL}?view=queue`), {
      params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
    });
    expect(
      queued.queries.find((q) => q.call.table === 'adu_reels')?.call.eqs
    ).toContainEqual(['status', 'downloaded']);
  });

  it('unknown config 404s without touching adu_reels', async () => {
    const supabase = arrange({ configRow: null });
    const res = await GET(makeRequest(BASE_URL), {
      params: Promise.resolve({ subdomain: 'testws', id: 'cfg-1' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Page not found.' });
    expect(supabase.queries.some((q) => q.call.table === 'adu_reels')).toBe(false);
  });
});
