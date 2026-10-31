import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  approvePayment,
  assertCanPost,
  assertFeatureAddWithinCap,
  assertPaidPlan,
  countsFromRow,
  createPeriodForPayment,
  getActivePeriod,
  getEntitlement,
  getUsageCount,
  getUsageCounts,
  hasAnyPeriod,
  isDestinationUsed,
  paymentFromRow,
  periodFromRow,
  pricePurchase,
  registerUsage,
  rejectPayment,
  SubscriptionGateError,
  type SubscriptionPaymentRow,
} from '@/lib/billing/entitlement';
import { logServerError } from '@/lib/server-analytics';

/**
 * Subscription entitlement (posting gates, usage registry, admin
 * approve/reject, pricing), tested against a small thenable fake
 * Supabase client — no real database. The fake mirrors the real
 * client's shape the code relies on: chainable filters, a thenable
 * select/insert/update result, and maybeSingle/single terminals.
 * Covers the branches the route tests never reach: cap checks,
 * already-used and race (23505) registration, period creation
 * failures, and the idempotent approve path.
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const mockedLogServerError = vi.mocked(logServerError);

type Row = Record<string, unknown>;

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

const TEN_COUNTS = {
  facebook: 10,
  instagram: 10,
  threads: 10,
  x: 10,
  tiktok: 10,
  youtube: 10,
};

function periodRow(overrides: Row = {}): Row {
  return {
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 10,
    instagram_count: 10,
    threads_count: 10,
    x_count: 10,
    tiktok_count: 10,
    youtube_count: 10,
    starts_at: '2020-01-01T00:00:00.000Z',
    ends_at: '2099-01-01T00:00:00.000Z',
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
    status: 'pending',
    facebook_count: 2,
    instagram_count: 2,
    threads_count: 2,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 420,
    is_upgrade: false,
    screenshot_storage_key: 'billing-screenshots/user-1/shot.jpg',
    nowpayments_payment_id: null,
    nowpayments_pay_address: null,
    nowpayments_pay_amount: null,
    nowpayments_network: null,
    period_id: null,
    approved_at: null,
    created_at: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function paymentObject(overrides: Partial<SubscriptionPaymentRow> = {}): SubscriptionPaymentRow {
  return {
    id: 'payment-1',
    userId: 'user-1',
    method: 'bank',
    bankMethod: 'easypaisa',
    status: 'pending',
    counts: { ...ZERO_COUNTS, facebook: 2, instagram: 2, threads: 2 },
    amountPkr: 420,
    isUpgrade: false,
    screenshotStorageKey: null,
    nowpaymentsPaymentId: null,
    nowpaymentsPayAddress: null,
    nowpaymentsPayAmount: null,
    nowpaymentsNetwork: null,
    couponCode: null,
    discountPkr: 0,
    periodId: null,
    approvedAt: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeState {
  periods: Row[];
  usageRows: Row[];
  usageCounts: Partial<Record<string, number>>;
  paymentRow: Row | null;
  periodById: Row | null;
  createdPeriodRow: Row | null;
  selectErrors: Partial<Record<string, unknown>>;
  // Error for the subscription_usage ROW-LIST select only (the
  // already-used lookup). The head-count select is unaffected, so a
  // test can fail the lookup without failing getEntitlement first.
  usageListError: unknown;
  usageInsertError: { code?: string } | null;
  periodInsertError: unknown;
  updateErrors: Partial<Record<string, unknown>>;
  inserted: Array<{ table: string; row: Row }>;
  updated: Array<{ table: string; patch: Row }>;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    periods: [],
    usageRows: [],
    usageCounts: {},
    paymentRow: null,
    periodById: null,
    createdPeriodRow: null,
    selectErrors: {},
    usageListError: null,
    usageInsertError: null,
    periodInsertError: null,
    updateErrors: {},
    inserted: [],
    updated: [],
    ...overrides,
  };
}

type Filter = { op: 'eq' | 'is' | 'lte' | 'gt' | 'neq' | 'in'; col: string; val: unknown };

class FakeBuilder {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private headCount = false;
  private op: 'select' | 'insert' | 'update' = 'select';

  constructor(
    private state: FakeState,
    private table: string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.headCount = true;
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

  in(col: string, val: unknown[]): this {
    this.filters.push({ op: 'in', col, val });
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

  neq(col: string, val: unknown): this {
    this.filters.push({ op: 'neq', col, val });
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

  insert(row: Row): this {
    this.op = 'insert';
    this.state.inserted.push({ table: this.table, row });
    // Mirror the database: a successful usage insert is visible to
    // the registry read that follows it in the same call.
    if (this.table === 'subscription_usage') {
      this.state.usageRows.push({
        user_id: row.user_id,
        platform: row.platform,
        destination_key: row.destination_key,
        feature: row.feature,
      });
    }
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.state.updated.push({ table: this.table, patch });
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const err = this.state.selectErrors[this.table];
    if (err) return { data: null, error: err };
    if (this.table === 'subscription_payments') {
      return { data: this.state.paymentRow, error: null };
    }
    if (this.table === 'subscription_periods') {
      return { data: this.state.periodById, error: null };
    }
    return { data: null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    if (this.op === 'insert' && this.table === 'subscription_periods') {
      if (this.state.periodInsertError) {
        return { data: null, error: this.state.periodInsertError };
      }
      return { data: this.state.createdPeriodRow, error: null };
    }
    return { data: null, error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: Record<string, unknown>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.compute()).then(onfulfilled, onrejected);
  }

  private compute(): Record<string, unknown> {
    if (this.op === 'insert') {
      const err =
        this.table === 'subscription_usage'
          ? this.state.usageInsertError
          : this.state.periodInsertError;
      return { data: null, error: err };
    }
    if (this.op === 'update') {
      return { error: this.state.updateErrors[this.table] ?? null };
    }
    const err = this.state.selectErrors[this.table];
    if (err) return { data: null, error: err, count: null };
    if (this.headCount) {
      const platform = this.filters.find((f) => f.col === 'platform')?.val as string;
      const override = this.state.usageCounts[platform];
      if (override !== undefined) return { count: override, error: null };
      // No override: derive the count from the registry rows, as a
      // real count query would (tests that set rows but no map).
      let rows = [...this.state.usageRows];
      for (const f of this.filters) {
        if (f.op === 'eq') rows = rows.filter((row) => row[f.col] === f.val);
        if (f.op === 'neq') rows = rows.filter((row) => row[f.col] !== f.val);
      }
      return { count: rows.length, error: null };
    }
    // Row-list selects only: the already-used lookup. Head counts
    // return above, so this error cannot leak into getEntitlement.
    if (this.table === 'subscription_usage' && this.state.usageListError) {
      return { data: null, error: this.state.usageListError, count: null };
    }
    let rows =
      this.table === 'subscription_periods'
        ? [...this.state.periods]
        : this.table === 'subscription_usage'
          ? [...this.state.usageRows]
          : [];
    for (const f of this.filters) {
      rows = rows.filter((row) => {
        const v = row[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'is') return f.val === null ? v == null : v === f.val;
        if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v);
        if (f.op === 'lte') return String(v) <= String(f.val);
        if (f.op === 'neq') return v !== f.val;
        return String(v) > String(f.val);
      });
    }
    if (this.orderCol) {
      const col = this.orderCol;
      rows.sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        if (this.orderAsc) return av < bv ? -1 : av > bv ? 1 : 0;
        return av > bv ? -1 : av < bv ? 1 : 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return { data: rows, error: null };
  }
}

function fakeClient(state: FakeState): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(state, table),
  } as unknown as SupabaseClient;
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('row mappers', () => {
  it('countsFromRow defaults missing counts to zero', () => {
    expect(countsFromRow({ facebook_count: 3 })).toEqual({
      ...ZERO_COUNTS,
      facebook: 3,
    });
  });

  it('periodFromRow maps a valid row and rejects bad rows', () => {
    const period = periodFromRow(periodRow());
    expect(period).toMatchObject({
      id: 'period-1',
      userId: 'user-1',
      counts: TEN_COUNTS,
      supersededAt: null,
    });
    expect(period?.startsAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(periodFromRow(periodRow({ id: 7 }))).toBeNull();
    expect(periodFromRow(periodRow({ ends_at: 'not-a-date' }))).toBeNull();
    expect(
      periodFromRow(periodRow({ superseded_at: '2026-01-01T00:00:00.000Z' }))?.supersededAt?.toISOString()
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('paymentFromRow maps methods, banks, networks, and statuses', () => {
    const payment = paymentFromRow(paymentRow());
    expect(payment).toMatchObject({
      method: 'bank',
      bankMethod: 'easypaisa',
      status: 'pending',
      amountPkr: 420,
      isUpgrade: false,
    });
    const crypto = paymentFromRow(
      paymentRow({
        method: 'nowpayments',
        bank_method: null,
        nowpayments_network: 'trc20',
        nowpayments_pay_amount: 2.5,
        status: 'paid',
      })
    );
    expect(crypto).toMatchObject({
      method: 'nowpayments',
      bankMethod: null,
      nowpaymentsNetwork: 'trc20',
      nowpaymentsPayAmount: 2.5,
      status: 'paid',
    });
    expect(paymentFromRow(paymentRow({ user_id: null }))).toBeNull();
    expect(paymentFromRow(paymentRow({ method: 'card' }))?.method).toBe('bank');
    expect(paymentFromRow(paymentRow({ bank_method: 'jazzcash' }))?.bankMethod).toBeNull();
    expect(paymentFromRow(paymentRow({ nowpayments_network: 'eth' }))?.nowpaymentsNetwork).toBeNull();
    expect(paymentFromRow(paymentRow({ nowpayments_pay_amount: '2.5' }))?.nowpaymentsPayAmount).toBeNull();
    expect(paymentFromRow(paymentRow({ status: null }))?.status).toBe('pending');
  });
});

describe('getActivePeriod', () => {
  it('returns the active period', async () => {
    const state = baseState({ periods: [periodRow()] });
    const period = await getActivePeriod(fakeClient(state), 'user-1', NOW);
    expect(period?.id).toBe('period-1');
  });

  it('returns null when no period matches the window', async () => {
    const state = baseState({
      periods: [
        periodRow({ ends_at: '2020-06-01T00:00:00.000Z' }),
        periodRow({ id: 'period-2', superseded_at: '2026-01-01T00:00:00.000Z' }),
      ],
    });
    await expect(getActivePeriod(fakeClient(state), 'user-1', NOW)).resolves.toBeNull();
  });

  it('fails closed on a query error', async () => {
    const state = baseState({
      selectErrors: { subscription_periods: { message: 'db down' } },
    });
    await expect(getActivePeriod(fakeClient(state), 'user-1', NOW)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] active period query failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('getUsageCounts / getUsageCount / isDestinationUsed', () => {
  it('counts per platform, defaulting missing platforms to zero', async () => {
    const state = baseState({ usageCounts: { facebook: 2, instagram: 1 } });
    await expect(getUsageCounts(fakeClient(state), 'user-1')).resolves.toEqual({
      ...ZERO_COUNTS,
      facebook: 2,
      instagram: 1,
    });
  });

  it('counts one platform exactly, without fetching its keys', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b' },
        { user_id: 'user-1', platform: 'instagram', destination_key: 'acct-c' },
      ],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(2);
    await expect(getUsageCount(fakeClient(state), 'user-1', 'threads')).resolves.toBe(0);
  });

  it('checks one destination by existence, not by listing keys', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
      ],
    });
    await expect(
      isDestinationUsed(fakeClient(state), 'user-1', 'facebook', 'page-a')
    ).resolves.toBe(true);
    await expect(
      isDestinationUsed(fakeClient(state), 'user-1', 'facebook', 'page-b')
    ).resolves.toBe(false);
  });

  it('fails closed when a usage query errors', async () => {
    const state = baseState({
      selectErrors: { subscription_usage: { message: 'db down' } },
    });
    await expect(getUsageCounts(fakeClient(state), 'user-1')).rejects.toBeInstanceOf(
      SubscriptionGateError
    );
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    await expect(
      isDestinationUsed(fakeClient(state), 'user-1', 'facebook', 'page-a')
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] usage counts query failed',
      expect.anything(),
      { source: 'billing' }
    );
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] usage count query failed',
      expect.anything(),
      { source: 'billing' }
    );
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] destination existence query failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('Publish Now uncapped (owner decision 2026-10-31)', () => {
  it('excludes Publish Now rows from every usage count', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b', feature: 'instagram-publish-now' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-c', feature: 'threads-publish-now' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-d', feature: 'destination-queue' },
      ],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(1);
    await expect(getUsageCounts(fakeClient(state), 'user-1')).resolves.toEqual({
      ...ZERO_COUNTS,
      facebook: 1,
    });
  });

  it('treats a Publish Now-only destination as unused for caps', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
    });
    await expect(
      isDestinationUsed(fakeClient(state), 'user-1', 'facebook', 'page-a')
    ).resolves.toBe(false);
  });

  it('assertPaidPlan returns the period regardless of bought units', async () => {
    const state = baseState({ periods: [periodRow({ facebook_count: 0 })] });
    const period = await assertPaidPlan(fakeClient(state), 'user-1', NOW);
    expect(period.id).toBe('period-1');
  });

  it('assertPaidPlan still refuses a Free user', async () => {
    const state = baseState();
    await expect(assertPaidPlan(fakeClient(state), 'user-1', NOW)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
    });
  });

  it('registerUsage reclassifies a Publish Now row when a capped feature registers it', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
      usageInsertError: { code: '23505' },
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'destination-queue', null, NOW)
    ).resolves.toMatchObject({ alreadyUsed: true });
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).toMatchObject({
      table: 'subscription_usage',
      patch: expect.objectContaining({ feature: 'destination-queue' }),
    });
  });

  it('registerUsage leaves a Publish Now row alone when Publish Now re-registers it', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
      usageInsertError: { code: '23505' },
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'publish-now', null, NOW)
    ).resolves.toMatchObject({ alreadyUsed: true });
    expect(state.updated).toHaveLength(0);
  });
});

describe('Cap scope: per user across workspaces (owner decision 2026-10-31)', () => {
  // destination_id is the workspace-scoped destination row. The cap
  // functions never filter on it (verified 2026-10-31: no cap query
  // takes a workspace parameter), so rows from two workspaces sum.
  // The distinct destination_id values below simulate one user
  // queueing in workspace A and workspace B. These tests lock that
  // behaviour: a future workspace-scoped counting change must fail
  // here first.
  it('sums usage across destination rows from different workspaces', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', destination_id: 'dest-workspace-a', feature: 'destination-queue' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b', destination_id: 'dest-workspace-b', feature: 'destination-queue' },
      ],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(2);
  });

  it('blocks a new destination when split usage across workspaces hits the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 2 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', destination_id: 'dest-workspace-a', feature: 'destination-queue' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b', destination_id: 'dest-workspace-b', feature: 'destination-queue' },
      ],
    });
    await expect(
      assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-c', NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
  });

  it('allows a new destination when split usage across workspaces is under the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 3 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', destination_id: 'dest-workspace-a', feature: 'destination-queue' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b', destination_id: 'dest-workspace-b', feature: 'destination-queue' },
      ],
    });
    const period = await assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-c', NOW);
    expect(period.id).toBe('period-1');
  });
});

describe('getEntitlement', () => {
  it('is Free with a plain reason when there is no period', async () => {
    const state = baseState({ usageCounts: { facebook: 1 } });
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement).toMatchObject({
      plan: 'free',
      active: false,
      canPost: false,
      readOnly: true,
      period: null,
    });
    expect(entitlement.reason).toContain('Prompt Library only');
    expect(entitlement.usage.facebook).toBe(1);
  });

  it('is Paid and can post with an active period', async () => {
    const state = baseState({ periods: [periodRow()], usageCounts: { facebook: 3 } });
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement).toMatchObject({
      plan: 'paid',
      active: true,
      canPost: true,
      readOnly: false,
      reason: null,
    });
    expect(entitlement.counts).toEqual(TEN_COUNTS);
    expect(entitlement.period?.id).toBe('period-1');
  });

  it('reports hasPriorPeriod true for an active period without an extra lookup', async () => {
    const state = baseState({ periods: [periodRow()] });
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement.hasPriorPeriod).toBe(true);
  });

  it('reports hasPriorPeriod true for a lapsed period (Expired, not Free)', async () => {
    const state = baseState({
      periods: [
        periodRow({
          starts_at: '2025-01-01T00:00:00.000Z',
          ends_at: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement).toMatchObject({
      plan: 'free',
      active: false,
      period: null,
      hasPriorPeriod: true,
    });
  });

  it('reports hasPriorPeriod false when no period was ever held', async () => {
    const state = baseState();
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement.hasPriorPeriod).toBe(false);
  });
});

describe('hasAnyPeriod', () => {
  it('returns true when any period row exists, active or lapsed', async () => {
    const lapsed = baseState({
      periods: [
        periodRow({
          starts_at: '2025-01-01T00:00:00.000Z',
          ends_at: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });
    await expect(hasAnyPeriod(fakeClient(lapsed), 'user-1')).resolves.toBe(true);
  });

  it('returns false when no period row exists', async () => {
    await expect(hasAnyPeriod(fakeClient(baseState()), 'user-1')).resolves.toBe(false);
  });

  it('fails closed — and logs — when the prior-period query errors', async () => {
    const state = baseState({
      selectErrors: { subscription_periods: { message: 'db down' } },
    });
    await expect(hasAnyPeriod(fakeClient(state), 'user-1')).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    try {
      await hasAnyPeriod(fakeClient(state), 'user-1');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('could not be checked right now');
    }
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] prior period query failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('assertCanPost', () => {
  it('refuses a Free user', async () => {
    const state = baseState();
    await expect(
      assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-a', NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  });

  it('refuses a new destination at the cap, naming pages for Facebook', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageCounts: { facebook: 1 },
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    await expect(
      assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-b', NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
    try {
      await assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-b', NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('limit of 1 pages');
    }
  });

  it('names accounts for non-Facebook platforms at the cap', async () => {
    const state = baseState({
      periods: [periodRow({ instagram_count: 1 })],
      usageCounts: { instagram: 1 },
      usageRows: [{ user_id: 'user-1', platform: 'instagram', destination_key: 'acct-a' }],
    });
    try {
      await assertCanPost(fakeClient(state), 'user-1', 'instagram', 'acct-b', NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('limit of 1 accounts');
    }
  });

  it('allows an already-used destination even at the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    const period = await assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-a', NOW);
    expect(period.id).toBe('period-1');
  });

  it('allows a new destination under the cap', async () => {
    const state = baseState({ periods: [periodRow()] });
    const period = await assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-a', NOW);
    expect(period.id).toBe('period-1');
  });
});

describe('assertFeatureAddWithinCap', () => {
  it('refuses a Free user', async () => {
    const state = baseState();
    await expect(
      assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-a'], NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  });

  it('allows new destinations under the cap and reports the new count', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b' },
      ],
    });
    const result = await assertFeatureAddWithinCap(
      fakeClient(state),
      'user-1',
      'facebook',
      ['page-c', 'page-d'],
      NOW
    );
    expect(result).toEqual({ allowed: 5, used: 2, newCount: 2 });
  });

  it('does not count already-registered destinations against the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-c' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-d' },
      ],
    });
    const result = await assertFeatureAddWithinCap(
      fakeClient(state),
      'user-1',
      'facebook',
      ['page-a', 'page-e'],
      NOW
    );
    expect(result).toEqual({ allowed: 5, used: 4, newCount: 1 });
  });

  it('dedupes repeated keys in one request', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-c' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-d' },
      ],
    });
    const result = await assertFeatureAddWithinCap(
      fakeClient(state),
      'user-1',
      'facebook',
      ['page-e', 'page-e'],
      NOW
    );
    expect(result.newCount).toBe(1);
  });

  it('refuses when new destinations would push usage past the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-c' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-d' },
      ],
    });
    await expect(
      assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-e', 'page-f'], NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
  });

  it('allows an add of only already-registered destinations even at the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    const result = await assertFeatureAddWithinCap(
      fakeClient(state),
      'user-1',
      'facebook',
      ['page-a'],
      NOW
    );
    expect(result).toEqual({ allowed: 1, used: 1, newCount: 0 });
  });

  it('allows an empty add even at the cap', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    const result = await assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', [], NOW);
    expect(result.newCount).toBe(0);
  });

  it('writes nothing to the registry', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    await assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-b'], NOW);
    expect(state.inserted.filter((entry) => entry.table === 'subscription_usage')).toEqual([]);
  });

  it('fails closed — and logs — when the already-used lookup errors', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 5 })],
      usageListError: { message: 'db down' },
    });
    await expect(
      assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-a'], NOW)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] feature-add cap check failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('registerUsage', () => {
  it('reports an already-used destination without inserting', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageRows: [{ user_id: 'user-1', platform: 'facebook', destination_key: 'page-a' }],
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'schedule', null, NOW)
    ).resolves.toEqual({ alreadyUsed: true, usedCount: 1 });
    expect(state.inserted).toHaveLength(0);
  });

  it('inserts a new destination and reports the new count', async () => {
    const state = baseState({ periods: [periodRow()] });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'schedule', null, NOW)
    ).resolves.toEqual({ alreadyUsed: false, usedCount: 1 });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      table: 'subscription_usage',
      row: expect.objectContaining({
        user_id: 'user-1',
        platform: 'facebook',
        destination_key: 'page-a',
        feature: 'schedule',
      }),
    });
  });

  it('treats a unique violation as an already-used race win', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageInsertError: { code: '23505' },
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'schedule', null, NOW)
    ).resolves.toEqual({ alreadyUsed: true, usedCount: 1 });
  });

  it('fails closed — and logs — on any other insert error', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageInsertError: { code: '42501' },
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'schedule', null, NOW)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] usage insert failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('createPeriodForPayment', () => {
  const startsAt = new Date('2026-06-01T00:00:00.000Z');

  it('starts a 30-day period and supersedes the old one', async () => {
    const state = baseState({ createdPeriodRow: periodRow({ id: 'period-new' }) });
    const period = await createPeriodForPayment(
      fakeClient(state),
      paymentObject(),
      startsAt
    );
    expect(period.id).toBe('period-new');
    const inserted = state.inserted.find((i) => i.table === 'subscription_periods');
    expect(inserted?.row).toMatchObject({
      user_id: 'user-1',
      payment_id: 'payment-1',
      facebook_count: 2,
      starts_at: '2026-06-01T00:00:00.000Z',
      ends_at: '2026-07-01T00:00:00.000Z',
    });
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).toMatchObject({
      table: 'subscription_periods',
      patch: expect.objectContaining({ superseded_at: '2026-06-01T00:00:00.000Z' }),
    });
  });

  it('fails closed when superseding errors', async () => {
    const state = baseState({
      updateErrors: { subscription_periods: { message: 'db down' } },
    });
    await expect(
      createPeriodForPayment(fakeClient(state), paymentObject(), startsAt)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] period supersede failed',
      expect.anything(),
      { source: 'billing' }
    );
  });

  it('fails closed when the period insert errors', async () => {
    const state = baseState({ periodInsertError: { message: 'db down' } });
    await expect(
      createPeriodForPayment(fakeClient(state), paymentObject(), startsAt)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] period insert failed',
      expect.anything(),
      { source: 'billing' }
    );
  });

  it('fails closed when the insert returns no row', async () => {
    const state = baseState({ createdPeriodRow: null });
    await expect(
      createPeriodForPayment(fakeClient(state), paymentObject(), startsAt)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
  });

  it('fails closed when the returned row cannot be read as a period', async () => {
    const state = baseState({ createdPeriodRow: { nonsense: true } });
    await expect(
      createPeriodForPayment(fakeClient(state), paymentObject(), startsAt)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
  });
});

describe('approvePayment', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('returns the existing period on a double approve without extending', async () => {
    const state = baseState({
      paymentRow: paymentRow({ period_id: 'period-1', status: 'approved' }),
      periodById: periodRow(),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period.id).toBe('period-1');
    expect(result.payment.status).toBe('approved');
    expect(state.inserted).toHaveLength(0);
  });

  it('approves a pending payment and starts its period', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.payment).toMatchObject({
      status: 'approved',
      periodId: 'period-new',
      approvedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(result.period.id).toBe('period-new');
    const paymentUpdate = state.updated.find((u) => u.table === 'subscription_payments');
    expect(paymentUpdate?.patch).toMatchObject({
      status: 'approved',
      approved_by: 'admin-1',
      period_id: 'period-new',
    });
  });

  it('creates a period when the stored period id no longer resolves', async () => {
    const state = baseState({
      paymentRow: paymentRow({ period_id: 'period-gone', status: 'pending' }),
      periodById: null,
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period.id).toBe('period-new');
  });

  it('reports a missing payment', async () => {
    const state = baseState({ paymentRow: null });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
    });
    const errorState = baseState({
      selectErrors: { subscription_payments: { message: 'db down' } },
    });
    await expect(
      approvePayment(fakeClient(errorState), 'payment-1', 'admin-1', now)
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
    const badRowState = baseState({ paymentRow: { nonsense: true } });
    await expect(
      approvePayment(fakeClient(badRowState), 'payment-1', 'admin-1', now)
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_FOUND' });
  });

  it('refuses a payment that is already decided', async () => {
    const state = baseState({ paymentRow: paymentRow({ status: 'rejected' }) });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_DECIDED',
    });
  });

  it('fails closed when the approval update errors', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      createdPeriodRow: periodRow({ id: 'period-new' }),
      updateErrors: { subscription_payments: { message: 'db down' } },
    });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] payment approve update failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('rejectPayment', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('rejects a pending payment', async () => {
    const state = baseState({ paymentRow: paymentRow() });
    const payment = await rejectPayment(fakeClient(state), 'payment-1', now);
    expect(payment.status).toBe('rejected');
    expect(state.updated[0]).toMatchObject({
      table: 'subscription_payments',
      patch: expect.objectContaining({ status: 'rejected' }),
    });
  });

  it('reports a missing payment and refuses a decided one', async () => {
    const missing = baseState({ paymentRow: null });
    await expect(rejectPayment(fakeClient(missing), 'payment-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
    });
    const decided = baseState({ paymentRow: paymentRow({ status: 'approved' }) });
    await expect(rejectPayment(fakeClient(decided), 'payment-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_DECIDED',
    });
  });

  it('fails closed when the rejection update errors', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      updateErrors: { subscription_payments: { message: 'db down' } },
    });
    await expect(rejectPayment(fakeClient(state), 'payment-1', now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] payment reject update failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('pricePurchase', () => {
  it('prices a fresh purchase at the full total', () => {
    const counts = { ...ZERO_COUNTS, facebook: 2, instagram: 2, threads: 2 };
    expect(pricePurchase(counts, null, NOW)).toEqual({
      amountPkr: 420,
      isUpgrade: false,
      quote: null,
    });
  });

  it('refuses a downgrade as a plain gate error, not a server failure', () => {
    const oldCounts = { ...ZERO_COUNTS, facebook: 20 };
    const newCounts = { ...ZERO_COUNTS, facebook: 10 };
    const activePeriod = {
      id: 'period-1',
      userId: 'user-1',
      counts: oldCounts,
      startsAt: new Date('2026-05-02T00:00:00.000Z'),
      endsAt: new Date('2026-06-11T00:00:00.000Z'),
      supersededAt: null,
    };
    let caught: unknown = null;
    try {
      pricePurchase(newCounts, activePeriod, NOW);
    } catch (err) {
      caught = err;
    }
    // The checkout routes turn SubscriptionGateError into a plain
    // 400; a raw DomainError would have fallen through to a 500.
    expect(caught).toBeInstanceOf(SubscriptionGateError);
    expect(caught).toMatchObject({ code: 'INVALID_REQUEST' });
    expect((caught as Error).message).toContain('Counts can only be increased');
  });

  it('prices the 10-to-20 upgrade with 10 days left as credit 233, pay 1167', () => {
    const oldCounts = { ...ZERO_COUNTS, facebook: 10 };
    const newCounts = { ...ZERO_COUNTS, facebook: 20 };
    const activePeriod = {
      id: 'period-1',
      userId: 'user-1',
      counts: oldCounts,
      startsAt: new Date('2026-05-02T00:00:00.000Z'),
      endsAt: new Date('2026-06-11T00:00:00.000Z'),
      supersededAt: null,
    };
    const priced = pricePurchase(newCounts, activePeriod, NOW);
    expect(priced.isUpgrade).toBe(true);
    expect(priced.amountPkr).toBe(1167);
    expect(priced.quote).toMatchObject({
      creditPkr: 233,
      oldMonthlyTotalPkr: 700,
      newMonthlyTotalPkr: 1400,
    });
  });
});
