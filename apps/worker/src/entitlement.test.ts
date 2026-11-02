/**
 * Worker-side scheduled-downgrade activation (PR 120 send-back
 * fix B2, option A): a due schedule activates on the worker
 * tick, so a publishing plan never waits for the user to open
 * the app. Tested against a small fake Supabase client — no real
 * database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  activateDueScheduledDowngrade,
  workspaceOwnerHasActivePeriod,
} from './entitlement.js';

type Row = Record<string, unknown>;

interface FakeDb {
  workspaces: Row[];
  users: Row[];
  periods: Row[];
  payments: Row[];
  commissions: Row[];
}

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private limitN: number | null = null;
  private insertRow: Row | null = null;
  private updatePatch: Row | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  insert(row: Row): this {
    this.insertRow = {
      ...row,
      id: `period-${this.db.periods.length + 1}`,
      superseded_at: null,
    };
    if (this.table === 'subscription_periods') this.db.periods.push(this.insertRow);
    return this;
  }

  update(patch: Row): this {
    this.updatePatch = patch;
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Row[]; error: null }) => void): void {
    if (this.updatePatch) {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.updatePatch);
      resolve({ data: matched.map((r) => ({ id: r['id'] })), error: null });
      return;
    }
    resolve({ data: this.matched(), error: null });
  }

  private rows(): Row[] {
    switch (this.table) {
      case 'workspaces':
        return this.db.workspaces;
      case 'users':
        return this.db.users;
      case 'subscription_periods':
        return this.db.periods;
      case 'subscription_payments':
        return this.db.payments;
      case 'seller_commissions':
        return this.db.commissions;
      default:
        return [];
    }
  }

  private matched(): Row[] {
    let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
}

function fakeClient(db: FakeDb): SupabaseClient {
  return {
    from: (table: string) => new FakeBuilder(db, table),
  } as unknown as SupabaseClient;
}

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
    users: [{ id: 'user-1', role: 'user' }],
    periods: [],
    payments: [],
    commissions: [],
    ...overrides,
  };
}

function scheduledPayment(overrides: Row = {}): Row {
  return {
    id: 'payment-1',
    user_id: 'user-1',
    status: 'approved',
    period_id: null,
    is_downgrade: true,
    scheduled_starts_at: '2026-05-20T00:00:00.000Z',
    facebook_count: 2,
    instagram_count: 1,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('activateDueScheduledDowngrade (worker side of option A)', () => {
  it('creates the period at activation time, links it, and backfills the commission period', async () => {
    const db = baseDb({
      payments: [scheduledPayment()],
      commissions: [{ id: 'commission-1', payment_id: 'payment-1', period_id: null }],
    });
    const activated = await activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW);
    expect(activated).toBe(true);
    expect(db.periods).toHaveLength(1);
    expect(db.periods[0]).toMatchObject({
      user_id: 'user-1',
      payment_id: 'payment-1',
      facebook_count: 2,
      starts_at: '2026-06-01T00:00:00.000Z',
      ends_at: '2026-07-01T00:00:00.000Z',
      superseded_at: null,
    });
    expect(db.payments[0]?.['period_id']).toBe('period-1');
    expect(db.commissions[0]?.['period_id']).toBe('period-1');
  });

  it('does not activate while a period is still live', async () => {
    const db = baseDb({
      periods: [
        {
          id: 'period-live',
          user_id: 'user-1',
          starts_at: '2026-05-01T00:00:00.000Z',
          ends_at: '2099-01-01T00:00:00.000Z',
          superseded_at: null,
        },
      ],
      payments: [scheduledPayment()],
    });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      false
    );
    expect(db.periods).toHaveLength(1);
  });

  it('does not activate a schedule whose start is still in the future', async () => {
    const db = baseDb({
      payments: [scheduledPayment({ scheduled_starts_at: '2026-06-20T00:00:00.000Z' })],
    });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      false
    );
    expect(db.periods).toHaveLength(0);
  });

  it('ignores approved payments that are not downgrades', async () => {
    const db = baseDb({ payments: [scheduledPayment({ is_downgrade: false })] });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      false
    );
    expect(db.periods).toHaveLength(0);
  });

  it('a second activation after linking is a no-op', async () => {
    const db = baseDb({ payments: [scheduledPayment()] });
    expect(await activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).toBe(true);
    expect(await activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).toBe(false);
    expect(db.periods).toHaveLength(1);
  });
});

describe('workspaceOwnerHasActivePeriod activates a due schedule on the tick', () => {
  it('returns true after worker activation, without the user opening the app', async () => {
    const db = baseDb({ payments: [scheduledPayment()] });
    await expect(workspaceOwnerHasActivePeriod(fakeClient(db), 'ws-1', NOW)).resolves.toBe(true);
    expect(db.periods).toHaveLength(1);
  });

  it('returns false when nothing is due and no period is live', async () => {
    const db = baseDb();
    await expect(workspaceOwnerHasActivePeriod(fakeClient(db), 'ws-1', NOW)).resolves.toBe(
      false
    );
  });

  it('admin owners stay exempt without touching periods', async () => {
    const db = baseDb({
      users: [{ id: 'user-1', role: 'admin' }],
      payments: [scheduledPayment()],
    });
    await expect(workspaceOwnerHasActivePeriod(fakeClient(db), 'ws-1', NOW)).resolves.toBe(true);
    expect(db.periods).toHaveLength(0);
  });
});
