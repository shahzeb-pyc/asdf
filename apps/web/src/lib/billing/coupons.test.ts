import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyHeldRedemptionsForPayment,
  applyRedemption,
  computeDiscount,
  CouponError,
  holdCoupon,
  loadCouponByCode,
  previewCoupon,
  releaseHeldRedemptionsForPayment,
  releaseRedemption,
  type CouponRow,
} from './coupons';

/**
 * In-memory stand-in for the Supabase query builder, faithful to
 * the semantics coupons.ts relies on: filters AND together, a
 * conditional update only lands on rows still matching every
 * filter (including gte/is guards), and each awaited call runs
 * atomically — the same guarantee the real single-statement
 * updates give against concurrent applications.
 */
type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string
  ) {}

  select(): this {
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

  gte(key: string, value: number): this {
    this.filters.push((row) => typeof row[key] === 'number' && (row[key] as number) >= value);
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

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): this {
    this.mode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.mode = 'maybeSingle';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: null } {
    if (this.op === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload as Row]).map(
        (row) => {
          const inserted: Row = {
            id: this.idSeq(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...row,
          };
          this.table.push(inserted);
          return { ...inserted };
        }
      );
      if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    if (this.op === 'update') {
      const patch = this.payload as Row;
      const updated: Row[] = [];
      for (const row of this.table) {
        if (this.matches(row)) {
          Object.assign(row, patch);
          updated.push({ ...row });
        }
      }
      if (this.mode === 'single') return { data: updated[0] ?? null, error: null };
      if (this.mode === 'maybeSingle') return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    let rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
    if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then(
    resolve: (value: { data: unknown; error: null }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeClient() {
  const tables: Record<string, Row[]> = { coupons: [], coupon_redemptions: [] };
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return {
        select: () => new FakeQuery(rows, 'select', null, idSeq),
        insert: (payload: Row | Row[]) => new FakeQuery(rows, 'insert', payload, idSeq),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload, idSeq),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

function seedCoupon(
  tables: Record<string, Row[]>,
  partial: Partial<Row> & { code: string }
): Row {
  const row: Row = {
    id: `coupon-${partial.code}`,
    kind: 'percent_multi',
    percent: null,
    initial_balance_pkr: null,
    remaining_balance_pkr: null,
    consumed_at: null,
    status: 'active',
    created_by: 'admin-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
  tables['coupons'].push(row);
  return row;
}

async function loadCoupon(client: SupabaseClient, code: string): Promise<CouponRow> {
  const coupon = await loadCouponByCode(client, code);
  if (!coupon) throw new Error(`seed coupon ${code} not found`);
  return coupon;
}

function couponErrorCode(err: unknown): string | null {
  return err instanceof CouponError ? err.code : null;
}

describe('percent_once lifecycle', () => {
  it('20% off a known total, then dead for everyone else', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const first = await loadCoupon(client, 'ONCE20');
    const redemption = await holdCoupon(client, {
      coupon: first,
      userId: 'user-a',
      paymentId: null,
      discountPkr: computeDiscount(first, 700),
    });
    expect(redemption.amountPkr).toBe(140);
    expect(redemption.status).toBe('held');
    const consumed = await loadCoupon(client, 'ONCE20');
    expect(consumed.consumedAt).not.toBeNull();

    // A second application by anyone is rejected: the reloaded
    // coupon already reports itself used at discount time, and
    // even a precomputed discount cannot claim it again.
    const second = await loadCoupon(client, 'ONCE20');
    try {
      computeDiscount(second, 700);
      expect.unreachable();
    } catch (err) {
      expect(couponErrorCode(err)).toBe('COUPON_USED');
    }
    await expect(
      holdCoupon(client, {
        coupon: second,
        userId: 'user-b',
        paymentId: null,
        discountPkr: 140,
      })
    ).rejects.toMatchObject({ code: 'COUPON_USED' });
  });

  it('rejecting the first hold frees the coupon again', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const first = await loadCoupon(client, 'ONCE20');
    const redemption = await holdCoupon(client, {
      coupon: first,
      userId: 'user-a',
      paymentId: null,
      discountPkr: computeDiscount(first, 700),
    });
    expect(await releaseRedemption(client, redemption)).toBe(true);
    const freed = await loadCoupon(client, 'ONCE20');
    expect(freed.consumedAt).toBeNull();
    const second = await loadCoupon(client, 'ONCE20');
    const again = await holdCoupon(client, {
      coupon: second,
      userId: 'user-b',
      paymentId: null,
      discountPkr: computeDiscount(second, 700),
    });
    expect(again.amountPkr).toBe(140);
  });

  it('two concurrent holds: exactly one wins', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const a = await loadCoupon(client, 'ONCE20');
    const b = await loadCoupon(client, 'ONCE20');
    const results = await Promise.allSettled([
      holdCoupon(client, {
        coupon: a,
        userId: 'user-a',
        paymentId: null,
        discountPkr: computeDiscount(a, 700),
      }),
      holdCoupon(client, {
        coupon: b,
        userId: 'user-b',
        paymentId: null,
        discountPkr: computeDiscount(b, 700),
      }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(couponErrorCode((lost[0] as PromiseRejectedResult).reason)).toBe('COUPON_USED');
  });
});

describe('percent_multi lifecycle', () => {
  it('usable repeatedly by different users until paused', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    for (const userId of ['user-a', 'user-b']) {
      const coupon = await loadCoupon(client, 'MULTI20');
      const redemption = await holdCoupon(client, {
        coupon,
        userId,
        paymentId: null,
        discountPkr: computeDiscount(coupon, 700),
      });
      expect(redemption.amountPkr).toBe(140);
      expect(await applyRedemption(client, redemption.id)).toBe(true);
    }
    // Pause blocks new uses only.
    const row = tables['coupons'][0];
    row['status'] = 'paused';
    const paused = await loadCoupon(client, 'MULTI20');
    try {
      computeDiscount(paused, 700);
      expect.unreachable();
    } catch (err) {
      expect(couponErrorCode(err)).toBe('COUPON_PAUSED');
    }
  });

  it('a held redemption still releases after the coupon is paused', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    tables['coupons'][0]['status'] = 'paused';
    expect(await releaseRedemption(client, redemption)).toBe(true);
  });
});

describe('balance lifecycle', () => {
  it('1000 pool, 400 purchase → 600 remains and is reusable', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const first = await loadCoupon(client, 'POOL1000');
    const r1 = await holdCoupon(client, {
      coupon: first,
      userId: 'user-a',
      paymentId: null,
      discountPkr: computeDiscount(first, 400),
    });
    expect(r1.amountPkr).toBe(400);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(600);
    const second = await loadCoupon(client, 'POOL1000');
    const r2 = await holdCoupon(client, {
      coupon: second,
      userId: 'user-b',
      paymentId: null,
      discountPkr: computeDiscount(second, 400),
    });
    expect(r2.amountPkr).toBe(400);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(200);
  });

  it('purchase over balance → discount capped, balance 0 afterward', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: null,
      discountPkr: computeDiscount(coupon, 1500),
    });
    expect(redemption.amountPkr).toBe(1000);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(0);
    const exhausted = await loadCoupon(client, 'POOL1000');
    try {
      computeDiscount(exhausted, 400);
      expect.unreachable();
    } catch (err) {
      expect(couponErrorCode(err)).toBe('COUPON_EXHAUSTED');
    }
  });

  it('manual reject restores the balance, exactly once', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 400),
    });
    expect(await releaseRedemption(client, redemption)).toBe(true);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(1000);
    // A retried release is a no-op, never a double restore.
    expect(await releaseRedemption(client, redemption)).toBe(false);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(1000);
  });

  it('apply does not restore, and payment-level release recovers held rows', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 400),
    });
    await applyHeldRedemptionsForPayment(client, 'payment-1');
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(600);
    expect(await applyRedemption(client, redemption.id)).toBe(false);
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(600);
  });

  it('concurrent applications cannot overdraw the shared pool', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const a = await loadCoupon(client, 'POOL1000');
    const b = await loadCoupon(client, 'POOL1000');
    const [r1, r2] = await Promise.all([
      holdCoupon(client, {
        coupon: a,
        userId: 'user-a',
        paymentId: null,
        discountPkr: computeDiscount(a, 600),
      }),
      holdCoupon(client, {
        coupon: b,
        userId: 'user-b',
        paymentId: null,
        discountPkr: computeDiscount(b, 600),
      }),
    ]);
    expect(r1.amountPkr + r2.amountPkr).toBe(1000);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(0);
  });
});

describe('preview and guards', () => {
  it('preview changes nothing', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const { discountPkr } = await previewCoupon(client, ' pool1000 ', 400);
    expect(discountPkr).toBe(400);
    expect((await loadCoupon(client, 'POOL1000')).remainingBalancePkr).toBe(1000);
    expect(tables['coupon_redemptions']).toHaveLength(0);
  });

  it('unknown, paused, deleted, and zero-amount cases fail plainly', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'PAUSED20', kind: 'percent_multi', percent: 20, status: 'paused' });
    seedCoupon(tables, { code: 'GONE20', kind: 'percent_multi', percent: 20, status: 'deleted' });
    seedCoupon(tables, { code: 'LIVE20', kind: 'percent_multi', percent: 20 });
    await expect(previewCoupon(client, 'NOPE', 700)).rejects.toMatchObject({
      code: 'COUPON_NOT_FOUND',
    });
    await expect(previewCoupon(client, 'PAUSED20', 700)).rejects.toMatchObject({
      code: 'COUPON_PAUSED',
    });
    await expect(previewCoupon(client, 'GONE20', 700)).rejects.toMatchObject({
      code: 'COUPON_NOT_FOUND',
    });
    const live = await loadCoupon(client, 'LIVE20');
    try {
      computeDiscount(live, 0);
      expect.unreachable();
    } catch (err) {
      expect(couponErrorCode(err)).toBe('COUPON_NO_DISCOUNT');
    }
  });
});
