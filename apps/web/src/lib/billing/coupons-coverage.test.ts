import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyHeldRedemptionsForPayment,
  applyRedemption,
  computeDiscount,
  CouponError,
  couponFromRow,
  couponToItem,
  holdCoupon,
  loadCouponByCode,
  redemptionFromRow,
  releaseHeldRedemptionsForPayment,
  releaseRedemption,
  type CouponRow,
} from './coupons';

/**
 * Coverage for the error, race, and recovery branches of coupons.ts
 * that the happy-path lifecycle suite does not reach. Every test
 * below asserts observable behaviour — an error code, a balance, a
 * row state — so each one fails if the branch it covers regresses.
 *
 * The fake mirrors the semantics coupons.ts relies on (conditional
 * updates only land on rows still matching every filter) and adds
 * fault injection: a rule replaces the next matching queries with
 * an error, an empty result, a null result, or custom data, so
 * database-failure branches can be exercised without a database.
 */
type Row = Record<string, unknown>;

type FaultKind = 'error' | 'empty' | 'null-data' | 'custom';

interface FaultRule {
  table: string;
  op: 'select' | 'insert' | 'update';
  kind: FaultKind;
  /** Matching queries to let through before this rule starts firing. */
  skip: number;
  /** How many matching queries this rule fires for. */
  times: number;
  customData?: unknown;
  onApply?: () => void;
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly faults: FaultRule[]
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
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => {
        for (const rule of this.faults) {
          // The table name is not stored on the query; the harness
          // passes it via a WeakMap-free trick: rules are scoped by
          // checking the table identity through the constructor arg
          // recorded on the query instance below.
          if (rule.table !== this.tableName || rule.op !== this.op) continue;
          if (rule.skip > 0) {
            rule.skip -= 1;
            continue;
          }
          if (rule.times <= 0) continue;
          rule.times -= 1;
          rule.onApply?.();
          if (rule.kind === 'error') return { data: null, error: { message: 'injected failure' } };
          if (rule.kind === 'empty') return { data: [], error: null };
          if (rule.kind === 'null-data') return { data: null, error: null };
          return { data: rule.customData ?? null, error: null };
        }
        return this.run();
      })
      .then(resolve, reject);
  }

  // Set by makeClient's from() right after construction.
  tableName = '';
}

function makeClient() {
  const tables: Record<string, Row[]> = { coupons: [], coupon_redemptions: [] };
  const faults: FaultRule[] = [];
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const wrap = (op: 'select' | 'insert' | 'update', payload: Row | Row[] | null) => {
        const query = new FakeQuery(rows, op, payload, idSeq, faults);
        query.tableName = table;
        return query;
      };
      return {
        select: () => wrap('select', null),
        insert: (payload: Row | Row[]) => wrap('insert', payload),
        update: (payload: Row) => wrap('update', payload),
      };
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    tables,
    fault: (rule: FaultRule) => {
      faults.push(rule);
    },
  };
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

function couponRow(partial: Partial<CouponRow> & { code: string }): CouponRow {
  return {
    id: `coupon-${partial.code}`,
    kind: 'percent_multi',
    percent: null,
    initialBalancePkr: null,
    remainingBalancePkr: null,
    consumedAt: null,
    status: 'active',
    createdBy: 'admin-1',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('lookup failures and row parsing', () => {
  it('a database error while looking a coupon up surfaces as unavailable, not a crash', async () => {
    const faulty = makeClient();
    seedCoupon(faulty.tables, { code: 'LIVE20', kind: 'percent_multi', percent: 20 });
    faulty.fault({ table: 'coupons', op: 'select', kind: 'error', skip: 0, times: 1 });
    await expect(loadCouponByCode(faulty.client, 'LIVE20')).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('blank codes and malformed rows resolve to "not found", never a crash', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'LIVE20', kind: 'percent_multi', percent: 20 });
    expect(await loadCouponByCode(client, '   ')).toBeNull();
    const malformed = makeClient();
    seedCoupon(malformed.tables, { code: 'LIVE20', kind: 'percent_multi', percent: 20 });
    malformed.fault({
      table: 'coupons',
      op: 'select',
      kind: 'custom',
      skip: 0,
      times: 1,
      customData: ['not-a-row'],
    });
    expect(await loadCouponByCode(malformed.client, 'LIVE20')).toBeNull();
  });

  it('row parsers reject incomplete rows and default missing fields', () => {
    expect(couponFromRow({ code: 'X', kind: 'percent_multi' })).toBeNull();
    expect(couponFromRow({ id: '1', kind: 'percent_multi' })).toBeNull();
    expect(couponFromRow({ id: '1', code: 'X', kind: 'bogus' })).toBeNull();
    expect(couponFromRow({ id: '1', code: 'X', kind: 'percent_multi' })?.createdAt).toBe('');
    expect(
      redemptionFromRow({ coupon_id: 'c', user_id: 'u', coupon_kind: 'balance' })
    ).toBeNull();
    expect(
      redemptionFromRow({ id: 'r', user_id: 'u', coupon_kind: 'balance' })
    ).toBeNull();
    expect(redemptionFromRow({ id: 'r', coupon_id: 'c', coupon_kind: 'balance' })).toBeNull();
    expect(
      redemptionFromRow({ id: 'r', coupon_id: 'c', user_id: 'u', coupon_kind: 'bogus' })
    ).toBeNull();
    const base = {
      id: 'r',
      coupon_id: 'c',
      coupon_kind: 'balance',
      user_id: 'u',
      payment_id: null,
      period_id: null,
    };
    expect(redemptionFromRow({ ...base, status: 'released' })?.status).toBe('released');
    expect(redemptionFromRow({ ...base, status: 'applied' })?.status).toBe('applied');
    expect(redemptionFromRow({ ...base, status: 'bogus' })?.status).toBe('held');
    expect(redemptionFromRow({ ...base })?.amountPkr).toBe(0);
    expect(redemptionFromRow({ ...base })?.createdAt).toBe('');
  });

  it('couponToItem carries the row through with its redemption count', () => {
    const item = couponToItem(couponRow({ code: 'POOL', kind: 'balance' }), 3);
    expect(item.code).toBe('POOL');
    expect(item.kind).toBe('balance');
    expect(item.redemptionsCount).toBe(3);
  });
});

describe('computeDiscount edge cases', () => {
  it('a percent coupon with no percent gives no discount, plainly', async () => {
    try {
      computeDiscount(couponRow({ code: 'ONCE', kind: 'percent_once' }), 700);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CouponError);
      expect((err as CouponError).code).toBe('COUPON_NO_DISCOUNT');
    }
    try {
      computeDiscount(couponRow({ code: 'MULTI', kind: 'percent_multi' }), 700);
      expect.unreachable();
    } catch (err) {
      expect((err as CouponError).code).toBe('COUPON_NO_DISCOUNT');
    }
  });

  it('a balance coupon with no recorded balance is exhausted', async () => {
    try {
      computeDiscount(couponRow({ code: 'POOL', kind: 'balance' }), 400);
      expect.unreachable();
    } catch (err) {
      expect((err as CouponError).code).toBe('COUPON_EXHAUSTED');
    }
  });
});

describe('balance claim races', () => {
  it('a coupon deleted or paused between load and claim fails plainly', async () => {
    const gone = makeClient();
    seedCoupon(gone.tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const goneCoupon = await loadCoupon(gone.client, 'POOL1000');
    gone.tables['coupons'].length = 0;
    await expect(
      holdCoupon(gone.client, {
        coupon: goneCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 400,
      })
    ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });

    const paused = makeClient();
    seedCoupon(paused.tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const pausedCoupon = await loadCoupon(paused.client, 'POOL1000');
    paused.tables['coupons'][0]['status'] = 'paused';
    await expect(
      holdCoupon(paused.client, {
        coupon: pausedCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 400,
      })
    ).rejects.toMatchObject({ code: 'COUPON_PAUSED' });

    const deleted = makeClient();
    seedCoupon(deleted.tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const deletedCoupon = await loadCoupon(deleted.client, 'POOL1000');
    deleted.tables['coupons'][0]['status'] = 'deleted';
    await expect(
      holdCoupon(deleted.client, {
        coupon: deletedCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 400,
      })
    ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });
  });

  it('a balance coupon with no recorded balance cannot be held', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'POOL', kind: 'balance' });
    const coupon = await loadCoupon(client, 'POOL');
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_EXHAUSTED' });
  });

  it('two failed claim attempts end in "changed just now", with nothing partially claimed', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupons', op: 'update', kind: 'empty', skip: 0, times: 2 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
    expect(tables['coupon_redemptions']).toHaveLength(0);
  });

  it('a database error while claiming a balance coupon surfaces as unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupons', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
  });
});

describe('percent claim races', () => {
  it('a percent_once claim that hits a database error surfaces as unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    fault({ table: 'coupons', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['consumed_at']).toBeNull();
  });

  it('a percent_once coupon deleted or paused between load and claim fails plainly', async () => {
    const gone = makeClient();
    seedCoupon(gone.tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const goneCoupon = await loadCoupon(gone.client, 'ONCE20');
    gone.tables['coupons'].length = 0;
    await expect(
      holdCoupon(gone.client, { coupon: goneCoupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });

    const paused = makeClient();
    seedCoupon(paused.tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const pausedCoupon = await loadCoupon(paused.client, 'ONCE20');
    paused.tables['coupons'][0]['status'] = 'paused';
    await expect(
      holdCoupon(paused.client, {
        coupon: pausedCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 140,
      })
    ).rejects.toMatchObject({ code: 'COUPON_PAUSED' });

    const deleted = makeClient();
    seedCoupon(deleted.tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const deletedCoupon = await loadCoupon(deleted.client, 'ONCE20');
    deleted.tables['coupons'][0]['status'] = 'deleted';
    await expect(
      holdCoupon(deleted.client, {
        coupon: deletedCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 140,
      })
    ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });
  });

  it('a percent_multi claim that hits a database error, or a vanished or paused coupon, fails plainly', async () => {
    const errored = makeClient();
    seedCoupon(errored.tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const erroredCoupon = await loadCoupon(errored.client, 'MULTI20');
    errored.fault({ table: 'coupons', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(errored.client, {
        coupon: erroredCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 140,
      })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });

    const gone = makeClient();
    seedCoupon(gone.tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const goneCoupon = await loadCoupon(gone.client, 'MULTI20');
    gone.tables['coupons'].length = 0;
    await expect(
      holdCoupon(gone.client, { coupon: goneCoupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });

    const paused = makeClient();
    seedCoupon(paused.tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const pausedCoupon = await loadCoupon(paused.client, 'MULTI20');
    paused.tables['coupons'][0]['status'] = 'paused';
    await expect(
      holdCoupon(paused.client, {
        coupon: pausedCoupon,
        userId: 'user-a',
        paymentId: null,
        discountPkr: 140,
      })
    ).rejects.toMatchObject({ code: 'COUPON_PAUSED' });
  });
});

describe('hold compensation when the redemption insert fails', () => {
  it('a failed insert restores a balance claim, and the hold still reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
    expect(tables['coupon_redemptions']).toHaveLength(0);
  });

  it('a failed insert undoes a percent_once claim, and the hold still reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['consumed_at']).toBeNull();
  });

  it('compensation never undoes a consumption it did not write', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    fault({
      table: 'coupon_redemptions',
      op: 'insert',
      kind: 'error',
      skip: 0,
      times: 1,
      onApply: () => {
        // Something else rewrote the consumption after this claim.
        tables['coupons'][0]['consumed_at'] = '2020-01-01T00:00:00.000Z';
      },
    });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['consumed_at']).toBe('2020-01-01T00:00:00.000Z');
  });

  it('an insert that returns no row still compensates and reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'null-data', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
  });

  it('an insert that returns an unparseable row reports unavailable, never a crash', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    fault({
      table: 'coupon_redemptions',
      op: 'insert',
      kind: 'custom',
      skip: 0,
      times: 1,
      customData: 'not-a-row',
    });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
  });

  it('when compensation itself fails, the hold still reports unavailable and the claim stays drawn', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'error', skip: 0, times: 1 });
    fault({ table: 'coupons', op: 'update', kind: 'error', skip: 1, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    // Claim drew 400 and compensation could not put it back.
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(600);
  });

  it('when compensation never lands, the hold still reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'error', skip: 0, times: 1 });
    fault({ table: 'coupons', op: 'update', kind: 'empty', skip: 1, times: 10 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(600);
  });

  it('when the coupon vanishes mid-compensation, the hold still reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({
      table: 'coupon_redemptions',
      op: 'insert',
      kind: 'error',
      skip: 0,
      times: 1,
      onApply: () => {
        tables['coupons'].length = 0;
      },
    });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
  });
});

describe('apply paths', () => {
  it('applying with a period records the period on the redemption', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    expect(await applyRedemption(client, redemption.id, 'period-1')).toBe(true);
    expect(tables['coupon_redemptions'][0]['period_id']).toBe('period-1');
  });

  it('a database error while applying surfaces as unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    fault({ table: 'coupon_redemptions', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(applyRedemption(client, redemption.id)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a database error while listing held redemptions surfaces as unavailable', async () => {
    const { client, fault } = makeClient();
    fault({ table: 'coupon_redemptions', op: 'select', kind: 'error', skip: 0, times: 1 });
    await expect(applyHeldRedemptionsForPayment(client, 'payment-1')).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a null listing result applies nothing and resolves', async () => {
    const { client, fault } = makeClient();
    fault({ table: 'coupon_redemptions', op: 'select', kind: 'null-data', skip: 0, times: 1 });
    await expect(applyHeldRedemptionsForPayment(client, 'payment-1')).resolves.toBeUndefined();
  });

  it('an unparseable row in a held listing is skipped while the valid row applies', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    tables['coupon_redemptions'].push({ nonsense: true });
    await applyHeldRedemptionsForPayment(client, 'payment-1');
    const valid = tables['coupon_redemptions'].find((row) => row['id'] === redemption.id);
    expect(valid?.['status']).toBe('applied');
    expect(tables['coupon_redemptions']).toHaveLength(2);
  });
});

describe('release paths', () => {
  it('a database error while releasing surfaces as unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    fault({ table: 'coupon_redemptions', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a later live claim survives the release of an earlier one', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    const first = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    // A second live redemption holding the same coupon (e.g. a
    // later legitimate claim recorded before this release runs).
    tables['coupon_redemptions'].push({
      id: 'held-later',
      coupon_id: tables['coupons'][0]['id'],
      coupon_kind: 'percent_once',
      user_id: 'user-b',
      payment_id: 'payment-2',
      period_id: null,
      amount_pkr: 140,
      status: 'held',
      balance_restored: false,
      created_at: new Date().toISOString(),
    });
    expect(await releaseRedemption(client, first)).toBe(true);
    expect(tables['coupons'][0]['consumed_at']).not.toBeNull();
  });

  it('a database error while checking live redemptions surfaces as unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    fault({ table: 'coupon_redemptions', op: 'select', kind: 'error', skip: 0, times: 1 });
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a restore that is already marked done does nothing, even for a held row', async () => {
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
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) row['balance_restored'] = true;
    expect(await releaseRedemption(client, redemption)).toBe(true);
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(600);
  });

  it('a restore with no coupon row left reports unavailable instead of restoring blindly', async () => {
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
    tables['coupons'].length = 0;
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a restore with no recorded balance reports unavailable instead of restoring blindly', async () => {
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
    tables['coupons'][0]['remaining_balance_pkr'] = null;
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a database error during a restore propagates instead of silently succeeding', async () => {
    const { client, tables, fault } = makeClient();
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
    // Fault installed after the hold, so no claim update remains to skip.
    fault({ table: 'coupons', op: 'update', kind: 'error', skip: 0, times: 1 });
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      message: 'injected failure',
    });
  });

  it('a restore that never lands reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
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
    // Fault installed after the hold, so no claim update remains to skip.
    fault({ table: 'coupons', op: 'update', kind: 'null-data', skip: 0, times: 10 });
    await expect(releaseRedemption(client, redemption)).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });
});

describe('payment-level release recovery', () => {
  it('a database error while listing redemptions for release surfaces as unavailable', async () => {
    const { client, fault } = makeClient();
    fault({ table: 'coupon_redemptions', op: 'select', kind: 'error', skip: 0, times: 1 });
    await expect(releaseHeldRedemptionsForPayment(client, 'payment-1')).rejects.toMatchObject({
      code: 'COUPON_UNAVAILABLE',
    });
  });

  it('a null listing result releases nothing and resolves', async () => {
    const { client, fault } = makeClient();
    fault({ table: 'coupon_redemptions', op: 'select', kind: 'null-data', skip: 0, times: 1 });
    await expect(releaseHeldRedemptionsForPayment(client, 'payment-1')).resolves.toBeUndefined();
  });

  it('payment release recovers a held balance row and skips unparseable rows', async () => {
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
    tables['coupon_redemptions'].push({ nonsense: true });
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
    const valid = tables['coupon_redemptions'].find((row) => row['id'] === redemption.id);
    expect(valid?.['status']).toBe('released');
    expect(tables['coupon_redemptions']).toHaveLength(2);
  });

  it('a released balance row that is already restored is not restored again', async () => {
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
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) {
      row['status'] = 'released';
      row['balance_restored'] = true;
    }
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(600);
  });

  it('a released balance row with a zero amount restores nothing', async () => {
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
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) {
      row['status'] = 'released';
      row['amount_pkr'] = 0;
    }
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(600);
  });

  it('a released balance row whose restore never landed is restored by payment release', async () => {
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
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) row['status'] = 'released';
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
    expect(row?.['balance_restored']).toBe(true);
  });

  it('a released percent_once row whose consumption was never undone is freed by payment release', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'ONCE20', kind: 'percent_once', percent: 20 });
    const coupon = await loadCoupon(client, 'ONCE20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) row['status'] = 'released';
    expect(tables['coupons'][0]['consumed_at']).not.toBeNull();
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['consumed_at']).toBeNull();
  });
});

describe('remaining compensation and listing branches', () => {
  it('compensation with no recorded balance retries, then reports unavailable', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, {
      code: 'POOL1000',
      kind: 'balance',
      initial_balance_pkr: 1000,
      remaining_balance_pkr: 1000,
    });
    const coupon = await loadCoupon(client, 'POOL1000');
    fault({
      table: 'coupon_redemptions',
      op: 'insert',
      kind: 'error',
      skip: 0,
      times: 1,
      onApply: () => {
        tables['coupons'][0]['remaining_balance_pkr'] = null;
      },
    });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 400 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    // No blind restore landed on a row with no recorded balance.
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBeNull();
  });

  it('a percent_multi hold that fails to insert needs no compensation', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    fault({ table: 'coupon_redemptions', op: 'insert', kind: 'error', skip: 0, times: 1 });
    await expect(
      holdCoupon(client, { coupon, userId: 'user-a', paymentId: null, discountPkr: 140 })
    ).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' });
    expect(tables['coupon_redemptions']).toHaveLength(0);
  });

  it('a null row in a held listing is skipped while the valid row applies', async () => {
    const { client, tables, fault } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    const heldRow = { ...tables['coupon_redemptions'][0] };
    fault({
      table: 'coupon_redemptions',
      op: 'select',
      kind: 'custom',
      skip: 0,
      times: 1,
      customData: [null, heldRow],
    });
    await applyHeldRedemptionsForPayment(client, 'payment-1');
    const valid = tables['coupon_redemptions'].find((row) => row['id'] === redemption.id);
    expect(valid?.['status']).toBe('applied');
  });

  it('a null row in a release listing is skipped while the valid row releases', async () => {
    const { client, tables, fault } = makeClient();
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
    const heldRow = { ...tables['coupon_redemptions'][0] };
    fault({
      table: 'coupon_redemptions',
      op: 'select',
      kind: 'custom',
      skip: 0,
      times: 1,
      customData: [null, heldRow],
    });
    await releaseHeldRedemptionsForPayment(client, 'payment-1');
    expect(tables['coupons'][0]['remaining_balance_pkr']).toBe(1000);
    const valid = tables['coupon_redemptions'].find((row) => row['id'] === redemption.id);
    expect(valid?.['status']).toBe('released');
  });

  it('a released percent_multi row needs no recovery on payment release', async () => {
    const { client, tables } = makeClient();
    seedCoupon(tables, { code: 'MULTI20', kind: 'percent_multi', percent: 20 });
    const coupon = await loadCoupon(client, 'MULTI20');
    const redemption = await holdCoupon(client, {
      coupon,
      userId: 'user-a',
      paymentId: 'payment-1',
      discountPkr: computeDiscount(coupon, 700),
    });
    const row = tables['coupon_redemptions'].find((r) => r['id'] === redemption.id);
    if (row) row['status'] = 'released';
    await expect(releaseHeldRedemptionsForPayment(client, 'payment-1')).resolves.toBeUndefined();
    expect(row?.['status']).toBe('released');
  });
});
