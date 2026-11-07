import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getEntitlement, SubscriptionGateError } from './entitlement';

/**
 * getEntitlement's plan value (entitlement rebuild): expired is an
 * explicit plan, never free. A user with no active period but a
 * prior paid period reads 'expired'; a user who never paid reads
 * 'free'. A database error fails loud — it must never resolve to a
 * Free answer the sidebar would render.
 *
 * Minimal in-memory stand-in for the Supabase query builder,
 * covering exactly the shapes getEntitlement uses: select (with
 * count/head), eq / neq / is / lte / gt / in, order, limit. The
 * client is cast to SupabaseClient, so the static types are the
 * real builder's; only runtime behaviour is faked.
 */
type Row = Record<string, unknown>;

type QueryValue = {
  data: Row[] | null;
  count: number | null;
  error: { message: string } | null;
};

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private sortKey: string | null = null;
  private sortAsc = true;
  private limitN: number | null = null;
  private countMode = false;

  constructor(
    private readonly rows: Row[],
    private readonly forceError: boolean = false
  ) {}

  select(_columns: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.count === 'exact') this.countMode = true;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] === value);
    return this;
  }

  neq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] !== value);
    return this;
  }

  is(col: string, value: unknown): this {
    this.filters.push((row) => row[col] === value);
    return this;
  }

  lte(col: string, value: string): this {
    this.filters.push(
      (row) => typeof row[col] === 'string' && (row[col] as string) <= value
    );
    return this;
  }

  gt(col: string, value: string): this {
    this.filters.push(
      (row) => typeof row[col] === 'string' && (row[col] as string) > value
    );
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[col]));
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.sortKey = col;
    this.sortAsc = opts.ascending;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private run(): Row[] {
    let out = this.rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.sortKey) {
      const key = this.sortKey;
      out = [...out].sort((a, b) => {
        const av = String(a[key] ?? '');
        const bv = String(b[key] ?? '');
        return this.sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }

  then<TResult1 = QueryValue, TResult2 = never>(
    onfulfilled?: ((value: QueryValue) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const value: QueryValue = this.forceError
      ? { data: null, count: null, error: { message: 'database down' } }
      : (() => {
          const rows = this.run();
          return {
            data: this.countMode ? null : rows,
            count: this.countMode ? rows.length : null,
            error: null,
          };
        })();
    return Promise.resolve(value).then(onfulfilled, onrejected);
  }
}

class FakeClient {
  constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly errorTables: Set<string> = new Set()
  ) {}

  from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? [], this.errorTables.has(table));
  }
}

const USER_ID = 'user-1';
const NOW = new Date('2026-11-07T12:00:00.000Z');

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
    starts_at: '2026-10-08T12:00:00.000Z',
    ends_at: '2026-11-07T12:00:00.000Z',
    superseded_at: null,
    ...overrides,
  };
}

function clientFor(tables: Record<string, Row[]>, errorTables: string[] = []): SupabaseClient {
  return new FakeClient(tables, new Set(errorTables)) as unknown as SupabaseClient;
}

describe('getEntitlement plan value', () => {
  it('active period reads paid with canPost', async () => {
    const client = clientFor({
      subscription_periods: [
        periodRow({ starts_at: '2026-10-08T12:00:00.000Z', ends_at: '2026-12-07T12:00:00.000Z' }),
      ],
      workspaces: [],
      subscription_usage: [],
    });
    const result = await getEntitlement(client, USER_ID, NOW);
    expect(result.plan).toBe('paid');
    expect(result.active).toBe(true);
    expect(result.canPost).toBe(true);
    expect(result.hasPriorPeriod).toBe(true);
  });

  it('lapsed period with no active period reads expired, never free', async () => {
    const client = clientFor({
      subscription_periods: [
        periodRow({ starts_at: '2026-09-08T12:00:00.000Z', ends_at: '2026-10-08T12:00:00.000Z' }),
      ],
      subscription_payments: [],
      workspaces: [],
      subscription_usage: [],
    });
    const result = await getEntitlement(client, USER_ID, NOW);
    expect(result.plan).toBe('expired');
    expect(result.active).toBe(false);
    expect(result.canPost).toBe(false);
    expect(result.readOnly).toBe(true);
    expect(result.hasPriorPeriod).toBe(true);
    expect(result.reason).toContain('has ended');
  });

  it('never paid reads free', async () => {
    const client = clientFor({
      subscription_periods: [],
      subscription_payments: [],
      workspaces: [],
      subscription_usage: [],
    });
    const result = await getEntitlement(client, USER_ID, NOW);
    expect(result.plan).toBe('free');
    expect(result.active).toBe(false);
    expect(result.canPost).toBe(false);
    expect(result.hasPriorPeriod).toBe(false);
    expect(result.reason).toContain('Free');
  });

  it('a database error fails loud instead of resolving to Free', async () => {
    const client = clientFor({ subscription_periods: [] }, ['subscription_periods']);
    let caught: unknown = null;
    try {
      await getEntitlement(client, USER_ID, NOW);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubscriptionGateError);
    expect((caught as SubscriptionGateError).code).toBe('ENTITLEMENT_UNAVAILABLE');
  });
});
