import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  approveRefund,
  getRefundEligibility,
  listUserRefunds,
  markRefundSent,
  rejectRefund,
  requestRefund,
} from '@/lib/billing/refunds';
import {
  getActivePeriod as entitlementActivePeriod,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';

/**
 * Refund rules, tested against a small thenable fake Supabase client
 * that applies the filters my lib actually uses (eq/is/lte/gt/in,
 * order, limit, range) to in-memory tables, and applies updates and
 * inserts to those tables so a second call sees the first call's
 * effect — which is exactly what the drop-to-Free and re-request
 * rules need.
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'is' | 'lte' | 'gt' | 'in'; col: string; val: unknown };

const DAY = 86_400_000;
const START = new Date('2026-10-01T00:00:00.000Z');
const NOW = new Date(START.getTime() + 3 * DAY);

function periodRow(overrides: Row = {}): Row {
  return {
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 2,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: START.toISOString(),
    ends_at: new Date(START.getTime() + 30 * DAY).toISOString(),
    superseded_at: null,
    ...overrides,
  };
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: 'payment-1',
    user_id: 'user-1',
    method: 'bank',
    bank_method: 'easypaisa',
    status: 'approved',
    facebook_count: 2,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 4200,
    is_upgrade: false,
    screenshot_storage_key: 'billing-screenshots/user-1/shot.jpg',
    nowpayments_payment_id: null,
    nowpayments_pay_address: null,
    nowpayments_pay_amount: null,
    nowpayments_network: null,
    period_id: 'period-1',
    approved_at: START.toISOString(),
    created_at: START.toISOString(),
    ...overrides,
  };
}

function refundRow(overrides: Row = {}): Row {
  return {
    id: 'refund-1',
    user_id: 'user-1',
    payment_id: 'payment-1',
    period_id: 'period-1',
    status: 'requested',
    amount_paid: 4200,
    currency: 'PKR',
    refund_amount: null,
    days_used: null,
    destination_type: 'mobile',
    destination_value: '03001234567',
    destination_network: null,
    reason: null,
    requested_at: NOW.toISOString(),
    decided_at: null,
    decided_by: null,
    sent_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

interface FakeState {
  periods: Row[];
  payments: Row[];
  requests: Row[];
  users: Row[];
  insertError: { code?: string } | null;
  selectErrors: Partial<Record<string, unknown>>;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    periods: [periodRow()],
    payments: [paymentRow()],
    requests: [],
    users: [{ id: 'user-1', email: 'user@example.com' }],
    insertError: null,
    selectErrors: {},
    ...overrides,
  };
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.op === 'eq') return value === filter.val;
    if (filter.op === 'is') return value === filter.val;
    if (filter.op === 'lte') return typeof value === 'string' && typeof filter.val === 'string' && value <= filter.val;
    if (filter.op === 'gt') return typeof value === 'string' && typeof filter.val === 'string' && value > filter.val;
    return Array.isArray(filter.val) && filter.val.includes(value);
  });
}

class FakeBuilder {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private op: 'select' | 'insert' | 'update' = 'select';
  private insertRow: Row | null = null;
  private updatePatch: Row | null = null;

  constructor(
    private state: FakeState,
    private table: string
  ) {}

  select(_cols?: string): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push({ op: 'is', col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: 'lte', col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ op: 'gt', col, val });
    return this;
  }

  in(col: string, val: unknown): this {
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
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

  insert(row: Row): this {
    this.op = 'insert';
    this.insertRow = row;
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.updatePatch = patch;
    return this;
  }

  private tableRows(): Row[] {
    if (this.table === 'subscription_periods') return this.state.periods;
    if (this.table === 'subscription_payments') return this.state.payments;
    if (this.table === 'refund_requests') return this.state.requests;
    if (this.table === 'users') return this.state.users;
    return [];
  }

  private runSelect(): { data: unknown; error: unknown } {
    const err = this.state.selectErrors[this.table];
    if (err) return { data: null, error: err };
    let rows = this.tableRows().filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (typeof av === 'string' && typeof bv === 'string') {
          return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        return 0;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitN !== null) {
      rows = rows.slice(0, this.limitN);
    }
    return { data: rows, error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const { data, error } = this.runSelect();
    if (error) return { data: null, error };
    const rows = data as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    if (this.op === 'insert') {
      if (this.state.insertError) return { data: null, error: this.state.insertError };
      const row = { id: 'refund-new', ...this.insertRow };
      this.state.requests.push(row);
      return { data: row, error: null };
    }
    const { data, error } = this.runSelect();
    if (error) return { data: null, error };
    const rows = data as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    let result: { data: unknown; error: unknown };
    if (this.op === 'update') {
      const rows = this.tableRows().filter((row) => matches(row, this.filters));
      for (const row of rows) Object.assign(row, this.updatePatch);
      result = { data: rows, error: null };
    } else {
      result = this.runSelect();
    }
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

function fakeClient(state: FakeState): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(state, table),
  } as unknown as SupabaseClient;
}

describe('refund eligibility', () => {
  it('approves the first purchase inside the window, with a day-3 estimate', async () => {
    const client = fakeClient(baseState());
    const eligibility = await getRefundEligibility(client, 'user-1', NOW);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.paymentId).toBe('payment-1');
    expect(eligibility.daysUsed).toBe(3);
    // 4200 - 3 * 140 = 3780.
    expect(eligibility.estimatedRefund).toBe(3780);
    expect(eligibility.destinationType).toBe('mobile');
    expect(eligibility.currency).toBe('PKR');
  });

  it('keeps the window open at exactly day 7 and closes it after', async () => {
    const client = fakeClient(baseState());
    const atDay7 = await getRefundEligibility(
      client,
      'user-1',
      new Date(START.getTime() + 7 * DAY)
    );
    expect(atDay7.eligible).toBe(true);
    const afterDay7 = await getRefundEligibility(
      client,
      'user-1',
      new Date(START.getTime() + 7 * DAY + 1)
    );
    expect(afterDay7.eligible).toBe(false);
    expect(afterDay7.reason).toMatch(/7-day refund window/);
    const atDay8 = await getRefundEligibility(client, 'user-1', new Date(START.getTime() + 8 * DAY));
    expect(atDay8.eligible).toBe(false);
  });

  it('refuses an upgrade, even as the only purchase', async () => {
    const state = baseState({ payments: [paymentRow({ is_upgrade: true })] });
    const eligibility = await getRefundEligibility(fakeClient(state), 'user-1', NOW);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toMatch(/Upgrades cannot be refunded/);
  });

  it('refuses a second purchase: the active period is not the earliest', async () => {
    const first = periodRow({
      id: 'period-old',
      starts_at: new Date(START.getTime() - 40 * DAY).toISOString(),
      ends_at: new Date(START.getTime() - 10 * DAY).toISOString(),
    });
    const second = periodRow({ id: 'period-1', starts_at: START.toISOString() });
    const state = baseState({
      periods: [first, second],
      payments: [
        paymentRow({ id: 'payment-old', period_id: 'period-old' }),
        paymentRow({ id: 'payment-1', period_id: 'period-1' }),
      ],
    });
    // Active period is period-1 (the only one inside its 30 days at NOW).
    const eligibility = await getRefundEligibility(fakeClient(state), 'user-1', NOW);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toMatch(/first purchase/);
  });

  it('refuses when no active plan exists', async () => {
    const state = baseState({
      periods: [periodRow({ superseded_at: START.toISOString() })],
    });
    const eligibility = await getRefundEligibility(fakeClient(state), 'user-1', NOW);
    expect(eligibility.eligible).toBe(false);
  });

  it('blocks a second request while one is pending, and blocks after approval', async () => {
    const pending = baseState({ requests: [refundRow({ status: 'requested' })] });
    const pendingEligibility = await getRefundEligibility(fakeClient(pending), 'user-1', NOW);
    expect(pendingEligibility.eligible).toBe(false);
    expect(pendingEligibility.reason).toMatch(/already waiting/);

    const approved = baseState({ requests: [refundRow({ status: 'approved', refund_amount: 3780 })] });
    const approvedEligibility = await getRefundEligibility(fakeClient(approved), 'user-1', NOW);
    expect(approvedEligibility.eligible).toBe(false);
    expect(approvedEligibility.reason).toMatch(/already been refunded/);
  });

  it('allows a fresh request after a rejection, while the window is open', async () => {
    const state = baseState({ requests: [refundRow({ status: 'rejected' })] });
    const eligibility = await getRefundEligibility(fakeClient(state), 'user-1', NOW);
    expect(eligibility.eligible).toBe(true);
  });

  it('refunds crypto in USDT from the recorded pay amount', async () => {
    const cryptoPayment = paymentRow({
      method: 'nowpayments',
      bank_method: null,
      status: 'paid',
      nowpayments_pay_amount: 100,
      nowpayments_network: 'trc20',
    });
    const state = baseState({ payments: [cryptoPayment] });
    const eligibility = await getRefundEligibility(fakeClient(state), 'user-1', NOW);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.currency).toBe('USDT');
    expect(eligibility.destinationType).toBe('usdt');
    // 100 - 3 * (100/30) = 90 -> 90.00.
    expect(eligibility.estimatedRefund).toBe(90);
  });

  it('fails loud for a crypto payment with no recorded USDT amount', async () => {
    const cryptoPayment = paymentRow({
      method: 'nowpayments',
      bank_method: null,
      status: 'paid',
      nowpayments_pay_amount: null,
    });
    const state = baseState({ payments: [cryptoPayment] });
    await expect(getRefundEligibility(fakeClient(state), 'user-1', NOW)).rejects.toBeInstanceOf(
      SubscriptionGateError
    );
  });
});

describe('refund request lifecycle', () => {
  it('stores the destination verbatim without auto-verifying it', async () => {
    const client = fakeClient(baseState());
    const refund = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03009998888', network: null },
        reason: 'Changed my mind',
      },
      NOW
    );
    expect(refund.status).toBe('requested');
    expect(refund.destinationValue).toBe('03009998888');
    expect(refund.reason).toBe('Changed my mind');
    expect(refund.refundAmount).toBeNull();
  });

  it('refuses a destination type that does not match the payment method', async () => {
    const client = fakeClient(baseState());
    await expect(
      requestRefund(
        client,
        'user-1',
        {
          paymentId: 'payment-1',
          destination: { type: 'bank', value: 'PK00BANK0001', network: null },
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'REFUND_NOT_ELIGIBLE' });
  });

  it('maps a duplicate-insert race to a conflict, not a duplicate row', async () => {
    const state = baseState({ insertError: { code: '23505' } });
    await expect(
      requestRefund(
        fakeClient(state),
        'user-1',
        {
          paymentId: 'payment-1',
          destination: { type: 'mobile', value: '03001234567', network: null },
        },
        NOW
      )
    ).rejects.toMatchObject({ code: 'REFUND_CONFLICT' });
  });

  it('keeps the plan active while a request is pending', async () => {
    const state = baseState();
    const client = fakeClient(state);
    await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    const period = await entitlementActivePeriod(client, 'user-1', NOW);
    expect(period).not.toBeNull();
    expect(period?.id).toBe('period-1');
  });

  it('drops the plan to Free on approval and locks the day-3 amount', async () => {
    const state = baseState();
    const client = fakeClient(state);
    const created = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    const approved = await approveRefund(client, created.id, 'admin-1', NOW);
    expect(approved.status).toBe('approved');
    expect(approved.daysUsed).toBe(3);
    expect(approved.refundAmount).toBe(3780);
    // Approval is not a send: sent stays null and status stays approved.
    expect(approved.sentAt).toBeNull();
    // The period is cancelled, so the plan reads as Free afterwards.
    const period = await entitlementActivePeriod(client, 'user-1', NOW);
    expect(period).toBeNull();
    const eligibility = await getRefundEligibility(client, 'user-1', NOW);
    expect(eligibility.eligible).toBe(false);
  });

  it('refunds in full on day-0 approval and zero at the 30-day cap', async () => {
    const day0 = baseState();
    const client0 = fakeClient(day0);
    const created0 = await requestRefund(
      client0,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      START
    );
    const approved0 = await approveRefund(client0, created0.id, 'admin-1', START);
    expect(approved0.refundAmount).toBe(4200);

    const late = baseState();
    const clientLate = fakeClient(late);
    const createdLate = await requestRefund(
      clientLate,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    const approvedLate = await approveRefund(
      clientLate,
      createdLate.id,
      'admin-1',
      new Date(START.getTime() + 45 * DAY)
    );
    expect(approvedLate.daysUsed).toBe(30);
    expect(approvedLate.refundAmount).toBe(0);
  });

  it('rejects, then allows a re-request inside the window', async () => {
    const state = baseState();
    const client = fakeClient(state);
    const created = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    const rejected = await rejectRefund(client, created.id, 'admin-1', NOW);
    expect(rejected.status).toBe('rejected');
    const again = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    expect(again.status).toBe('requested');
    expect(state.requests.filter((row) => row.status === 'requested')).toHaveLength(1);
  });

  it('runs approve then mark-as-sent, and refuses out-of-order transitions', async () => {
    const state = baseState();
    const client = fakeClient(state);
    const created = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    await expect(markRefundSent(client, created.id, NOW)).rejects.toMatchObject({
      code: 'REFUND_ALREADY_DECIDED',
    });
    const approved = await approveRefund(client, created.id, 'admin-1', NOW);
    await expect(approveRefund(client, created.id, 'admin-1', NOW)).rejects.toMatchObject({
      code: 'REFUND_ALREADY_DECIDED',
    });
    const sent = await markRefundSent(client, approved.id, NOW);
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBe(NOW.toISOString());
    const requests = await listUserRefunds(client, 'user-1');
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('sent');
  });

  it('keeps the plan running after a rejection', async () => {
    const state = baseState();
    const client = fakeClient(state);
    const created = await requestRefund(
      client,
      'user-1',
      {
        paymentId: 'payment-1',
        destination: { type: 'mobile', value: '03001234567', network: null },
      },
      NOW
    );
    await rejectRefund(client, created.id, 'admin-1', NOW);
    const period = await entitlementActivePeriod(client, 'user-1', NOW);
    expect(period).not.toBeNull();
  });
});
