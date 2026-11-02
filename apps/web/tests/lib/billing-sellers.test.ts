import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { recordCommissionForPayment } from '@/lib/billing/sellers';

/**
 * Seller commission recording, tested against a small fake
 * Supabase client — no real database. Covers the scheduled-
 * downgrade shape introduced by the PR #120 send-back fix B2
 * (option A): commission recorded at approval with period_id
 * null and period_starts_at set to the scheduled start, then
 * backfilled to the real period at activation.
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

interface FakeDb {
  users: Row[];
  sellerSettings: Row[];
  commissions: Row[];
  periods: Row[];
}

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN: number | null = null;
  private inserted: Row | null = null;

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

  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  insert(row: Row): this {
    this.inserted = {
      ...row,
      id: 'commission-1',
      payout_request_id: null,
      created_at: '2026-06-01T00:00:00.000Z',
    };
    if (this.table === 'seller_commissions') this.db.commissions.push(this.inserted);
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.inserted) return { data: this.inserted, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  then(
    resolve: (value: { data: Row[]; error: null }) => void
  ): void {
    resolve({ data: this.matched(), error: null });
  }

  private matched(): Row[] {
    let rows =
      this.table === 'users'
        ? [...this.db.users]
        : this.table === 'seller_settings'
          ? [...this.db.sellerSettings]
          : this.table === 'seller_commissions'
            ? [...this.db.commissions]
            : this.table === 'subscription_periods'
              ? [...this.db.periods]
              : [];
    rows = rows.filter((r) => this.filters.every((f) => f(r)));
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
    users: [{ id: 'user-1', referred_by_seller_id: 'seller-1' }],
    sellerSettings: [{ user_id: 'seller-1', rate: 10, scope: 'every', status: 'active' }],
    commissions: [],
    periods: [],
    ...overrides,
  };
}

const payment = {
  id: 'payment-1',
  userId: 'user-1',
  amountPkr: 420,
};

describe('recordCommissionForPayment scheduled-downgrade shape (option A)', () => {
  it('records with period_id null and the scheduled start when no period exists yet', async () => {
    const db = baseDb();
    const result = await recordCommissionForPayment(fakeClient(db), {
      ...payment,
      scheduledStartsAt: new Date('2026-06-20T00:00:00.000Z'),
    }, null);
    expect(result).toMatchObject({
      paymentId: 'payment-1',
      periodId: null,
      periodStartsAt: '2026-06-20T00:00:00.000Z',
      amountPkr: 42,
      status: 'pending',
    });
    expect(db.commissions).toHaveLength(1);
    expect(db.commissions[0]?.['period_id']).toBeNull();
  });

  it('records with the real period id and start when a period exists', async () => {
    const db = baseDb();
    const result = await recordCommissionForPayment(fakeClient(db), payment, {
      id: 'period-1',
      startsAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(result).toMatchObject({ periodId: 'period-1', amountPkr: 42 });
  });

  it('returns the existing row instead of inserting a second commission', async () => {
    const db = baseDb({
      commissions: [
        {
          id: 'commission-0',
          seller_id: 'seller-1',
          user_id: 'user-1',
          payment_id: 'payment-1',
          period_id: null,
          period_starts_at: '2026-06-20T00:00:00.000Z',
          rate_snapshot: 10,
          scope_snapshot: 'every',
          amount_pkr: 42,
          status: 'pending',
          payout_request_id: null,
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    const result = await recordCommissionForPayment(fakeClient(db), {
      ...payment,
      scheduledStartsAt: new Date('2026-06-20T00:00:00.000Z'),
    }, null);
    expect(result?.id).toBe('commission-0');
    expect(db.commissions).toHaveLength(1);
  });

  it('records nothing when the buyer has no seller referral', async () => {
    const db = baseDb({ users: [{ id: 'user-1', referred_by_seller_id: null }] });
    await expect(recordCommissionForPayment(fakeClient(db), payment, null)).resolves.toBeNull();
    expect(db.commissions).toHaveLength(0);
  });

  it('one-time scope with a prior period records nothing, even with a null period', async () => {
    const db = baseDb({
      sellerSettings: [{ user_id: 'seller-1', rate: 10, scope: 'one-time', status: 'active' }],
      periods: [{ id: 'period-live', user_id: 'user-1' }],
    });
    await expect(
      recordCommissionForPayment(fakeClient(db), {
        ...payment,
        scheduledStartsAt: new Date('2026-06-20T00:00:00.000Z'),
      }, null)
    ).resolves.toBeNull();
    expect(db.commissions).toHaveLength(0);
  });
});
