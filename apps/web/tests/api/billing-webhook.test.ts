import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { sortObjectForNowPaymentsSignature } from '@fbuploadpro/contracts';
import { POST as postWebhook } from '@/app/api/billing/nowpayments/webhook/route';

/**
 * NOWPayments webhook route (audit fix 2026-11-01): signature auth,
 * method/currency/amount verification, finished-from-failed/expired
 * activation, unknown-payment dedupe release, underpaid hold, and
 * refunded revocation — all against a small in-memory fake client,
 * so the route's real entitlement/coupon/issue helpers run.
 */

const IPN_SECRET = 'test-ipn-secret';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

vi.mock('@/lib/billing/nowpayments', () => ({
  getNowPaymentsConfig: () => ({ apiKey: 'test-key', ipnSecret: IPN_SECRET }),
}));

type Row = Record<string, unknown>;

interface FakeState {
  payments: Row[];
  periods: Row[];
  events: Row[];
  issues: Row[];
  redemptions: Row[];
  coupons: Row[];
}

let state: FakeState;

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    payments: [],
    periods: [],
    events: [],
    issues: [],
    redemptions: [],
    coupons: [],
    ...overrides,
  };
}

type Filter = { col: string; op: string; val: unknown };

class FakeBuilder {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: Filter[] = [];
  private patch: Row | null = null;
  private insertRow: Row | null = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private limitN: number | null = null;

  constructor(
    private table: string,
    private st: FakeState
  ) {}

  private rows(): Row[] {
    switch (this.table) {
      case 'subscription_payments':
        return this.st.payments;
      case 'subscription_periods':
        return this.st.periods;
      case 'subscription_webhook_events':
        return this.st.events;
      case 'subscription_webhook_issues':
        return this.st.issues;
      case 'coupon_redemptions':
        return this.st.redemptions;
      case 'coupons':
        return this.st.coupons;
      default:
        throw new Error(`unexpected table ${this.table}`);
    }
  }

  select(): this {
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

  delete(): this {
    this.op = 'delete';
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

  lte(col: string, val: unknown): this {
    this.filters.push({ col, op: 'lte', val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ col, op: 'gt', val });
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

  order(): this {
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
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
      if (f.op === 'lte') return typeof v === 'string' && typeof f.val === 'string' && v <= f.val;
      if (f.op === 'gt') return typeof v === 'string' && typeof f.val === 'string' && v > f.val;
      if (f.op === 'neq') return v !== f.val;
      if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v);
      return true;
    });
  }

  private compute(): { data: unknown; error: unknown } {
    const rows = this.rows();
    if (this.op === 'insert') {
      const row = { ...this.insertRow } as Row;
      if (this.table === 'subscription_webhook_events') {
        if (rows.some((r) => r['provider'] === row['provider'] && r['event_key'] === row['event_key'])) {
          return { data: null, error: { code: '23505' } };
        }
      }
      if (this.table === 'subscription_webhook_issues') {
        if (
          rows.some(
            (r) =>
              r['provider'] === 'nowpayments' &&
              r['provider_payment_id'] === row['provider_payment_id'] &&
              r['reason'] === row['reason'] &&
              r['dismissed_at'] == null
          )
        ) {
          return { data: null, error: { code: '23505' } };
        }
      }
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
      const data = matched.map((r) => ({ id: r['id'] }));
      return { data, error: null };
    }
    if (this.op === 'delete') {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (this.matches(rows[i] as Row)) rows.splice(i, 1);
      }
      return { data: [], error: null };
    }
    let matched = rows.filter((r) => this.matches(r));
    if (this.limitN !== null) matched = matched.slice(0, this.limitN);
    if (this.singleMode === 'single') {
      return { data: matched[0] ?? null, error: matched.length === 0 ? { code: 'PGRST116' } : null };
    }
    if (this.singleMode === 'maybeSingle') {
      return { data: matched[0] ?? null, error: null };
    }
    return { data: matched, error: null };
  }

  then(
    resolve: (value: { data: unknown; error: unknown }) => void,
    reject?: (err: unknown) => void
  ): void {
    try {
      resolve(this.compute());
    } catch (err) {
      if (reject) reject(err);
      else throw err;
    }
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

const PAYMENT_ID = '11111111-1111-4111-a111-111111111111';
const USER_ID = '22222222-2222-4222-a222-222222222222';

function paymentRow(overrides: Row = {}): Row {
  return {
    id: PAYMENT_ID,
    user_id: USER_ID,
    method: 'nowpayments',
    bank_method: null,
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
    nowpayments_payment_id: 'np-1',
    nowpayments_pay_address: 'TTestAddress',
    nowpayments_pay_amount: 10,
    nowpayments_network: 'trc20',
    coupon_code: null,
    discount_pkr: 0,
    period_id: null,
    approved_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function sign(payload: Record<string, unknown>): string {
  const sorted = JSON.stringify(sortObjectForNowPaymentsSignature(payload));
  return createHmac('sha512', IPN_SECRET).update(sorted).digest('hex');
}

async function callWebhook(
  payload: Record<string, unknown>,
  signature?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sig = signature ?? sign(payload);
  const req = new NextRequest('http://localhost:3000/api/billing/nowpayments/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
    body: JSON.stringify(payload),
  });
  const res = await postWebhook(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function finishedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payment_id: 'np-1',
    payment_status: 'finished',
    pay_amount: 10,
    actually_paid: 10,
    pay_currency: 'usdttrc20',
    order_id: PAYMENT_ID,
    ...overrides,
  };
}

describe('NOWPayments webhook route', () => {
  beforeEach(() => {
    state = baseState({ payments: [paymentRow()] });
  });

  it('rejects an invalid signature with 401 and activates nothing', async () => {
    const { status } = await callWebhook(finishedPayload(), 'deadbeef');
    expect(status).toBe(401);
    expect(state.periods).toHaveLength(0);
    expect(state.payments[0]?.['status']).toBe('pending');
  });

  it('activates a finished payment, links the period, and persists actuals', async () => {
    const { status, json } = await callWebhook(finishedPayload());
    expect(status).toBe(200);
    expect(json).toMatchObject({ received: true, activated: true });
    expect(state.periods).toHaveLength(1);
    expect(state.payments[0]).toMatchObject({
      status: 'paid',
      period_id: state.periods[0]?.['id'],
    });
    expect(state.payments[0]).toMatchObject({
      nowpayments_actual_paid: 10,
      nowpayments_actual_currency: 'usdttrc20',
    });
  });

  it('treats a repeated finished notification as a duplicate, with one period', async () => {
    await callWebhook(finishedPayload());
    const { json } = await callWebhook(finishedPayload());
    expect(json).toMatchObject({ received: true, duplicate: true });
    expect(state.periods).toHaveLength(1);
  });

  it('records unknown payments as issues and releases the dedupe row', async () => {
    state = baseState({ payments: [] });
    const payload = finishedPayload({ order_id: 'no-such-payment', payment_id: 'np-unknown' });
    const first = await callWebhook(payload);
    expect(first.json).toMatchObject({ received: true, unknownPayment: true });
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ reason: 'unknown_payment' });
    expect(state.events).toHaveLength(0);
    // A later real notification for the same key is NOT swallowed.
    const second = await callWebhook(payload);
    expect(second.json).toMatchObject({ received: true, unknownPayment: true });
    expect(second.json).not.toMatchObject({ duplicate: true });
  });

  it('rejects a currency mismatch, records an issue, and lets a corrected re-send activate', async () => {
    const wrong = await callWebhook(finishedPayload({ pay_currency: 'usdtbsc' }));
    expect(wrong.json).toMatchObject({ received: true, verificationFailed: true });
    expect(wrong.json['reason']).toBe('currency_mismatch');
    expect(state.payments[0]?.['status']).toBe('pending');
    expect(state.periods).toHaveLength(0);
    expect(state.issues).toHaveLength(1);
    const right = await callWebhook(finishedPayload());
    expect(right.json).toMatchObject({ received: true, activated: true });
    expect(state.periods).toHaveLength(1);
  });

  it('rejects an underpayment without activating', async () => {
    const { json } = await callWebhook(finishedPayload({ actually_paid: 5 }));
    expect(json).toMatchObject({ received: true, verificationFailed: true });
    expect(json['reason']).toBe('underpaid');
    expect(state.periods).toHaveLength(0);
  });

  it('marks failed, then still activates on a later finished event, flagging the released coupon', async () => {
    state = baseState({
      payments: [paymentRow()],
      redemptions: [
        {
          id: 'red-1',
          coupon_id: 'coup-1',
          coupon_kind: 'percent_once',
          user_id: USER_ID,
          payment_id: PAYMENT_ID,
          period_id: null,
          amount_pkr: 70,
          status: 'held',
          balance_restored: false,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    const failed = await callWebhook(finishedPayload({ payment_status: 'failed' }));
    expect(failed.json).toMatchObject({ received: true, updated: true });
    expect(state.payments[0]?.['status']).toBe('failed');
    expect(state.redemptions[0]?.['status']).toBe('released');
    const finished = await callWebhook(finishedPayload());
    expect(finished.json).toMatchObject({ received: true, activated: true });
    expect(state.periods).toHaveLength(1);
    expect(state.issues.some((i) => i['reason'] === 'coupon_released_before_finish')).toBe(true);
  });

  it('leaves an already-paid payment untouched on a late failure', async () => {
    await callWebhook(finishedPayload());
    const late = await callWebhook(finishedPayload({ payment_status: 'failed' }));
    // The period link short-circuits before the failure branch: a
    // paid payment is never re-decided by a late event.
    expect(late.json).toMatchObject({ received: true, alreadyActivated: true });
    expect(state.payments[0]?.['status']).toBe('paid');
    expect(state.periods).toHaveLength(1);
  });

  it('answers alreadyDecided when a failed payment gets a second failure', async () => {
    await callWebhook(finishedPayload({ payment_status: 'failed' }));
    const again = await callWebhook(finishedPayload({ payment_status: 'expired' }));
    expect(again.json).toMatchObject({ received: true, alreadyDecided: true });
    expect(state.payments[0]?.['status']).toBe('failed');
  });

  it('holds a partially_paid payment for admin decision without activating', async () => {
    const { json } = await callWebhook(finishedPayload({ payment_status: 'partially_paid' }));
    expect(json).toMatchObject({ received: true, heldForAdmin: true });
    expect(state.payments[0]?.['status']).toBe('pending');
    expect(state.periods).toHaveLength(0);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ reason: 'underpaid' });
  });

  it('never activates a rejected payment, even when finished arrives', async () => {
    state = baseState({ payments: [paymentRow({ status: 'rejected' })] });
    const { json } = await callWebhook(finishedPayload());
    expect(json).toMatchObject({ received: true, rejected: true });
    expect(state.periods).toHaveLength(0);
  });

  it('revokes the period on a refunded notification for an activated payment', async () => {
    await callWebhook(finishedPayload());
    const periodId = state.periods[0]?.['id'];
    const { json } = await callWebhook(finishedPayload({ payment_status: 'refunded' }));
    expect(json).toMatchObject({ received: true, refunded: true });
    expect(state.periods[0]?.['superseded_at']).not.toBeNull();
    expect(state.issues.some((i) => i['reason'] === 'refunded')).toBe(true);
    expect(periodId).toBeDefined();
  });

  it('ignores waiting notifications without changing anything', async () => {
    const { json } = await callWebhook(finishedPayload({ payment_status: 'waiting' }));
    expect(json).toMatchObject({ received: true, ignored: true });
    expect(state.payments[0]?.['status']).toBe('pending');
  });
});
