/**
 * Worker-side scheduled-downgrade activation (PR 120 send-back
 * fix B2, option A): a due schedule activates on the worker
 * tick, so a publishing plan never waits for the user to open
 * the app. Tested against a small fake Supabase client — no real
 * database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { InternalError } from '@fbuploadpro/contracts';

import {
  activateDueScheduledDowngrade,
  workspaceCanPublishForDestination,
} from './entitlement.js';

type Row = Record<string, unknown>;

interface FakeDb {
  workspaces: Row[];
  users: Row[];
  periods: Row[];
  payments: Row[];
  commissions: Row[];
  /** S2: subscription_usage rows the can_publish_for fake counts. */
  usage: Row[];
  /** S2: destinations rows the can_publish_for fake checks for 'disconnected'. */
  destinations: Row[];
  /** Every query the fake answers, in order (C3: pins the probe shape). */
  queries: Array<{ table: string; op: 'select' | 'insert' | 'update'; limit: number | null }>;
  /** C4: every RPC call the fake answers, in order. */
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  /** C3: when true, the EXISTS probe (payments select, limit 1) errors. */
  failExistsProbe?: boolean;
  /** S2: when true, the can_publish_for RPC errors. */
  failRpc?: boolean;
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

  lte(col: string, val: string): this {
    this.filters.push((r) => typeof r[col] === 'string' && (r[col] as string) <= val);
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private log(op: 'select' | 'insert' | 'update'): void {
    this.db.queries.push({ table: this.table, op, limit: this.limitN });
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
    this.log(this.insertRow ? 'insert' : this.updatePatch ? 'update' : 'select');
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    this.log(this.insertRow ? 'insert' : this.updatePatch ? 'update' : 'select');
    if (this.insertRow) return { data: this.insertRow, error: null };
    return { data: this.matched()[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Row[] | null; error: unknown }) => void): void {
    // C3 probe failure: only the EXISTS query (payments select with
    // limit 1) errors — the full-path select has no limit, so it
    // still runs and the activation can proceed.
    if (
      this.db.failExistsProbe &&
      this.table === 'subscription_payments' &&
      this.limitN === 1 &&
      !this.insertRow &&
      !this.updatePatch
    ) {
      this.log('select');
      resolve({ data: null, error: new Error('exists probe boom') });
      return;
    }
    this.log(this.updatePatch ? 'update' : this.insertRow ? 'insert' : 'select');
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
      case 'subscription_usage':
        return this.db.usage;
      case 'destinations':
        return this.db.destinations;
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
    // S2: the shared can_publish_for function, computed from the
    // same fake rows the SQL function reads — admin owner, or an
    // active period whose window contains p_at, plus the count
    // half: already-registered (non-publish-now usage row for the
    // key) or counted usage (publish-now features excluded,
    // rows linked to a disconnected destination in the owner's
    // workspaces excluded) under the period's *_count cap.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      if (db.failRpc) return { data: null, error: new Error('rpc boom') };
      if (fn !== 'can_publish_for') {
        throw new InternalError(`unexpected rpc ${fn}`);
      }
      const workspace = db.workspaces.find((w) => w['id'] === args['p_workspace_id']);
      const ownerId = workspace?.['owner_id'];
      const user = db.users.find((u) => u['id'] === ownerId);
      if (user?.['role'] === 'admin') return { data: true, error: null };
      const at = Date.parse(args['p_at'] as string);
      const period = db.periods
        .filter((p) => {
          if (p['user_id'] !== ownerId || p['superseded_at'] !== null) return false;
          const starts = Date.parse(p['starts_at'] as string);
          const ends = Date.parse(p['ends_at'] as string);
          return starts <= at && ends > at;
        })
        .sort(
          (a, b) => Date.parse(b['ends_at'] as string) - Date.parse(a['ends_at'] as string)
        )[0];
      if (!period) return { data: false, error: null };
      const platform = args['p_platform'] as string;
      const key = args['p_destination_key'] as string;
      const isPublishNow = (feature: unknown): boolean =>
        feature === 'publish-now' ||
        feature === 'instagram-publish-now' ||
        feature === 'threads-publish-now';
      const registered = db.usage.some(
        (u) =>
          u['user_id'] === ownerId &&
          u['platform'] === platform &&
          u['destination_key'] === key &&
          !isPublishNow(u['feature'])
      );
      if (registered) return { data: true, error: null };
      const disconnectedIds = new Set(
        db.destinations
          .filter(
            (d) =>
              d['status'] === 'disconnected' &&
              d['platform'] === platform &&
              db.workspaces.some(
                (w) => w['id'] === d['workspace_id'] && w['owner_id'] === ownerId
              )
          )
          .map((d) => d['id'])
      );
      const usage = db.usage.filter(
        (u) =>
          u['user_id'] === ownerId &&
          u['platform'] === platform &&
          !isPublishNow(u['feature']) &&
          !disconnectedIds.has(u['destination_id'])
      ).length;
      const count =
        typeof period[`${platform}_count`] === 'number'
          ? (period[`${platform}_count`] as number)
          : 0;
      return { data: usage < count, error: null };
    },
  } as unknown as SupabaseClient;
}

function baseDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
    users: [{ id: 'user-1', role: 'user' }],
    periods: [],
    payments: [],
    commissions: [],
    usage: [],
    destinations: [],
    queries: [],
    rpcCalls: [],
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

describe('workspaceCanPublishForDestination activates a due schedule on the tick', () => {
  it('returns true after worker activation, without the user opening the app', async () => {
    const db = baseDb({ payments: [scheduledPayment()] });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(true);
    expect(db.periods).toHaveLength(1);
    // S2: the first RPC says no, activation runs, the re-check is a
    // second call to the same RPC — never a periods select.
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual([
      'can_publish_for',
      'can_publish_for',
    ]);
  });

  it('returns false when nothing is due and no period is live', async () => {
    const db = baseDb();
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('admin owners stay exempt without touching periods', async () => {
    const db = baseDb({
      users: [{ id: 'user-1', role: 'admin' }],
      payments: [scheduledPayment()],
    });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(true);
    expect(db.periods).toHaveLength(0);
    // S2: exactly one RPC call, zero table queries on the admin path.
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.queries).toHaveLength(0);
  });
});

describe('workspaceCanPublishForDestination — one RPC gate (S2)', () => {
  const periodSelects = (db: FakeDb) =>
    db.queries.filter((q) => q.table === 'subscription_periods' && q.op === 'select');
  const paymentSelects = (db: FakeDb) =>
    db.queries.filter((q) => q.table === 'subscription_payments' && q.op === 'select');

  it('live period: true with exactly one RPC call and zero period selects', async () => {
    const db = baseDb({
      periods: [
        {
          id: 'period-live',
          user_id: 'user-1',
          facebook_count: 1,
          starts_at: '2026-05-01T00:00:00.000Z',
          ends_at: '2026-07-01T00:00:00.000Z',
          superseded_at: null,
        },
      ],
    });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toEqual({
      fn: 'can_publish_for',
      args: {
        p_workspace_id: 'ws-1',
        p_platform: 'facebook',
        p_destination_key: 'ext-dest-1',
        p_at: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(periodSelects(db)).toHaveLength(0);
    expect(db.queries).toHaveLength(0);
  });

  it('expired period only: false; the false path pays the activation probe, no full select', async () => {
    const db = baseDb({
      periods: [
        {
          id: 'period-expired',
          user_id: 'user-1',
          starts_at: '2026-04-01T00:00:00.000Z',
          ends_at: '2026-05-01T00:00:00.000Z',
          superseded_at: null,
        },
      ],
    });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    expect(db.rpcCalls).toHaveLength(1);
    // The activation function's own periods select + exactly one
    // payments query — the LIMIT 1 EXISTS probe. No full select,
    // and the gate itself never selected periods.
    expect(periodSelects(db)).toHaveLength(1);
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
  });

  it('superseded-only period: false, same false-path shape as expired', async () => {
    const db = baseDb({
      periods: [
        {
          id: 'period-superseded',
          user_id: 'user-1',
          starts_at: '2026-05-01T00:00:00.000Z',
          ends_at: '2026-07-01T00:00:00.000Z',
          superseded_at: '2026-05-15T00:00:00.000Z',
        },
      ],
    });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    expect(db.rpcCalls).toHaveLength(1);
    expect(periodSelects(db)).toHaveLength(1);
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
  });

  it('future-only period: false, same false-path shape as expired', async () => {
    const db = baseDb({
      periods: [
        {
          id: 'period-future',
          user_id: 'user-1',
          starts_at: '2026-07-01T00:00:00.000Z',
          ends_at: '2026-08-01T00:00:00.000Z',
          superseded_at: null,
        },
      ],
    });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    expect(db.rpcCalls).toHaveLength(1);
    expect(periodSelects(db)).toHaveLength(1);
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
  });

  it('RPC error: false (fail closed), loud log, no throw, no table query', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = baseDb({ failRpc: true });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.queries).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('publish-count check failed'),
      expect.anything()
    );
    errSpy.mockRestore();
  });
});

describe('activateDueScheduledDowngrade — C3 EXISTS gate', () => {
  const paymentSelects = (db: FakeDb) =>
    db.queries.filter((q) => q.table === 'subscription_payments' && q.op === 'select');

  it('active period: the gate never runs — zero payments queries', async () => {
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
    expect(paymentSelects(db)).toHaveLength(0);
    expect(db.periods).toHaveLength(1);
  });

  it('nothing due: exactly one EXISTS query (limit 1), no full payments select', async () => {
    const db = baseDb();
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      false
    );
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
    expect(db.periods).toHaveLength(0);
  });

  it('future schedule: the EXISTS returns no row, no period is created', async () => {
    const db = baseDb({
      payments: [scheduledPayment({ scheduled_starts_at: '2026-06-20T00:00:00.000Z' })],
    });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      false
    );
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
    expect(db.periods).toHaveLength(0);
  });

  it('due schedule: EXISTS first, then the full path — period created and linked', async () => {
    const db = baseDb({
      payments: [scheduledPayment()],
      commissions: [{ id: 'commission-1', payment_id: 'payment-1', period_id: null }],
    });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      true
    );
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
      { table: 'subscription_payments', op: 'select', limit: null },
    ]);
    expect(db.periods).toHaveLength(1);
    expect(db.payments[0]?.['period_id']).toBe('period-1');
    expect(db.commissions[0]?.['period_id']).toBe('period-1');
  });

  it('EXISTS error: logged loudly and the full path still activates', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = baseDb({ payments: [scheduledPayment()], failExistsProbe: true });
    await expect(activateDueScheduledDowngrade(fakeClient(db), 'user-1', NOW)).resolves.toBe(
      true
    );
    expect(db.periods).toHaveLength(1);
    expect(db.payments[0]?.['period_id']).toBe('period-1');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('due scheduled downgrade probe failed'),
      expect.anything()
    );
    errSpy.mockRestore();
  });
});

describe('workspaceCanPublishForDestination — C3 ADU gate probe', () => {
  const paymentSelects = (db: FakeDb) =>
    db.queries.filter((q) => q.table === 'subscription_payments' && q.op === 'select');
  const periodSelects = (db: FakeDb) =>
    db.queries.filter((q) => q.table === 'subscription_periods' && q.op === 'select');

  it('no period, nothing due: one RPC + the activation probe, no full payments select', async () => {
    const db = baseDb();
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(
      false
    );
    // S2: the gate is one RPC call; the only periods select left is
    // the activation function's own, then exactly one payments
    // query — the LIMIT 1 EXISTS.
    expect(db.rpcCalls).toHaveLength(1);
    expect(periodSelects(db)).toHaveLength(1);
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
    ]);
    expect(db.periods).toHaveLength(0);
  });

  it('due schedule: EXISTS, then the full path, and the re-check sees the period', async () => {
    const db = baseDb({ payments: [scheduledPayment()] });
    await expect(workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW)).resolves.toBe(true);
    expect(paymentSelects(db)).toEqual([
      { table: 'subscription_payments', op: 'select', limit: 1 },
      { table: 'subscription_payments', op: 'select', limit: null },
    ]);
    // S2: first RPC false, second RPC (post-activation re-check) true.
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.periods).toHaveLength(1);
    expect(db.payments[0]?.['period_id']).toBe('period-1');
  });
});

describe('workspaceCanPublishForDestination — counts (S2)', () => {
  const livePeriod = (overrides: Row = {}): Row => ({
    id: 'period-live',
    user_id: 'user-1',
    facebook_count: 1,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: '2026-05-01T00:00:00.000Z',
    ends_at: '2026-07-01T00:00:00.000Z',
    superseded_at: null,
    ...overrides,
  });
  const usageRow = (
    destinationKey: string,
    feature = 'schedule',
    destinationId: string | null = null
  ): Row => ({
    id: `usage-${destinationKey}`,
    user_id: 'user-1',
    platform: 'facebook',
    destination_key: destinationKey,
    feature,
    destination_id: destinationId,
  });
  const gate = (db: FakeDb) =>
    workspaceCanPublishForDestination(fakeClient(db), 'ws-1', 'facebook', 'ext-dest-1', NOW);

  it('live period, destination registered, usage at cap → true (grandfather branch)', async () => {
    const db = baseDb({
      periods: [livePeriod()],
      usage: [usageRow('ext-dest-1')],
    });
    await expect(gate(db)).resolves.toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]?.fn).toBe('can_publish_for');
  });

  it('live period, destination unregistered, usage below cap → true', async () => {
    const db = baseDb({
      periods: [livePeriod({ facebook_count: 2 })],
      usage: [usageRow('other-key')],
    });
    await expect(gate(db)).resolves.toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('live period, destination unregistered, usage at cap → false', async () => {
    const db = baseDb({
      periods: [livePeriod()],
      usage: [usageRow('other-key')],
    });
    await expect(gate(db)).resolves.toBe(false);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('live period, destination unregistered, usage at cap, target disconnected → false', async () => {
    const db = baseDb({
      periods: [livePeriod()],
      usage: [usageRow('other-key')],
      destinations: [
        { id: 'dest-1', workspace_id: 'ws-1', platform: 'facebook', status: 'disconnected' },
      ],
    });
    await expect(gate(db)).resolves.toBe(false);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('live period, usage below cap only because a registered destination is disconnected → true', async () => {
    const db = baseDb({
      periods: [livePeriod()],
      usage: [usageRow('ext-dest-9', 'schedule', 'dest-9')],
      destinations: [
        { id: 'dest-9', workspace_id: 'ws-1', platform: 'facebook', status: 'disconnected' },
      ],
    });
    await expect(gate(db)).resolves.toBe(true);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('legacy publish-now-only row for the destination, usage at cap → false', async () => {
    const db = baseDb({
      periods: [livePeriod()],
      usage: [usageRow('other-key'), usageRow('ext-dest-1', 'publish-now')],
    });
    await expect(gate(db)).resolves.toBe(false);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('no period: false; exactly one RPC + the activation probe, no full select', async () => {
    const db = baseDb();
    await expect(gate(db)).resolves.toBe(false);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]?.fn).toBe('can_publish_for');
    // The gate itself never selects periods; the single periods
    // select is the activation function's own, then exactly one
    // payments query — the LIMIT 1 EXISTS probe.
    expect(
      db.queries.filter((q) => q.table === 'subscription_periods' && q.op === 'select')
    ).toHaveLength(1);
    expect(
      db.queries.filter((q) => q.table === 'subscription_payments' && q.op === 'select')
    ).toEqual([{ table: 'subscription_payments', op: 'select', limit: 1 }]);
  });

  it('RPC error: false (fail closed), loud log, no throw, no table query', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = baseDb({ periods: [livePeriod()], failRpc: true });
    await expect(gate(db)).resolves.toBe(false);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.queries).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('publish-count check failed'),
      expect.anything()
    );
    errSpy.mockRestore();
  });
});
