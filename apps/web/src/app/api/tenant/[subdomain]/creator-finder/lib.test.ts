import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listSavedCreators, saveCreatorsToDb } from './lib';

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

  public constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly errorOnRangeIndex?: number,
  ) {}

  public select(): this {
    return this;
  }

  public eq(): this {
    return this;
  }

  public order(): this {
    return this;
  }

  public range(from: number, to: number): Promise<QueryResult> {
    const index = this.ranges.length;
    this.ranges.push([from, to]);
    if (this.errorOnRangeIndex === index) {
      return Promise.resolve({ data: null, error: { code: 'PGRST500' } });
    }
    return Promise.resolve({
      data: this.rows.slice(from, to + 1),
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
