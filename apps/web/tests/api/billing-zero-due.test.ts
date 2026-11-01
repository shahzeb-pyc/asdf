import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as postZeroDue } from '@/app/api/tenant/[subdomain]/billing/payments/zero-due/route';

/**
 * Zero-due coupon checkout (audit fix 2026-11-01): the route that
 * used to bypass the one-pending guard entirely, grant a period on
 * a settled discount that no longer covered the amount, and leave
 * a live period behind when activation failed part-way. Covered:
 * the 409, the settled-discount refusal with the new amount, the
 * orphan-period supersede on a failed apply, admin rejection, and
 * idempotency replay / invalid keys.
 */

const userId = '11111111-1111-4111-a111-111111111111';

const authState = vi.hoisted(() => ({ role: 'user' }));
const idempotencyOverride = vi.hoisted(() => ({
  lookup: null as null | ((...args: unknown[]) => unknown),
}));
const storeCalls: unknown[][] = [];

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId,
      email: 'buyer@example.com',
      name: 'Buyer',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const workspaceMock = vi.hoisted(() => ({
  rejectOnce: false,
}));

vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: vi.fn(async () => {
    if (workspaceMock.rejectOnce) {
      workspaceMock.rejectOnce = false;
      throw new Error('workspace lookup down');
    }
    return 'ws-1';
  }),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => fakeClient,
    lookupBillingIdempotency: (...args: unknown[]) =>
      idempotencyOverride.lookup
        ? idempotencyOverride.lookup(...args)
        : { key: null, replay: null },
    storeBillingIdempotency: (...args: unknown[]) => {
      storeCalls.push(args);
      return Promise.resolve();
    },
  };
});

type Row = Record<string, unknown>;

interface FakeDb {
  payments: Row[];
  periods: Row[];
  coupons: Row[];
  redemptions: Row[];
  settleSmaller: boolean;
  applyFailsOnce: boolean;
  failReleaseOnce: boolean;
  failSupersedeOnce: boolean;
}

let db: FakeDb;

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private filterCols: string[] = [];
  private patch: Row | null = null;
  private op: 'select' | 'insert' | 'update' = 'select';
  private insertRow: Row | null = null;
  private limitN: number | null = null;
  private singleMode = false;
  private maybeMode = false;

  constructor(private table: string) {}

  private rows(): Row[] {
    if (this.table === 'subscription_payments') return db.payments;
    if (this.table === 'subscription_periods') return db.periods;
    if (this.table === 'coupons') return db.coupons;
    return db.redemptions;
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

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    this.filterCols.push(col);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push(
      (r) => typeof r[col] === 'string' && typeof val === 'string' && r[col] <= val
    );
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push(
      (r) => typeof r[col] === 'string' && typeof val === 'string' && r[col] > val
    );
    return this;
  }

  gte(col: string, val: unknown): this {
    this.filters.push(
      (r) =>
        typeof r[col] === 'number' && typeof val === 'number' && (r[col] as number) >= (val as number)
    );
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
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
    this.singleMode = true;
    return this;
  }

  maybeSingle(): this {
    this.maybeMode = true;
    return this;
  }

  private matched(): Row[] {
    let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  then(resolve: (value: { data: unknown; error: unknown }) => void): void {
    if (this.op === 'insert' && this.insertRow) {
      const row: Row = {
        ...this.insertRow,
        id: `${this.table}-${this.rows().length + 1}`,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      };
      if (this.table === 'coupon_redemptions' && db.settleSmaller) {
        row['amount_pkr'] = (row['amount_pkr'] as number) - 10;
      }
      this.rows().push(row);
      if (this.singleMode || this.maybeMode) {
        resolve({ data: row, error: null });
        return;
      }
      resolve({ data: [row], error: null });
      return;
    }
    if (this.op === 'update') {
      if (this.table === 'coupon_redemptions' && db.applyFailsOnce) {
        db.applyFailsOnce = false;
        resolve({ data: null, error: { code: '500', message: 'boom' } });
        return;
      }
      if (
        this.table === 'coupon_redemptions' &&
        db.failReleaseOnce &&
        this.patch?.['status'] === 'released'
      ) {
        db.failReleaseOnce = false;
        resolve({ data: null, error: { code: '500', message: 'boom' } });
        return;
      }
      if (
        this.table === 'subscription_periods' &&
        db.failSupersedeOnce &&
        this.patch?.['superseded_at'] != null &&
        // Only the orphan supersede (eq id) — not period creation's
        // supersede-all (eq user_id), which must succeed first.
        this.filterCols.includes('id')
      ) {
        // The route awaits this update without reading its error
        // result, so only a thrown failure reaches its catch/log:
        // the fake throws, like a transport failure would.
        db.failSupersedeOnce = false;
        throw new Error('supersede down');
      }
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.patch);
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    const matched = this.matched();
    if (this.singleMode) {
      resolve({ data: matched[0] ?? null, error: matched.length === 0 ? { code: 'PGRST116' } : null });
      return;
    }
    if (this.maybeMode) {
      resolve({ data: matched[0] ?? null, error: null });
      return;
    }
    resolve({ data: matched, error: null });
  }
}

const fakeClient = {
  from(table: string): FakeBuilder {
    return new FakeBuilder(table);
  },
};

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function couponRow(overrides: Row = {}): Row {
  return {
    id: 'coupon-1',
    code: 'FREE100',
    kind: 'percent_multi',
    percent: 100,
    status: 'active',
    consumed_at: null,
    remaining_balance_pkr: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function zeroDueRequest(couponCode = 'FREE100', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/billing/payments/zero-due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ counts: { ...ZERO_COUNTS, facebook: 1 }, couponCode }),
  });
}

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) } as never;

describe('zero-due coupon checkout', () => {
  beforeEach(() => {
    authState.role = 'user';
    idempotencyOverride.lookup = null;
    storeCalls.length = 0;
    db = {
      payments: [],
      periods: [],
      coupons: [couponRow()],
      redemptions: [],
      settleSmaller: false,
      applyFailsOnce: false,
      failReleaseOnce: false,
      failSupersedeOnce: false,
    };
  });

  it('activates a period immediately when the coupon covers the full amount', async () => {
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      period: { id: string };
      couponCode: string;
      discountPkr: number;
    };
    expect(body.couponCode).toBe('FREE100');
    expect(body.discountPkr).toBe(70);
    expect(db.periods).toHaveLength(1);
    // The insert omits superseded_at (the column defaults to NULL);
    // the fake carries no defaults, so assert absence-or-null.
    expect(db.periods[0]['superseded_at'] ?? null).toBeNull();
    expect(db.redemptions).toHaveLength(1);
    expect(db.redemptions[0]).toMatchObject({ status: 'applied', period_id: body.period.id });
    expect(storeCalls).toHaveLength(1);
  });

  it('refuses admins with 403', async () => {
    authState.role = 'admin';
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(403);
    expect(db.periods).toHaveLength(0);
  });

  it('refuses when a payment is already pending, creating no period', async () => {
    db.payments.push({ id: 'payment-1', user_id: userId, status: 'pending' });
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PENDING_PAYMENT_EXISTS');
    expect(db.periods).toHaveLength(0);
  });

  it('returns 404 for an unknown coupon code', async () => {
    const res = await postZeroDue(zeroDueRequest('NOPE'), ctx);
    expect(res.status).toBe(404);
    expect(db.periods).toHaveLength(0);
  });

  it('refuses a coupon that does not cover the full amount', async () => {
    db.coupons = [couponRow({ percent: 50 })];
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(400);
    expect(db.periods).toHaveLength(0);
    expect(db.redemptions).toHaveLength(0);
  });

  it('refuses when the settled discount no longer covers the amount, and releases the hold', async () => {
    db.settleSmaller = true;
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      amountDuePkr: number;
      settledDiscountPkr: number;
    };
    expect(body.error).toBe('COUPON_SETTLED_LESS');
    expect(body.amountDuePkr).toBe(70);
    expect(body.settledDiscountPkr).toBe(60);
    expect(db.periods).toHaveLength(0);
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });

  it('supersedes the just-created period when applying the redemption fails', async () => {
    db.applyFailsOnce = true;
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('COUPON_UNAVAILABLE');
    expect(db.periods).toHaveLength(1);
    expect(db.periods[0]['superseded_at']).not.toBeNull();
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });

  it('rejects an invalid Idempotency-Key with 400', async () => {
    idempotencyOverride.lookup = () => ({ invalid: true });
    const res = await postZeroDue(
      zeroDueRequest('FREE100', { 'Idempotency-Key': 'not-a-uuid' }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(db.periods).toHaveLength(0);
  });

  it('replays a stored activation instead of creating a second period', async () => {
    idempotencyOverride.lookup = () => ({
      key: '11111111-1111-4111-a111-111111111111',
      replay: { status: 201, body: { period: { id: 'period-replayed' } } },
    });
    const res = await postZeroDue(
      zeroDueRequest('FREE100', { 'Idempotency-Key': '11111111-1111-4111-a111-111111111111' }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(db.periods).toHaveLength(0);
  });
});

describe('zero-due checkout failure branches', () => {
  beforeEach(() => {
    authState.role = 'user';
    idempotencyOverride.lookup = null;
    storeCalls.length = 0;
    workspaceMock.rejectOnce = false;
    db = {
      payments: [],
      periods: [],
      coupons: [couponRow()],
      redemptions: [],
      settleSmaller: false,
      applyFailsOnce: false,
      failReleaseOnce: false,
      failSupersedeOnce: false,
    };
  });

  it('an unresolvable workspace is logged and the checkout still proceeds', async () => {
    workspaceMock.rejectOnce = true;
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(201);
    expect(db.periods).toHaveLength(1);
  });

  it('an idempotency store failure returns 500 without a period', async () => {
    idempotencyOverride.lookup = () => {
      throw new Error('store down');
    };
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(500);
    expect(db.periods).toHaveLength(0);
  });

  it('a failing settled-release is logged and the refusal still lands', async () => {
    db.settleSmaller = true;
    db.failReleaseOnce = true;
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('COUPON_SETTLED_LESS');
    expect(db.periods).toHaveLength(0);
    expect(db.redemptions[0]).toMatchObject({ status: 'held' });
  });

  it('a failing orphan supersede is logged and the coupon is still released', async () => {
    db.applyFailsOnce = true;
    db.failSupersedeOnce = true;
    const res = await postZeroDue(zeroDueRequest(), ctx);
    expect(res.status).toBe(400);
    expect(db.periods).toHaveLength(1);
    expect(db.periods[0]['superseded_at'] ?? null).toBeNull();
    expect(db.redemptions[0]).toMatchObject({ status: 'released' });
  });
});
