import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listSavedCreators, listSavedCreatorsPage, saveCreatorsToDb } from './lib';

/**
 * listSavedCreators paged fetch (verification SEND BACK B1).
 *
 * PostgREST silently truncates an unbounded select at 1,000 rows,
 * so the old single-select fetch could never return more than
 * that — Saved pagination totals, search/filter, and the CSV
 * export (which claims "all saved creators") would all silently
 * miss rows past the truncation. The fixed fetch pages with
 * .range() until a short page.
 *
 * Why this test fails on the old fetch: the old code never calls
 * .range(), so the recorded ranges below are empty and the
 * returned list is the fake query object destructured to no rows
 * (data undefined -> []), never the 1,001 rows. The fixed code
 * records two ranges and returns every row.
 */

function makeRow(index: number): Record<string, unknown> {
  return {
    handle: `user${index}`,
    display_name: `User ${index}`,
    avatar_url: null,
    profile_url: `https://www.tiktok.com/@user${index}`,
    follower_count: null,
    verified: null,
    source: 'trending',
    search_term: 'PK',
    updated_at: '2026-10-30T00:00:00.000Z',
  };
}

type QueryResult = { data: unknown[] | null; error: unknown };

/** Minimal Supabase query-builder fake honouring .range() slicing. */
class FakeQuery {
  public ranges: Array<[number, number]> = [];
  private eqFilters: Record<string, string> = {};
  private orPattern: string | null = null;
  private headCount = false;
  public countError: unknown = null;

  public constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly errorOnRangeIndex?: number,
  ) {}

  public select(
    _columns?: string,
    options?: { count?: string; head?: boolean },
  ): this {
    if (options?.head) this.headCount = true;
    return this;
  }

  public eq(column: string, value: string): this {
    this.eqFilters[column] = value;
    return this;
  }

  public or(filters: string): this {
    this.orPattern = filters;
    return this;
  }

  public order(): this {
    return this;
  }

  /** Rows after the recorded filters (eq on source + ilike search). */
  private filteredRows(): Record<string, unknown>[] {
    let rows = this.rows;
    const source = this.eqFilters.source;
    if (source !== undefined) {
      rows = rows.filter((row) => row.source === source);
    }
    if (this.orPattern) {
      const match = /"%([^"]*)%"/.exec(this.orPattern);
      const needle = (match?.[1] ?? '')
        .replaceAll('\\%', '%')
        .replaceAll('\\_', '_')
        .replaceAll('\\\\', '\\')
        .toLowerCase();
      rows = rows.filter((row) => {
        const name = String(row.display_name ?? '').toLowerCase();
        const handle = String(row.handle ?? '').toLowerCase();
        return name.includes(needle) || handle.includes(needle);
      });
    }
    return rows;
  }

  /**
   * Thenable so `await query` works for the count-head query: it resolves
   * with the filtered count, never rows.
   */
  public then(
    resolve: (value: { count: number | null; error: unknown }) => void,
  ): void {
    if (this.countError) {
      resolve({ count: null, error: this.countError });
      return;
    }
    resolve({ count: this.filteredRows().length, error: null });
  }

  public range(from: number, to: number): Promise<QueryResult> {
    const index = this.ranges.length;
    this.ranges.push([from, to]);
    if (this.errorOnRangeIndex === index) {
      return Promise.resolve({ data: null, error: { code: 'PGRST500' } });
    }
    const rows = this.filteredRows();
    return Promise.resolve({
      data: rows.slice(from, to + 1),
      error: null,
    });
  }
}

class FakeSupabase {
  public query: FakeQuery;

  public constructor(
    rows: Record<string, unknown>[],
    errorOnRangeIndex?: number,
  ) {
    this.query = new FakeQuery(rows, errorOnRangeIndex);
  }

  public from(): FakeQuery {
    return this.query;
  }
}

function asClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe('listSavedCreators paged fetch', () => {
  it('returns every row across more than one Supabase page', async () => {
    // 1,001 rows: a full 1,000-row page plus a 1-row short page.
    const rows = Array.from({ length: 1001 }, (_, i) => makeRow(i));
    const fake = new FakeSupabase(rows);
    const result = await listSavedCreators(
      asClient(fake),
      'workspace-1',
      'user-1',
    );
    expect(result).not.toBeNull();
    expect(result?.length).toBe(1001);
    expect(result?.[0]?.handle).toBe('user0');
    expect(result?.[1000]?.handle).toBe('user1000');
    // The fetch actually paged: two .range() calls, not one select.
    expect(fake.query.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('returns a single short page unchanged', async () => {
    const rows = [makeRow(0), makeRow(1)];
    const fake = new FakeSupabase(rows);
    const result = await listSavedCreators(
      asClient(fake),
      'workspace-1',
      'user-1',
    );
    expect(result?.length).toBe(2);
    expect(fake.query.ranges).toEqual([[0, 999]]);
  });

  it('fails loud with null on a paged-fetch error, never a partial list', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const rows = Array.from({ length: 1001 }, (_, i) => makeRow(i));
      // Second page errors: the first 1,000 rows must NOT be
      // returned as if they were the whole list.
      const fake = new FakeSupabase(rows, 1);
      const result = await listSavedCreators(
        asClient(fake),
        'workspace-1',
        'user-1',
      );
      expect(result).toBeNull();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('saveCreatorsToDb enrichment merge', () => {
  /** Minimal fake for the save read + upsert chains. */
  class SaveFake {
    public upserted: Record<string, unknown>[] = [];

    public constructor(
      private readonly existing: Record<string, unknown>[],
    ) {}

    public from(): SaveFake {
      return this;
    }

    public select(): SaveFake {
      return this;
    }

    public eq(): SaveFake {
      return this;
    }

    public async in(): Promise<{ data: unknown[]; error: null }> {
      return { data: this.existing, error: null };
    }

    public async upsert(
      rows: Record<string, unknown>[],
    ): Promise<{ error: null }> {
      this.upserted = rows;
      return { error: null };
    }
  }

  const storedRow = {
    ...makeRow(0),
    bio: 'Stored bio',
    countik_enriched: true,
    countik_follower_count: 100,
    following_count: 10,
    hearts_count: 20,
    video_count: 30,
    countik_verified: false,
    engagement_total: 5,
    engagement_likes: 4,
    engagement_comments: 0.5,
    engagement_shares: 0.5,
    average_views: 1000,
    average_likes: 100,
    average_comments: 10,
    average_shares: 5,
    hashtags: ['stored'],
    mentions: [],
  };

  it('keeps stored enrichment when the new save has none', async () => {
    const fake = new SaveFake([storedRow]);
    const ok = await saveCreatorsToDb(
      fake as unknown as SupabaseClient,
      'workspace-1',
      'user-1',
      [
        {
          handle: 'user0',
          displayName: 'User 0',
          avatarUrl: null,
          latestVideoTitle: null,
          latestVideoCover: null,
          profileUrl: 'https://www.tiktok.com/@user0',
        },
      ],
      'trending',
      'PK',
    );
    expect(ok).toBe(true);
    expect(fake.upserted[0]?.bio).toBe('Stored bio');
    expect(fake.upserted[0]?.countik_enriched).toBe(true);
    expect(fake.upserted[0]?.hashtags).toEqual(['stored']);
  });

  it('replaces stored enrichment wholesale when the new save has fresh data', async () => {
    const fake = new SaveFake([storedRow]);
    const ok = await saveCreatorsToDb(
      fake as unknown as SupabaseClient,
      'workspace-1',
      'user-1',
      [
        {
          handle: 'user0',
          displayName: 'User 0',
          avatarUrl: null,
          latestVideoTitle: null,
          latestVideoCover: null,
          profileUrl: 'https://www.tiktok.com/@user0',
          enrichment: {
            bio: 'Fresh bio',
            followingCount: 99,
            hashtags: ['fresh'],
            mentions: [],
          },
        },
      ],
      'trending',
      'PK',
    );
    expect(ok).toBe(true);
    expect(fake.upserted[0]?.bio).toBe('Fresh bio');
    expect(fake.upserted[0]?.following_count).toBe(99);
    expect(fake.upserted[0]?.hashtags).toEqual(['fresh']);
  });
});

describe('listSavedCreatorsPage (spec 169)', () => {
  function pageRow(
    index: number,
    source: 'trending' | 'niche' | 'similar' = 'trending',
  ): Record<string, unknown> {
    return {
      ...makeRow(index),
      display_name: `User ${index}`,
      source,
    };
  }

  it('pages in the database: 65 rows come back 30 / 30 / 5 with the count total', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => pageRow(i));
    const fake = new FakeSupabase(rows);
    const page1 = await listSavedCreatorsPage(
      asClient(fake),
      'workspace-1',
      'user-1',
      { page: 1 },
    );
    expect(page1?.creators).toHaveLength(30);
    expect(page1?.total).toBe(65);
    expect(page1?.totalPages).toBe(3);
    expect(page1?.page).toBe(1);
    expect(page1?.pageSize).toBe(30);
    // One range per page — the database does the paging, not memory.
    expect(fake.query.ranges).toEqual([[0, 29]]);
    const page3 = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { page: 3 },
    );
    expect(page3?.creators).toHaveLength(5);
    expect(page3?.page).toBe(3);
  });

  it('filters by source in the database', async () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => pageRow(i, 'trending')),
      ...Array.from({ length: 3 }, (_, i) => pageRow(10 + i, 'niche')),
    ];
    const fake = new FakeSupabase(rows);
    const result = await listSavedCreatorsPage(
      asClient(fake),
      'workspace-1',
      'user-1',
      { source: 'niche', page: 1 },
    );
    expect(result?.total).toBe(3);
    expect(result?.creators).toHaveLength(3);
    expect(result?.creators.map((c) => c.source)).toEqual([
      'niche',
      'niche',
      'niche',
    ]);
  });

  it('searches display name or handle, case-insensitively, ignoring a leading @', async () => {
    const rows = [
      { ...pageRow(0), display_name: 'Alice Fit', handle: 'alice' },
      { ...pageRow(1), display_name: 'Bob Daily', handle: 'bob' },
      { ...pageRow(2), display_name: 'Carol', handle: 'carol' },
    ];
    const byName = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { q: 'FIT', page: 1 },
    );
    expect(byName?.creators.map((c) => c.handle)).toEqual(['alice']);
    const byHandle = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { q: '@bob', page: 1 },
    );
    expect(byHandle?.creators.map((c) => c.handle)).toEqual(['bob']);
    const noMatch = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { q: 'zzz', page: 1 },
    );
    expect(noMatch?.creators).toEqual([]);
    expect(noMatch?.total).toBe(0);
    expect(noMatch?.totalPages).toBe(0);
  });

  it('a LIKE wildcard in the search matches literally, not everything', async () => {
    const rows = [
      { ...pageRow(0), display_name: 'Percent', handle: '100%real' },
      { ...pageRow(1), display_name: 'Plain', handle: 'plain' },
      { ...pageRow(2), display_name: 'Under Score', handle: 'user_1' },
      { ...pageRow(3), display_name: 'User Zero', handle: 'user0' },
    ];
    const percent = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { q: '%', page: 1 },
    );
    expect(percent?.creators.map((c) => c.handle)).toEqual(['100%real']);
    const underscore = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { q: 'user_', page: 1 },
    );
    expect(underscore?.creators.map((c) => c.handle)).toEqual(['user_1']);
  });

  it('clamps a page past the end to the last page', async () => {
    const rows = Array.from({ length: 65 }, (_, i) => pageRow(i));
    const result = await listSavedCreatorsPage(
      asClient(new FakeSupabase(rows)),
      'workspace-1',
      'user-1',
      { page: 99 },
    );
    expect(result?.page).toBe(3);
    expect(result?.creators).toHaveLength(5);
  });

  it('fails loud with null on a count failure or a page failure', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      const rows = Array.from({ length: 5 }, (_, i) => pageRow(i));
      const countFail = new FakeSupabase(rows);
      countFail.query.countError = { code: 'PGRST500' };
      expect(
        await listSavedCreatorsPage(asClient(countFail), 'workspace-1', 'user-1', {
          page: 1,
        }),
      ).toBeNull();
      const pageFail = new FakeSupabase(rows, 0);
      expect(
        await listSavedCreatorsPage(asClient(pageFail), 'workspace-1', 'user-1', {
          page: 1,
        }),
      ).toBeNull();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
