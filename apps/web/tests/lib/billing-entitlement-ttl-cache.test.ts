import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  approveRefund,
  assertCanPost,
  assertFeatureAddWithinCap,
  assertPaidPlan,
  createPeriodForPurchase,
  ENTITLEMENT_CACHE_TTL_MS,
  getEntitlementCached,
  invalidateEntitlementCache,
  registerUsage,
  releaseUsageForFeature,
} from '@/lib/billing/entitlement';
import { logServerError } from '@/lib/server-analytics';
import { POST as decidePayment } from '@/app/api/admin/payments/[paymentId]/route';
import { POST as postZeroDue } from '@/app/api/tenant/[subdomain]/billing/payments/zero-due/route';

/**
 * Plan-check S1 — short server-side entitlement cache (30 s TTL).
 *
 * Tested against a small thenable fake Supabase client — no real
 * database. The fake mirrors the real client's shape the code
 * relies on: chainable filters, a thenable select/insert/update/
 * delete result, maybeSingle/single terminals, and a counting
 * `get_entitlement` RPC computed from the fixture tables the way
 * the SQL function does (active-period window, per-platform usage
 * counts with the legacy publish-now exclusion, ever-paid flag).
 *
 * The cache itself is module-level in `entitlement.ts`, so every
 * test uses a FRESH fake client object (a fresh WeakMap key) and,
 * where it matters, a distinct user id — no test can read another
 * test's cached entry.
 *
 * Two notes on coverage limits, stated plainly:
 * - The hit-validation branch (wrong-user period, bad plan value,
 *   missing counts) is defence-in-depth: no answer the raw read can
 *   produce through the public API fails it (`parseEntitlementRpcResult`
 *   and `buildEntitlement` already enforce the same invariants), so
 *   no public-API test can plant a corrupt entry. It is covered by
 *   the clone-failure fall-through tests below (same code path:
 *   invalid/uncloneable entry → delete, loud log, live re-read) and
 *   by the wrong-user raw-read test, which pins that a period for
 *   another user is never cached in the first place.
 * - `getCachedEntitlement` (the React-cache layer) is not re-tested
 *   here: the existing `entitlement-shared-read.test.ts` pin stays
 *   green unmodified (criterion 9), and the full suite covers the
 *   two RSC call sites (criterion 13).
 */

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const mockedLogServerError = vi.mocked(logServerError);

const authState = vi.hoisted(() => ({ role: 'admin', userId: 'user-1' }));
const clientHolder = vi.hoisted(() => ({ client: null as unknown as SupabaseClient }));
const couponMock = vi.hoisted(() => ({
  applyFailsOnce: false,
  applyHook: null as null | (() => Promise<unknown>),
}));

vi.mock('@/lib/route-auth', () => ({
  authenticateAdminRoute: vi.fn(async () => ({
    session: {
      userId: authState.userId,
      email: 'admin@example.com',
      name: 'Admin',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: authState.userId,
      email: 'buyer@example.com',
      name: 'Buyer',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => clientHolder.client,
    lookupBillingIdempotency: () => ({ key: null, replay: null }),
    storeBillingIdempotency: () => Promise.resolve(),
  };
});

vi.mock('@/lib/billing/coupons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/coupons')>();
  return {
    ...actual,
    applyRedemption: async (...args: Parameters<typeof actual.applyRedemption>) => {
      if (couponMock.applyFailsOnce) {
        couponMock.applyFailsOnce = false;
        // The test may install a hook that runs while the redemption
        // is being applied — e.g. a concurrent read on the same
        // instance, which is exactly the window the W4 orphan-guard
        // invalidation closes.
        if (couponMock.applyHook) await couponMock.applyHook();
        throw new Error('apply down');
      }
      return actual.applyRedemption(...args);
    },
  };
});

type Row = Record<string, unknown>;

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

const PLATFORMS = ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube'] as const;
const LEGACY_FEATURES = ['publish-now', 'instagram-publish-now', 'threads-publish-now'];

function periodRow(overrides: Row = {}): Row {
  return {
    id: 'period-1',
    user_id: 'user-1',
    payment_id: null,
    facebook_count: 10,
    instagram_count: 10,
    threads_count: 10,
    x_count: 10,
    tiktok_count: 10,
    youtube_count: 10,
    starts_at: '2026-06-01T00:00:00.000Z',
    ends_at: '2026-07-01T00:00:00.000Z',
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
    facebook_count: 1,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 70,
    is_upgrade: false,
    is_downgrade: false,
    scheduled_starts_at: null,
    rejection_reason: null,
    rejection_detail: null,
    override_reason: null,
    decided_at: null,
    screenshot_storage_key: 'billing-screenshots/user-1/shot.jpg',
    coupon_code: null,
    discount_pkr: 0,
    period_id: null,
    approved_at: null,
    created_at: '2026-06-01T00:00:00.000Z',
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
    amount_paid: 420,
    currency: 'PKR',
    refund_amount: null,
    days_used: null,
    destination_type: 'mobile',
    destination_value: '03001234567',
    reason: 'changed my mind',
    requested_at: '2026-06-02T00:00:00.000Z',
    decided_at: null,
    sent_at: null,
    ...overrides,
  };
}

function couponRow(overrides: Row = {}): Row {
  return {
    id: 'coupon-1',
    code: 'FREE100',
    kind: 'percent_multi',
    percent: 100,
    initial_balance_pkr: 0,
    remaining_balance_pkr: 0,
    consumed_at: null,
    status: 'active',
    created_by: 'admin-1',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeState {
  periods: Row[];
  payments: Row[];
  usageRows: Row[];
  usageCounts: Partial<Record<string, number>>;
  refundRequests: Row[];
  sellerCommissions: Row[];
  users: Row[];
  coupons: Row[];
  redemptions: Row[];
  rpcCalls: number;
  rpcWrongUser: boolean;
  rpcError: unknown;
  periodInsertError: unknown;
  usageInsertError: { code?: string } | null;
  selectErrors: Partial<Record<string, unknown>>;
  periodSeq: number;
  redemptionSeq: number;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    periods: [],
    payments: [],
    usageRows: [],
    usageCounts: {},
    refundRequests: [],
    sellerCommissions: [],
    users: [],
    coupons: [],
    redemptions: [],
    rpcCalls: 0,
    rpcWrongUser: false,
    rpcError: null,
    periodInsertError: null,
    usageInsertError: null,
    selectErrors: {},
    periodSeq: 0,
    redemptionSeq: 0,
    ...overrides,
  };
}

type Filter = { op: 'eq' | 'is' | 'lte' | 'gt' | 'gte' | 'neq' | 'in'; col: string; val: unknown };

function tableRows(state: FakeState, table: string): Row[] {
  switch (table) {
    case 'subscription_periods':
      return state.periods;
    case 'subscription_payments':
      return state.payments;
    case 'subscription_usage':
      return state.usageRows;
    case 'refund_requests':
      return state.refundRequests;
    case 'seller_commissions':
      return state.sellerCommissions;
    case 'users':
      return state.users;
    case 'coupons':
      return state.coupons;
    case 'coupon_redemptions':
      return state.redemptions;
    default:
      return [];
  }
}

function matchesFilter(row: Row, filter: Filter): boolean {
  const v = row[filter.col];
  switch (filter.op) {
    case 'eq':
      return v === filter.val;
    case 'is':
      return filter.val === null ? v == null : v === filter.val;
    case 'lte':
      return String(v) <= String(filter.val);
    case 'gt':
      return String(v) > String(filter.val);
    case 'gte':
      return String(v) >= String(filter.val);
    case 'neq':
      return v !== filter.val;
    case 'in':
      return Array.isArray(filter.val) && (filter.val as unknown[]).includes(v);
    default:
      return true;
  }
}

class FakeBuilder {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private headCount = false;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private insertRow: Row | null = null;
  private patch: Row | null = null;
  private insertedRow: Row | null = null;

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

  gte(col: string, val: unknown): this {
    this.filters.push({ op: 'gte', col, val });
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
    this.insertRow = { ...row };
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.patch = { ...patch };
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const err = this.state.selectErrors[this.table];
    if (err) return { data: null, error: err };
    const rows = this.filteredRows();
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    if (this.op === 'insert') {
      const computed = this.compute();
      return { data: (computed as { data: unknown }).data, error: (computed as { error: unknown }).error };
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

  private filteredRows(): Row[] {
    let rows = [...tableRows(this.state, this.table)];
    for (const filter of this.filters) {
      rows = rows.filter((row) => matchesFilter(row, filter));
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
    return rows;
  }

  private compute(): Record<string, unknown> {
    if (this.op === 'insert') {
      if (this.table === 'subscription_periods' && this.state.periodInsertError) {
        const err = this.state.periodInsertError;
        this.state.periodInsertError = null;
        return { data: null, error: err };
      }
      if (this.table === 'subscription_usage' && this.state.usageInsertError) {
        const err = this.state.usageInsertError;
        this.state.usageInsertError = null;
        return { data: null, error: err };
      }
      const row = this.insertRow ?? {};
      if (this.table === 'subscription_usage') {
        const clash = this.state.usageRows.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
        this.state.usageRows.push({ ...row });
        this.insertedRow = { ...row };
        return { data: null, error: null };
      }
      if (this.table === 'subscription_periods') {
        this.state.periodSeq += 1;
        const created: Row = {
          id: `period-${this.state.periodSeq}`,
          user_id: row['user_id'],
          payment_id: row['payment_id'] ?? null,
          facebook_count: row['facebook_count'] ?? 0,
          instagram_count: row['instagram_count'] ?? 0,
          threads_count: row['threads_count'] ?? 0,
          x_count: row['x_count'] ?? 0,
          tiktok_count: row['tiktok_count'] ?? 0,
          youtube_count: row['youtube_count'] ?? 0,
          starts_at: row['starts_at'],
          ends_at: row['ends_at'],
          superseded_at: null,
        };
        this.state.periods.push(created);
        this.insertedRow = { ...created };
        return { data: this.insertedRow, error: null };
      }
      if (this.table === 'coupon_redemptions') {
        this.state.redemptionSeq += 1;
        const created: Row = {
          id: `red-${this.state.redemptionSeq}`,
          ...row,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        };
        this.state.redemptions.push(created);
        this.insertedRow = { ...created };
        return { data: this.insertedRow, error: null };
      }
      tableRows(this.state, this.table).push({ ...row });
      this.insertedRow = { ...row };
      return { data: this.insertedRow, error: null };
    }
    if (this.op === 'delete') {
      const rows = tableRows(this.state, this.table);
      const deleted: Row[] = [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (this.filters.every((f) => matchesFilter(rows[i] as Row, f))) {
          deleted.push(rows[i] as Row);
          rows.splice(i, 1);
        }
      }
      return { data: deleted, error: null };
    }
    if (this.op === 'update') {
      const rows = this.filteredRows();
      for (const row of rows) Object.assign(row, this.patch ?? {});
      return { data: rows, error: null };
    }
    const err = this.state.selectErrors[this.table];
    if (err) return { data: null, error: err, count: null };
    if (this.headCount) {
      const platform = this.filters.find((f) => f.col === 'platform')?.val as string | undefined;
      if (platform) {
        const override = this.state.usageCounts[platform];
        if (override !== undefined) return { count: override, error: null };
      }
      return { count: this.filteredRows().length, error: null };
    }
    return { data: this.filteredRows(), error: null };
  }
}

/**
 * The `get_entitlement` RPC answer, computed from this fake's own
 * state the way the SQL function does. A real implementation
 * against the fixture tables, not a canned success.
 */
function computeEntitlementRpc(state: FakeState, userId: string, nowIso: string): Row {
  const periods = state.periods.filter((row) => row['user_id'] === userId);
  const sortedActive = periods
    .filter(
      (row) =>
        row['superseded_at'] == null &&
        typeof row['starts_at'] === 'string' &&
        (row['starts_at'] as string) <= nowIso &&
        typeof row['ends_at'] === 'string' &&
        (row['ends_at'] as string) > nowIso
    )
    .sort((a, b) => String(b['ends_at']).localeCompare(String(a['ends_at'])));
  const active: Row | null = sortedActive.length > 0 ? { ...sortedActive[0] } : null;
  if (active && state.rpcWrongUser) active['user_id'] = 'user-OTHER';
  const usage: Row = {};
  for (const platform of PLATFORMS) {
    const override = state.usageCounts[platform];
    if (override !== undefined) {
      usage[platform] = override;
      continue;
    }
    usage[platform] = state.usageRows.filter(
      (row) =>
        row['user_id'] === userId &&
        row['platform'] === platform &&
        !LEGACY_FEATURES.includes(row['feature'] as string)
    ).length;
  }
  return {
    period: active,
    usage,
    has_prior_period: periods.length > 0,
  };
}

function fakeClient(state: FakeState): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(state, table),
    rpc: (fn: string, args: { p_user_id: string; p_now: string }) => {
      if (fn !== 'get_entitlement') {
        return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
      }
      state.rpcCalls += 1;
      if (state.rpcError) {
        return Promise.resolve({ data: null, error: state.rpcError });
      }
      return Promise.resolve({
        data: computeEntitlementRpc(state, args.p_user_id, args.p_now),
        error: null,
      });
    },
  } as unknown as SupabaseClient;
}

const T0 = new Date('2026-06-01T00:00:00.000Z');
const PAID_COUNTS = { ...ZERO_COUNTS, facebook: 2, instagram: 2, threads: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  authState.role = 'admin';
  authState.userId = 'user-1';
  couponMock.applyFailsOnce = false;
  couponMock.applyHook = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TTL expiry (criterion 1)', () => {
  it('serves the first answer with zero RPCs inside 30 s and re-reads after 30 s', async () => {
    expect(ENTITLEMENT_CACHE_TTL_MS).toBe(30_000);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    const first = await getEntitlementCached(client, 'user-1');
    expect(first.plan).toBe('paid');
    expect(state.rpcCalls).toBe(1);

    vi.setSystemTime(new Date(T0.getTime() + 29_000));
    const second = await getEntitlementCached(client, 'user-1');
    expect(second.plan).toBe('paid');
    expect(state.rpcCalls).toBe(1);

    vi.setSystemTime(new Date(T0.getTime() + 31_000));
    const third = await getEntitlementCached(client, 'user-1');
    expect(third.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);
  });
});

describe('per-instance invalidation (criterion 3)', () => {
  it('a write invalidates only the writing instance; the other instance serves stale until TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = baseState();
    // Two client objects over the same database = two serverless
    // instances. Each reads once (1 RPC each); both cache free.
    const clientA = fakeClient(state);
    const clientB = fakeClient(state);
    await expect(getEntitlementCached(clientA, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    await expect(getEntitlementCached(clientB, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(2);

    // The period is created out-of-band (another instance / the
    // worker), then invalidated on instance A only.
    state.periods.push(periodRow());
    invalidateEntitlementCache(clientA, 'user-1');
    const rpcBefore = state.rpcCalls;
    const stale = await getEntitlementCached(clientB, 'user-1');
    expect(stale.plan).toBe('free');
    expect(state.rpcCalls).toBe(rpcBefore);

    // The TTL — not the invalidation — is the cross-instance
    // guarantee: 31 s later instance B re-reads and sees paid.
    vi.setSystemTime(new Date(T0.getTime() + 31_000));
    const fresh = await getEntitlementCached(clientB, 'user-1');
    expect(fresh.plan).toBe('paid');
    expect(state.rpcCalls).toBe(rpcBefore + 1);
  });
});

describe('no cross-user leakage (criterion 4)', () => {
  it('never serves user A’s answer to user B, and never shares across client instances', async () => {
    const state = baseState({
      periods: [periodRow({ user_id: 'user-A' })],
    });
    const client = fakeClient(state);
    const a = await getEntitlementCached(client, 'user-A');
    expect(a.plan).toBe('paid');
    expect(state.rpcCalls).toBe(1);

    const b = await getEntitlementCached(client, 'user-B');
    expect(b.plan).toBe('free');
    expect(state.rpcCalls).toBe(2);

    const aAgain = await getEntitlementCached(client, 'user-A');
    expect(aAgain.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);

    // Same user id, different client instance: a miss, not a share.
    const otherClient = fakeClient(state);
    const aOtherClient = await getEntitlementCached(otherClient, 'user-A');
    expect(aOtherClient.plan).toBe('paid');
    expect(state.rpcCalls).toBe(3);
  });
});

describe('just-paid / just-expired display staleness bounded at 30 s (criterion 5)', () => {
  it('a cached free answer is replaced by paid at most 30 s after the write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = baseState();
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    state.periods.push(periodRow());
    vi.setSystemTime(new Date(T0.getTime() + 29_000));
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    vi.setSystemTime(new Date(T0.getTime() + 31_000));
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(2);
  });

  it('a cached paid answer is replaced by expired at most 30 s after the supersede', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    state.periods[0]!['superseded_at'] = T0.toISOString();
    vi.setSystemTime(new Date(T0.getTime() + 29_000));
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    vi.setSystemTime(new Date(T0.getTime() + 31_000));
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'expired' });
    expect(state.rpcCalls).toBe(2);
  });
});

describe('concurrent in-flight dedup (criterion 10)', () => {
  it('22 concurrent reads on a cold cache issue exactly 1 RPC', async () => {
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    const answers = await Promise.all(
      Array.from({ length: 22 }, () => getEntitlementCached(client, 'user-1'))
    );
    expect(state.rpcCalls).toBe(1);
    expect(answers).toHaveLength(22);
    for (const answer of answers) expect(answer.plan).toBe('paid');
  });
});

describe('clone isolation (criterion 11)', () => {
  it('mutating a returned entitlement does not change the next read’s answer', async () => {
    const state = baseState({
      periods: [periodRow()],
      usageRows: [
        { user_id: 'user-1', platform: 'facebook', destination_key: 'dest-1', feature: 'queue' },
      ],
    });
    const client = fakeClient(state);
    const first = await getEntitlementCached(client, 'user-1');
    expect(first.usage.facebook).toBe(1);
    first.usage.facebook = 99;
    const second = await getEntitlementCached(client, 'user-1');
    expect(second.usage.facebook).toBe(1);
    expect(state.rpcCalls).toBe(1);
  });
});

describe('size bound (criterion 12)', () => {
  it('inserting past 5,000 entries evicts the oldest and never throws', async () => {
    const state = baseState();
    const client = fakeClient(state);
    for (let i = 0; i < 5001; i += 1) {
      await getEntitlementCached(client, `user-${i}`);
    }
    expect(state.rpcCalls).toBe(5001);

    // The oldest entry is gone: a re-read pays a fresh RPC.
    await getEntitlementCached(client, 'user-0');
    expect(state.rpcCalls).toBe(5002);

    // A recent entry is still cached: zero RPCs.
    await getEntitlementCached(client, 'user-5000');
    expect(state.rpcCalls).toBe(5002);
  });
});

describe('invalidation on each plan write (criterion 2)', () => {
  it('W1: createPeriodForPurchase invalidates, so the next read re-reads paid', async () => {
    const state = baseState();
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    const period = await createPeriodForPurchase(client, {
      userId: 'user-1',
      counts: PAID_COUNTS,
      paymentId: null,
    });
    expect(period.id).toBe('period-1');

    const after = await getEntitlementCached(client, 'user-1');
    expect(after.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);
  });

  it('W2: the admin approve route invalidates on a schedule-only approval, where W1 never runs', async () => {
    // A live period plus a downgrade payment: approval records the
    // schedule only and creates NO period, so createPeriodForPurchase
    // (W1) never runs — only the route-level W2 call can invalidate.
    const state = baseState({
      periods: [periodRow()],
      payments: [paymentRow({ is_downgrade: true })],
    });
    const client = fakeClient(state);
    clientHolder.client = client;
    authState.role = 'admin';

    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    const req = new NextRequest('http://localhost:3000/api/admin/payments/payment-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const res = await decidePayment(req, {
      params: Promise.resolve({ paymentId: 'payment-1' }),
    } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { scheduled?: boolean };
    expect(json.scheduled).toBe(true);

    const after = await getEntitlementCached(client, 'user-1');
    expect(after.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);
  });

  it('W2: the admin approve route invalidates on a normal approval too', async () => {
    const state = baseState({ payments: [paymentRow()] });
    const client = fakeClient(state);
    clientHolder.client = client;
    authState.role = 'admin';

    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    const req = new NextRequest('http://localhost:3000/api/admin/payments/payment-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const res = await decidePayment(req, {
      params: Promise.resolve({ paymentId: 'payment-1' }),
    } as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { period?: { id: string } };
    expect(json.period?.id).toBe('period-1');

    const after = await getEntitlementCached(client, 'user-1');
    expect(after.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);
  });

  it('W3: approveRefund invalidates, so the next read re-reads expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));
    const state = baseState({
      periods: [periodRow()],
      refundRequests: [refundRow()],
    });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    const approved = await approveRefund(client, 'refund-1', 'admin-1');
    expect(approved.status).toBe('approved');

    const after = await getEntitlementCached(client, 'user-1');
    expect(after.plan).toBe('expired');
    expect(state.rpcCalls).toBe(2);
  });

  it('W4: the zero-due orphan guard invalidates after superseding the just-created period', async () => {
    const state = baseState({ coupons: [couponRow()] });
    const client = fakeClient(state);
    clientHolder.client = client;
    authState.role = 'user';
    couponMock.applyFailsOnce = true;
    // A concurrent read on the same instance lands between the
    // period creation and the orphan-guard supersede: W1 already
    // invalidated the seeded free entry, so this read caches PAID.
    // Only the W4 invalidation in the guard can clear it — without
    // that line, the read after the POST would serve stale paid.
    couponMock.applyHook = async () => {
      const midFlight = await getEntitlementCached(client, 'user-1');
      expect(midFlight.plan).toBe('paid');
    };

    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/billing/payments/zero-due',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          counts: { ...ZERO_COUNTS, facebook: 1 },
          couponCode: 'FREE100',
        }),
      }
    );
    const res = await postZeroDue(req, {
      params: Promise.resolve({ subdomain: 'acme' }),
    } as never);
    expect(res.status).toBe(500);
    // The orphan guard superseded the period it just created.
    expect(state.periods).toHaveLength(1);
    expect(state.periods[0]!['superseded_at']).not.toBeNull();
    // Seed (1) + mid-flight paid read (1) = 2 RPCs so far.
    expect(state.rpcCalls).toBe(2);

    // The W4 invalidation means the next read re-reads (1 RPC) and
    // sees the superseded period as no plan — without it, the read
    // would be a stale paid hit at 0 RPCs.
    const after = await getEntitlementCached(client, 'user-1');
    expect(after.plan).toBe('free');
    expect(state.rpcCalls).toBe(3);
  });

  it('W5 (best-effort): registerUsage and releaseUsageForFeature invalidate the display counts', async () => {
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    const registered = await registerUsage(client, 'user-1', 'facebook', 'dest-1', 'queue');
    expect(registered.alreadyUsed).toBe(false);
    expect(registered.usedCount).toBe(1);
    const afterRegister = await getEntitlementCached(client, 'user-1');
    expect(afterRegister.usage.facebook).toBe(1);
    expect(state.rpcCalls).toBe(3);

    const released = await releaseUsageForFeature(client, 'user-1', 'facebook', 'dest-1', 'queue');
    expect(released).toBe(true);
    const afterRelease = await getEntitlementCached(client, 'user-1');
    expect(afterRelease.usage.facebook).toBe(0);
    expect(state.rpcCalls).toBe(4);
  });
});

describe('gates never read the cache (criterion 6)', () => {
  it('with a warm stale-free cache, every gate still reads live and allows', async () => {
    const state = baseState();
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'free' });
    expect(state.rpcCalls).toBe(1);

    // The period lands out-of-band: the cache still says free.
    state.periods.push(periodRow());

    const before = state.rpcCalls;
    const period = await assertCanPost(client, 'user-1', 'facebook', 'dest-1');
    expect(period.id).toBe('period-1');
    expect(state.rpcCalls).toBeGreaterThan(before);

    const add = await assertFeatureAddWithinCap(client, 'user-1', 'facebook', ['dest-2']);
    expect(add).toEqual({ allowed: 10, used: 0, newCount: 1 });
    expect(state.rpcCalls).toBeGreaterThan(before + 1);

    // Neither gate above invalidates or refreshes the cache: the
    // display read still serves the stale free answer for free.
    const stillCached = await getEntitlementCached(client, 'user-1');
    expect(stillCached.plan).toBe('free');
    expect(state.rpcCalls).toBe(before + 2);

    const registered = await registerUsage(client, 'user-1', 'facebook', 'dest-1', 'queue');
    expect(registered.alreadyUsed).toBe(false);
    expect(state.rpcCalls).toBeGreaterThan(before + 2);

    // assertPaidPlan reads the live period row directly (no RPC),
    // so only its behaviour — not an RPC count — pins it here.
    const paidPeriod = await assertPaidPlan(client, 'user-1');
    expect(paidPeriod.id).toBe('period-1');
    expect(state.rpcCalls).toBe(before + 3);
  });

  it('with a warm stale-paid cache, every gate still reads live and blocks', async () => {
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    // The period is superseded out-of-band: the cache still says paid.
    state.periods[0]!['superseded_at'] = T0.toISOString();

    const before = state.rpcCalls;
    await expect(assertCanPost(client, 'user-1', 'facebook', 'dest-1')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
    });
    expect(state.rpcCalls).toBeGreaterThan(before);

    await expect(
      assertFeatureAddWithinCap(client, 'user-1', 'facebook', ['dest-2'])
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
    await expect(
      registerUsage(client, 'user-1', 'facebook', 'dest-1', 'queue')
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
    await expect(assertPaidPlan(client, 'user-1')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
    });
  });
});

describe('cache error falls through to the live read (criterion 7)', () => {
  it('a clone failure on a hit deletes the entry and re-reads live', async () => {
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(1);

    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw new Error('clone down');
    });
    try {
      const answer = await getEntitlementCached(client, 'user-1');
      expect(answer.plan).toBe('paid');
    } finally {
      spy.mockRestore();
    }
    expect(state.rpcCalls).toBe(2);
    expect(mockedLogServerError).toHaveBeenCalledWith(
      '[billing] cached entitlement clone failed, re-reading live',
      expect.anything(),
      { source: 'billing', userId: 'user-1' }
    );
    // The corrupt entry is gone: the next read re-reads live again.
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(3);
  });

  it('a clone failure on a miss deletes the entry and re-reads live', async () => {
    const state = baseState({ periods: [periodRow()] });
    const client = fakeClient(state);
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw new Error('clone down');
    });
    try {
      const answer = await getEntitlementCached(client, 'user-1');
      expect(answer.plan).toBe('paid');
    } finally {
      spy.mockRestore();
    }
    // One RPC for the miss, one for the fall-through re-read.
    expect(state.rpcCalls).toBe(2);
    // The entry was deleted: the next read is a miss again.
    await expect(getEntitlementCached(client, 'user-1')).resolves.toMatchObject({ plan: 'paid' });
    expect(state.rpcCalls).toBe(3);
  });

  it('a wrong-user RPC answer throws, caches nothing, and the next read retries live', async () => {
    const state = baseState({ periods: [periodRow()], rpcWrongUser: true });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(state.rpcCalls).toBe(1);

    state.rpcWrongUser = false;
    const answer = await getEntitlementCached(client, 'user-1');
    expect(answer.plan).toBe('paid');
    expect(state.rpcCalls).toBe(2);
  });

  it('a raw-read failure caches nothing: the next read retries live', async () => {
    const state = baseState({ rpcError: { message: 'db down' } });
    const client = fakeClient(state);
    await expect(getEntitlementCached(client, 'user-1')).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
    expect(state.rpcCalls).toBe(1);

    state.rpcError = null;
    const answer = await getEntitlementCached(client, 'user-1');
    expect(answer.plan).toBe('free');
    expect(state.rpcCalls).toBe(2);
  });

  it('invalidateEntitlementCache never throws and performs no I/O', () => {
    const state = baseState();
    const client = fakeClient(state);
    expect(() => invalidateEntitlementCache(client, 'user-1')).not.toThrow();
    expect(state.rpcCalls).toBe(0);
  });
});
