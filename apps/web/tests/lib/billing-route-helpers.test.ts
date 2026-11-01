import { beforeEach, describe, expect, it } from 'vitest';

import { BANK_PAYMENT_DETAILS } from '@/lib/billing/payment-details';
import {
  getBillingAdminClient,
  mapEntitlementToResponse,
  mapPaymentToItem,
  paymentRowToItem,
} from '@/lib/billing/route-helpers';
import type { SubscriptionPaymentRow } from '@/lib/billing/entitlement';

/**
 * Billing route helpers: payment/entitlement mapping and the
 * payment-destination details shown on the Billing page. No
 * database, no network — pure mapping plus the admin-client
 * absence case (no env in tests, so no client).
 */

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function payment(overrides: Partial<SubscriptionPaymentRow> = {}): SubscriptionPaymentRow {
  return {
    id: 'payment-1',
    userId: 'user-1',
    method: 'bank',
    bankMethod: 'easypaisa',
    status: 'pending',
    counts: { ...ZERO_COUNTS, facebook: 2 },
    amountPkr: 140,
    isUpgrade: false,
    screenshotStorageKey: 'billing-screenshots/user-1/shot.jpg',
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

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

describe('getBillingAdminClient', () => {
  it('returns null when no Supabase env is configured', () => {
    expect(getBillingAdminClient()).toBeNull();
  });
});

describe('mapPaymentToItem', () => {
  it('passes known statuses through', () => {
    for (const status of ['approved', 'rejected', 'paid', 'failed', 'expired'] as const) {
      expect(mapPaymentToItem(payment({ status })).status).toBe(status);
    }
  });

  it('maps an unknown status to pending rather than leaking it', () => {
    expect(mapPaymentToItem(payment({ status: 'weird' })).status).toBe('pending');
  });

  it('maps every field', () => {
    expect(mapPaymentToItem(payment())).toEqual({
      id: 'payment-1',
      method: 'bank',
      bankMethod: 'easypaisa',
      status: 'pending',
      counts: { ...ZERO_COUNTS, facebook: 2 },
      amountPkr: 140,
      isUpgrade: false,
      screenshotStorageKey: 'billing-screenshots/user-1/shot.jpg',
      nowpaymentsPaymentId: null,
      nowpaymentsPayAddress: null,
      nowpaymentsPayAmount: null,
      nowpaymentsNetwork: null,
      couponCode: null,
      discountPkr: 0,
      createdAt: '2026-10-30T00:00:00.000Z',
      approvedAt: null,
    });
  });
});

describe('mapEntitlementToResponse', () => {
  it('reports null period bounds for a Free entitlement', () => {
    const response = mapEntitlementToResponse({
      plan: 'free',
      active: false,
      counts: ZERO_COUNTS,
      usage: ZERO_COUNTS,
      period: null,
      canPost: false,
      readOnly: true,
      reason: 'Your plan is Free, which covers the Prompt Library only.',
      hasPriorPeriod: false,
    });
    expect(response).toMatchObject({
      plan: 'free',
      active: false,
      periodEndsAt: null,
      periodStartsAt: null,
      canPost: false,
      readOnly: true,
      hasPriorPeriod: false,
    });
  });

  it('reports ISO period bounds for a Paid entitlement', () => {
    const response = mapEntitlementToResponse({
      plan: 'paid',
      active: true,
      counts: { ...ZERO_COUNTS, facebook: 5 },
      usage: { ...ZERO_COUNTS, facebook: 2 },
      period: {
        id: 'period-1',
        userId: 'user-1',
        counts: { ...ZERO_COUNTS, facebook: 5 },
        startsAt: new Date('2026-06-01T00:00:00.000Z'),
        endsAt: new Date('2026-07-01T00:00:00.000Z'),
        supersededAt: null,
      },
      canPost: true,
      readOnly: false,
      reason: null,
      hasPriorPeriod: true,
    });
    expect(response.periodStartsAt).toBe('2026-06-01T00:00:00.000Z');
    expect(response.periodEndsAt).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('paymentRowToItem', () => {
  it('rejects null, arrays, and unreadable rows', () => {
    expect(paymentRowToItem(null)).toBeNull();
    expect(paymentRowToItem([])).toBeNull();
    expect(paymentRowToItem({ nonsense: true })).toBeNull();
  });

  it('maps a readable row', () => {
    const item = paymentRowToItem({
      id: 'payment-1',
      user_id: 'user-1',
      method: 'bank',
      bank_method: 'nayapay',
      status: 'approved',
      facebook_count: 2,
      amount_pkr: 140,
      is_upgrade: false,
      created_at: '2026-10-30T00:00:00.000Z',
    });
    expect(item).toMatchObject({
      id: 'payment-1',
      method: 'bank',
      bankMethod: 'nayapay',
      status: 'approved',
      amountPkr: 140,
    });
  });
});

describe('BANK_PAYMENT_DETAILS', () => {
  it('lists the mobile wallets on the shared number', () => {
    expect(BANK_PAYMENT_DETAILS.easypaisa).toEqual({
      label: 'Easypaisa',
      accountNumber: '03278644204',
    });
    expect(BANK_PAYMENT_DETAILS.nayapay).toEqual({
      label: 'Nayapay',
      accountNumber: '03278644204',
    });
  });

  it('lists the UBL account with IBAN and holder', () => {
    expect(BANK_PAYMENT_DETAILS.ubl).toEqual({
      label: 'UBL bank',
      bank: 'UBL',
      accountNumber: '313590315',
      iban: 'PK77UNIL0109000313590315',
      holder: 'SHAH ZAIB MALIK',
    });
  });
});

describe('billing idempotency helpers', () => {
  type Row = Record<string, unknown>;
  type Filter = { col: string; op: string; val: unknown };

  class IdemBuilder {
    private op: 'select' | 'insert' | 'upsert' | 'delete' = 'select';
    private filters: Filter[] = [];
    private row: Row | null = null;
    private maybeSingleMode = false;

    constructor(private rows: Row[]) {}

    select(): this {
      return this;
    }

    insert(row: Row): this {
      this.op = 'insert';
      this.row = row;
      return this;
    }

    upsert(row: Row): this {
      this.op = 'upsert';
      this.row = row;
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

    lte(col: string, val: unknown): this {
      this.filters.push({ col, op: 'lte', val });
      return this;
    }

    gt(col: string, val: unknown): this {
      this.filters.push({ col, op: 'gt', val });
      return this;
    }

    maybeSingle(): this {
      this.maybeSingleMode = true;
      return this;
    }

    private matches(r: Row): boolean {
      return this.filters.every((f) => {
        const v = r[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'lte') return typeof v === 'string' && typeof f.val === 'string' && v <= f.val;
        if (f.op === 'gt') return typeof v === 'string' && typeof f.val === 'string' && v > f.val;
        return true;
      });
    }

    private compute(): { data: unknown; error: unknown } {
      if (this.op === 'insert' || this.op === 'upsert') {
        const row = { ...this.row } as Row;
        const idx = this.rows.findIndex(
          (r) =>
            r['workspace_id'] === row['workspace_id'] &&
            r['user_id'] === row['user_id'] &&
            r['action'] === row['action'] &&
            r['idempotency_key'] === row['idempotency_key']
        );
        if (idx >= 0) {
          if (this.op === 'upsert') return { data: null, error: null };
          return { data: null, error: { code: '23505' } };
        }
        this.rows.push(row);
        return { data: null, error: null };
      }
      if (this.op === 'delete') {
        for (let i = this.rows.length - 1; i >= 0; i -= 1) {
          if (this.matches(this.rows[i] as Row)) this.rows.splice(i, 1);
        }
        return { data: null, error: null };
      }
      const matched = this.rows.filter((r) => this.matches(r));
      if (this.maybeSingleMode) {
        return { data: matched[0] ?? null, error: null };
      }
      return { data: matched, error: null };
    }

    then(resolve: (value: { data: unknown; error: unknown }) => void): void {
      resolve(this.compute());
    }
  }

  const KEY = '123e4567-e89b-12d3-a456-426614174000';

  function headersWith(key: string | null): { get(name: string): string | null } {
    return { get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? key : null) };
  }

  function idemClient(rows: Row[]): { from(table: string): IdemBuilder } {
    return {
      from(table: string): IdemBuilder {
        if (table !== 'idempotency_keys') throw new Error(`unexpected table ${table}`);
        return new IdemBuilder(rows);
      },
    };
  }

  it('returns no key and touches nothing without a header', async () => {
    const { lookupBillingIdempotency } = await import('@/lib/billing/route-helpers');
    const rows: Row[] = [];
    const result = await lookupBillingIdempotency(
      idemClient(rows) as never,
      'ws-1',
      'user-1',
      'billing-bank',
      headersWith(null)
    );
    expect(result).toEqual({ key: null, replay: null });
    expect(rows).toHaveLength(0);
  });

  it('flags an invalid key without touching the store', async () => {
    const { lookupBillingIdempotency } = await import('@/lib/billing/route-helpers');
    const rows: Row[] = [];
    const result = await lookupBillingIdempotency(
      idemClient(rows) as never,
      'ws-1',
      'user-1',
      'billing-bank',
      headersWith('not-a-uuid')
    );
    expect(result).toEqual({ invalid: true });
    expect(rows).toHaveLength(0);
  });

  it('stores a success and replays it on a same-key retry', async () => {
    const { lookupBillingIdempotency, storeBillingIdempotency } = await import(
      '@/lib/billing/route-helpers'
    );
    const rows: Row[] = [];
    const client = idemClient(rows) as never;
    const first = await lookupBillingIdempotency(client, 'ws-1', 'user-1', 'billing-crypto', headersWith(KEY));
    expect(first).toEqual({ key: KEY, replay: null });
    await storeBillingIdempotency(client, 'ws-1', 'user-1', 'billing-crypto', KEY, {
      status: 201,
      body: { id: 'payment-9' },
    });
    const replay = await lookupBillingIdempotency(client, 'ws-1', 'user-1', 'billing-crypto', headersWith(KEY));
    expect(replay).toEqual({ key: KEY, replay: { status: 201, body: { id: 'payment-9' } } });
  });

  it('skips the store when the key or workspace is missing', async () => {
    const { storeBillingIdempotency } = await import('@/lib/billing/route-helpers');
    const rows: Row[] = [];
    const client = idemClient(rows) as never;
    await storeBillingIdempotency(client, null, 'user-1', 'billing-bank', KEY, { status: 201, body: {} });
    await storeBillingIdempotency(client, 'ws-1', 'user-1', 'billing-bank', null, { status: 201, body: {} });
    expect(rows).toHaveLength(0);
  });
});
