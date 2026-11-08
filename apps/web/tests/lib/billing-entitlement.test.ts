import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateDueScheduledDowngrades,
  approvePayment,
  hasOutstandingScheduledDowngrade,
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
  releaseUsageForFeature,
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
    isDowngrade: false,
    scheduledStartsAt: null,
    rejectionReason: null,
    rejectionDetail: null,
    overrideReason: null,
    decidedAt: null,
    screenshotStorageKey: null,
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
  workspaces: Row[];
  destinations: Row[];
  usageRows: Row[];
  usageCounts: Partial<Record<string, number>>;
  paymentRow: Row | null;
  // Row-list view of subscription_payments for the scheduled-
  // downgrade guards (hasOutstanding / activation), which query
  // the payments table as a list. Null (default) keeps the old
  // behaviour: list selects on payments return no rows.
  paymentRows: Row[] | null;
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
  deleteErrors: Partial<Record<string, unknown>>;
  inserted: Array<{ table: string; row: Row }>;
  updated: Array<{ table: string; patch: Row }>;
  deleted: Array<{ table: string; filters: Filter[] }>;
  // Race simulations for the claim-first approval paths: the next
  // claim (status patch) or link (period_id patch) update loses to
  // a concurrent winner, which is recorded as already linked.
  loseClaimOnce: boolean;
  loseLinkOnce: boolean;
  // Crypto-activation race: the next paid-claim update loses to a
  // concurrent winner that claimed but crashed before linking, so
  // the payment reads back paid with no period.
  loseCryptoClaimOnce: boolean;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    periods: [],
    workspaces: [],
    destinations: [],
    usageRows: [],
    usageCounts: {},
    paymentRow: null,
    paymentRows: null,
    periodById: null,
    createdPeriodRow: null,
    selectErrors: {},
    usageListError: null,
    usageInsertError: null,
    periodInsertError: null,
    updateErrors: {},
    deleteErrors: {},
    inserted: [],
    updated: [],
    deleted: [],
    loseClaimOnce: false,
    loseLinkOnce: false,
    loseCryptoClaimOnce: false,
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
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private deletePatch: Row | null = null;

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
    // Mirror the database: a SUCCESSFUL usage insert is visible to
    // the registry read that follows it in the same call. A failed
    // insert (usageInsertError / periodInsertError configured)
    // inserts nothing — the race-winner row in the 23505 test is
    // seeded explicitly instead.
    const insertError =
      this.table === 'subscription_usage'
        ? this.state.usageInsertError
        : this.table === 'subscription_periods'
          ? this.state.periodInsertError
          : null;
    if (this.table === 'subscription_usage' && !insertError) {
      this.state.usageRows.push({
        user_id: row.user_id,
        platform: row.platform,
        destination_key: row.destination_key,
        feature: row.feature,
      });
    }
    return this;
  }

  delete(): this {
    this.op = 'delete';
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
      if (this.state.paymentRows !== null) {
        const idFilter = this.filters.find((f) => f.op === 'eq' && f.col === 'id');
        const row = idFilter
          ? this.state.paymentRows.find((r) => r['id'] === idFilter.val) ?? null
          : (this.state.paymentRows[0] ?? null);
        return { data: row, error: null };
      }
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
      // Consume-once: a retry after a 23505 (legacy-row delete +
      // reinsert) must succeed — the error models one failed
      // attempt, not a permanently broken table.
      const err =
        this.table === 'subscription_usage'
          ? this.state.usageInsertError
          : this.state.periodInsertError;
      if (this.table === 'subscription_usage') this.state.usageInsertError = null;
      if (this.table === 'subscription_periods') this.state.periodInsertError = null;
      return { data: null, error: err };
    }
    if (this.op === 'delete') {
      const deleteError = this.state.deleteErrors[this.table] ?? null;
      if (deleteError) return { data: null, error: deleteError, count: null };
      this.state.deleted.push({ table: this.table, filters: [...this.filters] });
      const deletedIds: unknown[] = [];
      const rows =
        this.table === 'subscription_usage'
          ? this.state.usageRows
          : this.table === 'subscription_periods'
            ? this.state.periods
            : [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i] as Row;
        const matches = this.filters.every((f) => {
          const v = row[f.col];
          if (f.op === 'eq') return v === f.val;
          if (f.op === 'is') return f.val === null ? v == null : v === f.val;
          if (f.op === 'neq') return v !== f.val;
          return false;
        });
        if (matches) {
          deletedIds.push((rows[i] as Row)['id'] ?? null);
          rows.splice(i, 1);
        }
      }
      return { data: deletedIds, error: null };
    }
    if (this.op === 'update') {
      const err = this.state.updateErrors[this.table] ?? null;
      if (err) return { error: err };
      // Emulate the claim/link conditional updates on payments:
      // the update lands only when every filter still matches the
      // stored row, and returns the row id (the select('id') the
      // code awaits). A lost race returns no rows.
      if (this.table === 'subscription_payments' && this.state.paymentRow) {
        const row = this.state.paymentRow;
        const patch = this.state.updated
          .filter((u) => u.table === 'subscription_payments')
          .at(-1)?.patch;
        // A concurrent crypto winner claimed but crashed before
        // linking: our claim matches nothing, and the reload finds
        // the payment paid with no period (the repair path).
        if (this.state.loseCryptoClaimOnce && patch && patch['status'] === 'paid') {
          this.state.loseCryptoClaimOnce = false;
          Object.assign(row, { status: 'paid', period_id: null });
          return { data: [], error: null };
        }
        // A concurrent winner claimed (and linked) between our load
        // and our claim: our claim matches nothing, and the poll
        // finds the winner already linked.
        if (this.state.loseClaimOnce && patch && 'status' in patch && !('period_id' in patch)) {
          this.state.loseClaimOnce = false;
          Object.assign(row, { status: 'approved', period_id: 'period-winner' });
          return { data: [], error: null };
        }
        // A concurrent winner linked between our create and our
        // link: our link matches nothing, and the orphan path finds
        // the winner already linked.
        if (this.state.loseLinkOnce && patch && 'period_id' in patch) {
          this.state.loseLinkOnce = false;
          Object.assign(row, { period_id: 'period-winner' });
          return { data: [], error: null };
        }
        const matches = this.filters.every((f) => {
          const v = row[f.col];
          if (f.op === 'eq') return v === f.val;
          if (f.op === 'is') return f.val === null ? v == null : v === f.val;
          return true;
        });
        if (matches) {
          if (patch) Object.assign(row, patch);
          return { data: [{ id: row['id'] }], error: null };
        }
        return { data: [], error: null };
      }
      return { error: null };
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
        if (f.op === 'in')
          rows = rows.filter(
            (row) => Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col])
          );
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
        : this.table === 'subscription_payments' && this.state.paymentRows !== null
          ? [...this.state.paymentRows]
          : this.table === 'subscription_usage'
          ? [...this.state.usageRows]
          : this.table === 'workspaces'
            ? [...this.state.workspaces]
            : this.table === 'destinations'
              ? [...this.state.destinations]
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

  it('paymentFromRow maps methods, banks, and statuses', () => {
    const payment = paymentFromRow(paymentRow());
    expect(payment).toMatchObject({
      method: 'bank',
      bankMethod: 'easypaisa',
      status: 'pending',
      amountPkr: 420,
      isUpgrade: false,
    });
    expect(paymentFromRow(paymentRow({ user_id: null }))).toBeNull();
    expect(paymentFromRow(paymentRow({ method: 'card' }))?.method).toBe('bank');
    expect(paymentFromRow(paymentRow({ bank_method: 'jazzcash' }))?.bankMethod).toBeNull();
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

  it('runs the six per-platform counts in parallel', async () => {
    // Smooth-steps spec: the six countUsageForPlatform calls are
    // independent given the disconnected map, so they run together
    // instead of one after another. Track how many head-count
    // queries are in flight at once: sequential awaits never
    // exceed one; Promise.all has all six in flight together.
    const tracker = { inFlight: 0, maxInFlight: 0 };
    class TrackingBuilder extends FakeBuilder {
      override then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: Record<string, unknown>) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        tracker.inFlight += 1;
        tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
        return super.then<TResult1, TResult2>(
          (value) => {
            tracker.inFlight -= 1;
            return onfulfilled ? onfulfilled(value) : (value as unknown as TResult1);
          },
          (reason) => {
            tracker.inFlight -= 1;
            return onrejected ? onrejected(reason) : Promise.reject(reason);
          }
        );
      }
    }
    const state = baseState({
      usageCounts: { facebook: 1, instagram: 2, threads: 3, x: 4, tiktok: 5, youtube: 6 },
    });
    const trackingClient = {
      from: (table: string) => new TrackingBuilder(state, table),
    } as unknown as SupabaseClient;
    await expect(getUsageCounts(trackingClient, 'user-1')).resolves.toEqual({
      ...ZERO_COUNTS,
      facebook: 1,
      instagram: 2,
      threads: 3,
      x: 4,
      tiktok: 5,
      youtube: 6,
    });
    expect(tracker.maxInFlight).toBe(6);
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

  it('registerUsage deletes a legacy Publish Now row and inserts the capped row', async () => {
    // Audit fix 2026-11-01 (fix 24): the old reclassify UPDATE is
    // gone — a capped registration colliding with a legacy
    // Publish-Now row deletes that row and inserts the capped row
    // instead, so the destination counts without keeping any
    // Publish-Now row. The first insert fails 23505; the retry
    // after the delete succeeds.
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
      usageInsertError: { code: '23505' },
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'destination-queue', null, NOW)
    ).resolves.toMatchObject({ alreadyUsed: false, usedCount: 1 });
    expect(state.updated).toHaveLength(0);
    expect(state.deleted).toHaveLength(1);
    expect(state.deleted[0]).toMatchObject({ table: 'subscription_usage' });
    expect(state.usageRows).toHaveLength(1);
    expect(state.usageRows[0]).toMatchObject({ feature: 'destination-queue' });
  });

  it('registerUsage rejects Publish Now features outright', async () => {
    // Audit fix 2026-11-01 (fix 24): Publish Now never registers
    // usage — not even a re-registration of its own legacy row.
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
    });
    await expect(
      registerUsage(fakeClient(state), 'user-1', 'facebook', 'page-a', 'publish-now', null, NOW)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(state.updated).toHaveLength(0);
    expect(state.inserted).toHaveLength(0);
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

describe('Disconnected destinations do not count (owner decision 2026-11-02)', () => {
  // Boundary is EXACT: ONLY status 'disconnected' is excluded.
  // invalid_token, page_checkpoint, paused, and rate-limited rows
  // keep counting. The exclusion is a read-time filter on the
  // destination_id link — no usage row is deleted, so a reconnected
  // destination counts again with no re-registration.
  function disconnectedState(overrides: Partial<FakeState> = {}): FakeState {
    return baseState({
      workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
      ...overrides,
    });
  }

  function destinationRow(id: string, status: string, platform = 'facebook'): Row {
    return { id, workspace_id: 'ws-1', platform, status };
  }

  function usageRow(key: string, destinationId: string | null, platform = 'facebook'): Row {
    return {
      user_id: 'user-1',
      platform,
      destination_key: key,
      destination_id: destinationId,
      feature: 'destination-queue',
    };
  }

  it('excludes a disconnected destination from the count', async () => {
    const state = disconnectedState({
      destinations: [
        destinationRow('dest-active', 'active'),
        destinationRow('dest-disc', 'disconnected'),
      ],
      usageRows: [usageRow('page-a', 'dest-active'), usageRow('page-b', 'dest-disc')],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(1);
    await expect(getUsageCounts(fakeClient(state), 'user-1')).resolves.toMatchObject({
      facebook: 1,
    });
  });

  it('excludes ONLY disconnected: expired, checkpoint, and paused keep counting', async () => {
    const state = disconnectedState({
      destinations: [
        destinationRow('dest-active', 'active'),
        destinationRow('dest-expired', 'invalid_token'),
        destinationRow('dest-checkpoint', 'page_checkpoint'),
        destinationRow('dest-paused', 'paused'),
        destinationRow('dest-disc', 'disconnected'),
      ],
      usageRows: [
        usageRow('page-a', 'dest-active'),
        usageRow('page-b', 'dest-expired'),
        usageRow('page-c', 'dest-checkpoint'),
        usageRow('page-d', 'dest-paused'),
        usageRow('page-e', 'dest-disc'),
      ],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(4);
  });

  it('counts a reconnected destination again with no new registration', async () => {
    const state = disconnectedState({
      destinations: [destinationRow('dest-disc', 'disconnected')],
      usageRows: [usageRow('page-b', 'dest-disc')],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(0);
    // The status flips back; the SAME usage row is still there.
    state.destinations = [destinationRow('dest-disc', 'active')];
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(1);
  });

  it('keeps unlinked and legacy usage rows counting unchanged', async () => {
    const state = disconnectedState({
      destinations: [destinationRow('dest-disc', 'disconnected')],
      usageRows: [
        usageRow('page-legacy', null),
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-old', feature: 'destination-queue' },
        usageRow('page-b', 'dest-disc'),
      ],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(2);
  });

  it('does not exclude a disconnected destination owned by another user', async () => {
    const state = disconnectedState({
      workspaces: [
        { id: 'ws-1', owner_id: 'user-1' },
        { id: 'ws-2', owner_id: 'user-2' },
      ],
      // dest-other lives in user-2's workspace, so user-1's count
      // keeps it: the exclusion only follows the user's own rows.
      destinations: [
        { id: 'dest-other', workspace_id: 'ws-2', platform: 'facebook', status: 'disconnected' },
      ],
      usageRows: [usageRow('page-x', 'dest-other')],
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).resolves.toBe(1);
  });

  it('allows a new destination when the only used slots are disconnected rows', async () => {
    const state = disconnectedState({
      periods: [periodRow({ facebook_count: 1 })],
      destinations: [destinationRow('dest-disc', 'disconnected')],
      usageRows: [usageRow('page-b', 'dest-disc')],
    });
    const period = await assertCanPost(fakeClient(state), 'user-1', 'facebook', 'page-c', NOW);
    expect(period.id).toBe('period-1');
  });

  it('fails closed when the disconnected-destinations lookup errors', async () => {
    const state = disconnectedState({
      selectErrors: { workspaces: { message: 'db down' } },
    });
    await expect(getUsageCount(fakeClient(state), 'user-1', 'facebook')).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
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

  it('reports plan expired (never free) for a lapsed period', async () => {
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
      plan: 'expired',
      active: false,
      period: null,
      hasPriorPeriod: true,
    });
    expect(entitlement.reason).toContain('has ended');
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
    // The race winner's capped row is seeded: a failed insert
    // inserts nothing, so the already-used read must find a row
    // that another request actually wrote.
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'schedule' },
      ],
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
    expect(result.period?.id).toBe('period-1');
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
    expect(result.period?.id).toBe('period-new');
    // Claim-first approval writes twice: the claim (status +
    // approved_by) and then the period link. The link update is
    // the one carrying period_id.
    const claimUpdate = state.updated.find(
      (u) => u.table === 'subscription_payments' && u.patch['status'] === 'approved'
    );
    expect(claimUpdate?.patch).toMatchObject({ status: 'approved', approved_by: 'admin-1' });
    const linkUpdate = state.updated.find(
      (u) => u.table === 'subscription_payments' && u.patch['period_id'] === 'period-new'
    );
    expect(linkUpdate?.patch).toMatchObject({ period_id: 'period-new' });
  });

  it('creates a period when the stored period id no longer resolves', async () => {
    const state = baseState({
      paymentRow: paymentRow({ period_id: 'period-gone', status: 'pending' }),
      periodById: null,
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period?.id).toBe('period-new');
  });

  it('reports a missing payment', async () => {
    const state = baseState({ paymentRow: null });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
    });
    const errorState = baseState({
      selectErrors: { subscription_payments: { message: 'db down' } },
    });
    // Audit fix: a database error during load must fail loud as
    // unavailable, never masquerade as a missing payment (404 is
    // reserved for a clean empty result, asserted above).
    await expect(
      approvePayment(fakeClient(errorState), 'payment-1', 'admin-1', now)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
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
      '[billing] payment approve claim failed',
      expect.anything(),
      { source: 'billing' }
    );
  });
});

describe('approvePayment downgrade, option A (owner decision 2026-11-02, PR #120 send-back B2)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('schedules on the payment only: no period row, live period untouched', async () => {
    const state = baseState({
      paymentRow: paymentRow({ is_downgrade: true }),
      periods: [periodRow({ id: 'period-live', ends_at: '2026-06-20T00:00:00.000Z' })],
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.payment.status).toBe('approved');
    expect(result.period).toBeNull();
    expect(result.payment.scheduledStartsAt?.toISOString()).toBe('2026-06-20T00:00:00.000Z');
    // No future period row coexists with the live one — that was
    // the one-live-index violation this fix removes.
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(0);
    expect(
      state.updated.filter(
        (u) => u.table === 'subscription_periods' && 'superseded_at' in u.patch
      )
    ).toHaveLength(0);
    expect(
      state.updated.find(
        (u) =>
          u.table === 'subscription_payments' &&
          u.patch['scheduled_starts_at'] === '2026-06-20T00:00:00.000Z'
      )
    ).toBeTruthy();
  });

  it('starts at approval, never backdated, when the live period has lapsed', async () => {
    const state = baseState({
      paymentRow: paymentRow({ is_downgrade: true }),
      periods: [periodRow({ id: 'period-old', ends_at: '2026-05-20T00:00:00.000Z' })],
      createdPeriodRow: periodRow({
        id: 'period-new',
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: '2026-07-01T00:00:00.000Z',
      }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period?.id).toBe('period-new');
    const inserted = state.inserted.find((i) => i.table === 'subscription_periods');
    expect(inserted?.row).toMatchObject({ starts_at: '2026-06-01T00:00:00.000Z' });
  });

  it('fails closed when the lapsed downgrade period insert errors', async () => {
    const state = baseState({
      paymentRow: paymentRow({ is_downgrade: true }),
      periods: [periodRow({ id: 'period-old', ends_at: '2026-05-20T00:00:00.000Z' })],
      periodInsertError: { message: 'db down' },
    });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] period insert failed',
      expect.anything(),
      { source: 'billing' }
    );
  });

  it('blocks a second scheduled downgrade while one is outstanding', async () => {
    const pending = paymentRow({ is_downgrade: true });
    const outstanding = paymentRow({
      id: 'payment-2',
      status: 'approved',
      period_id: null,
      is_downgrade: true,
      scheduled_starts_at: '2026-06-20T00:00:00.000Z',
    });
    const state = baseState({
      paymentRow: pending,
      paymentRows: [pending, outstanding],
      periods: [periodRow({ id: 'period-live', ends_at: '2026-06-20T00:00:00.000Z' })],
    });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_ALREADY_DECIDED',
    });
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(0);
  });

  it('hasOutstandingScheduledDowngrade ignores non-downgrade approved payments', async () => {
    const state = baseState({
      paymentRows: [
        paymentRow({ id: 'payment-2', status: 'approved', period_id: null, is_downgrade: false }),
      ],
    });
    await expect(hasOutstandingScheduledDowngrade(fakeClient(state), 'user-1')).resolves.toBe(
      false
    );
  });
});

describe('activateDueScheduledDowngrades (option A activation path)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('creates and links the period at activation time, not the scheduled date', async () => {
    const scheduled = paymentRow({
      status: 'approved',
      period_id: null,
      is_downgrade: true,
      scheduled_starts_at: '2026-05-20T00:00:00.000Z',
    });
    const state = baseState({
      paymentRow: scheduled,
      paymentRows: [scheduled],
      periods: [],
      createdPeriodRow: periodRow({
        id: 'period-new',
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: '2026-07-01T00:00:00.000Z',
      }),
    });
    const period = await activateDueScheduledDowngrades(fakeClient(state), 'user-1', now);
    expect(period?.id).toBe('period-new');
    const inserted = state.inserted.find((i) => i.table === 'subscription_periods');
    expect(inserted?.row).toMatchObject({
      user_id: 'user-1',
      payment_id: 'payment-1',
      starts_at: '2026-06-01T00:00:00.000Z',
    });
    expect(scheduled['period_id']).toBe('period-new');
  });

  it('does not activate while a period is still live', async () => {
    const scheduled = paymentRow({
      status: 'approved',
      period_id: null,
      is_downgrade: true,
      scheduled_starts_at: '2026-05-20T00:00:00.000Z',
    });
    const state = baseState({
      paymentRow: scheduled,
      paymentRows: [scheduled],
      periods: [periodRow({ id: 'period-live', ends_at: '2099-01-01T00:00:00.000Z' })],
    });
    await expect(activateDueScheduledDowngrades(fakeClient(state), 'user-1', now)).resolves.toBe(
      null
    );
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(0);
  });

  it('does not activate a schedule whose start is still in the future', async () => {
    const scheduled = paymentRow({
      status: 'approved',
      period_id: null,
      is_downgrade: true,
      scheduled_starts_at: '2026-06-20T00:00:00.000Z',
    });
    const state = baseState({
      paymentRow: scheduled,
      paymentRows: [scheduled],
      periods: [],
    });
    await expect(activateDueScheduledDowngrades(fakeClient(state), 'user-1', now)).resolves.toBe(
      null
    );
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(0);
  });

  it('a second activation after linking is a no-op', async () => {
    const scheduled = paymentRow({
      status: 'approved',
      period_id: null,
      is_downgrade: true,
      scheduled_starts_at: '2026-05-20T00:00:00.000Z',
    });
    const state = baseState({
      paymentRow: scheduled,
      paymentRows: [scheduled],
      periods: [],
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const first = await activateDueScheduledDowngrades(fakeClient(state), 'user-1', now);
    expect(first?.id).toBe('period-new');
    const second = await activateDueScheduledDowngrades(fakeClient(state), 'user-1', now);
    expect(second).toBeNull();
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(1);
  });
});

describe('approvePayment screenshot override (owner decision 2026-11-02)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('refuses a screenshot-less bank approval without a recorded reason', async () => {
    const state = baseState({
      paymentRow: paymentRow({ screenshot_storage_key: null }),
    });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('records the override reason on approval', async () => {
    const state = baseState({
      paymentRow: paymentRow({ screenshot_storage_key: null }),
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now, {
      overrideReason: 'Screenshot verified on file',
    });
    expect(result.payment.status).toBe('approved');
    expect(
      state.updated.find(
        (u) =>
          u.table === 'subscription_payments' &&
          u.patch['override_reason'] === 'Screenshot verified on file'
      )
    ).toBeTruthy();
  });
});

describe('payment load tolerates non-object rows', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('approvePayment reports a non-object row as missing, not as a crash', async () => {
    const state = baseState({ paymentRow: 'nonsense' as unknown as Row });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
    });
  });

  it('rejectPayment reports a non-object row as missing, not as a crash', async () => {
    const state = baseState({ paymentRow: 'nonsense' as unknown as Row });
    await expect(rejectPayment(fakeClient(state), 'payment-1', now)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_FOUND',
    });
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

  it('records a rejection reason and detail, in memory and on the row', async () => {
    const state = baseState({ paymentRow: paymentRow() });
    const payment = await rejectPayment(fakeClient(state), 'payment-1', now, {
      reason: 'Wrong amount',
      detail: 'Sent 60, not 70',
    });
    expect(payment.status).toBe('rejected');
    expect(payment.rejectionReason).toBe('Wrong amount');
    expect(payment.rejectionDetail).toBe('Sent 60, not 70');
    expect(
      state.updated.find(
        (u) =>
          u.table === 'subscription_payments' &&
          u.patch['rejection_reason'] === 'Wrong amount' &&
          u.patch['rejection_detail'] === 'Sent 60, not 70'
      )
    ).toBeTruthy();
  });

  it('records a reason without detail as null', async () => {
    const state = baseState({ paymentRow: paymentRow() });
    const payment = await rejectPayment(fakeClient(state), 'payment-1', now, {
      reason: 'Wrong amount',
    });
    expect(payment.rejectionReason).toBe('Wrong amount');
    expect(payment.rejectionDetail).toBeNull();
  });

  it('fails closed when the reject load errors', async () => {
    const state = baseState({
      selectErrors: { subscription_payments: { message: 'db down' } },
    });
    await expect(rejectPayment(fakeClient(state), 'payment-1', now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] payment reject load failed',
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
      isDowngrade: false,
      quote: null,
      downgradeQuote: null,
    });
  });

  it('prices a downgrade as the new monthly total, prepaid, with no credit', () => {
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
    // Downgrade is a supported flow since the separate-sections
    // build: the user pays the new lower monthly total now, the
    // lower plan starts after the current plan ends, and no credit
    // is given for the days left on the old plan.
    const priced = pricePurchase(newCounts, activePeriod, NOW);
    expect(priced.isDowngrade).toBe(true);
    expect(priced.isUpgrade).toBe(false);
    expect(priced.amountPkr).toBe(700);
    expect(priced.quote).toBeNull();
    expect(priced.downgradeQuote).toMatchObject({
      oldMonthlyTotalPkr: 1400,
      newMonthlyTotalPkr: 700,
      amountToPayPkr: 700,
    });
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

  it('reports the downgrade reason for a mixed change that raises a count', () => {
    const oldCounts = { ...ZERO_COUNTS, facebook: 2, instagram: 2 };
    const newCounts = { ...ZERO_COUNTS, facebook: 3, instagram: 1 };
    const activePeriod = {
      id: 'period-1',
      userId: 'user-1',
      counts: oldCounts,
      startsAt: new Date('2026-05-02T00:00:00.000Z'),
      endsAt: new Date('2026-06-11T00:00:00.000Z'),
      supersededAt: null,
    };
    expect(() => pricePurchase(newCounts, activePeriod, NOW)).toThrowError(/cannot raise/);
  });

  it('reports the upgrade reason for an unchanged plan', () => {
    const oldCounts = { ...ZERO_COUNTS, facebook: 2 };
    const activePeriod = {
      id: 'period-1',
      userId: 'user-1',
      counts: oldCounts,
      startsAt: new Date('2026-05-02T00:00:00.000Z'),
      endsAt: new Date('2026-06-11T00:00:00.000Z'),
      supersededAt: null,
    };
    expect(() => pricePurchase(oldCounts, activePeriod, NOW)).toThrowError(
      /must cost more than the current plan/
    );
  });
});

describe('approvePayment races (audit fix 2026-11-01, fix 14)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('returns the winner period when the claim loses, creating no period', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      periodById: periodRow({ id: 'period-winner' }),
      loseClaimOnce: true,
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period?.id).toBe('period-winner');
    expect(result.payment.status).toBe('approved');
    expect(state.inserted.filter((i) => i.table === 'subscription_periods')).toHaveLength(0);
  });

  it('supersedes the orphan and returns the winner when the link loses', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      createdPeriodRow: periodRow({ id: 'period-new' }),
      periodById: periodRow({ id: 'period-winner' }),
      loseLinkOnce: true,
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period?.id).toBe('period-winner');
    // The orphan period created by the loser is superseded at once,
    // so it can never become the live period.
    const supersede = state.updated.find(
      (u) => u.table === 'subscription_periods' && u.patch['superseded_at'] != null
    );
    expect(supersede).toBeDefined();
  });
});

describe('releaseUsageForFeature (audit fix 2026-11-01, fix 2)', () => {
  it('deletes only the row matching the removed feature', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'destination-queue' },
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'auto-download-upload' },
      ],
    });
    const removed = await releaseUsageForFeature(
      fakeClient(state),
      'user-1',
      'facebook',
      'page-a',
      'auto-download-upload'
    );
    expect(removed).toBe(true);
    expect(state.usageRows).toHaveLength(1);
    expect(state.usageRows[0]).toMatchObject({ feature: 'destination-queue' });
  });

  it('leaves rows alone when the feature does not match', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'destination-queue' },
      ],
    });
    const removed = await releaseUsageForFeature(
      fakeClient(state),
      'user-1',
      'facebook',
      'page-a',
      'auto-download-upload'
    );
    expect(removed).toBe(false);
    expect(state.usageRows).toHaveLength(1);
  });
});

describe('assertFeatureAddWithinCap Publish-Now exclusion (audit fix 2026-11-01, fix 23)', () => {
  it('does not count a Publish-Now-only destination as registered', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'publish-now' },
      ],
    });
    const result = await assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-a'], NOW);
    expect(result).toEqual({ allowed: 1, used: 0, newCount: 1 });
  });

  it('still enforces the cap for capped-feature usage', async () => {
    const state = baseState({
      periods: [periodRow({ facebook_count: 1 })],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-b', feature: 'destination-queue' },
      ],
    });
    await expect(
      assertFeatureAddWithinCap(fakeClient(state), 'user-1', 'facebook', ['page-c'], NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
  });
});

describe('approvePayment stale link (audit fix 2026-11-01, fix 14)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('overwrites a stored period link that resolves to no period row', async () => {
    const state = baseState({
      paymentRow: paymentRow({ period_id: 'period-stale' }),
      periodById: null,
      createdPeriodRow: periodRow({ id: 'period-new' }),
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    expect(result.period?.id).toBe('period-new');
    const linkUpdate = state.updated.find(
      (u) => u.table === 'subscription_payments' && u.patch['period_id'] === 'period-new'
    );
    expect(linkUpdate).toBeDefined();
  });

  it('repairs a claim lost to a winner whose period never resolved, via the stale link', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      periodById: null,
      createdPeriodRow: periodRow({ id: 'period-new' }),
      loseClaimOnce: true,
    });
    const result = await approvePayment(fakeClient(state), 'payment-1', 'admin-1', now);
    // The winner linked 'period-winner', but that row does not
    // resolve here, so the repair path treats it as a stale link
    // and overwrites it with the period it just created.
    expect(result.period?.id).toBe('period-new');
    const linkUpdate = state.updated.find(
      (u) => u.table === 'subscription_payments' && u.patch['period_id'] === 'period-new'
    );
    expect(linkUpdate).toBeDefined();
  });
});


describe('entitlement failure branches (audit fix 2026-11-01)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('releaseUsageForFeature fails closed when the delete errors', async () => {
    const state = baseState({
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'page-a', feature: 'destination-queue' },
      ],
      deleteErrors: { subscription_usage: { code: '500' } },
    });
    await expect(
      releaseUsageForFeature(fakeClient(state), 'user-1', 'facebook', 'page-a', 'destination-queue')
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
  });

  it('createPeriodForPayment fails closed when the replaced-period lookup errors', async () => {
    const state = baseState({
      selectErrors: { subscription_periods: { code: '500' } },
    });
    const payment = paymentFromRow(paymentRow({ is_upgrade: true }));
    if (!payment) throw new Error('test payment did not map');
    await expect(createPeriodForPayment(fakeClient(state), payment, now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
  });

  it('an upgrade whose refund cancel fails still activates, loudly', async () => {
    const state = baseState({
      periods: [periodRow()],
      createdPeriodRow: periodRow({ id: 'period-new' }),
      updateErrors: { refund_requests: { code: '500' } },
    });
    const payment = paymentFromRow(paymentRow({ is_upgrade: true }));
    if (!payment) throw new Error('test payment did not map');
    const period = await createPeriodForPayment(fakeClient(state), payment, now);
    expect(period.id).toBe('period-new');
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] upgrade refund cancel did not land; upgrade proceeds',
      expect.anything(),
      expect.objectContaining({ userId: 'user-1' })
    );
  });

  it('a link lost with no winner period fails closed instead of linking nothing', async () => {
    const state = baseState({
      paymentRow: paymentRow(),
      periodById: null,
      createdPeriodRow: periodRow({ id: 'period-new' }),
      loseLinkOnce: true,
    });
    await expect(approvePayment(fakeClient(state), 'payment-1', 'admin-1', now)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
  });

});

describe('Perf round 1: entitlement reads run concurrently', () => {
  // A fake client that records every query's start / resolve order.
  // The fake resolves synchronously, so with sequential awaits each
  // resolve precedes the next start, while with Promise.all all
  // starts precede the first resolve. That ordering difference is
  // what these tests observe — no production data, no network.
  class RecordingBuilder extends FakeBuilder {
    private readonly tableName: string;

    constructor(
      state: FakeState,
      table: string,
      private readonly events: string[]
    ) {
      super(state, table);
      this.tableName = table;
    }

    override then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: Record<string, unknown>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
      this.events.push(`start:${this.tableName}`);
      const wrappedFulfilled = onfulfilled
        ? (value: Record<string, unknown>) => {
            this.events.push(`resolve:${this.tableName}`);
            return onfulfilled(value);
          }
        : null;
      const wrappedRejected = onrejected
        ? (reason: unknown) => {
            this.events.push(`resolve:${this.tableName}`);
            return onrejected(reason);
          }
        : null;
      return super.then(wrappedFulfilled, wrappedRejected);
    }
  }

  function recordingClient(state: FakeState): {
    client: SupabaseClient;
    events: string[];
  } {
    const events: string[] = [];
    const client = {
      from: (table: string) => new RecordingBuilder(state, table, events),
    } as unknown as SupabaseClient;
    return { client, events };
  }

  // The six platform counts must all start before the first one
  // resolves, and the usage chain must start before the period
  // read resolves — i.e. the reads overlap instead of queueing.
  function expectUsageCountsConcurrent(events: string[]): void {
    const usageEvents = events.filter(
      (event) => event === 'start:subscription_usage' || event === 'resolve:subscription_usage'
    );
    expect(usageEvents.filter((event) => event.startsWith('start:'))).toHaveLength(6);
    expect(usageEvents.indexOf('resolve:subscription_usage')).toBe(
      usageEvents.lastIndexOf('start:subscription_usage') + 1
    );
    expect(events.indexOf('start:workspaces')).toBeLessThan(
      events.indexOf('resolve:subscription_periods')
    );
  }

  it('paid user: same entitlement data, counts + period read concurrently', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageCounts: { facebook: 2, instagram: 1, threads: 4, x: 0, tiktok: 3, youtube: 5 },
    });
    const { client, events } = recordingClient(state);
    const entitlement = await getEntitlement(client, 'user-1', NOW);
    expect(entitlement.plan).toBe('paid');
    expect(entitlement.active).toBe(true);
    expect(entitlement.counts).toEqual(TEN_COUNTS);
    expect(entitlement.usage).toEqual({
      facebook: 2,
      instagram: 1,
      threads: 4,
      x: 0,
      tiktok: 3,
      youtube: 5,
    });
    expect(entitlement.period?.id).toBe('period-1');
    expect(entitlement.canPost).toBe(true);
    expect(entitlement.readOnly).toBe(false);
    expect(entitlement.reason).toBeNull();
    expect(entitlement.hasPriorPeriod).toBe(true);
    expectUsageCountsConcurrent(events);
  });

  it('free user: same entitlement data, counts + period read concurrently', async () => {
    const state = baseState({ usageCounts: { facebook: 1, threads: 2 } });
    const { client, events } = recordingClient(state);
    const entitlement = await getEntitlement(client, 'user-1', NOW);
    expect(entitlement.plan).toBe('free');
    expect(entitlement.active).toBe(false);
    expect(entitlement.counts).toEqual(ZERO_COUNTS);
    expect(entitlement.usage).toEqual({
      facebook: 1,
      instagram: 0,
      threads: 2,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
    expect(entitlement.period).toBeNull();
    expect(entitlement.canPost).toBe(false);
    expect(entitlement.readOnly).toBe(true);
    expect(entitlement.reason).toContain('Prompt Library only');
    expect(entitlement.hasPriorPeriod).toBe(false);
    expectUsageCountsConcurrent(events);
  });

  it('paid user with a disconnected destination: exclusion survives the parallel counts', async () => {
    const state = baseState({
      periods: [periodRow()],
      workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
      destinations: [
        { id: 'dest-active', workspace_id: 'ws-1', platform: 'facebook', status: 'active' },
        { id: 'dest-disc', workspace_id: 'ws-1', platform: 'facebook', status: 'disconnected' },
      ],
      usageRows: [
        {
          user_id: 'user-1',
          platform: 'facebook',
          destination_key: 'page-a',
          destination_id: 'dest-active',
          feature: 'destination-queue',
        },
        {
          user_id: 'user-1',
          platform: 'facebook',
          destination_key: 'page-b',
          destination_id: 'dest-disc',
          feature: 'destination-queue',
        },
        {
          user_id: 'user-1',
          platform: 'facebook',
          destination_key: 'page-c',
          destination_id: 'dest-disc',
          feature: 'destination-queue',
        },
        {
          user_id: 'user-1',
          platform: 'instagram',
          destination_key: 'acct-a',
          destination_id: null,
          feature: 'destination-queue',
        },
      ],
    });
    const entitlement = await getEntitlement(fakeClient(state), 'user-1', NOW);
    expect(entitlement.plan).toBe('paid');
    // facebook: 3 rows, 2 linked to the disconnected destination.
    expect(entitlement.usage).toMatchObject({ facebook: 1, instagram: 1 });
    expect(entitlement.counts).toEqual(TEN_COUNTS);
  });
});
