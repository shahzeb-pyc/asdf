import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UPGRADE_CANCEL_REFUND_REASON } from '@fbuploadpro/contracts';
import { createPeriodForPurchase } from './entitlement';
import { cancelPendingRefundsForSupersededPeriods } from './refund-cancel';

/**
 * Upgrade-cancels-refund tests (owner decision 2026-11-01).
 *
 * In-memory stand-in for the Supabase query builder, following the
 * same pattern as coupons.test.ts: filters AND together, a
 * conditional update only lands on rows still matching every
 * filter, and each awaited call runs atomically. Extended here
 * with lte/gt, which the replaced-period lookup needs.
 */
type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
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

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  is(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  lte(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) <= value);
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) > value);
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
    const rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
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
  const tables: Record<string, Row[]> = { subscription_periods: [], refund_requests: [] };
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

const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;

function seedPeriod(
  tables: Record<string, Row[]>,
  partial: Partial<Row> & { id: string }
): Row {
  const row: Row = {
    user_id: 'user-1',
    facebook_count: 1,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    ends_at: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    superseded_at: null,
    ...partial,
  };
  tables['subscription_periods'].push(row);
  return row;
}

function seedRefund(
  tables: Record<string, Row[]>,
  partial: Partial<Row> & { id: string; period_id: string }
): Row {
  const row: Row = {
    user_id: 'user-1',
    payment_id: 'payment-1',
    status: 'requested',
    amount_paid: 700,
    currency: 'PKR',
    refund_amount: null,
    days_used: null,
    destination_type: 'mobile',
    destination_value: '03210000000',
    destination_network: null,
    reason: null,
    requested_at: NOW.toISOString(),
    decided_at: null,
    sent_at: null,
    ...partial,
  };
  tables['refund_requests'].push(row);
  return row;
}

const COUNTS = {
  facebook: 2,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

describe('upgrade cancels a pending refund', () => {
  it('upgrade activation cancels the pending refund on the replaced period and pays no refund', async () => {
    const { client, tables } = makeClient();
    const old = seedPeriod(tables, { id: 'period-old' });
    const request = seedRefund(tables, { id: 'refund-1', period_id: 'period-old' });

    const period = await createPeriodForPurchase(
      client,
      { userId: 'user-1', counts: COUNTS, paymentId: 'payment-2', isUpgrade: true },
      NOW
    );

    expect(period.id).not.toBe('period-old');
    expect(period.supersededAt).toBeNull();
    expect(old['superseded_at']).toBe(NOW.toISOString());
    expect(request['status']).toBe('rejected');
    expect(request['reason']).toBe(UPGRADE_CANCEL_REFUND_REASON);
    expect(request['refund_amount']).toBeNull();
    // No second live period: exactly one non-superseded period.
    // (The fake insert omits superseded_at where the real column
    // defaults to NULL, so match both.)
    const live = tables['subscription_periods'].filter((row) => row['superseded_at'] == null);
    expect(live).toHaveLength(1);
    expect(live[0]['id']).toBe(period.id);
  });

  it('renewal after expiry leaves the pending refund alone', async () => {
    const { client, tables } = makeClient();
    // Lapsed period: ended before NOW, so a fresh purchase is a
    // renewal, not an upgrade — even though the old period is
    // still unsuperseded in the table.
    seedPeriod(tables, {
      id: 'period-old',
      starts_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      ends_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    });
    const request = seedRefund(tables, { id: 'refund-1', period_id: 'period-old' });

    await createPeriodForPurchase(
      client,
      { userId: 'user-1', counts: COUNTS, paymentId: 'payment-2' },
      NOW
    );

    expect(request['status']).toBe('requested');
    expect(request['reason']).toBeNull();
    expect(request['decided_at']).toBeNull();
  });

  it('upgrade cancels only the replaced period’s request; other requests are untouched', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables, { id: 'period-old' });
    const replaced = seedRefund(tables, { id: 'refund-1', period_id: 'period-old' });
    // A request on an already-superseded period (legacy row from
    // before this rule): not the plan being replaced, left alone.
    seedPeriod(tables, {
      id: 'period-older',
      starts_at: new Date(NOW.getTime() - 70 * DAY).toISOString(),
      ends_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      superseded_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
    });
    const legacy = seedRefund(tables, {
      id: 'refund-2',
      period_id: 'period-older',
      payment_id: 'payment-0',
    });
    // An already-approved request on the replaced period: decided
    // rows are never rewritten.
    const approved = seedRefund(tables, {
      id: 'refund-3',
      period_id: 'period-old',
      payment_id: 'payment-1',
      status: 'approved',
      refund_amount: 500,
      decided_at: new Date(NOW.getTime() - DAY).toISOString(),
    });

    await createPeriodForPurchase(
      client,
      { userId: 'user-1', counts: COUNTS, paymentId: 'payment-2', isUpgrade: true },
      NOW
    );

    expect(replaced['status']).toBe('rejected');
    expect(replaced['reason']).toBe(UPGRADE_CANCEL_REFUND_REASON);
    expect(legacy['status']).toBe('requested');
    expect(legacy['reason']).toBeNull();
    expect(approved['status']).toBe('approved');
    expect(approved['refund_amount']).toBe(500);
  });

  it('cancel helper is a no-op with no period ids and counts only requested rows', async () => {
    const { client, tables } = makeClient();
    expect(await cancelPendingRefundsForSupersededPeriods(client, [])).toBe(0);
    seedRefund(tables, { id: 'refund-1', period_id: 'period-old', status: 'approved' });
    expect(await cancelPendingRefundsForSupersededPeriods(client, ['period-old'], NOW)).toBe(0);
    expect(tables['refund_requests'][0]['status']).toBe('approved');
  });
});
