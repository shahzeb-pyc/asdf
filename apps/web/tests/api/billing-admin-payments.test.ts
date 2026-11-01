import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as listPayments } from '@/app/api/admin/payments/route';
import { POST as decidePayment } from '@/app/api/admin/payments/[paymentId]/route';

/**
 * Admin payments list + rescue decisions (audit fix 2026-11-01):
 * pending-first across the FULL list (fix 19), 404 for a missing
 * payment before the bank gate (fix 20), and the crypto rescue
 * decisions approve-crypto / expire-crypto (fix 15).
 */

const authState = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('@/lib/route-auth', () => ({
  authenticateAdminRoute: vi.fn(async () => ({
    session: {
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;
type Filter = { col: string; op: string; val: unknown };

interface FakeState {
  payments: Row[];
  periods: Row[];
  redemptions: Row[];
  // Seller tables (rescue approve records the referral commission):
  // no test buyer is referred, so both stay empty.
  commissions: Row[];
  users: Row[];
  failQuery: 'count' | 'pending' | 'decided' | null;
  updateErrorOnce: boolean;
  expireLosesOnce: boolean;
  selectErrorOnce: boolean;
}

let state: FakeState;

class FakeBuilder {
  private op: 'select' | 'insert' | 'update' = 'select';
  private filters: Filter[] = [];
  private patch: Row | null = null;
  private insertRow: Row | null = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private headCount = false;
  private orderDesc: string | null = null;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;

  constructor(
    private table: string,
    private st: FakeState
  ) {}

  private rows(): Row[] {
    if (this.table === 'subscription_payments') return this.st.payments;
    if (this.table === 'subscription_periods') return this.st.periods;
    if (this.table === 'seller_commissions') return this.st.commissions;
    if (this.table === 'users') return this.st.users;
    return this.st.redemptions;
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.headCount = true;
    return this;
  }

  insert(row: Row): this {
    this.op = 'insert';
    this.insertRow = { ...row };
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push({ col, op: 'is', val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ col, op: 'neq', val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filters.push({ col, op: 'in', val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ col, op: 'lte', val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ col, op: 'gt', val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    if (opts?.ascending === false) this.orderDesc = col;
    return this;
  }

  range(start: number, end: number): this {
    this.rangeStart = start;
    this.rangeEnd = end;
    return this;
  }

  limit(): this {
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const v = row[f.col];
      if (f.op === 'eq') return v === f.val;
      if (f.op === 'is') return f.val === null ? v == null : v === f.val;
      if (f.op === 'neq') return v !== f.val;
      if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v);
      if (f.op === 'lte') return typeof v === 'string' && typeof f.val === 'string' && v <= f.val;
      if (f.op === 'gt') return typeof v === 'string' && typeof f.val === 'string' && v > f.val;
      return true;
    });
  }

  private compute(): { data: unknown; error: unknown; count?: number | null } {
    const rows = this.rows();
    if (this.op === 'update' && this.st.updateErrorOnce) {
      this.st.updateErrorOnce = false;
      return { data: null, error: { code: '500', message: 'boom' } };
    }
    if (
      this.op === 'update' &&
      this.st.expireLosesOnce &&
      this.table === 'subscription_payments' &&
      this.patch?.['status'] === 'expired'
    ) {
      this.st.expireLosesOnce = false;
      return { data: [], error: null };
    }
    if (this.op === 'select' && this.st.selectErrorOnce && this.table === 'coupon_redemptions') {
      this.st.selectErrorOnce = false;
      return { data: null, error: { code: '500', message: 'boom' } };
    }
    if (this.op === 'insert') {
      const row = { ...this.insertRow } as Row;
      if (this.table === 'subscription_periods' && row['id'] == null) {
        row['id'] = `period-${rows.length + 1}`;
      }
      rows.push(row);
      if (this.singleMode) return { data: row, error: null };
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      const matched = rows.filter((r) => this.matches(r));
      for (const r of matched) Object.assign(r, this.patch);
      return { data: matched.map((r) => ({ id: r['id'] })), error: null };
    }
    let matched = rows.filter((r) => this.matches(r));
    if (this.headCount) {
      if (this.st.failQuery === 'count') {
        return { data: [], error: { code: '500', message: 'boom' }, count: null };
      }
      return { data: [], error: null, count: matched.length };
    }
    if (
      this.st.failQuery === 'pending' &&
      this.filters.some((f) => f.col === 'status' && f.op === 'eq' && f.val === 'pending')
    ) {
      return { data: [], error: { code: '500', message: 'boom' } };
    }
    if (
      this.st.failQuery === 'decided' &&
      this.filters.some((f) => f.col === 'status' && f.op === 'neq')
    ) {
      return { data: [], error: { code: '500', message: 'boom' } };
    }
    if (this.orderDesc) {
      matched = [...matched].sort((a, b) =>
        String(b[this.orderDesc as string]).localeCompare(String(a[this.orderDesc as string]))
      );
    }
    if (this.rangeStart !== null && this.rangeEnd !== null) {
      matched = matched.slice(this.rangeStart, this.rangeEnd + 1);
    }
    if (this.singleMode === 'single') {
      return { data: matched[0] ?? null, error: matched.length === 0 ? { code: 'PGRST116' } : null };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }

  then(resolve: (value: { data: unknown; error: unknown; count?: number | null }) => void): void {
    resolve(this.compute());
  }
}

const fakeClient = {
  from(table: string): FakeBuilder {
    return new FakeBuilder(table, state);
  },
};

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => fakeClient,
  };
});

function paymentRow(overrides: Row = {}): Row {
  return {
    id: 'payment-1',
    user_id: 'user-1',
    method: 'bank',
    bank_method: 'easypaisa',
    status: 'pending',
    facebook_count: 1,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 70,
    is_upgrade: false,
    screenshot_storage_key: null,
    nowpayments_payment_id: null,
    nowpayments_pay_address: null,
    nowpayments_pay_amount: null,
    nowpayments_network: null,
    coupon_code: null,
    discount_pkr: 0,
    period_id: null,
    approved_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function cryptoRow(overrides: Row = {}): Row {
  return paymentRow({
    method: 'nowpayments',
    bank_method: null,
    nowpayments_payment_id: 'np-1',
    nowpayments_pay_address: 'TTestAddress',
    nowpayments_pay_amount: 10,
    nowpayments_network: 'trc20',
    ...overrides,
  });
}

const ctx = (paymentId?: string) =>
  ({
    params: Promise.resolve(
      paymentId ? { paymentId } : {}
    ),
  }) as never;

describe('admin payments list', () => {
  beforeEach(() => {
    authState.role = 'admin';
    state = {
      payments: [
        paymentRow({ id: 'decided-1', status: 'approved', created_at: '2026-06-03T00:00:00.000Z' }),
        paymentRow({ id: 'pending-old', status: 'pending', created_at: '2026-06-01T00:00:00.000Z' }),
        paymentRow({ id: 'pending-new', status: 'pending', created_at: '2026-06-02T00:00:00.000Z' }),
      ],
      periods: [],
      redemptions: [],
      commissions: [],
      users: [],
      failQuery: null,
      updateErrorOnce: false,
      expireLosesOnce: false,
      selectErrorOnce: false,
    };
  });

  it('refuses non-admins with 403', async () => {
    authState.role = 'user';
    const req = new NextRequest('http://localhost:3000/api/admin/payments');
    const res = await listPayments(req);
    expect(res.status).toBe(403);
  });

  it('sorts pending-first across the full list, newest first within each run', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/payments');
    const res = await listPayments(req);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { payments: Array<{ id: string }>; pendingTotal: number };
    expect(json.pendingTotal).toBe(2);
    expect(json.payments.map((p) => p.id)).toEqual(['pending-new', 'pending-old', 'decided-1']);
  });

  it('pages past the pending run into decided rows', async () => {
    const payments: Row[] = [];
    for (let i = 0; i < 101; i += 1) {
      payments.push(
        paymentRow({
          id: `pending-${i}`,
          status: 'pending',
          created_at: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
        })
      );
    }
    payments.push(paymentRow({ id: 'decided-1', status: 'approved' }));
    state.payments = payments;
    const req = new NextRequest('http://localhost:3000/api/admin/payments?page=2');
    const res = await listPayments(req);
    const json = (await res.json()) as { payments: Array<{ id: string }>; pendingTotal: number };
    expect(json.pendingTotal).toBe(101);
    // Page 2 holds the last pending row plus the decided row — a
    // pending row is never buried behind decided rows on page 1.
    expect(json.payments[0]?.id).toMatch(/^pending-/);
    expect(json.payments.map((p) => p.id)).toContain('decided-1');
    expect(json.payments).toHaveLength(2);
  });
});

describe('admin payments rescue decisions', () => {
  beforeEach(() => {
    authState.role = 'admin';
    state = {
      payments: [cryptoRow()],
      periods: [],
      redemptions: [],
      commissions: [],
      users: [],
      failQuery: null,
      updateErrorOnce: false,
      expireLosesOnce: false,
      selectErrorOnce: false,
    };
  });

  async function decide(paymentId: string, decision: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = new NextRequest(
      `http://localhost:3000/api/admin/payments/${paymentId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) }
    );
    const res = await decidePayment(req, ctx(paymentId));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('returns 404 for a missing payment before any gate', async () => {
    const { status, json } = await decide('no-such-payment', 'approve');
    expect(status).toBe(404);
    expect(json['error']).toBe('PAYMENT_NOT_FOUND');
  });

  it('approve-crypto starts a period for a stuck crypto payment', async () => {
    const { status, json } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(200);
    expect((json['period'] as Record<string, unknown>)['id']).toBeDefined();
    expect(state.payments[0]).toMatchObject({ status: 'paid' });
    expect(state.periods).toHaveLength(1);
  });

  it('expire-crypto closes a stuck crypto payment', async () => {
    const { status } = await decide('payment-1', 'expire-crypto');
    expect(status).toBe(200);
    expect(state.payments[0]).toMatchObject({ status: 'expired' });
  });

  it('refuses rescue decisions for bank payments', async () => {
    state.payments = [paymentRow()];
    const { status } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(400);
  });

  it('refuses rescue for a crypto payment that already has a period', async () => {
    state.payments = [cryptoRow({ period_id: 'period-1' })];
    const { status } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(400);
  });
});

describe('admin payments list and rescue failure branches', () => {
  beforeEach(() => {
    authState.role = 'admin';
    state = {
      payments: [cryptoRow()],
      periods: [],
      redemptions: [],
      commissions: [],
      users: [],
      failQuery: null,
      updateErrorOnce: false,
      expireLosesOnce: false,
      selectErrorOnce: false,
    };
  });

  it('a failing pending count fails the list with 500', async () => {
    state.failQuery = 'count';
    const req = new NextRequest('http://localhost:3000/api/admin/payments');
    const res = await listPayments(req);
    expect(res.status).toBe(500);
  });

  it('a failing pending slice fails the list with 500', async () => {
    state.failQuery = 'pending';
    const req = new NextRequest('http://localhost:3000/api/admin/payments');
    const res = await listPayments(req);
    expect(res.status).toBe(500);
  });

  it('a failing decided slice fails the list with 500', async () => {
    state.failQuery = 'decided';
    const req = new NextRequest('http://localhost:3000/api/admin/payments');
    const res = await listPayments(req);
    expect(res.status).toBe(500);
  });

  async function decide(paymentId: string, decision: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = new NextRequest(
      `http://localhost:3000/api/admin/payments/${paymentId}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) }
    );
    const res = await decidePayment(req, ctx(paymentId));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('rescue on a missing payment returns 404', async () => {
    state.payments = [];
    const { status, json } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(404);
    expect(json['error']).toBe('PAYMENT_NOT_FOUND');
  });

  it('rescue on an unmappable row returns 404', async () => {
    state.payments = [cryptoRow({ user_id: null })];
    const { status } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(404);
  });

  it('rescue on a decided crypto payment returns 400', async () => {
    state.payments = [cryptoRow({ status: 'approved' })];
    const { status } = await decide('payment-1', 'approve-crypto');
    expect(status).toBe(400);
  });

  it('expire losing the conditional update to a concurrent finish returns 409', async () => {
    state.expireLosesOnce = true;
    const { status, json } = await decide('payment-1', 'expire-crypto');
    expect(status).toBe(409);
    expect(json['error']).toBe('PAYMENT_ALREADY_DECIDED');
  });

  it('an expire update error fails with 500', async () => {
    state.updateErrorOnce = true;
    const { status } = await decide('payment-1', 'expire-crypto');
    expect(status).toBe(500);
  });

  it('a coupon-release failure after expire is logged and the expire still succeeds', async () => {
    state.selectErrorOnce = true;
    const { status } = await decide('payment-1', 'expire-crypto');
    expect(status).toBe(200);
    expect(state.payments[0]).toMatchObject({ status: 'expired' });
  });
});
