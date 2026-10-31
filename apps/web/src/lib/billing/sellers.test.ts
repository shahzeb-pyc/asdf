import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyRefundOutcomeToCommission,
  changeReferralCode,
  decidePayoutRequest,
  deleteSeller,
  getSellerBalances,
  recordCommissionForPayment,
  refreshSellerCommissions,
  requestPayout,
  resolveReferralCode,
  SellerError,
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
    private readonly tableErrors: Record<string, TableError>,
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
    return this.tableErrors[this.table] ?? null;
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
  tableErrors: Record<string, TableError> = {},
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
});
