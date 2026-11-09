/**
 * Plan-check C3 — dedicated downgrade-activation tick.
 *
 * The tick scans once for due schedules, then calls the EXISTING
 * worker activation function once per owner — no third copy of the
 * activation logic. Tested against a small fake Supabase client in
 * the entitlement.test.ts style — no real database.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runDowngradeActivationTick } from './downgrade-tick.js';

type Row = Record<string, unknown>;

interface FakeDb {
  periods: Row[];
  payments: Row[];
  commissions: Row[];
  /** Every query the fake answers, in order (pins the scan shape). */
  queries: Array<{ table: string; op: 'select' | 'insert' | 'update'; limit: number | null }>;
  /** C3: when true, the tick's scan query (payments select, limit 100) errors. */
  failScan?: boolean;
  /** C3: period inserts for these owners fail (per-owner isolation). */
  failPeriodInsertForUserIds?: Set<string>;
}

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN: number | null = null;
  private sortKey: string | null = null;
  private sortAsc = true;
  private insertRow: Row | null = null;
  private insertError: Error | null = null;
  private updatePatch: Row | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

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

  lte(col: string, val: string): this {
    this.filters.push((r) => typeof r[col] === 'string' && (r[col] as string) <= val);
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

  insert(row: Row): this {
    if (
      this.table === 'subscription_periods' &&
      typeof row['user_id'] === 'string' &&
      this.db.failPeriodInsertForUserIds?.has(row['user_id'])
    ) {
      this.insertError = new Error('period insert boom');
      return this;
    }
    this.insertRow = {
      ...row,
      id: `period-${this.db.periods.length + 1}`,
      superseded_at: null,
    };
    if (this.table === 'subscription_periods') this.db.periods.push(this.insertRow);
    return this;
  }

  update(patch: Row): this {
    this.updatePatch = patch;
    return this;
  }

  private log(op: 'select' | 'insert' | 'update'): void {
    this.db.queries.push({ table: this.table, op, limit: this.limitN });
  }

  async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    this.log(this.insertRow || this.insertError ? 'insert' : this.updatePatch ? 'update' : 'select');
    if (this.insertError) return { data: null, error: this.insertError };
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: unknown }> {
    this.log(this.insertRow || this.insertError ? 'insert' : this.updatePatch ? 'update' : 'select');
    if (this.insertError) return { data: null, error: this.insertError };
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Row[] | null; error: unknown }) => void): void {
    // C3 scan failure: only the tick's scan (payments select with
    // limit 100) errors — per-owner activation queries are unaffected.
    if (
      this.db.failScan &&
      this.table === 'subscription_payments' &&
      this.limitN === 100 &&
      !this.insertRow &&
      !this.updatePatch
    ) {
      this.log('select');
      resolve({ data: null, error: new Error('scan boom') });
      return;
    }
    this.log(this.updatePatch ? 'update' : this.insertRow ? 'insert' : 'select');
    if (this.updatePatch) {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.updatePatch);
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    resolve({ data: this.matched(), error: null });
  }

  private rows(): Row[] {
    switch (this.table) {
      case 'subscription_periods':
        return this.db.periods;
      case 'subscription_payments':
        return this.db.payments;
      case 'seller_commissions':
        return this.db.commissions;
      default:
        return [];
    }
  }

  private matched(): Row[] {
    let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.sortKey) {
      const key = this.sortKey;
      const asc = this.sortAsc;
      rows = [...rows].sort((a, b) => {
        const av = String(a[key] ?? '');
        const bv = String(b[key] ?? '');
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
}

function fakeClient(db: FakeDb): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(db, table),
  } as unknown as SupabaseClient;
}

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    periods: [],
    payments: [],
    commissions: [],
    queries: [],
    ...overrides,
  };
}

function scheduledPayment(overrides: Row = {}): Row {
  return {
    id: 'payment-1',
    user_id: 'user-1',
    status: 'approved',
    period_id: null,
    is_downgrade: true,
    scheduled_starts_at: '2026-05-20T00:00:00.000Z',
    facebook_count: 2,
    instagram_count: 1,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('runDowngradeActivationTick', () => {
  it('activates due schedules end-to-end, earliest first, one call per owner', async () => {
    const db = baseDb({
      payments: [
        scheduledPayment({ id: 'payment-u1', user_id: 'user-1' }),
        scheduledPayment({
          id: 'payment-u2',
          user_id: 'user-2',
          scheduled_starts_at: '2026-05-10T00:00:00.000Z',
        }),
        // Ignored by the scan: future, non-downgrade, already linked.
        scheduledPayment({
          id: 'payment-future',
          user_id: 'user-3',
          scheduled_starts_at: '2026-06-20T00:00:00.000Z',
        }),
        scheduledPayment({ id: 'payment-nondg', user_id: 'user-4', is_downgrade: false }),
        scheduledPayment({ id: 'payment-linked', user_id: 'user-5', period_id: 'period-old' }),
      ],
      commissions: [
        { id: 'commission-u1', payment_id: 'payment-u1', period_id: null },
        { id: 'commission-u2', payment_id: 'payment-u2', period_id: null },
      ],
    });
    const result = await runDowngradeActivationTick({ db: fakeClient(db), now: NOW });
    expect(result).toEqual({ scanned: 2, dueOwners: 2, activated: 2, failed: 0 });
    expect(db.periods).toHaveLength(2);
    // Earliest-first: user-2 (May 10) activates before user-1 (May 20).
    expect(db.periods[0]?.['user_id']).toBe('user-2');
    expect(db.periods[1]?.['user_id']).toBe('user-1');
    for (const period of db.periods) {
      expect(period).toMatchObject({
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: '2026-07-01T00:00:00.000Z',
      });
    }
    const byId = new Map(db.payments.map((p) => [p['id'], p]));
    expect(byId.get('payment-u1')?.['period_id']).toBe('period-2');
    expect(byId.get('payment-u2')?.['period_id']).toBe('period-1');
    expect(byId.get('payment-future')?.['period_id']).toBeNull();
    expect(byId.get('payment-nondg')?.['period_id']).toBeNull();
    expect(byId.get('payment-linked')?.['period_id']).toBe('period-old');
    expect(db.commissions[0]?.['period_id']).toBe('period-2');
    expect(db.commissions[1]?.['period_id']).toBe('period-1');
  });

  it('empty scan: one query, zero writes', async () => {
    const db = baseDb();
    const result = await runDowngradeActivationTick({ db: fakeClient(db), now: NOW });
    expect(result).toEqual({ scanned: 0, dueOwners: 0, activated: 0, failed: 0 });
    expect(db.queries).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 100 },
    ]);
    expect(db.periods).toHaveLength(0);
    expect(db.payments).toHaveLength(0);
    expect(db.commissions).toHaveLength(0);
  });

  it('one owner failing does not stop the others, and the failure is counted', async () => {
    const db = baseDb({
      payments: [
        scheduledPayment({ id: 'payment-u1', user_id: 'user-1' }),
        scheduledPayment({ id: 'payment-u2', user_id: 'user-2' }),
      ],
      failPeriodInsertForUserIds: new Set(['user-1']),
    });
    const result = await runDowngradeActivationTick({ db: fakeClient(db), now: NOW });
    expect(result).toEqual({ scanned: 2, dueOwners: 2, activated: 1, failed: 1 });
    expect(db.periods).toHaveLength(1);
    expect(db.periods[0]?.['user_id']).toBe('user-2');
    const byId = new Map(db.payments.map((p) => [p['id'], p]));
    expect(byId.get('payment-u1')?.['period_id']).toBeNull();
    expect(byId.get('payment-u2')?.['period_id']).toBe('period-1');
  });

  it('one owner with two due schedules: earliest only, second untouched', async () => {
    const db = baseDb({
      payments: [
        scheduledPayment({
          id: 'payment-late',
          scheduled_starts_at: '2026-05-20T00:00:00.000Z',
        }),
        scheduledPayment({
          id: 'payment-early',
          scheduled_starts_at: '2026-05-10T00:00:00.000Z',
        }),
      ],
    });
    const result = await runDowngradeActivationTick({ db: fakeClient(db), now: NOW });
    expect(result).toEqual({ scanned: 2, dueOwners: 1, activated: 1, failed: 0 });
    expect(db.periods).toHaveLength(1);
    expect(db.periods[0]?.['payment_id']).toBe('payment-early');
    const byId = new Map(db.payments.map((p) => [p['id'], p]));
    expect(byId.get('payment-early')?.['period_id']).toBe('period-1');
    expect(byId.get('payment-late')?.['period_id']).toBeNull();
  });

  it('scan failure throws to the caller', async () => {
    const db = baseDb({ failScan: true });
    await expect(runDowngradeActivationTick({ db: fakeClient(db), now: NOW })).rejects.toThrow(
      'Downgrade activation scan failed'
    );
  });
});
