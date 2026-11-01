import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyRefundOutcomeToCommission,
  changeReferralCode,
  createSeller,
  decidePayoutRequest,
  deleteSeller,
  getCurrentReferralCode,
  getSellerBalances,
  getSellerPayoutDetails,
  getSellerPurchaserCount,
  getSellerSettings,
  getSellerSignupCount,
  hasUnresolvedRefundRequest,
  listAdminPayoutRequests,
  listReferralCodes,
  listReferredUsers,
  listSellerCommissions,
  listSellerPayoutRequests,
  listSellers,
  recordCommissionForPayment,
  refreshSellerCommissions,
  requestPayout,
  resolveReferralCode,
  saveSellerPayoutDetails,
  SellerError,
  updateSeller,
} from './sellers';

/**
 * In-memory stand-in for the Supabase query builder, covering
 * exactly the shapes sellers.ts uses: select (with count/head),
 * insert/select, update/select, delete, upsert, or-filters, and
 * the auth.admin stub. Filters AND together; a conditional
 * update only lands on rows still matching every filter.
 */
type Row = Record<string, unknown>;

interface TableError {
  code: string;
  message: string;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `id-${idSeq}`;
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private orderKey: string | null = null;
  private orderAsc = true;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  private selectCalled = false;
  private countMode = false;
  private headMode = false;

  constructor(
    private readonly db: Record<string, Row[]>,
    private readonly tableErrors: Record<string, TableError | undefined>,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete' | 'upsert',
    private readonly payload: Row | Row[] | null,
    private readonly onConflict?: string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectCalled = true;
    if (opts?.count === 'exact') this.countMode = true;
    if (opts?.head) this.headMode = true;
    return this;
  }

  insert(): this {
    return this;
  }

  update(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  neq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] !== value);
    return this;
  }

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  is(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  or(filter: string): this {
    const parts = filter.split(',').map((part) => {
      const match = part.match(/^(.+?)\.(eq|ilike)\.(.+)$/);
      if (!match) return () => false;
      const [, field, op, raw] = match as [string, string, string, string];
      return (row: Row) => {
        const actual = row[field];
        if (op === 'eq') return actual === raw;
        return (
          typeof actual === 'string' && actual.toLowerCase() === raw.toLowerCase()
        );
      };
    });
    this.filters.push((row) => parts.some((p) => p(row)));
    return this;
  }

  order(key: string, opts?: { ascending?: boolean }): this {
    this.orderKey = key;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private tableError(): TableError | null {
    // Op-scoped keys (e.g. 'seller_commissions:update') fail only
    // that operation, so error paths mid-flow stay reachable even
    // when the same table is read successfully earlier in the flow.
    return this.tableErrors[`${this.table}:${this.op}`] ?? this.tableErrors[this.table] ?? null;
  }

  private matched(): Row[] {
    let rows = (this.db[this.table] ?? []).filter((row) =>
      this.filters.every((f) => f(row))
    );
    if (this.orderKey) {
      const key = this.orderKey;
      rows = [...rows].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (typeof av === 'string' && typeof bv === 'string') {
          return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        if (typeof av === 'number' && typeof bv === 'number') {
          return this.orderAsc ? av - bv : bv - av;
        }
        return 0;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private async run(): Promise<{ data: unknown; error: TableError | null; count?: number }> {
    const tableError = this.tableError();
    if (tableError) {
      // A 23505 insert still lands the row: that is the race the
      // production code handles (a concurrent insert won), so the
      // raced-lookup path after it stays exercisable.
      if (tableError.code === '23505' && this.op === 'insert') {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map(
          (r) => ({ id: nextId(), created_at: new Date().toISOString(), ...r })
        );
        (this.db[this.table] ?? (this.db[this.table] = [])).push(...rows);
      }
      return { data: null, error: tableError };
    }
    const table = this.db[this.table] ?? (this.db[this.table] = []);
    if (this.op === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map(
        (r) => ({
          id: nextId(),
          created_at: new Date().toISOString(),
          // Mirrors the migration default: a fresh code row is current.
          ...(this.table === 'referral_codes' ? { superseded_at: null } : {}),
          ...r,
        })
      );
      table.push(...rows);
      if (!this.selectCalled) return { data: null, error: null };
      return { data: rows, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const matched = this.matched();
      for (const row of matched) Object.assign(row, patch);
      if (!this.selectCalled) return { data: null, error: null };
      return { data: matched, error: null };
    }
    if (this.op === 'delete') {
      const matched = new Set(this.matched());
      this.db[this.table] = table.filter((row) => !matched.has(row));
      return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const row = this.payload as Row;
      const key = this.onConflict ?? 'id';
      const existing = table.find((r) => r[key] === row[key]);
      if (existing) Object.assign(existing, row);
      else table.push({ id: nextId(), created_at: new Date().toISOString(), ...row });
      return { data: null, error: null };
    }
    const matched = this.matched();
    if (this.countMode) {
      return { data: this.headMode ? [] : matched, error: null, count: matched.length };
    }
    return { data: matched, error: null };
  }

  then<TResult1 = { data: unknown; error: TableError | null; count?: number }>(
    onfulfilled?: ((value: { data: unknown; error: TableError | null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    return this.run().then(onfulfilled as never);
  }

  async maybeSingle(): Promise<{ data: unknown; error: TableError | null }> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = (result.data ?? []) as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: unknown; error: TableError | null }> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = (result.data ?? []) as Row[];
    if (rows.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
    }
    return { data: rows[0], error: null };
  }
}

function makeClient(
  seed: Record<string, Row[]> = {},
  tableErrors: Record<string, TableError | undefined> = {},
  authOverrides: Partial<{
    createUser: (input: Row) => Promise<{ data: { user: { id: string } | null }; error: TableError | null }>;
    deleteUser: (id: string) => Promise<{ error: TableError | null }>;
  }> = {}
): { client: SupabaseClient; db: Record<string, Row[]>; auth: { createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> } } {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) {
    db[table] = rows.map((r) => ({ ...r }));
  }
  const createUser = vi.fn(
    authOverrides.createUser ??
      (async () => ({ data: { user: { id: nextId() } }, error: null }))
  );
  const deleteUser = vi.fn(
    authOverrides.deleteUser ?? (async () => ({ error: null }))
  );
  const client = {
    from: (table: string) => ({
      select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
        new FakeQuery(db, tableErrors, table, 'select', null).select(cols, opts),
      insert: (payload: Row | Row[]) =>
        new FakeQuery(db, tableErrors, table, 'insert', payload),
      update: (payload: Row) => new FakeQuery(db, tableErrors, table, 'update', payload),
      delete: () => new FakeQuery(db, tableErrors, table, 'delete', null),
      upsert: (payload: Row, opts?: { onConflict?: string }) =>
        new FakeQuery(db, tableErrors, table, 'upsert', payload, opts?.onConflict),
    }),
    auth: { admin: { createUser, deleteUser } },
  } as unknown as SupabaseClient;
  return { client, db, auth: { createUser, deleteUser } };
}

const SELLER_ID = 'seller-1';
const BUYER_ID = 'buyer-1';

/** Assert a promise rejects with a SellerError carrying this code. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SellerError);
    expect((err as SellerError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but the promise resolved`);
}

function sellerSeed(overrides: Partial<Row> = {}): Record<string, Row[]> {
  return {
    users: [
      { id: SELLER_ID, name: 'Ali', email: 'ali@example.com', role: 'seller', status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
      { id: BUYER_ID, name: 'Bilal', email: 'bilal@example.com', role: 'user', status: 'active', referred_by_seller_id: SELLER_ID, referred_by_code: 'ALI20', created_at: '2026-01-02T00:00:00.000Z' },
    ],
    seller_settings: [
      { user_id: SELLER_ID, rate: 20, scope: 'every', status: 'active' },
    ],
    referral_codes: [
      { id: 'code-1', seller_id: SELLER_ID, code: 'ALI20', superseded_at: null, created_at: '2026-01-01T00:00:00.000Z' },
    ],
    seller_commissions: [],
    seller_payout_requests: [],
    seller_payout_details: [],
    subscription_periods: [],
    refund_requests: [],
  };
}

function commissionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: nextId(),
    seller_id: SELLER_ID,
    user_id: BUYER_ID,
    payment_id: 'pay-1',
    period_id: 'period-1',
    period_starts_at: '2026-01-01T00:00:00.000Z',
    rate_snapshot: 20,
    scope_snapshot: 'every',
    amount_pkr: 1400,
    status: 'pending',
    payout_request_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sellers lib', () => {
  it('resolves current and superseded codes, but not unknown or paused sellers', async () => {
    const { client, db } = makeClient(sellerSeed());
    const resolved = await resolveReferralCode(client, ' ali20 ');
    expect(resolved).toEqual({ sellerId: SELLER_ID, sellerName: 'Ali' });
    expect(await resolveReferralCode(client, 'NOPE')).toBeNull();

    // Superseded code stays valid forever.
    db['referral_codes']!.push({
      id: 'code-2',
      seller_id: SELLER_ID,
      code: 'OLD20',
      superseded_at: '2026-02-01T00:00:00.000Z',
      created_at: '2025-12-01T00:00:00.000Z',
    });
    expect(await resolveReferralCode(client, 'OLD20')).not.toBeNull();

    // Pausing the seller freezes NEW signups.
    db['seller_settings']![0]!['status'] = 'paused';
    expect(await resolveReferralCode(client, 'ALI20')).toBeNull();
  });

  it('changes codes by superseding, and refuses taken codes', async () => {
    const { client, db } = makeClient(sellerSeed());
    const changed = await changeReferralCode(client, SELLER_ID, 'new99');
    expect(changed.code).toBe('NEW99');
    const codes = db['referral_codes']!;
    expect(codes.find((c) => c['code'] === 'ALI20')!['superseded_at']).not.toBeNull();
    expect(codes.find((c) => c['code'] === 'NEW99')!['superseded_at']).toBeNull();

    await expect(changeReferralCode(client, SELLER_ID, 'new99')).rejects.toMatchObject({
      code: 'REFERRAL_CODE_TAKEN',
    });
  });

  it('records every-scope commissions idempotently, and skips unreferred or paused sellers', async () => {
    const { client, db } = makeClient(sellerSeed());
    const payment = { id: 'pay-1', userId: BUYER_ID, amountPkr: 7000 };
    const period = { id: 'period-1', startsAt: new Date('2026-01-01T00:00:00.000Z') };
    const first = await recordCommissionForPayment(client, payment, period);
    expect(first?.amountPkr).toBe(1400);
    expect(first?.rateSnapshot).toBe(20);
    expect(first?.scopeSnapshot).toBe('every');
    const second = await recordCommissionForPayment(client, payment, period);
    expect(second?.id).toBe(first?.id);
    expect(db['seller_commissions']!.length).toBe(1);

    // Unreferred buyer: no commission.
    const unreferred = await recordCommissionForPayment(
      client,
      { id: 'pay-2', userId: 'buyer-2', amountPkr: 7000 },
      { id: 'period-2', startsAt: new Date() }
    );
    expect(unreferred).toBeNull();

    // Paused seller: no commission.
    db['seller_settings']![0]!['status'] = 'paused';
    const paused = await recordCommissionForPayment(
      client,
      { id: 'pay-3', userId: BUYER_ID, amountPkr: 7000 },
      { id: 'period-3', startsAt: new Date() }
    );
    expect(paused).toBeNull();
  });

  it('spends a one-time bounty on the first purchase even when refunded', async () => {
    const seed = sellerSeed();
    seed['seller_settings']![0]!['scope'] = 'one-time';
    seed['subscription_periods']!.push({ id: 'period-old', user_id: BUYER_ID });
    const { client } = makeClient(seed);
    const result = await recordCommissionForPayment(
      client,
      { id: 'pay-9', userId: BUYER_ID, amountPkr: 7000 },
      { id: 'period-new', startsAt: new Date() }
    );
    expect(result).toBeNull();
  });

  it('moves commissions to payable only after 10 days with no unresolved refund', async () => {
    const seed = sellerSeed();
    const old = commissionRow({ id: 'c-old', period_starts_at: '2025-12-01T00:00:00.000Z', payment_id: 'pay-old' });
    const recent = commissionRow({ id: 'c-new', period_starts_at: '2026-01-09T00:00:00.000Z', payment_id: 'pay-new' });
    const blocked = commissionRow({ id: 'c-blocked', period_starts_at: '2025-12-01T00:00:00.000Z', payment_id: 'pay-blocked' });
    seed['seller_commissions']!.push(old, recent, blocked);
    seed['refund_requests']!.push({ id: 'r-1', payment_id: 'pay-blocked', status: 'requested' });
    const { client, db } = makeClient(seed);
    const moved = await refreshSellerCommissions(client, SELLER_ID, new Date('2026-01-11T00:00:00.000Z'));
    expect(moved).toBe(1);
    const rows = db['seller_commissions']!;
    expect(rows.find((r) => r['id'] === 'c-old')!['status']).toBe('payable');
    expect(rows.find((r) => r['id'] === 'c-new')!['status']).toBe('pending');
    expect(rows.find((r) => r['id'] === 'c-blocked')!['status']).toBe('pending');
  });

  it('treats a missing refund_requests table as no requests (42P01 bridge)', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(
      commissionRow({ id: 'c-old', period_starts_at: '2025-12-01T00:00:00.000Z' })
    );
    const { client, db } = makeClient(seed, {
      refund_requests: { code: '42P01', message: 'relation does not exist' },
    });
    const moved = await refreshSellerCommissions(client, SELLER_ID, new Date('2026-01-11T00:00:00.000Z'));
    expect(moved).toBe(1);
    expect(db['seller_commissions']![0]!['status']).toBe('payable');
  });

  it('refuses payouts below 1000 with the shortfall, and snapshots payables on success', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(commissionRow({ id: 'c-1', status: 'payable', amount_pkr: 600 }));
    seed['seller_payout_details']!.push({ seller_id: SELLER_ID, method: 'easypaisa', account_label: '03270000000' });
    const { client, db } = makeClient(seed);
    await expect(requestPayout(client, SELLER_ID)).rejects.toMatchObject({
      code: 'PAYOUT_BELOW_MINIMUM',
    });
    expect(db['seller_payout_requests']!.length).toBe(0);

    db['seller_commissions']!.push(commissionRow({ id: 'c-2', status: 'payable', amount_pkr: 500, payment_id: 'pay-2' }));
    const { request, count } = await requestPayout(client, SELLER_ID);
    expect(request.totalPkr).toBe(1100);
    expect(count).toBe(2);
    expect(request.status).toBe('pending');
    const rows = db['seller_commissions']!;
    expect(rows.every((r) => r['status'] === 'requested')).toBe(true);
    expect(rows.every((r) => r['payout_request_id'] === request.id)).toBe(true);
  });

  it('refuses payouts without saved payout details', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(commissionRow({ id: 'c-1', status: 'payable', amount_pkr: 1500 }));
    const { client } = makeClient(seed);
    await expect(requestPayout(client, SELLER_ID)).rejects.toMatchObject({
      code: 'PAYOUT_DETAILS_MISSING',
    });
  });

  it('marks a batch sent or rejects it back to payable, and refuses double decisions', async () => {
    const seed = sellerSeed();
    seed['seller_payout_requests']!.push({
      id: 'req-1',
      seller_id: SELLER_ID,
      total_pkr: 1100,
      status: 'pending',
      seller_name_snapshot: 'Ali',
      seller_email_snapshot: 'ali@example.com',
      payout_method_snapshot: 'easypaisa',
      payout_account_snapshot: '03270000000',
      requested_at: '2026-01-05T00:00:00.000Z',
      decided_at: null,
    });
    seed['seller_commissions']!.push(
      commissionRow({ id: 'c-1', status: 'requested', payout_request_id: 'req-1' })
    );
    const { client, db } = makeClient(seed);
    const sent = await decidePayoutRequest(client, 'req-1', 'admin-1', 'mark-sent');
    expect(sent.status).toBe('paid');
    expect(db['seller_commissions']![0]!['status']).toBe('paid');
    await expect(decidePayoutRequest(client, 'req-1', 'admin-1', 'mark-sent')).rejects.toMatchObject({
      code: 'PAYOUT_REQUEST_ALREADY_DECIDED',
    });
    await expect(decidePayoutRequest(client, 'req-missing', 'admin-1', 'reject')).rejects.toMatchObject({
      code: 'PAYOUT_REQUEST_NOT_FOUND',
    });

    // Reject path: rows return to payable, detached.
    db['seller_payout_requests']!.push({
      id: 'req-2',
      seller_id: SELLER_ID,
      total_pkr: 500,
      status: 'pending',
      seller_name_snapshot: 'Ali',
      seller_email_snapshot: 'ali@example.com',
      payout_method_snapshot: null,
      payout_account_snapshot: null,
      requested_at: '2026-01-06T00:00:00.000Z',
      decided_at: null,
    });
    db['seller_commissions']!.push(
      commissionRow({ id: 'c-2', status: 'requested', payout_request_id: 'req-2', payment_id: 'pay-2' })
    );
    const rejected = await decidePayoutRequest(client, 'req-2', 'admin-1', 'reject');
    expect(rejected.status).toBe('rejected');
    const row = db['seller_commissions']!.find((r) => r['id'] === 'c-2')!;
    expect(row['status']).toBe('payable');
    expect(row['payout_request_id']).toBeNull();
  });

  it('blocks deletion while any commission is unpaid, and deletes cleanly when paid out', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(commissionRow({ id: 'c-1', status: 'pending' }));
    const blocked = makeClient(seed);
    await expect(deleteSeller(blocked.client, SELLER_ID)).rejects.toMatchObject({
      code: 'SELLER_HAS_UNPAID_COMMISSIONS',
    });
    expect(blocked.auth.deleteUser).not.toHaveBeenCalled();

    const paidSeed = sellerSeed();
    paidSeed['seller_commissions']!.push(commissionRow({ id: 'c-1', status: 'paid' }));
    const { client, db, auth } = makeClient(paidSeed);
    const result = await deleteSeller(client, SELLER_ID);
    expect(result.deleted).toBe(true);
    expect(auth.deleteUser).toHaveBeenCalledWith(SELLER_ID);
    expect(db['users']!.find((u) => u['id'] === SELLER_ID)).toBeUndefined();
    expect(db['referral_codes']!.length).toBe(0);
  });

  it('sums balances by status and excludes cancelled rows', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(
      commissionRow({ id: 'c-1', status: 'pending', amount_pkr: 100 }),
      commissionRow({ id: 'c-2', status: 'payable', amount_pkr: 200 }),
      commissionRow({ id: 'c-3', status: 'requested', amount_pkr: 300 }),
      commissionRow({ id: 'c-4', status: 'paid', amount_pkr: 400 }),
      commissionRow({ id: 'c-5', status: 'cancelled', amount_pkr: 999 })
    );
    const { client } = makeClient(seed);
    const balances = await getSellerBalances(client, SELLER_ID);
    expect(balances).toEqual({ pending: 100, payable: 200, requested: 300, paid: 400 });
  });

  it('reduces a commission on partial refund and cancels on full refund', async () => {
    const seed = sellerSeed();
    seed['seller_commissions']!.push(commissionRow({ id: 'c-1', amount_pkr: 1400, rate_snapshot: 20 }));
    const { client, db } = makeClient(seed);
    const reduced = await applyRefundOutcomeToCommission(client, 'pay-1', 3500);
    expect(reduced?.amountPkr).toBe(700);
    expect(db['seller_commissions']![0]!['amount_pkr']).toBe(700);

    const cancelled = await applyRefundOutcomeToCommission(client, 'pay-1', 0);
    expect(cancelled?.status).toBe('cancelled');
    expect(db['seller_commissions']![0]!['status']).toBe('cancelled');
  });

  it('throws SellerError (not a silent null) when the database fails', async () => {
    const { client } = makeClient(sellerSeed(), {
      seller_settings: { code: 'XX000', message: 'boom' },
    });
    await expect(resolveReferralCode(client, 'ALI20')).rejects.toBeInstanceOf(SellerError);
  });

  it('fails loud on every scan/count/lookup error, with the right code', async () => {
    const err = { code: 'XX000', message: 'boom' };
    const { client: c1 } = makeClient(sellerSeed(), { seller_commissions: err });
    await expectCode(getSellerBalances(c1, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(listSellerCommissions(c1, SELLER_ID, 50), 'SELLERS_UNAVAILABLE');
    await expectCode(applyRefundOutcomeToCommission(c1, 'pay-1', 0), 'SELLERS_UNAVAILABLE');
    await expectCode(recordCommissionForPayment(
      c1,
      { id: 'pay-1', userId: BUYER_ID, amountPkr: 7000 },
      { id: 'period-1', startsAt: new Date('2026-01-01T00:00:00.000Z') }
    ), 'SELLERS_UNAVAILABLE');
    await expectCode(refreshSellerCommissions(c1, SELLER_ID, new Date('2026-02-01T00:00:00.000Z')), 'SELLERS_UNAVAILABLE');

    const { client: c2 } = makeClient(sellerSeed(), { users: err });
    await expectCode(getSellerSignupCount(c2, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(getSellerPurchaserCount(c2, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(listSellers(c2, 20, 0), 'SELLERS_UNAVAILABLE');
    await expectCode(createSeller(c2, {
      name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 20, scope: 'every',
    }), 'SELLERS_UNAVAILABLE');

    const { client: c3 } = makeClient(sellerSeed(), { seller_payout_details: err });
    await expectCode(getSellerPayoutDetails(c3, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(saveSellerPayoutDetails(c3, SELLER_ID, { method: 'easypaisa', accountLabel: '0327' }), 'SELLERS_UNAVAILABLE');

    const { client: c4 } = makeClient(sellerSeed(), { seller_payout_requests: err });
    await expectCode(listSellerPayoutRequests(c4, SELLER_ID, 20, 0), 'SELLERS_UNAVAILABLE');
    await expectCode(listAdminPayoutRequests(c4, 20, 0), 'SELLERS_UNAVAILABLE');

    const { client: c5 } = makeClient(sellerSeed(), { referral_codes: err });
    await expectCode(resolveReferralCode(c5, 'ALI20'), 'SELLERS_UNAVAILABLE');
    await expectCode(getCurrentReferralCode(c5, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(listReferralCodes(c5, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(changeReferralCode(c5, SELLER_ID, 'NEW99'), 'SELLERS_UNAVAILABLE');
  });

  it('fails the purchaser scans when their tables fail', async () => {
    const err = { code: 'XX000', message: 'boom' };
    const seed = sellerSeed();
    seed['subscription_periods']!.push({ id: 'period-1', user_id: BUYER_ID });
    const { client } = makeClient(seed, { subscription_periods: err });
    await expectCode(getSellerPurchaserCount(client, SELLER_ID), 'SELLERS_UNAVAILABLE');
    await expectCode(listReferredUsers(client, SELLER_ID, 20, 0), 'SELLERS_UNAVAILABLE');
  });

  it('treats a non-42P01 refund lookup error as a failure, not "no requests"', async () => {
    const { client } = makeClient(sellerSeed(), {
      refund_requests: { code: 'XX000', message: 'boom' },
    });
    await expectCode(hasUnresolvedRefundRequest(client, 'pay-1'), 'SELLERS_UNAVAILABLE');
  });

  it('returns nulls and empty strings for malformed or missing rows, never throws', async () => {
    const { client: c1 } = makeClient(sellerSeed());
    expect(await getSellerSettings(c1, 'nobody')).toBeNull();
    expect(await resolveReferralCode(c1, '')).toBeNull();

    // A seller with no code rows has no current code.
    const seed0 = sellerSeed();
    seed0['referral_codes'] = [];
    const { client: c0 } = makeClient(seed0);
    expect(await getCurrentReferralCode(c0, SELLER_ID)).toBeNull();

    // A code row without a code is dropped by the list (the ''
    // fallback still executes first); a row without created_at
    // keeps its code with a blank date.
    const seed2 = sellerSeed();
    seed2['referral_codes'] = [
      { id: 'code-9', seller_id: SELLER_ID, superseded_at: null },
      { id: 'code-10', seller_id: SELLER_ID, code: 'ALI20', superseded_at: null },
    ];
    const { client: c2 } = makeClient(seed2);
    expect(await getCurrentReferralCode(c2, SELLER_ID)).toBeNull();
    const codes = await listReferralCodes(c2, SELLER_ID);
    expect(codes).toEqual([{ code: 'ALI20', current: true, createdAt: '' }]);

    // Settings row with an unknown scope is not a seller.
    const seed3 = sellerSeed();
    seed3['seller_settings'] = [{ user_id: SELLER_ID, rate: 20, scope: 'weird', status: 'active' }];
    const { client: c3 } = makeClient(seed3);
    expect(await getSellerSettings(c3, SELLER_ID)).toBeNull();

    // Balances ignore non-numeric amounts and cancelled rows.
    const seed4 = sellerSeed();
    seed4['seller_commissions']!.push(
      commissionRow({ status: 'pending', amount_pkr: '1400' }),
      commissionRow({ id: 'c-req', payment_id: 'pay-req', status: 'requested', amount_pkr: 700 }),
      commissionRow({ id: 'c-can', payment_id: 'pay-can', status: 'cancelled', amount_pkr: 9999 })
    );
    const { client: c4 } = makeClient(seed4);
    expect(await getSellerBalances(c4, SELLER_ID)).toEqual({ pending: 0, payable: 0, requested: 700, paid: 0 });

    // Payout details with an unknown method, or no account label.
    const seed5 = sellerSeed();
    seed5['seller_payout_details'] = [{ seller_id: SELLER_ID, method: 'cash', account_label: 'x' }];
    const { client: c5 } = makeClient(seed5);
    expect(await getSellerPayoutDetails(c5, SELLER_ID)).toBeNull();
    const seed6 = sellerSeed();
    seed6['seller_payout_details'] = [{ seller_id: SELLER_ID, method: 'easypaisa' }];
    const { client: c6 } = makeClient(seed6);
    expect(await getSellerPayoutDetails(c6, SELLER_ID)).toEqual({ method: 'easypaisa', accountLabel: '' });

    // A commission row missing its buyer is listed with a null name.
    const seed7 = sellerSeed();
    seed7['seller_commissions']!.push(commissionRow({ user_id: 'ghost' }));
    const { client: c7 } = makeClient(seed7);
    const listed = await listSellerCommissions(c7, SELLER_ID, 50);
    expect(listed[0]?.buyerName).toBeNull();
    expect(listed[0]?.buyerEmail).toBe('');
    // And a malformed commission row is filtered out, not returned.
    const seed8 = sellerSeed();
    seed8['seller_commissions']!.push({ seller_id: SELLER_ID, status: 'payable', amount_pkr: 100 });
    const { client: c8 } = makeClient(seed8);
    expect(await listSellerCommissions(c8, SELLER_ID, 50)).toEqual([]);
  });

  it('skips sellers without ids or settings, and blanks missing fields, in the admin list', async () => {
    const seed = sellerSeed();
    seed['users']!.push(
      { id: 'seller-2', role: 'seller', status: 'active' },
      { role: 'seller', status: 'active' },
      { id: 'seller-3', name: 'No Settings', email: 'nosettings@example.com', role: 'seller', status: 'active' }
    );
    seed['seller_settings']!.push({ user_id: 'seller-2', rate: 15, scope: 'one-time', status: 'active' });
    const { client } = makeClient(seed);
    const { sellers } = await listSellers(client, 20, 0);
    const ids = sellers.map((s) => s.id);
    expect(ids).toContain(SELLER_ID);
    expect(ids).toContain('seller-2');
    expect(ids).not.toContain('seller-3');
    const blank = sellers.find((s) => s.id === 'seller-2')!;
    expect(blank.email).toBe('');
    expect(blank.createdAt).toBe('');
  });

  it('lists referred users with purchase flags, and none when nobody was referred', async () => {
    const seed = sellerSeed();
    seed['subscription_periods']!.push({ id: 'period-1', user_id: BUYER_ID });
    const { client } = makeClient(seed);
    const { users, total } = await listReferredUsers(client, SELLER_ID, 20, 0);
    expect(total).toBe(1);
    expect(users[0]).toEqual(expect.objectContaining({
      id: BUYER_ID, name: 'Bilal', email: 'bilal@example.com', purchased: true,
    }));
    expect(await getSellerPurchaserCount(client, SELLER_ID)).toBe(1);

    const emptySeed = sellerSeed();
    emptySeed['users'] = emptySeed['users']!.filter((u) => u['id'] === SELLER_ID);
    const { client: empty } = makeClient(emptySeed);
    const none = await listReferredUsers(empty, SELLER_ID, 20, 0);
    expect(none.users).toEqual([]);
    expect(none.total).toBe(0);
  });

  it('records a one-time commission when no prior period exists', async () => {
    const seed = sellerSeed();
    seed['seller_settings']![0]!['scope'] = 'one-time';
    const { client } = makeClient(seed);
    const result = await recordCommissionForPayment(
      client,
      { id: 'pay-1', userId: BUYER_ID, amountPkr: 7000 },
      { id: 'period-1', startsAt: new Date('2026-01-01T00:00:00.000Z') }
    );
    expect(result?.amountPkr).toBe(1400);
    expect(result?.scopeSnapshot).toBe('one-time');
  });

  it('fails the buyer and prior-period checks loudly, and wins or loses the insert race cleanly', async () => {
    const err = { code: 'XX000', message: 'boom' };
    const payment = { id: 'pay-1', userId: BUYER_ID, amountPkr: 7000 };
    const period = { id: 'period-1', startsAt: new Date('2026-01-01T00:00:00.000Z') };

    const { client: c1 } = makeClient(sellerSeed(), { users: err });
    await expectCode(recordCommissionForPayment(c1, payment, period), 'SELLERS_UNAVAILABLE');

    const seed2 = sellerSeed();
    seed2['seller_settings']![0]!['scope'] = 'one-time';
    const { client: c2 } = makeClient(seed2, { subscription_periods: err });
    await expectCode(recordCommissionForPayment(c2, payment, period), 'SELLERS_UNAVAILABLE');

    // 23505: a concurrent approval recorded it first — the landed
    // row is returned, not an error. (No pre-seeded commission:
    // existence must miss so the insert is actually attempted.)
    const { client: c3 } = makeClient(sellerSeed(), {
      'seller_commissions:insert': { code: '23505', message: 'duplicate' },
    });
    const raced = await recordCommissionForPayment(c3, payment, period);
    expect(raced?.amountPkr).toBe(1400);

    // Any other insert failure is loud.
    const { client: c4 } = makeClient(sellerSeed(), {
      'seller_commissions:insert': err,
    });
    await expectCode(recordCommissionForPayment(c4, payment, period), 'SELLERS_UNAVAILABLE');
  });

  it('rolls a payout back on insert failure, move failure, and a lost race', async () => {
    const err = { code: 'XX000', message: 'boom' };
    const payable = (overrides: Partial<Row> = {}) =>
      commissionRow({ status: 'payable', amount_pkr: 1500, ...overrides });
    const details = [{ seller_id: SELLER_ID, method: 'easypaisa', account_label: '0327' }];

    // Insert failure: no request row survives.
    const seed1 = sellerSeed();
    seed1['seller_commissions']!.push(payable());
    seed1['seller_payout_details'] = details;
    const { client: c1, db: db1 } = makeClient(seed1, { seller_payout_requests: err });
    await expectCode(requestPayout(c1, SELLER_ID, new Date('2026-02-01T00:00:00.000Z')), 'SELLERS_UNAVAILABLE');
    expect(db1['seller_payout_requests']).toEqual([]);

    // Move failure: the request row is deleted again.
    const seed2 = sellerSeed();
    seed2['seller_commissions']!.push(payable());
    seed2['seller_payout_details'] = details;
    const { client: c2, db: db2 } = makeClient(seed2, { 'seller_commissions:update': err });
    await expectCode(requestPayout(c2, SELLER_ID, new Date('2026-02-01T00:00:00.000Z')), 'SELLERS_UNAVAILABLE');
    expect(db2['seller_payout_requests']).toEqual([]);
    expect(db2['seller_commissions']![0]!['status']).toBe('payable');

    // Lost race: a payable row without an id moves nothing, so the
    // request is rolled back and the below-minimum error surfaces.
    const seed3 = sellerSeed();
    const idLess = payable();
    delete idLess['id'];
    seed3['seller_commissions']!.push(idLess);
    seed3['seller_payout_details'] = details;
    const { client: c3, db: db3 } = makeClient(seed3);
    await expectCode(requestPayout(c3, SELLER_ID, new Date('2026-02-01T00:00:00.000Z')), 'PAYOUT_BELOW_MINIMUM');
    expect(db3['seller_payout_requests']).toEqual([]);
  });

  it('snapshots a null seller name when the seller user row is gone', async () => {
    const seed = sellerSeed();
    seed['users'] = seed['users']!.filter((u) => u['id'] !== SELLER_ID);
    seed['seller_commissions']!.push(commissionRow({ status: 'payable', amount_pkr: 1500 }));
    seed['seller_payout_details'] = [{ seller_id: SELLER_ID, method: 'easypaisa', account_label: '0327' }];
    const { client } = makeClient(seed);
    const { request } = await requestPayout(client, SELLER_ID, new Date('2026-02-01T00:00:00.000Z'));
    expect(request.sellerNameSnapshot).toBeNull();
    expect(request.sellerEmailSnapshot).toBe('');
  });

  it('adjusts commissions for every refund shape, and never rewrites paid rows', async () => {
    const err = { code: 'XX000', message: 'boom' };

    // No commission for the payment: null, no throw.
    const { client: c0 } = makeClient(sellerSeed());
    expect(await applyRefundOutcomeToCommission(c0, 'pay-none', 0)).toBeNull();

    // Paid: returned untouched (and loudly logged); cancelled: returned.
    const seedPaid = sellerSeed();
    seedPaid['seller_commissions']!.push(commissionRow({ status: 'paid' }));
    const { client: cPaid } = makeClient(seedPaid);
    const paid = await applyRefundOutcomeToCommission(cPaid, 'pay-1', 0);
    expect(paid?.status).toBe('paid');
    const seedCan = sellerSeed();
    seedCan['seller_commissions']!.push(commissionRow({ status: 'cancelled' }));
    const { client: cCan } = makeClient(seedCan);
    expect((await applyRefundOutcomeToCommission(cCan, 'pay-1', 0))?.status).toBe('cancelled');

    // Cancel failure is loud.
    const seedFail = sellerSeed();
    seedFail['seller_commissions']!.push(commissionRow({ status: 'pending' }));
    const { client: cFail } = makeClient(seedFail, { 'seller_commissions:update': err });
    await expectCode(applyRefundOutcomeToCommission(cFail, 'pay-1', 0), 'SELLERS_UNAVAILABLE');

    // Requested + full refund: cancelled and the request total zeroed.
    const seedReq = sellerSeed();
    seedReq['seller_commissions']!.push(commissionRow({
      status: 'requested', payout_request_id: 'req-1', amount_pkr: 1400,
    }));
    seedReq['seller_payout_requests'] = [{
      id: 'req-1', seller_id: SELLER_ID, total_pkr: 1400, status: 'pending',
    }];
    const { client: cReq, db: dbReq } = makeClient(seedReq);
    const cancelled = await applyRefundOutcomeToCommission(cReq, 'pay-1', 0);
    expect(cancelled?.status).toBe('cancelled');
    expect(dbReq['seller_payout_requests']![0]!['total_pkr']).toBe(0);

    // Requested + partial refund: reduced and the request corrected.
    const seedPart = sellerSeed();
    seedPart['seller_commissions']!.push(commissionRow({
      status: 'requested', payout_request_id: 'req-1', amount_pkr: 1400, rate_snapshot: 20,
    }));
    seedPart['seller_payout_requests'] = [{
      id: 'req-1', seller_id: SELLER_ID, total_pkr: 1400, status: 'pending',
    }];
    const { client: cPart, db: dbPart } = makeClient(seedPart);
    const reduced = await applyRefundOutcomeToCommission(cPart, 'pay-1', 3500);
    expect(reduced?.amountPkr).toBe(700);
    expect(dbPart['seller_payout_requests']![0]!['total_pkr']).toBe(700);

    // Reduce failure is loud.
    const seedRed = sellerSeed();
    seedRed['seller_commissions']!.push(commissionRow({ status: 'pending' }));
    const { client: cRed } = makeClient(seedRed, { 'seller_commissions:update': err });
    await expectCode(applyRefundOutcomeToCommission(cRed, 'pay-1', 3500), 'SELLERS_UNAVAILABLE');
  });

  it('decides payout requests, and fails loud on every step that can fail', async () => {
    const err = { code: 'XX000', message: 'boom' };
    const requestRow = (overrides: Partial<Row> = {}) => ({
      id: 'req-1', seller_id: SELLER_ID, total_pkr: 1400, status: 'pending',
      seller_name_snapshot: 'Ali', seller_email_snapshot: 'ali@example.com',
      payout_method_snapshot: 'easypaisa', payout_account_snapshot: '0327',
      requested_at: '2026-01-05T00:00:00.000Z', decided_at: null,
      ...overrides,
    });

    // Unknown request: not found.
    const { client: c0 } = makeClient(sellerSeed());
    await expectCode(decidePayoutRequest(c0, 'req-missing', 'admin-1', 'mark-sent'), 'PAYOUT_REQUEST_NOT_FOUND');

    // Mark-sent update failure.
    const seed1 = sellerSeed();
    seed1['seller_payout_requests'] = [requestRow()];
    const { client: c1 } = makeClient(seed1, { 'seller_payout_requests:update': err });
    await expectCode(decidePayoutRequest(c1, 'req-1', 'admin-1', 'mark-sent'), 'SELLERS_UNAVAILABLE');

    // Rows mark-paid failure (request update succeeds first).
    const seed2 = sellerSeed();
    seed2['seller_payout_requests'] = [requestRow()];
    seed2['seller_commissions']!.push(commissionRow({ status: 'requested', payout_request_id: 'req-1' }));
    const { client: c2 } = makeClient(seed2, { 'seller_commissions:update': err });
    await expectCode(decidePayoutRequest(c2, 'req-1', 'admin-1', 'mark-sent'), 'SELLERS_UNAVAILABLE');

    // Reject update failure, and rows release failure.
    const seed3 = sellerSeed();
    seed3['seller_payout_requests'] = [requestRow()];
    const { client: c3 } = makeClient(seed3, { 'seller_payout_requests:update': err });
    await expectCode(decidePayoutRequest(c3, 'req-1', 'admin-1', 'reject'), 'SELLERS_UNAVAILABLE');
    const seed4 = sellerSeed();
    seed4['seller_payout_requests'] = [requestRow()];
    seed4['seller_commissions']!.push(commissionRow({ status: 'requested', payout_request_id: 'req-1' }));
    const { client: c4 } = makeClient(seed4, { 'seller_commissions:update': err });
    await expectCode(decidePayoutRequest(c4, 'req-1', 'admin-1', 'reject'), 'SELLERS_UNAVAILABLE');
  });

  it('creates sellers, and rolls the auth user back when profiling fails', async () => {
    const err = { code: 'XX000', message: 'boom' };

    // Auth already-registered maps to the exists code; other auth
    // failures are loud.
    const { client: c1 } = makeClient(sellerSeed(), {}, {
      createUser: async () => ({ data: { user: null }, error: { code: 'XX', message: 'already registered' } }),
    });
    await expectCode(createSeller(c1, {
      name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 20, scope: 'every',
    }), 'SELLER_EMAIL_EXISTS');
    const { client: c2 } = makeClient(sellerSeed(), {}, {
      createUser: async () => ({ data: { user: null }, error: err }),
    });
    await expectCode(createSeller(c2, {
      name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 20, scope: 'every',
    }), 'SELLERS_UNAVAILABLE');

    // Profile write failure rolls the auth user back, then throws.
    const { client: c3, db: db3, auth: auth3 } = makeClient(sellerSeed(), { 'users:upsert': err });
    await expectCode(createSeller(c3, {
      name: 'Omar', email: 'omar2@example.com', password: 'Password123!', rate: 20, scope: 'every',
    }), 'SELLERS_UNAVAILABLE');
    expect(auth3.deleteUser).toHaveBeenCalled();

    // Rollback failure itself is logged, and the throw still stands.
    const { client: c4, auth: auth4 } = makeClient(sellerSeed(), { 'users:upsert': err }, {
      deleteUser: async () => ({ error: err }),
    });
    await expectCode(createSeller(c4, {
      name: 'Omar', email: 'omar3@example.com', password: 'Password123!', rate: 20, scope: 'every',
    }), 'SELLERS_UNAVAILABLE');
    expect(auth4.deleteUser).toHaveBeenCalled();
    expect(db3['users']!.find((u) => u['email'] === 'omar2@example.com')).toBeUndefined();
  });

  it('updates sellers by scope or status alone, and rejects missing or deleted sellers', async () => {
    const { client: c0 } = makeClient(sellerSeed());
    await expectCode(updateSeller(c0, 'nobody', { rate: 15 }), 'SELLER_NOT_FOUND');
    const seedDel = sellerSeed();
    seedDel['seller_settings']![0]!['status'] = 'deleted';
    const { client: cDel } = makeClient(seedDel);
    await expectCode(updateSeller(cDel, SELLER_ID, { rate: 15 }), 'SELLER_NOT_FOUND');

    const { client: c1 } = makeClient(sellerSeed());
    const scoped = await updateSeller(c1, SELLER_ID, { scope: 'one-time' });
    expect(scoped.scope).toBe('one-time');
    expect(scoped.rate).toBe(20);
    const paused = await updateSeller(c1, SELLER_ID, { status: 'paused' });
    expect(paused.status).toBe('paused');

    const { client: c2 } = makeClient(sellerSeed(), { 'seller_settings:update': { code: 'XX000', message: 'boom' } });
    await expectCode(updateSeller(c2, SELLER_ID, { rate: 15 }), 'SELLERS_UNAVAILABLE');
  });

  it('deletes sellers through every failure, and tolerates a missing auth user', async () => {
    const err = { code: 'XX000', message: 'boom' };

    const { client: c0 } = makeClient(sellerSeed());
    await expectCode(deleteSeller(c0, 'nobody'), 'SELLER_NOT_FOUND');

    const { client: c1 } = makeClient(sellerSeed(), { seller_commissions: err });
    await expectCode(deleteSeller(c1, SELLER_ID), 'SELLERS_UNAVAILABLE');

    const { client: c2 } = makeClient(sellerSeed(), {}, {
      deleteUser: async () => ({ error: err }),
    });
    await expectCode(deleteSeller(c2, SELLER_ID), 'SELLERS_UNAVAILABLE');

    const { client: c3, db: db3 } = makeClient(sellerSeed(), {}, {
      // Supabase auth errors are real Errors; the tolerance check
      // reads err.message, so the test double must be one too.
      deleteUser: async () => ({ error: Object.assign(new Error('User not found'), { code: 'XX' }) }),
    });
    expect(await deleteSeller(c3, SELLER_ID)).toEqual({ deleted: true });
    expect(db3['users']!.find((u) => u['id'] === SELLER_ID)).toBeUndefined();

    const { client: c4 } = makeClient(sellerSeed(), { 'referral_codes:delete': err });
    await expectCode(deleteSeller(c4, SELLER_ID), 'SELLERS_UNAVAILABLE');

    const { client: c5 } = makeClient(sellerSeed(), { 'users:delete': err });
    await expectCode(deleteSeller(c5, SELLER_ID), 'SELLERS_UNAVAILABLE');
  });

  it('refreshes commissions, skipping malformed rows and failing loud on transition errors', async () => {
    // Malformed pending rows are skipped, not crashed on.
    const seed = sellerSeed();
    seed['seller_commissions']!.push(
      commissionRow({ status: 'pending', period_starts_at: undefined as never }),
      commissionRow({ id: 'c-old', payment_id: 'pay-old', status: 'pending', period_starts_at: '2026-01-01T00:00:00.000Z' })
    );
    const { client, db } = makeClient(seed);
    const moved = await refreshSellerCommissions(client, SELLER_ID, new Date('2026-02-01T00:00:00.000Z'));
    expect(moved).toBe(1);
    expect(db['seller_commissions']!.find((r) => r['id'] === 'c-old')!['status']).toBe('payable');

    // Transition failure is loud.
    const seed2 = sellerSeed();
    seed2['seller_commissions']!.push(commissionRow({ status: 'pending', period_starts_at: '2026-01-01T00:00:00.000Z' }));
    const { client: c2 } = makeClient(seed2, { 'seller_commissions:update': { code: 'XX000', message: 'boom' } });
    await expectCode(refreshSellerCommissions(c2, SELLER_ID, new Date('2026-02-01T00:00:00.000Z')), 'SELLERS_UNAVAILABLE');
  });

  it('fails code changes loudly at the clash, supersede, and insert steps', async () => {
    const err = { code: 'XX000', message: 'boom' };

    // Supersede failure.
    const { client: c1 } = makeClient(sellerSeed(), { 'referral_codes:update': err });
    await expectCode(changeReferralCode(c1, SELLER_ID, 'NEW99'), 'SELLERS_UNAVAILABLE');

    // Insert race: the code was taken concurrently.
    const { client: c2 } = makeClient(sellerSeed(), {
      'referral_codes:insert': { code: '23505', message: 'duplicate' },
    });
    await expectCode(changeReferralCode(c2, SELLER_ID, 'NEW99'), 'REFERRAL_CODE_TAKEN');

    // Any other insert failure is loud.
    const { client: c3 } = makeClient(sellerSeed(), { 'referral_codes:insert': err });
    await expectCode(changeReferralCode(c3, SELLER_ID, 'NEW99'), 'SELLERS_UNAVAILABLE');
  });

  it('filters malformed payout requests and blanks missing snapshots', async () => {
    const seed = sellerSeed();
    seed['seller_payout_requests'] = [
      { id: 'req-1', seller_id: SELLER_ID, total_pkr: 1400, status: 'pending' },
      { id: 'req-bad', seller_id: SELLER_ID, total_pkr: 100, status: 'weird' },
      { seller_id: SELLER_ID, total_pkr: 100, status: 'pending' },
    ];
    const { client, db } = makeClient(seed);
    const { requests } = await listSellerPayoutRequests(client, SELLER_ID, 20, 0);
    expect(requests.map((r) => r.id)).toEqual(['req-1']);
    expect(requests[0]?.sellerEmailSnapshot).toBe('');
    expect(requests[0]?.requestedAt).toBe('');

    // Commission-count failure inside the list is loud.
    const { client: c2 } = makeClient(seed, { seller_commissions: { code: 'XX000', message: 'boom' } });
    await expectCode(listSellerPayoutRequests(c2, SELLER_ID, 20, 0), 'SELLERS_UNAVAILABLE');
    expect(db['seller_payout_requests']!.length).toBe(3);
  });
});
