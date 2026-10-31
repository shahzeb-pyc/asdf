/**
 * @file sellers-routes.test.ts
 * @description Route-level tests for the sellers API: seller
 * dashboard/referrals/referral-code/payout-details/payout-requests,
 * the public referral validate endpoint, and the admin sellers
 * list/detail/queue/decision routes. Auth for seller routes is
 * REAL (signed tokens — validateSessionActive passes in the
 * test env without a Supabase client); admin auth is mocked at
 * the route-auth boundary like the refunds route tests. The
 * billing admin client is an in-memory fake in the same shape as
 * the lib tests' fake, so route <-> lib wiring executes for real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signSessionToken } from '@fbuploadpro/contracts';
import { GET as getSellerDashboard } from '@/app/api/seller/dashboard/route';
import { GET as getSellerReferrals } from '@/app/api/seller/referrals/route';
import { POST as postSellerReferralCode } from '@/app/api/seller/referral-code/route';
import { PUT as putSellerPayoutDetails } from '@/app/api/seller/payout-details/route';
import {
  GET as getSellerPayoutRequests,
  POST as postSellerPayoutRequest,
} from '@/app/api/seller/payout-requests/route';
import { GET as getReferralValidate } from '@/app/api/referral/validate/route';
import {
  GET as getAdminSellers,
  POST as postAdminSeller,
} from '@/app/api/tenant/[subdomain]/sellers/route';
import {
  GET as getAdminSellerDetail,
  PATCH as patchAdminSeller,
  DELETE as deleteAdminSeller,
} from '@/app/api/tenant/[subdomain]/sellers/[sellerId]/route';
import { GET as getAdminPayoutRequests } from '@/app/api/tenant/[subdomain]/sellers/payout-requests/route';
import { POST as postAdminPayoutDecision } from '@/app/api/tenant/[subdomain]/sellers/payout-requests/[requestId]/route';

const TEST_SECRET = 'sellers-route-test-secret-0123456789abcdef';

const adminAuthState = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'user' }));
vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      subdomain: 'e2e',
      role: adminAuthState.role,
      status: 'active',
    },
  })),
}));

const clientState = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient | null,
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: vi.fn(() => clientState.client),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

// ---------------------------------------------------------------- fake client

type Row = Record<string, unknown>;

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

  private async run(): Promise<{
    data: unknown;
    error: { code: string; message: string } | null;
    count?: number;
  }> {
    const table = this.db[this.table] ?? (this.db[this.table] = []);
    if (this.op === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map(
        (r) => ({
          id: nextId(),
          created_at: new Date().toISOString(),
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

  then<TResult1 = { data: unknown; error: unknown; count?: number }>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number }) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1> {
    return this.run().then(onfulfilled as never);
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = (result.data ?? []) as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = (result.data ?? []) as Row[];
    if (rows.length === 0) {
      return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
    }
    return { data: rows[0], error: null };
  }
}

function makeClient(seed: Record<string, Row[]> = {}): {
  client: SupabaseClient;
  db: Record<string, Row[]>;
  auth: { createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> };
} {
  const db: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(seed)) {
    db[table] = rows.map((r) => ({ ...r }));
  }
  const createUser = vi.fn(async (input: { email: string }) => ({
    data: { user: { id: nextId(), email: input.email } },
    error: null,
  }));
  const deleteUser = vi.fn(async () => ({ error: null }));
  const client = {
    from: (table: string) => ({
      select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
        new FakeQuery(db, table, 'select', null).select(cols, opts),
      insert: (payload: Row | Row[]) => new FakeQuery(db, table, 'insert', payload),
      update: (payload: Row) => new FakeQuery(db, table, 'update', payload),
      delete: () => new FakeQuery(db, table, 'delete', null),
      upsert: (payload: Row, opts?: { onConflict?: string }) =>
        new FakeQuery(db, table, 'upsert', payload, opts?.onConflict),
    }),
    auth: { admin: { createUser, deleteUser } },
  } as unknown as SupabaseClient;
  return { client, db, auth: { createUser, deleteUser } };
}

// ---------------------------------------------------------------- seeds

const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const SELLER2_ID = '44444444-4444-4444-8444-444444444444';
const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const PAYMENT_ID = '55555555-5555-4555-8555-555555555555';
const PERIOD_ID = '66666666-6666-4666-8666-666666666666';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const OLD = '2025-12-01T00:00:00.000Z';
const RECENT = new Date().toISOString();

function baseSeed(): Record<string, Row[]> {
  return {
    users: [
      { id: SELLER_ID, name: 'Ali', email: 'ali@example.com', role: 'seller', status: 'active', created_at: OLD },
      { id: SELLER2_ID, name: 'Sara', email: 'sara@example.com', role: 'seller', status: 'active', created_at: OLD },
      { id: BUYER_ID, name: 'Bilal', email: 'bilal@example.com', role: 'user', status: 'active', referred_by_seller_id: SELLER_ID, referred_by_code: 'ALI20', created_at: OLD },
    ],
    seller_settings: [
      { user_id: SELLER_ID, rate: 20, scope: 'every', status: 'active' },
      { user_id: SELLER2_ID, rate: 15, scope: 'one-time', status: 'active' },
    ],
    referral_codes: [
      { id: 'code-1', seller_id: SELLER_ID, code: 'ALI20', superseded_at: null, created_at: OLD },
      { id: 'code-2', seller_id: SELLER2_ID, code: 'TAKEN1', superseded_at: null, created_at: OLD },
    ],
    seller_commissions: [
      { id: 'comm-1', seller_id: SELLER_ID, user_id: BUYER_ID, payment_id: PAYMENT_ID, period_id: PERIOD_ID, period_starts_at: OLD, rate_snapshot: 20, scope_snapshot: 'every', amount_pkr: 1400, status: 'payable', payout_request_id: null, created_at: OLD },
      { id: 'comm-2', seller_id: SELLER_ID, user_id: BUYER_ID, payment_id: '88888888-8888-4888-8888-888888888888', period_id: PERIOD_ID, period_starts_at: RECENT, rate_snapshot: 20, scope_snapshot: 'every', amount_pkr: 600, status: 'pending', payout_request_id: null, created_at: RECENT },
    ],
    seller_payout_requests: [],
    seller_payout_details: [
      { seller_id: SELLER_ID, method: 'easypaisa', account_label: '03270000000', updated_at: OLD },
    ],
    subscription_periods: [
      { id: PERIOD_ID, user_id: BUYER_ID, starts_at: OLD },
    ],
    refund_requests: [],
  };
}

function requestedSeed(): Record<string, Row[]> {
  const seed = baseSeed();
  seed['seller_payout_requests'] = [
    { id: REQUEST_ID, seller_id: SELLER_ID, total_pkr: 1400, status: 'pending', seller_name_snapshot: 'Ali', seller_email_snapshot: 'ali@example.com', payout_method_snapshot: 'easypaisa', payout_account_snapshot: '03270000000', requested_at: OLD, decided_at: null, decided_by: null, created_at: OLD, updated_at: OLD },
  ];
  seed['seller_commissions'] = (seed['seller_commissions'] as Row[]).map((c) =>
    c['id'] === 'comm-1' ? { ...c, status: 'requested', payout_request_id: REQUEST_ID } : c
  );
  return seed;
}

// ---------------------------------------------------------------- helpers

async function sellerToken(role: 'seller' | 'user' = 'seller', userId = SELLER_ID): Promise<string> {
  return signSessionToken(
    {
      userId,
      email: role === 'seller' ? 'aliseller@gmail.com' : 'bilalbuyer@gmail.com',
      name: role === 'seller' ? 'Ali' : 'Bilal',
      subdomain: 'e2e',
      role,
      status: 'active',
    },
    TEST_SECRET
  );
}

function req(
  url: string,
  init: { token?: string; method?: string; body?: unknown; ip?: string } = {}
): NextRequest {
  const headers: Record<string, string> = {};
  if (init.token) headers['cookie'] = `fbup_session=${init.token}`;
  if (init.ip) headers['x-forwarded-for'] = init.ip;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

function adminParams<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve({ subdomain: 'e2e', ...params }) };
}

describe('sellers routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    adminAuthState.role = 'admin';
    idSeq = 0;
  });

  function install(seed: Record<string, Row[]> = baseSeed()) {
    const made = makeClient(seed);
    clientState.client = made.client;
    return made;
  }

  describe('seller dashboard', () => {
    it('returns rate, scope, link, balances, and counts for the seller', async () => {
      install();
      const res = await getSellerDashboard(req('/api/seller/dashboard', { token: await sellerToken() }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rate).toBe(20);
      expect(body.scope).toBe('every');
      expect(body.currentCode).toBe('ALI20');
      expect(body.referralLink).toContain('ref=ALI20');
      expect(body.balances).toEqual({ pending: 600, payable: 1400, requested: 0, paid: 0 });
      expect(body.signups).toBe(1);
      expect(body.purchasers).toBe(1);
      expect(body.payoutDetails).toEqual({ method: 'easypaisa', accountLabel: '03270000000' });
    });

    it('401s without a session and 403s for a non-seller role', async () => {
      install();
      expect((await getSellerDashboard(req('/api/seller/dashboard'))).status).toBe(401);
      const userRes = await getSellerDashboard(
        req('/api/seller/dashboard', { token: await sellerToken('user', BUYER_ID) })
      );
      expect(userRes.status).toBe(403);
    });

    it('503s when no server client is available', async () => {
      clientState.client = null;
      const res = await getSellerDashboard(req('/api/seller/dashboard', { token: await sellerToken() }));
      expect(res.status).toBe(503);
    });
  });

  describe('seller referrals', () => {
    it('lists referred users with purchased flags', async () => {
      install();
      const res = await getSellerReferrals(req('/api/seller/referrals', { token: await sellerToken() }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.users[0].email).toBe('bilal@example.com');
      expect(body.users[0].purchased).toBe(true);
    });
  });

  describe('seller referral code', () => {
    it('changes the code and supersedes the old one', async () => {
      const { db } = install();
      const res = await postSellerReferralCode(
        req('/api/seller/referral-code', { token: await sellerToken(), method: 'POST', body: { code: 'NEW99' } })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).code).toBe('NEW99');
      const codes = db['referral_codes'] as Row[];
      expect(codes.find((c) => c['code'] === 'ALI20')?.['superseded_at']).not.toBeNull();
      expect(codes.find((c) => c['code'] === 'NEW99')?.['superseded_at']).toBeNull();
    });

    it('409s on a code another seller uses and 400s on an invalid code', async () => {
      install();
      const taken = await postSellerReferralCode(
        req('/api/seller/referral-code', { token: await sellerToken(), method: 'POST', body: { code: 'TAKEN1' } })
      );
      expect(taken.status).toBe(409);
      const invalid = await postSellerReferralCode(
        req('/api/seller/referral-code', { token: await sellerToken(), method: 'POST', body: { code: 'ab' } })
      );
      expect(invalid.status).toBe(400);
    });
  });

  describe('seller payout details', () => {
    it('saves details and returns ok', async () => {
      const { db } = install();
      const res = await putSellerPayoutDetails(
        req('/api/seller/payout-details', {
          token: await sellerToken(),
          method: 'PUT',
          body: { method: 'nayapay', accountLabel: '03270000001' },
        })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      const details = (db['seller_payout_details'] as Row[]).find((d) => d['seller_id'] === SELLER_ID);
      expect(details?.['method']).toBe('nayapay');
      expect(details?.['account_label']).toBe('03270000001');
    });

    it('400s on an invalid method', async () => {
      install();
      const res = await putSellerPayoutDetails(
        req('/api/seller/payout-details', {
          token: await sellerToken(),
          method: 'PUT',
          body: { method: 'bank', accountLabel: 'x' },
        })
      );
      expect(res.status).toBe(400);
    });
  });

  describe('seller payout requests', () => {
    it('lists own requests newest first', async () => {
      install(requestedSeed());
      const res = await getSellerPayoutRequests(req('/api/seller/payout-requests', { token: await sellerToken() }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.requests[0].status).toBe('pending');
      expect(body.requests[0].totalPkr).toBe(1400);
    });

    it('creates a request snapshotting all payables', async () => {
      const { db } = install();
      const res = await postSellerPayoutRequest(
        req('/api/seller/payout-requests', { token: await sellerToken(), method: 'POST' })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.request.totalPkr).toBe(1400);
      expect(body.request.status).toBe('pending');
      const comm = (db['seller_commissions'] as Row[]).find((c) => c['id'] === 'comm-1');
      expect(comm?.['status']).toBe('requested');
      expect(comm?.['payout_request_id']).toBe(body.request.id);
    });

    it('400s below the minimum with the shortfall, and without payout details', async () => {
      const low = baseSeed();
      low['seller_commissions'] = (low['seller_commissions'] as Row[]).filter((c) => c['id'] !== 'comm-1');
      install(low);
      const below = await postSellerPayoutRequest(
        req('/api/seller/payout-requests', { token: await sellerToken(), method: 'POST' })
      );
      expect(below.status).toBe(400);
      expect((await below.json()).error).toBe('PAYOUT_BELOW_MINIMUM');

      const noDetails = baseSeed();
      noDetails['seller_payout_details'] = [];
      install(noDetails);
      const missing = await postSellerPayoutRequest(
        req('/api/seller/payout-requests', { token: await sellerToken(), method: 'POST' })
      );
      expect(missing.status).toBe(400);
      expect((await missing.json()).error).toBe('PAYOUT_DETAILS_MISSING');
    });
  });

  describe('public referral validate', () => {
    it('returns the seller name for a valid code, case-insensitively', async () => {
      install();
      const res = await getReferralValidate(req('/api/referral/validate?code=ali20', { ip: '10.0.0.1' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ valid: true, sellerName: 'Ali' });
    });

    it('returns invalid for unknown codes and 503 without a client', async () => {
      install();
      const res = await getReferralValidate(req('/api/referral/validate?code=NOPE', { ip: '10.0.0.2' }));
      expect(await res.json()).toEqual({ valid: false, sellerName: null });
      clientState.client = null;
      const unavailable = await getReferralValidate(req('/api/referral/validate?code=ALI20', { ip: '10.0.0.3' }));
      expect(unavailable.status).toBe(503);
    });
  });

  describe('admin sellers list', () => {
    it('lists sellers with stats, newest first', async () => {
      install();
      const res = await getAdminSellers(req('/api/tenant/e2e/sellers'), adminParams({}));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.sellers[0].email).toBeDefined();
      const ali = body.sellers.find((s: { email: string }) => s.email === 'ali@example.com');
      expect(ali.payablePkr).toBe(1400);
      expect(ali.currentCode).toBe('ALI20');
    });

    it('403s for non-admins and 503s without a client', async () => {
      install();
      adminAuthState.role = 'user';
      const forbidden = await getAdminSellers(req('/api/tenant/e2e/sellers'), adminParams({}));
      expect(forbidden.status).toBe(403);
      adminAuthState.role = 'admin';
      clientState.client = null;
      const unavailable = await getAdminSellers(req('/api/tenant/e2e/sellers'), adminParams({}));
      expect(unavailable.status).toBe(503);
    });
  });

  describe('admin seller create', () => {
    it('creates the seller and returns its id', async () => {
      const { db } = install();
      const res = await postAdminSeller(
        req('/api/tenant/e2e/sellers', {
          method: 'POST',
          body: { name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 25, scope: 'one-time' },
        }),
        adminParams({})
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(typeof body.sellerId).toBe('string');
      const row = (db['users'] as Row[]).find((u) => u['email'] === 'omar@example.com');
      expect(row?.['role']).toBe('seller');
      const settings = (db['seller_settings'] as Row[]).find((s) => s['user_id'] === body.sellerId);
      expect(settings?.['rate']).toBe(25);
      expect(settings?.['scope']).toBe('one-time');
    });

    it('409s on an existing email and 400s on an invalid rate', async () => {
      install();
      const existing = await postAdminSeller(
        req('/api/tenant/e2e/sellers', {
          method: 'POST',
          body: { name: 'Ali', email: 'ali@example.com', password: 'Password123!', rate: 20, scope: 'every' },
        }),
        adminParams({})
      );
      expect(existing.status).toBe(409);
      expect((await existing.json()).error).toBe('SELLER_EMAIL_EXISTS');
      const invalid = await postAdminSeller(
        req('/api/tenant/e2e/sellers', {
          method: 'POST',
          body: { name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 0, scope: 'every' },
        }),
        adminParams({})
      );
      expect(invalid.status).toBe(400);
    });

    it('rolls back the created seller when the initial code is taken', async () => {
      const { db } = install();
      const res = await postAdminSeller(
        req('/api/tenant/e2e/sellers', {
          method: 'POST',
          body: { name: 'Omar', email: 'omar@example.com', password: 'Password123!', rate: 20, scope: 'every', referralCode: 'TAKEN1' },
        }),
        adminParams({})
      );
      expect(res.status).toBe(409);
      expect((db['users'] as Row[]).find((u) => u['email'] === 'omar@example.com')).toBeUndefined();
    });
  });

  describe('admin seller detail', () => {
    it('returns profile, codes, balances, commissions, and referrals', async () => {
      install();
      const res = await getAdminSellerDetail(
        req(`/api/tenant/e2e/sellers/${SELLER_ID}`),
        adminParams({ sellerId: SELLER_ID })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.seller.email).toBe('ali@example.com');
      expect(body.seller.currentCode).toBe('ALI20');
      expect(body.balances.payable).toBe(1400);
      expect(body.commissions).toHaveLength(2);
      expect(body.referredUsers).toHaveLength(1);
      expect(body.referredTotal).toBe(1);
    });

    it('404s for a non-seller id', async () => {
      install();
      const res = await getAdminSellerDetail(
        req(`/api/tenant/e2e/sellers/${BUYER_ID}`),
        adminParams({ sellerId: BUYER_ID })
      );
      expect(res.status).toBe(404);
    });

    it('patches rate/scope and 400s on invalid updates', async () => {
      const { db } = install();
      const res = await patchAdminSeller(
        req(`/api/tenant/e2e/sellers/${SELLER_ID}`, { method: 'PATCH', body: { rate: 15, scope: 'one-time' } }),
        adminParams({ sellerId: SELLER_ID })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      const settings = (db['seller_settings'] as Row[]).find((s) => s['user_id'] === SELLER_ID);
      expect(settings?.['rate']).toBe(15);
      expect(settings?.['scope']).toBe('one-time');
      const invalid = await patchAdminSeller(
        req(`/api/tenant/e2e/sellers/${SELLER_ID}`, { method: 'PATCH', body: { rate: 101 } }),
        adminParams({ sellerId: SELLER_ID })
      );
      expect(invalid.status).toBe(400);
    });

    it('blocks delete while commissions are unpaid, then deletes when paid out', async () => {
      const { db } = install();
      const blocked = await deleteAdminSeller(
        req(`/api/tenant/e2e/sellers/${SELLER_ID}`, { method: 'DELETE' }),
        adminParams({ sellerId: SELLER_ID })
      );
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error).toBe('SELLER_HAS_UNPAID_COMMISSIONS');
      for (const row of db['seller_commissions'] as Row[]) {
        if (row['seller_id'] === SELLER_ID) row['status'] = 'paid';
      }
      const deleted = await deleteAdminSeller(
        req(`/api/tenant/e2e/sellers/${SELLER_ID}`, { method: 'DELETE' }),
        adminParams({ sellerId: SELLER_ID })
      );
      expect(deleted.status).toBe(200);
      expect((db['users'] as Row[]).find((u) => u['id'] === SELLER_ID)).toBeUndefined();
    });
  });

  describe('admin payout queue', () => {
    it('lists requests and marks a batch sent', async () => {
      const { db } = install(requestedSeed());
      const list = await getAdminPayoutRequests(req('/api/tenant/e2e/sellers/payout-requests'), adminParams({}));
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.total).toBe(1);
      expect(body.requests[0].status).toBe('pending');
      const decided = await postAdminPayoutDecision(
        req(`/api/tenant/e2e/sellers/payout-requests/${REQUEST_ID}`, { method: 'POST', body: { action: 'mark-sent' } }),
        adminParams({ requestId: REQUEST_ID })
      );
      expect(decided.status).toBe(200);
      const request = (db['seller_payout_requests'] as Row[]).find((r) => r['id'] === REQUEST_ID);
      expect(request?.['status']).toBe('paid');
      const comm = (db['seller_commissions'] as Row[]).find((c) => c['id'] === 'comm-1');
      expect(comm?.['status']).toBe('paid');
    });

    it('rejects back to payable and 409s on a decided request', async () => {
      const { db } = install(requestedSeed());
      const rejected = await postAdminPayoutDecision(
        req(`/api/tenant/e2e/sellers/payout-requests/${REQUEST_ID}`, { method: 'POST', body: { action: 'reject' } }),
        adminParams({ requestId: REQUEST_ID })
      );
      expect(rejected.status).toBe(200);
      const request = (db['seller_payout_requests'] as Row[]).find((r) => r['id'] === REQUEST_ID);
      expect(request?.['status']).toBe('rejected');
      const comm = (db['seller_commissions'] as Row[]).find((c) => c['id'] === 'comm-1');
      expect(comm?.['status']).toBe('payable');
      expect(comm?.['payout_request_id']).toBeNull();
      const again = await postAdminPayoutDecision(
        req(`/api/tenant/e2e/sellers/payout-requests/${REQUEST_ID}`, { method: 'POST', body: { action: 'reject' } }),
        adminParams({ requestId: REQUEST_ID })
      );
      expect(again.status).toBe(409);
    });
  });
});
