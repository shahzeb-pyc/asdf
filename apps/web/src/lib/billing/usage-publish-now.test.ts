import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerUsage, SubscriptionGateError } from './entitlement';

/**
 * Publish-Now usage rules (audit fix 2026-11-01, fix 24):
 * Publish Now never registers usage, the usage route rejects it,
 * and a capped registration colliding with a legacy pre-fix
 * Publish-Now row deletes that row and inserts the capped row
 * instead — so the destination counts, without keeping any
 * Publish-Now row.
 *
 * In-memory Supabase stand-in, same pattern as the other billing
 * tests: filters AND together, a conditional update/delete only
 * lands on matching rows, and a duplicate (user, platform, key)
 * insert fails with 23505 like the real unique index.
 */
type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.head = true;
    return this;
  }

  insert(): this {
    return this;
  }

  update(): this {
    return this;
  }

  delete(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  neq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] !== value);
    return this;
  }

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  is(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  lte(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) <= value);
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) > value);
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.mode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.mode = 'maybeSingle';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: { code: string } | null; count?: number } {
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of rows) {
        const clash = this.table.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
      }
      const inserted = rows.map((row) => {
        const fresh: Row = { id: this.idSeq(), ...row };
        this.table.push(fresh);
        return { ...fresh };
      });
      return { data: inserted, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const row of this.table) {
        if (this.matches(row)) {
          Object.assign(row, patch);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    if (this.op === 'delete') {
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) this.table.splice(i, 1);
      }
      return { data: [], error: null };
    }
    let rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
    const count = rows.length;
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.head) return { data: [], error: null, count };
    if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
    if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, count };
  }

  then(
    resolve: (value: { data: unknown; error: { code: string } | null; count?: number }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeClient() {
  const tables: Record<string, Row[]> = { subscription_periods: [], subscription_usage: [] };
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq).select(cols, opts),
        insert: (payload: Row | Row[]) => new FakeQuery(rows, 'insert', payload, idSeq),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload, idSeq),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;

function seedActivePeriod(tables: Record<string, Row[]>) {
  tables['subscription_periods'].push({
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 5,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    ends_at: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedUsage(tables: Record<string, Row[]>, feature: string, key = 'page-1') {
  tables['subscription_usage'].push({
    id: `usage-${feature}`,
    user_id: 'user-1',
    platform: 'facebook',
    destination_key: key,
    feature,
    destination_id: 'dest-1',
  });
}

describe('registerUsage and Publish Now', () => {
  it('refuses every legacy Publish-Now feature before touching the database', async () => {
    const { client, tables } = makeClient();
    seedActivePeriod(tables);
    for (const feature of ['publish-now', 'instagram-publish-now', 'threads-publish-now']) {
      await expect(
        registerUsage(client, 'user-1', 'facebook', 'page-1', feature, 'dest-1', NOW)
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(tables['subscription_usage']).toHaveLength(0);
  });

  it('a capped registration colliding with a legacy PN row deletes it and counts the destination', async () => {
    const { client, tables } = makeClient();
    seedActivePeriod(tables);
    seedUsage(tables, 'publish-now');

    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );

    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    // No Publish-Now row survives; exactly one capped row remains.
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['feature']).toBe('destination-queue');
  });

  it('a destination used only via Publish Now does not count as used', async () => {
    const { client, tables } = makeClient();
    seedActivePeriod(tables);
    seedUsage(tables, 'publish-now');

    // Registering a DIFFERENT destination succeeds and counts 1
    // (the PN-only destination contributes 0).
    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-2',
      'destination-queue',
      'dest-2',
      NOW
    );
    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(2);
  });

  it('a second capped registration of the same destination is already-used', async () => {
    const { client, tables } = makeClient();
    seedActivePeriod(tables);
    await registerUsage(client, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1', NOW);
    const second = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'auto-download-upload',
      'dest-1',
      NOW
    );
    expect(second.alreadyUsed).toBe(true);
    expect(second.usedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(1);
  });
});
