import { describe, expect, it, vi } from 'vitest';

import {
  checkStorageQuota,
  formatStorageGb,
  getStorageQuotaState,
  STORAGE_BYTES_PER_UNIT,
  type StorageQuotaState,
} from '@/lib/billing/storage-quota';

/**
 * Media Library storage quota: 5 GB per paid page/account in the
 * user's ACTIVE period, usage summed from live media_items rows
 * (so deleting a file frees its quota immediately). No active
 * period → quota 0. Tested against small fakes for both database
 * shapes the routes use (Supabase client and SQL client) — no real
 * database.
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

const GB = 1073741824;

function periodRow(counts: Record<string, number>): Row {
  return {
    // getActivePeriod filters on user_id, and periodFromRow requires
    // id + user_id + both dates: a row missing any of them reads as
    // "no active period", which is exactly how these tests first failed.
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: counts.facebook ?? 0,
    instagram_count: counts.instagram ?? 0,
    threads_count: counts.threads ?? 0,
    x_count: counts.x ?? 0,
    tiktok_count: counts.tiktok ?? 0,
    youtube_count: counts.youtube ?? 0,
    starts_at: '2020-01-01T00:00:00.000Z',
    ends_at: '2099-01-01T00:00:00.000Z',
    superseded_at: null,
  };
}

class FakeSupabaseBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private sortCol: string | null = null;
  private sortAsc = true;
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(private rows: Row[]) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push((r) => String(r[col]) <= String(val));
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push((r) => String(r[col]) > String(val));
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.sortCol = col;
    this.sortAsc = opts?.ascending !== false;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  then(resolve: (value: { data: Row[]; error: null }) => void): void {
    let rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sortCol) {
      const col = this.sortCol;
      rows = [...rows].sort((a, b) =>
        this.sortAsc
          ? String(a[col]).localeCompare(String(b[col]))
          : String(b[col]).localeCompare(String(a[col]))
      );
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    }
    resolve({ data: rows, error: null });
  }
}

function fakeSupabase(periods: Row[], media: Row[]) {
  return {
    from(table: string) {
      if (table === 'subscription_periods') return new FakeSupabaseBuilder(periods);
      if (table === 'media_items') return new FakeSupabaseBuilder(media);
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function fakeSql(period: Row | null, usageTotal: number) {
  return {
    query: async (sql: string) => {
      if (sql.includes('subscription_periods')) return period ? [period] : [];
      if (sql.includes('SUM(file_size)')) return [{ total: usageTotal }];
      throw new Error(`unexpected sql ${sql}`);
    },
  };
}

describe('storage quota math', () => {
  it('quota is 5 GB per paid unit across platforms in the active period', async () => {
    const client = fakeSupabase(
      [periodRow({ facebook: 5, instagram: 3 })],
      []
    );
    const state: StorageQuotaState = await getStorageQuotaState(
      client as never,
      'user-1'
    );
    expect(state.quotaBytes).toBe(8 * STORAGE_BYTES_PER_UNIT);
    expect(state.quotaBytes).toBe(8 * 5 * GB);
  });

  it('no active period → quota 0, and any upload is refused', async () => {
    const client = fakeSupabase([], []);
    const state = await getStorageQuotaState(client as never, 'user-1');
    expect(state.quotaBytes).toBe(0);
    const check = checkStorageQuota(state, 1);
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.noQuota).toBe(true);
  });

  it('upload under quota succeeds; at exactly quota succeeds; one byte over fails with the plain message', async () => {
    const quota = 2 * STORAGE_BYTES_PER_UNIT; // 10 GB
    const used = quota - 100;
    expect(checkStorageQuota({ quotaBytes: quota, usedBytes: used }, 100).allowed).toBe(true);
    const over = checkStorageQuota({ quotaBytes: quota, usedBytes: used }, 101);
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.message).toContain('10 GB');
      expect(over.message).toContain('Delete some files');
    }
  });

  it('deleting a file frees its quota for a new upload', async () => {
    const media: Row[] = [
      { user_id: 'user-1', file_size: 10 * GB },
      { user_id: 'user-1', file_size: 5 * GB },
    ];
    const client = fakeSupabase([periodRow({ facebook: 4 })], media);
    const before = await getStorageQuotaState(client as never, 'user-1');
    expect(before.usedBytes).toBe(15 * GB);
    media.splice(0, 1);
    const after = await getStorageQuotaState(client as never, 'user-1');
    expect(after.usedBytes).toBe(5 * GB);
    expect(checkStorageQuota(after, 10 * GB).allowed).toBe(true);
  });

  it('usage sums past 1,000 rows (no PostgREST truncation)', async () => {
    const media: Row[] = Array.from({ length: 1500 }, () => ({
      user_id: 'user-1',
      file_size: 1024 * 1024,
    }));
    const client = fakeSupabase([periodRow({ facebook: 1 })], media);
    const state = await getStorageQuotaState(client as never, 'user-1');
    expect(state.usedBytes).toBe(1500 * 1024 * 1024);
  });

  it('SQL path gives the same quota and usage', async () => {
    const client = fakeSql(periodRow({ facebook: 2, threads: 1 }), 3 * GB);
    const state = await getStorageQuotaState(client as never, 'user-1');
    expect(state.quotaBytes).toBe(3 * STORAGE_BYTES_PER_UNIT);
    expect(state.usedBytes).toBe(3 * GB);
  });

  it('formats gigabytes for the plain message', () => {
    expect(formatStorageGb(STORAGE_BYTES_PER_UNIT)).toBe('5 GB');
    expect(formatStorageGb(8 * STORAGE_BYTES_PER_UNIT)).toBe('40 GB');
  });
});
