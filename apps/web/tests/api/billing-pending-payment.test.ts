import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import { POST as postBank } from '@/app/api/tenant/[subdomain]/billing/payments/route';
import { POST as postCrypto } from '@/app/api/tenant/[subdomain]/billing/payments/crypto/route';

/**
 * One pending payment per user: while any payment with status
 * 'pending' exists for the user, bank AND crypto submissions are
 * refused with 409 and create nothing — no row, no screenshot
 * upload, no crypto deposit. After the pending payment is approved
 * or rejected, submissions work again. A race that slips past the
 * check collides on the one-pending-per-user index (23505) and gets
 * the same 409.
 *
 * Tested against a small thenable fake Supabase client — no real
 * database, storage, or NOWPayments call.
 */

const userId = '11111111-1111-4111-a111-111111111111';

const authRole = vi.hoisted(() => ({ role: 'user' }));
const minimumUsdtValue = vi.hoisted(() => ({ value: 1 }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId,
      email: 'buyer@example.com',
      name: 'Buyer',
      subdomain: 'acme',
      role: authRole.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

interface FakeDb {
  payments: Row[];
  coupons: Row[];
  redemptions: Row[];
  insertViolation: boolean;
  putObjectCalls: number;
  nowPaymentsCalls: number;
  failReleaseOnce: boolean;
}

let db: FakeDb;

const fakeClient = {
  from(table: string) {
    if (table === 'subscription_payments') {
      return new FakeBuilder(
        () => db.payments,
        (row) => {
          db.payments.push(row);
        },
        true
      );
    }
    if (table === 'subscription_periods') {
      // No active period in these tests (fresh-purchase pricing).
      return new FakeBuilder(() => []);
    }
    if (table === 'coupons') {
      return new FakeBuilder(() => db.coupons);
    }
    if (table === 'coupon_redemptions') {
      return new FakeBuilder(
        () => db.redemptions,
        (row) => {
          db.redemptions.push(row);
        }
      );
    }
    throw new Error(`unexpected table ${table}`);
  },
};

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN: number | null = null;
  private insertRow: Row | null = null;
  private updatePatch: Row | null = null;

  constructor(
    private getRows: () => Row[],
    private pushRow?: (row: Row) => void,
    private violationApplies = false
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

  lte(): this {
    return this;
  }

  gt(): this {
    return this;
  }

  order(): this {
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  insert(row: Row): this {
    this.insertRow = { ...row, id: `payment-${db.payments.length + 1}`, created_at: '2026-10-31T00:00:00.000Z' };
    return this;
  }

  update(patch: Row): this {
    this.updatePatch = patch;
    return this;
  }

  private matched(): Row[] {
    let rows = this.getRows().filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  async single(): Promise<{ data: Row | null; error: { code: string } | null }> {
    if (this.insertRow) {
      if (db.insertViolation && this.violationApplies) {
        return { data: null, error: { code: '23505' } };
      }
      this.pushRow?.(this.insertRow);
      const row = this.insertRow;
      this.insertRow = null;
      return { data: row, error: null };
    }
    const row = this.matched()[0] ?? null;
    return { data: row, error: row ? null : { code: 'PGRST116' } };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.matched()[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Row[]; error: { code: string } | null }) => void): void {
    if (this.updatePatch) {
      // A failing coupon release: the flip update errors, so
      // releaseRedemption throws and the route logs it (then still
      // returns its 409/422 — the release failure never blocks the
      // refusal itself).
      const isReleaseFlip =
        this.getRows() === db.redemptions && this.updatePatch['status'] === 'released';
      if (isReleaseFlip && db.failReleaseOnce) {
        db.failReleaseOnce = false;
        resolve({ data: [], error: { code: '500' } });
        return;
      }
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.updatePatch);
      // The real client with .select('id') returns the updated ids;
      // coupon claim/release branches depend on a non-empty result.
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    resolve({ data: this.matched(), error: null });
  }
}

const idempotencyOverride = vi.hoisted(() => ({
  lookup: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => fakeClient,
    lookupBillingIdempotency: (...args: unknown[]) =>
      idempotencyOverride.lookup
        ? idempotencyOverride.lookup(...args)
        : (actual.lookupBillingIdempotency as (...args: unknown[]) => unknown)(...args),
  };
});

vi.mock('@/lib/storage', () => ({
  getStorageService: () => ({
    putObject: vi.fn(async () => {
      db.putObjectCalls += 1;
    }),
  }),
}));

vi.mock('@/lib/billing/nowpayments', () => ({
  getNowPaymentsConfig: () => ({ apiKey: 'test-key' }),
  estimateUsdt: async () => 10,
  minimumUsdt: async () => minimumUsdtValue.value,
  createNowPaymentsPayment: async () => {
    db.nowPaymentsCalls += 1;
    return { paymentId: 'np-1', payAddress: 'TTestAddress', payAmount: 10 };
  },
  NowPaymentsError: class extends Error {},
}));

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function seedPayment(overrides: Row = {}): Row {
  const row: Row = {
    id: `seed-${db.payments.length + 1}`,
    user_id: userId,
    method: 'bank',
    bank_method: 'easypaisa',
    status: 'pending',
    ...ZERO_COUNTS,
    amount_pkr: 70,
    is_upgrade: false,
    screenshot_storage_key: null,
    nowpayments_payment_id: null,
    nowpayments_pay_address: null,
    nowpayments_pay_amount: null,
    nowpayments_network: null,
    period_id: null,
    approved_at: null,
    created_at: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
  db.payments.push(row);
  return row;
}

function bankRequest(): NextRequest {
  const form = new FormData();
  form.append('counts', JSON.stringify({ ...ZERO_COUNTS, facebook: 1 }));
  form.append('bankMethod', 'easypaisa');
  form.append('screenshot', new Blob(['fake-png-bytes'], { type: 'image/png' }), 'proof.png');
  return new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments', {
    method: 'POST',
    body: form,
  });
}

function cryptoRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments/crypto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      counts: { ...ZERO_COUNTS, facebook: 1 },
      network: 'trc20',
      isUpgrade: false,
    }),
  });
}

function couponRow(overrides: Row = {}): Row {
  return {
    id: 'coupon-1',
    code: 'HALF50',
    kind: 'percent_multi',
    percent: 50,
    status: 'active',
    consumed_at: null,
    remaining_balance_pkr: null,
    created_at: '2026-10-31T00:00:00.000Z',
    updated_at: '2026-10-31T00:00:00.000Z',
    ...overrides,
  };
}

function bankRequestWithCoupon(): NextRequest {
  const form = new FormData();
  form.append('counts', JSON.stringify({ ...ZERO_COUNTS, facebook: 1 }));
  form.append('bankMethod', 'easypaisa');
  form.append('couponCode', 'HALF50');
  form.append('screenshot', new Blob(['fake-png-bytes'], { type: 'image/png' }), 'proof.png');
  return new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments', {
    method: 'POST',
    body: form,
  });
}

function cryptoRequestWithCoupon(): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments/crypto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      counts: { ...ZERO_COUNTS, facebook: 1 },
      network: 'trc20',
      isUpgrade: false,
      couponCode: 'HALF50',
    }),
  });
}

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) };

describe('one pending payment per user', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    db = { payments: [], coupons: [couponRow()], redemptions: [], insertViolation: false, putObjectCalls: 0, nowPaymentsCalls: 0, failReleaseOnce: false };
  });

  it('bank submission while a bank payment is pending → 409, no row, no screenshot stored', async () => {
    seedPayment({ status: 'pending' });
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('PENDING_PAYMENT_EXISTS');
    expect(body.message).toContain('waiting for approval');
    expect(db.payments).toHaveLength(1);
    expect(db.putObjectCalls).toBe(0);
  });

  it('crypto submission while a bank payment is pending → 409, no deposit created', async () => {
    seedPayment({ status: 'pending', method: 'bank' });
    const res = await postCrypto(cryptoRequest(), ctx);
    expect(res.status).toBe(409);
    expect(db.payments).toHaveLength(1);
    expect(db.nowPaymentsCalls).toBe(0);
  });

  it('bank submission while a crypto payment is pending → 409', async () => {
    seedPayment({ status: 'pending', method: 'nowpayments', bank_method: null });
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(409);
    expect(db.payments).toHaveLength(1);
  });

  it('after rejection of the pending payment, a new bank submission succeeds', async () => {
    seedPayment({ status: 'rejected' });
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(201);
    expect(db.payments).toHaveLength(2);
    expect(db.payments[1]?.['status']).toBe('pending');
  });

  it('after approval of the pending payment, a new crypto submission succeeds', async () => {
    seedPayment({ status: 'approved' });
    const res = await postCrypto(cryptoRequest(), ctx);
    expect(res.status).toBe(201);
    expect(db.nowPaymentsCalls).toBe(1);
    expect(db.payments).toHaveLength(2);
  });

  it('a race that slips past the check collides on the index (23505) → same 409, no second row', async () => {
    db.insertViolation = true;
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('PENDING_PAYMENT_EXISTS');
    expect(db.payments).toHaveLength(0);
  });

  it('Binance submissions use the same manual path and are blocked while pending', async () => {
    seedPayment({ status: 'pending', method: 'bank', bank_method: 'binance' });
    const form = new FormData();
    form.append('counts', JSON.stringify({ ...ZERO_COUNTS, facebook: 1 }));
    form.append('bankMethod', 'binance');
    form.append('screenshot', new Blob(['fake-png-bytes'], { type: 'image/png' }), 'proof.png');
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments', {
      method: 'POST',
      body: form,
    });
    const res = await postBank(req, ctx);
    expect(res.status).toBe(409);
    expect(db.payments).toHaveLength(1);
  });
});

describe('billing submission idempotency (audit fix 2026-11-01, fix 9)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    db = { payments: [], coupons: [couponRow()], redemptions: [], insertViolation: false, putObjectCalls: 0, nowPaymentsCalls: 0, failReleaseOnce: false };
    idempotencyOverride.lookup = null;
  });

  it('an invalid Idempotency-Key is rejected with 400 before any payment is created', async () => {
    idempotencyOverride.lookup = () => ({ invalid: true });
    const req = bankRequest();
    req.headers.set('Idempotency-Key', 'not-a-uuid');
    const res = await postBank(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('INVALID_REQUEST');
    expect(db.payments).toHaveLength(0);
    expect(db.putObjectCalls).toBe(0);
  });

  it('a replayed key returns the stored response and creates no second payment', async () => {
    idempotencyOverride.lookup = () => ({
      key: '11111111-1111-4111-a111-111111111111',
      replay: { status: 201, body: { id: 'payment-replayed' } },
    });
    const req = bankRequest();
    req.headers.set('Idempotency-Key', '11111111-1111-4111-a111-111111111111');
    const res = await postBank(req, ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    const body = await res.json();
    expect(body.id).toBe('payment-replayed');
    expect(db.payments).toHaveLength(0);
  });
});

describe('billing submissions with coupons, admin rejection, and crypto idempotency', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    db = {
      payments: [],
      coupons: [couponRow()],
      redemptions: [],
      insertViolation: false,
      putObjectCalls: 0,
      nowPaymentsCalls: 0,
      failReleaseOnce: false,
    };
    idempotencyOverride.lookup = null;
    authRole.role = 'user';
    minimumUsdtValue.value = 1;
  });

  it('bank admin submission is refused with 403', async () => {
    authRole.role = 'admin';
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(403);
    expect(db.payments).toHaveLength(0);
  });

  it('crypto admin submission is refused with 403', async () => {
    authRole.role = 'admin';
    const res = await postCrypto(cryptoRequest(), ctx);
    expect(res.status).toBe(403);
    expect(db.payments).toHaveLength(0);
  });

  it('a failing idempotency store returns 500 without creating a payment', async () => {
    idempotencyOverride.lookup = () => {
      throw new Error('store down');
    };
    const res = await postBank(bankRequest(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('IDEMPOTENCY_STORE_UNAVAILABLE');
    expect(db.payments).toHaveLength(0);
  });

  it('crypto invalid Idempotency-Key is rejected with 400', async () => {
    idempotencyOverride.lookup = () => ({ invalid: true });
    const req = cryptoRequest();
    req.headers.set('Idempotency-Key', 'not-a-uuid');
    const res = await postCrypto(req, ctx);
    expect(res.status).toBe(400);
    expect(db.payments).toHaveLength(0);
    expect(db.nowPaymentsCalls).toBe(0);
  });

  it('crypto replay returns the stored checkout and creates no deposit', async () => {
    idempotencyOverride.lookup = () => ({
      key: '11111111-1111-4111-a111-111111111111',
      replay: { status: 201, body: { id: 'payment-replayed' } },
    });
    const req = cryptoRequest();
    req.headers.set('Idempotency-Key', '11111111-1111-4111-a111-111111111111');
    const res = await postCrypto(req, ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(db.payments).toHaveLength(0);
    expect(db.nowPaymentsCalls).toBe(0);
  });

  it('bank with a coupon charges and records the settled discount and links the redemption', async () => {
    const res = await postBank(bankRequestWithCoupon(), ctx);
    expect(res.status).toBe(201);
    expect(db.payments).toHaveLength(1);
    expect(db.payments[0]).toMatchObject({ amount_pkr: 35, discount_pkr: 35 });
    expect(db.redemptions).toHaveLength(1);
    expect(db.redemptions[0]).toMatchObject({
      status: 'held',
      payment_id: db.payments[0]['id'],
    });
  });

  it('bank race with a held coupon releases the hold before the 409', async () => {
    db.insertViolation = true;
    const res = await postBank(bankRequestWithCoupon(), ctx);
    expect(res.status).toBe(409);
    expect(db.payments).toHaveLength(0);
    expect(db.redemptions).toHaveLength(1);
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });

  it('crypto below-minimum releases the held coupon and creates no deposit', async () => {
    minimumUsdtValue.value = 20;
    const res = await postCrypto(cryptoRequestWithCoupon(), ctx);
    expect(res.status).toBe(422);
    expect(db.nowPaymentsCalls).toBe(0);
    expect(db.payments).toHaveLength(0);
    expect(db.redemptions).toHaveLength(1);
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });

  it('crypto race with a held coupon releases the hold before the 409', async () => {
    db.insertViolation = true;
    const res = await postCrypto(cryptoRequestWithCoupon(), ctx);
    expect(res.status).toBe(409);
    expect(db.nowPaymentsCalls).toBe(0);
    expect(db.payments).toHaveLength(0);
    expect(db.redemptions).toHaveLength(1);
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });
});

describe('billing submission release-failure logging', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    db = {
      payments: [],
      coupons: [couponRow()],
      redemptions: [],
      insertViolation: false,
      putObjectCalls: 0,
      nowPaymentsCalls: 0,
      failReleaseOnce: false,
    };
    idempotencyOverride.lookup = null;
    authRole.role = 'user';
    minimumUsdtValue.value = 1;
  });

  it('crypto idempotency store failure returns 500 without a deposit', async () => {
    idempotencyOverride.lookup = () => {
      throw new Error('store down');
    };
    const res = await postCrypto(cryptoRequest(), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('IDEMPOTENCY_STORE_UNAVAILABLE');
    expect(db.nowPaymentsCalls).toBe(0);
  });

  it('bank race still 409s when the coupon release itself fails', async () => {
    db.insertViolation = true;
    db.failReleaseOnce = true;
    const res = await postBank(bankRequestWithCoupon(), ctx);
    expect(res.status).toBe(409);
    expect(db.payments).toHaveLength(0);
    // The release failed, so the hold stays held — but the refusal
    // itself still lands; the failure is logged, not swallowed.
    expect(db.redemptions[0]).toMatchObject({ status: 'held' });
  });

  it('crypto below-minimum still 422s when the coupon release itself fails', async () => {
    minimumUsdtValue.value = 20;
    db.failReleaseOnce = true;
    const res = await postCrypto(cryptoRequestWithCoupon(), ctx);
    expect(res.status).toBe(422);
    expect(db.nowPaymentsCalls).toBe(0);
    expect(db.redemptions[0]).toMatchObject({ status: 'held' });
  });

  it('crypto race still 409s when the coupon release itself fails', async () => {
    db.insertViolation = true;
    db.failReleaseOnce = true;
    const res = await postCrypto(cryptoRequestWithCoupon(), ctx);
    expect(res.status).toBe(409);
    expect(db.nowPaymentsCalls).toBe(0);
    expect(db.redemptions[0]).toMatchObject({ status: 'held' });
  });
});
