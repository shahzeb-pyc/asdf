import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import { getStorageQuotaState, STORAGE_BYTES_PER_UNIT } from './storage-quota';
import type { SubscriptionPeriodRow } from './entitlement';

/**
 * Plan-check R2: the Home loader already holds the active period, so
 * `getStorageQuotaState` must derive the quota from a passed-in period
 * instead of re-reading `subscription_periods` — for paid, free and
 * expired alike — while usage is still summed from live media rows.
 *
 * The fake counts every `subscription_periods` query, so a regression
 * that re-reads the period fails the "no period query" assertions
 * even when the returned numbers happen to look right.
 */
type Row = Record<string, unknown>;

const USER_ID = 'user-1';
const GIB = STORAGE_BYTES_PER_UNIT;

function periodRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'period-1',
    user_id: USER_ID,
    facebook_count: 10,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: '2026-11-01T00:00:00.000Z',
    ends_at: '2026-12-01T00:00:00.000Z',
    superseded_at: null,
    ...overrides,
  };
}

function periodObject(overrides: Partial<SubscriptionPeriodRow> = {}): SubscriptionPeriodRow {
  return {
    id: 'period-1',
    userId: USER_ID,
    counts: {
      facebook: 10,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    },
    startsAt: new Date('2026-11-01T00:00:00.000Z'),
    endsAt: new Date('2026-12-01T00:00:00.000Z'),
    supersededAt: null,
    ...overrides,
  };
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private orderKey: string | null = null;
  private orderAsc = true;

  constructor(private readonly table: Row[]) {}

  select(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  is(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  lte(key: string, value: string): this {
    this.filters.push(
      (row) => typeof row[key] === 'string' && (row[key] as string) <= value
    );
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push(
      (row) => typeof row[key] === 'string' && (row[key] as string) > value
    );
    return this;
  }

  order(key: string, opts?: { ascending?: boolean }): this {
    this.orderKey = key;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  then(
    resolve: (value: { data: Row[]; error: null }) => void,
    reject: (err: unknown) => void
  ): void {
    try {
      let rows = this.table.filter((row) => this.filters.every((f) => f(row)));
      if (this.orderKey) {
        const key = this.orderKey;
        rows = [...rows].sort((a, b) => {
          const av = String(a[key] ?? '');
          const bv = String(b[key] ?? '');
          return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.rangeStart !== null) {
        rows = rows.slice(this.rangeStart, (this.rangeEnd ?? rows.length) + 1);
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      resolve({ data: rows, error: null });
    } catch (err) {
      reject(err);
    }
  }
}

class FakeSupabase {
  periodQueries = 0;

  constructor(
    private readonly periods: Row[],
    private readonly media: Row[]
  ) {}

  from(table: string): FakeQuery {
    if (table === 'subscription_periods') this.periodQueries += 1;
    return new FakeQuery(table === 'subscription_periods' ? this.periods : this.media);
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

function mediaRows(sizes: number[]): Row[] {
  return sizes.map((file_size) => ({ user_id: USER_ID, file_size }));
}

describe('getStorageQuotaState with a passed-in period (R2)', () => {
  it('paid: passed period gives the same quota as a fresh read, without querying subscription_periods', async () => {
    const media = mediaRows([100, 200, 300]);
    const freshClient = new FakeSupabase([periodRow()], media);
    const reusedClient = new FakeSupabase([periodRow()], media);

    const fresh = await getStorageQuotaState(freshClient.asClient(), USER_ID);
    const reused = await getStorageQuotaState(reusedClient.asClient(), USER_ID, {
      period: periodObject(),
    });

    expect(fresh).toEqual({ quotaBytes: 10 * GIB, usedBytes: 600 });
    expect(reused).toEqual(fresh);
    expect(freshClient.periodQueries).toBe(1);
    expect(reusedClient.periodQueries).toBe(0);
  });

  it('paid: mixed platform counts sum to the same quota passed in vs read fresh', async () => {
    const counts = {
      facebook: 2,
      instagram: 1,
      threads: 1,
      x: 0,
      tiktok: 0,
      youtube: 0,
    };
    const media = mediaRows([1024]);
    const freshClient = new FakeSupabase(
      [periodRow({ facebook_count: 2, instagram_count: 1, threads_count: 1 })],
      media
    );
    const reusedClient = new FakeSupabase(
      [periodRow({ facebook_count: 2, instagram_count: 1, threads_count: 1 })],
      media
    );

    const fresh = await getStorageQuotaState(freshClient.asClient(), USER_ID);
    const reused = await getStorageQuotaState(reusedClient.asClient(), USER_ID, {
      period: periodObject({ counts }),
    });

    expect(fresh).toEqual({ quotaBytes: 4 * GIB, usedBytes: 1024 });
    expect(reused).toEqual(fresh);
    expect(reusedClient.periodQueries).toBe(0);
  });

  it('free: passed null period gives quota 0 without a period query, usage still summed', async () => {
    const client = new FakeSupabase([], mediaRows([500, 700]));

    const state = await getStorageQuotaState(client.asClient(), USER_ID, {
      period: null,
    });

    expect(state).toEqual({ quotaBytes: 0, usedBytes: 1200 });
    expect(client.periodQueries).toBe(0);
  });

  it('expired: passed null period matches a fresh read over a lapsed period row', async () => {
    const lapsed = periodRow({
      starts_at: '2026-10-01T00:00:00.000Z',
      ends_at: '2026-10-31T00:00:00.000Z',
    });
    const media = mediaRows([42]);
    const freshClient = new FakeSupabase([lapsed], media);
    const reusedClient = new FakeSupabase([lapsed], media);

    const fresh = await getStorageQuotaState(freshClient.asClient(), USER_ID);
    const reused = await getStorageQuotaState(reusedClient.asClient(), USER_ID, {
      period: null,
    });

    expect(fresh).toEqual({ quotaBytes: 0, usedBytes: 42 });
    expect(reused).toEqual(fresh);
    expect(reusedClient.periodQueries).toBe(0);
  });

  it('usage is still summed from live rows across the 1,000-row pages', async () => {
    const sizes = Array.from({ length: 2500 }, () => 1000);
    const client = new FakeSupabase([periodRow()], mediaRows(sizes));

    const state = await getStorageQuotaState(client.asClient(), USER_ID, {
      period: periodObject(),
    });

    expect(state).toEqual({ quotaBytes: 10 * GIB, usedBytes: 2_500_000 });
    expect(client.periodQueries).toBe(0);
  });

  it('omitting the period keeps the old behaviour: the period is read fresh', async () => {
    const client = new FakeSupabase([periodRow()], mediaRows([10]));

    const state = await getStorageQuotaState(client.asClient(), USER_ID);

    expect(state).toEqual({ quotaBytes: 10 * GIB, usedBytes: 10 });
    expect(client.periodQueries).toBe(1);
  });
});

describe('getStorageQuotaState SQL path with a passed-in period (R2)', () => {
  function fakeSql(periodRows: Row[], usageTotal: number) {
    let periodQueries = 0;
    const client = {
      query: async (sql: string) => {
        if (sql.includes('subscription_periods')) {
          periodQueries += 1;
          return periodRows;
        }
        return [{ total: usageTotal }];
      },
    } as unknown as DatabaseClient;
    return { client, getPeriodQueries: () => periodQueries };
  }

  it('paid: passed period gives the same quota as a fresh read, without a period query', async () => {
    const fresh = fakeSql([periodRow()], 600);
    const reused = fakeSql([periodRow()], 600);

    const freshState = await getStorageQuotaState(fresh.client, USER_ID);
    const reusedState = await getStorageQuotaState(reused.client, USER_ID, {
      period: periodObject(),
    });

    expect(freshState).toEqual({ quotaBytes: 10 * GIB, usedBytes: 600 });
    expect(reusedState).toEqual(freshState);
    expect(fresh.getPeriodQueries()).toBe(1);
    expect(reused.getPeriodQueries()).toBe(0);
  });

  it('free: passed null period gives quota 0 without a period query', async () => {
    const sql = fakeSql([], 1200);

    const state = await getStorageQuotaState(sql.client, USER_ID, { period: null });

    expect(state).toEqual({ quotaBytes: 0, usedBytes: 1200 });
    expect(sql.getPeriodQueries()).toBe(0);
  });
});
