import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  aduDestinationKeysForCap,
  registerAduConfigUsage,
  releaseAduConfigUsage,
  type AduContext,
} from './adu';
import {
  assertFeatureAddWithinCap,
  getUsageCount,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';

/**
 * Plan-check B1 — Threads Auto Download must register its cap unit.
 *
 * Before this fix, the Threads ADU route cap-checked at add but never
 * called registerUsage, and its DELETE never released — so a user
 * could add unlimited Threads ADU configs. These tests run the REAL
 * entitlement engine (registerUsage / assertFeatureAddWithinCap /
 * releaseUsageForFeature) against an in-memory Supabase stand-in, so
 * they prove the behaviour end to end at the adu.ts boundary:
 * a Threads config consumes one Threads unit, deleting it frees it,
 * at-cap blocks the add, and the add-gate and the register agree on
 * the destination key (external_destination_id ?? id).
 *
 * Fake pattern follows usage-publish-now.test.ts: filters AND
 * together, a duplicate (user, platform, destination_key) insert
 * fails with 23505 like the real unique index, and a delete
 * followed by .select() returns the deleted rows (what
 * releaseUsageForFeature reads).
 */
type Row = Record<string, unknown>;

const billingClientHolder: { client: SupabaseClient | null } = { client: null };

vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: () => billingClientHolder.client,
}));

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;
  private selectCalled = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectCalled = true;
    if (opts?.head) this.head = true;
    return this;
  }

  insert(): this {
    return this;
  }

  update(): this {
    return this;
  }

  delete(): this {
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

  lte(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) <= value);
    return this;
  }

  gt(key: string, value: string): this {
    this.filters.push((row) => typeof row[key] === 'string' && (row[key] as string) > value);
    return this;
  }

  order(): this {
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

  private run(): { data: unknown; error: { code: string } | null; count?: number } {
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of rows) {
        if (this.tableName === 'subscription_usage') {
          const clash = this.table.some(
            (existing) =>
              existing['user_id'] === row['user_id'] &&
              existing['platform'] === row['platform'] &&
              existing['destination_key'] === row['destination_key']
          );
          if (clash) return { data: null, error: { code: '23505' } };
        }
      }
      const inserted = rows.map((row) => {
        const fresh: Row = { id: this.idSeq(), ...row };
        this.table.push(fresh);
        return { ...fresh };
      });
      return { data: inserted, error: null };
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
      return { data: this.selectCalled ? updated : [], error: null };
    }
    if (this.op === 'delete') {
      const deleted: Row[] = [];
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) {
          deleted.push({ ...(this.table[i] as Row) });
          this.table.splice(i, 1);
        }
      }
      return { data: this.selectCalled ? deleted : [], error: null };
    }
    let rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
    const count = rows.length;
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.head) return { data: [], error: null, count };
    if (this.mode === 'single') return { data: rows[0] ?? null, error: null };
    if (this.mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, count };
  }

  then(
    resolve: (value: { data: unknown; error: { code: string } | null; count?: number }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeClient() {
  const tables: Record<string, Row[]> = {
    subscription_periods: [],
    subscription_usage: [],
    destinations: [],
    workspaces: [{ id: 'ws-1', owner_id: 'user-1' }],
    adu_configs: [],
    subscription_payments: [],
    seller_commissions: [],
  };
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table).select(cols, opts),
        insert: (payload: Row | Row[]) => new FakeQuery(rows, 'insert', payload, idSeq, table),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload, idSeq, table),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

const DAY = 86_400_000;

function seedActivePeriod(tables: Record<string, Row[]>, threadsCount: number) {
  const now = Date.now();
  tables['subscription_periods'].push({
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 0,
    instagram_count: 0,
    threads_count: threadsCount,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(now - 10 * DAY).toISOString(),
    ends_at: new Date(now + 20 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedThreadsDestination(
  tables: Record<string, Row[]>,
  id: string,
  externalId: string | null
) {
  tables['destinations'].push({
    id,
    workspace_id: 'ws-1',
    platform: 'threads',
    external_destination_id: externalId,
    status: 'active',
  });
}

function seedConfig(tables: Record<string, Row[]>, configId: string, destinationId: string) {
  tables['adu_configs'].push({ id: configId, workspace_id: 'ws-1', destination_id: destinationId });
}

function makeCtx(client: SupabaseClient, role = 'user'): AduContext {
  return { workspaceId: 'ws-1', supabase: client, userId: 'user-1', role };
}

describe('Threads ADU cap registration (plan-check B1)', () => {
  beforeEach(() => {
    billingClientHolder.client = null;
  });

  it('the cap key for a Threads destination is its external id', async () => {
    const { client, tables } = makeClient();
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedThreadsDestination(tables, 'dest-2', null);
    const keys = await aduDestinationKeysForCap(client, 'ws-1', 'threads', [
      'dest-1',
      'dest-2',
    ]);
    // Order follows the row order returned by the query; both keys
    // must be present and the null-external destination falls back
    // to its row id.
    expect(keys).toHaveLength(2);
    expect(keys).toContain('threads-acct-1');
    expect(keys).toContain('dest-2');
  });

  it('registering a Threads ADU config consumes one Threads unit', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 2);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedConfig(tables, 'config-1', 'dest-1');

    const reg = await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-1', 'config-1');
    expect(reg.ok).toBe(true);
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]).toMatchObject({
      user_id: 'user-1',
      platform: 'threads',
      destination_key: 'threads-acct-1',
      feature: 'auto-download-upload',
      destination_id: 'dest-1',
    });
    expect(await getUsageCount(client, 'user-1', 'threads')).toBe(1);
    // The config survives: registration succeeded, so no rollback.
    expect(tables['adu_configs']).toHaveLength(1);
  });

  it('the add-gate sees the registered unit under the same key', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedThreadsDestination(tables, 'dest-2', 'threads-acct-2');
    seedConfig(tables, 'config-1', 'dest-1');

    // Before registering, the gate sees 0 used and the new key fits.
    const keys = await aduDestinationKeysForCap(client, 'ws-1', 'threads', ['dest-1']);
    const before = await assertFeatureAddWithinCap(client, 'user-1', 'threads', keys);
    expect(before).toMatchObject({ allowed: 1, used: 0, newCount: 1 });

    await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-1', 'config-1');

    // After registering, the SAME key is already used (newCount 0,
    // so re-adding it passes), while a different key is now at cap.
    const same = await assertFeatureAddWithinCap(client, 'user-1', 'threads', keys);
    expect(same).toMatchObject({ allowed: 1, used: 1, newCount: 0 });
    const otherKeys = await aduDestinationKeysForCap(client, 'ws-1', 'threads', ['dest-2']);
    await expect(
      assertFeatureAddWithinCap(client, 'user-1', 'threads', otherKeys)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
  });

  it('at cap, registering fails with SUBSCRIPTION_CAP_REACHED and rolls the config back', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedThreadsDestination(tables, 'dest-2', 'threads-acct-2');
    seedConfig(tables, 'config-1', 'dest-1');
    seedConfig(tables, 'config-2', 'dest-2');

    expect(
      await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-1', 'config-1')
    ).toEqual({ ok: true });
    const reg = await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-2', 'config-2');
    expect(reg.ok).toBe(false);
    if (reg.ok) throw new Error('expected the at-cap registration to fail');
    expect(reg.error).toBeInstanceOf(SubscriptionGateError);
    expect((reg.error as SubscriptionGateError).code).toBe('SUBSCRIPTION_CAP_REACHED');
    // Only the first unit counts, and the second config was rolled
    // back (deleted) — a config can never exist without its unit.
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(await getUsageCount(client, 'user-1', 'threads')).toBe(1);
    expect(tables['adu_configs'].map((row) => row['id'])).toEqual(['config-1']);
  });

  it('a free user cannot register: the gate refuses and the config is rolled back', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    // No period seeded: Free user, never paid.
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedConfig(tables, 'config-1', 'dest-1');

    const reg = await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-1', 'config-1');
    expect(reg.ok).toBe(false);
    if (reg.ok) throw new Error('expected the free-user registration to fail');
    expect((reg.error as SubscriptionGateError).code).toBe('SUBSCRIPTION_REQUIRED');
    expect(tables['subscription_usage']).toHaveLength(0);
    expect(tables['adu_configs']).toHaveLength(0);
  });

  it('deleting a Threads ADU config frees its unit', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedConfig(tables, 'config-1', 'dest-1');

    await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-1', 'config-1');
    expect(await getUsageCount(client, 'user-1', 'threads')).toBe(1);

    await releaseAduConfigUsage(makeCtx(client), 'threads', 'dest-1');
    expect(tables['subscription_usage']).toHaveLength(0);
    expect(await getUsageCount(client, 'user-1', 'threads')).toBe(0);

    // The freed unit is usable again: a different destination
    // registers cleanly at the same cap of 1.
    seedThreadsDestination(tables, 'dest-2', 'threads-acct-2');
    seedConfig(tables, 'config-2', 'dest-2');
    const reg = await registerAduConfigUsage(makeCtx(client), 'threads', 'dest-2', 'config-2');
    expect(reg.ok).toBe(true);
    expect(await getUsageCount(client, 'user-1', 'threads')).toBe(1);
  });

  it('release keeps the row when another feature still uses the destination', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    // The destination was registered first by queueing, not by ADU.
    tables['subscription_usage'].push({
      id: 'usage-queue',
      user_id: 'user-1',
      platform: 'threads',
      destination_key: 'threads-acct-1',
      feature: 'destination-queue',
      destination_id: 'dest-1',
    });

    await releaseAduConfigUsage(makeCtx(client), 'threads', 'dest-1');
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['feature']).toBe('destination-queue');
  });

  it('admins never register usage', async () => {
    const { client, tables } = makeClient();
    billingClientHolder.client = client;
    seedActivePeriod(tables, 1);
    seedThreadsDestination(tables, 'dest-1', 'threads-acct-1');
    seedConfig(tables, 'config-1', 'dest-1');

    const reg = await registerAduConfigUsage(makeCtx(client, 'admin'), 'threads', 'dest-1', 'config-1');
    expect(reg.ok).toBe(true);
    expect(tables['subscription_usage']).toHaveLength(0);
    expect(tables['adu_configs']).toHaveLength(1);
  });
});
