import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertFeatureAddWithinCap,
  getEntitlement,
  getUsageCount,
  registerUsage,
  SubscriptionGateError,
} from './entitlement';

/**
 * Plan-check R3 + R5 + R5b (one shared plan read for
 * check-then-register): the add-gate and the register share one
 * entitlement read, the register stops checking the same
 * destination twice, and the clean-insert path derives usedCount
 * from the gate read instead of re-counting. A shared-read
 * register still re-counts usage fresh immediately before the
 * INSERT (pre-insert re-check): the shared read is stale by then
 * on the mirror routes, and the re-check is what keeps a
 * concurrent different-destination registration from publishing
 * over the cap.
 *
 * In-memory Supabase stand-in, same pattern as the other billing
 * tests: filters AND together, a conditional update/delete only
 * lands on matching rows, and a duplicate (user, platform, key)
 * insert fails with 23505 like the real unique index. On top of
 * that, every executed query is logged, so the tests can pin that
 * a read really went away — not just that the answer stayed the
 * same. A period select is one getEntitlement's period read; a
 * head-count select is one count query.
 */
type Row = Record<string, unknown>;

interface QueryLogEntry {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  head: boolean;
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string,
    private readonly queryLog: QueryLogEntry[],
    private readonly failures: { inserts: number; retryInsert: number } | null = null,
    private readonly isUsage = false
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }): this {
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
    this.queryLog.push({ table: this.tableName, op: this.op, head: this.head });
    if (this.op === 'insert') {
      if (this.isUsage && this.failures) {
        this.failures.inserts += 1;
        if (this.failures.retryInsert > 0 && this.failures.inserts >= 2) {
          this.failures.retryInsert -= 1;
          return { data: null, error: { code: '500' } };
        }
      }
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const row of rows) {
        const clash = this.table.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
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
      return { data: updated, error: null };
    }
    if (this.op === 'delete') {
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) this.table.splice(i, 1);
      }
      return { data: [], error: null };
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
    subscription_payments: [],
    workspaces: [],
    destinations: [],
  };
  const queryLog: QueryLogEntry[] = [];
  const failures = { inserts: 0, retryInsert: 0 };
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const isUsage = table === 'subscription_usage';
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table, queryLog, failures, isUsage).select(
            cols,
            opts
          ),
        insert: (payload: Row | Row[]) =>
          new FakeQuery(rows, 'insert', payload, idSeq, table, queryLog, failures, isUsage),
        update: (payload: Row) =>
          new FakeQuery(rows, 'update', payload, idSeq, table, queryLog, failures, isUsage),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table, queryLog, failures, isUsage),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, tables, queryLog, failures };
}

const NOW = new Date('2026-11-01T12:00:00.000Z');
const DAY = 86_400_000;

function seedPaidPeriod(
  tables: Record<string, Row[]>,
  userId = 'user-1',
  facebookCount = 5
) {
  tables['subscription_periods'].push({
    id: `period-${userId}`,
    user_id: userId,
    facebook_count: facebookCount,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    ends_at: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedLapsedPeriod(tables: Record<string, Row[]>, userId = 'user-1') {
  tables['subscription_periods'].push({
    id: `period-lapsed-${userId}`,
    user_id: userId,
    facebook_count: 5,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
    ends_at: new Date(NOW.getTime() - 5 * DAY).toISOString(),
    superseded_at: null,
  });
}

function seedUsage(
  tables: Record<string, Row[]>,
  userId: string,
  platform: string,
  key: string,
  feature: string,
  destinationId: string | null = null
) {
  tables['subscription_usage'].push({
    id: `usage-${feature}-${key}`,
    user_id: userId,
    platform,
    destination_key: key,
    feature,
    destination_id: destinationId,
  });
}

function seedWorkspace(tables: Record<string, Row[]>, userId: string, workspaceId = 'ws-1') {
  tables['workspaces'].push({ id: workspaceId, owner_id: userId });
}

function seedDestination(
  tables: Record<string, Row[]>,
  id: string,
  status: string,
  platform = 'facebook',
  workspaceId = 'ws-1'
) {
  tables['destinations'].push({ id, platform, status, workspace_id: workspaceId });
}

function countPeriodSelects(queryLog: QueryLogEntry[]): number {
  return queryLog.filter((entry) => entry.table === 'subscription_periods' && entry.op === 'select')
    .length;
}

function countUsageHeadCounts(queryLog: QueryLogEntry[]): number {
  return queryLog.filter(
    (entry) => entry.table === 'subscription_usage' && entry.op === 'select' && entry.head
  ).length;
}

function countUsageExistenceSelects(queryLog: QueryLogEntry[]): number {
  return queryLog.filter(
    (entry) => entry.table === 'subscription_usage' && entry.op === 'select' && !entry.head
  ).length;
}

async function gateOutcome(
  client: SupabaseClient,
  userId: string,
  platform: 'facebook',
  keys: string[],
  sharedEntitlement?: Awaited<ReturnType<typeof getEntitlement>>
): Promise<string> {
  try {
    await assertFeatureAddWithinCap(client, userId, platform, keys, NOW, sharedEntitlement);
    return 'ok';
  } catch (err) {
    if (err instanceof SubscriptionGateError) return err.code;
    throw err;
  }
}

async function registerOutcome(
  client: SupabaseClient,
  userId: string,
  platform: 'facebook',
  key: string,
  destinationId: string | null = null,
  sharedEntitlement?: Awaited<ReturnType<typeof getEntitlement>>
): Promise<string> {
  try {
    const result = await registerUsage(
      client,
      userId,
      platform,
      key,
      'destination-queue',
      destinationId,
      NOW,
      sharedEntitlement
    );
    return result.alreadyUsed ? 'already-used' : 'registered';
  } catch (err) {
    if (err instanceof SubscriptionGateError) return err.code;
    throw err;
  }
}

describe('R3 — one shared entitlement read for check-then-register', () => {
  it('gate + register with one shared read issue exactly one period select', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    // The route's single read, shared with both steps.
    const shared = await getEntitlement(client, 'user-1', NOW);
    const periodSelectsAfterRouteRead = countPeriodSelects(queryLog);
    expect(periodSelectsAfterRouteRead).toBe(1);

    await assertFeatureAddWithinCap(client, 'user-1', 'facebook', ['page-1'], NOW, shared);
    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW,
      shared
    );
    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    // Neither step paid for a second full read.
    expect(countPeriodSelects(queryLog)).toBe(1);
  });

  it('gate + register without the shared read issue two period selects', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    await assertFeatureAddWithinCap(client, 'user-1', 'facebook', ['page-1'], NOW);
    await registerUsage(client, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1', NOW);
    expect(countPeriodSelects(queryLog)).toBe(2);
  });

  it('cap decisions are identical with and without the shared read, on the matrix', async () => {
    const scenarios: Array<{
      name: string;
      seed: (tables: Record<string, Row[]>) => void;
      keys: string[];
      registerKey: string;
    }> = [
      {
        name: 'paid below cap, new destination',
        seed: (tables) => seedPaidPeriod(tables),
        keys: ['page-1'],
        registerKey: 'page-1',
      },
      {
        name: 'paid at cap, new destination',
        seed: (tables) => {
          seedPaidPeriod(tables, 'user-1', 1);
          seedUsage(tables, 'user-1', 'facebook', 'page-0', 'destination-queue', 'dest-0');
        },
        keys: ['page-1'],
        registerKey: 'page-1',
      },
      {
        name: 'free user, new destination',
        seed: () => {},
        keys: ['page-1'],
        registerKey: 'page-1',
      },
      {
        name: 'expired user, new destination',
        seed: (tables) => seedLapsedPeriod(tables),
        keys: ['page-1'],
        registerKey: 'page-1',
      },
      {
        name: 'paid below cap, already-registered destination',
        seed: (tables) => {
          seedPaidPeriod(tables);
          seedUsage(tables, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1');
        },
        keys: ['page-1'],
        registerKey: 'page-1',
      },
      {
        name: 'paid below cap, disconnected already-registered destination',
        seed: (tables) => {
          seedPaidPeriod(tables);
          seedWorkspace(tables, 'user-1');
          seedDestination(tables, 'dest-1', 'disconnected');
          seedUsage(tables, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1');
        },
        keys: ['page-1'],
        registerKey: 'page-1',
      },
    ];
    for (const scenario of scenarios) {
      const run = async (shared: boolean): Promise<[string, string]> => {
        const { client, tables } = makeClient();
        scenario.seed(tables);
        const entitlement = shared
          ? await getEntitlement(client, 'user-1', NOW)
          : undefined;
        const gate = await gateOutcome(
          client,
          'user-1',
          'facebook',
          scenario.keys,
          entitlement
        );
        const register = await registerOutcome(
          client,
          'user-1',
          'facebook',
          scenario.registerKey,
          null,
          entitlement
        );
        return [gate, register];
      };
      const withShared = await run(true);
      const withoutShared = await run(false);
      expect(
        withShared,
        `${scenario.name}: shared-read outcome differs from the fresh-read outcome`
      ).toEqual(withoutShared);
    }
  });

  it('a paid entitlement for another user is rejected fail-closed, with no row written', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1');
    // The entitlement belongs to user-1 (paid); the calls below
    // are for user-3, who has no period at all. Passing user-1's
    // paid read for user-3 must fail closed, never let user-3
    // publish on user-1's plan.
    const otherUsersEntitlement = await getEntitlement(client, 'user-1', NOW);
    expect(otherUsersEntitlement.period?.userId).toBe('user-1');

    await expect(
      assertFeatureAddWithinCap(client, 'user-3', 'facebook', ['page-1'], NOW, otherUsersEntitlement)
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    await expect(
      registerUsage(
        client,
        'user-3',
        'facebook',
        'page-1',
        'destination-queue',
        'dest-1',
        NOW,
        otherUsersEntitlement
      )
    ).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE' });
    expect(tables['subscription_usage']).toHaveLength(0);
  });

  it('a free/expired entitlement passed for its own user still blocks', async () => {
    const freeClient = makeClient();
    const freeEntitlement = await getEntitlement(freeClient.client, 'user-1', NOW);
    expect(freeEntitlement.plan).toBe('free');
    await expect(
      assertFeatureAddWithinCap(
        freeClient.client,
        'user-1',
        'facebook',
        ['page-1'],
        NOW,
        freeEntitlement
      )
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
    await expect(
      registerUsage(
        freeClient.client,
        'user-1',
        'facebook',
        'page-1',
        'destination-queue',
        'dest-1',
        NOW,
        freeEntitlement
      )
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });

    const expiredClient = makeClient();
    seedLapsedPeriod(expiredClient.tables);
    const expiredEntitlement = await getEntitlement(expiredClient.client, 'user-1', NOW);
    expect(expiredEntitlement.plan).toBe('expired');
    await expect(
      assertFeatureAddWithinCap(
        expiredClient.client,
        'user-1',
        'facebook',
        ['page-1'],
        NOW,
        expiredEntitlement
      )
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  });
});

describe('R5 — the register stops checking the same destination twice', () => {
  it('a clean register performs exactly one destination-existence lookup', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );
    expect(result.alreadyUsed).toBe(false);
    // The one lookup is assertCanPost's; the second pre-check is
    // gone (two lookups would have shown up here).
    expect(countUsageExistenceSelects(queryLog)).toBe(1);
  });

  it('concurrent double-register still yields one unit and both calls report already-used', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    const [first, second] = await Promise.all([
      registerUsage(client, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1', NOW),
      registerUsage(client, 'user-1', 'facebook', 'page-1', 'auto-download-upload', 'dest-1', NOW),
    ]);
    expect(tables['subscription_usage']).toHaveLength(1);
    expect([first.alreadyUsed, second.alreadyUsed].sort()).toEqual([false, true]);
    expect(first.usedCount).toBe(1);
    expect(second.usedCount).toBe(1);
  });

  it('a legacy publish-now row is still replaced, never double-counted', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    seedUsage(tables, 'user-1', 'facebook', 'page-1', 'publish-now', 'dest-1');

    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );
    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['feature']).toBe('destination-queue');
  });
});

describe('R5b — the register stops re-counting after a clean insert', () => {
  it('clean-insert usedCount matches a fresh re-read, with exactly one pre-insert count re-check', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    const shared = await getEntitlement(client, 'user-1', NOW);
    const headCountsBeforeRegister = countUsageHeadCounts(queryLog);
    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW,
      shared
    );
    expect(result.alreadyUsed).toBe(false);
    // The clean-insert path still derives the count from the gate
    // read — no count query runs AFTER the insert. The one count
    // query that runs during the register is the pre-insert
    // re-check (SEND BACK fix on PR 188): with a shared read the
    // gate is stale by the time the register runs, so usage is
    // re-counted fresh immediately before the INSERT and a
    // genuinely new destination at/over cap is refused. The full
    // entitlement read is still shared — no second period select —
    // only this one count query is re-paid.
    expect(countUsageHeadCounts(queryLog)).toBe(headCountsBeforeRegister + 1);
    const fresh = await getUsageCount(client, 'user-1', 'facebook');
    expect(result.usedCount).toBe(fresh);
    expect(result.usedCount).toBe(1);
  });

  it('a disconnected destination falls back to the exact re-read', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedWorkspace(tables, 'user-1');
    seedDestination(tables, 'dest-disc', 'disconnected');

    const shared = await getEntitlement(client, 'user-1', NOW);
    const headCountsBeforeRegister = countUsageHeadCounts(queryLog);
    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-disc',
      'destination-queue',
      'dest-disc',
      NOW,
      shared
    );
    expect(result.alreadyUsed).toBe(false);
    // A disconnected-linked row does not count toward the cap, so
    // usage + 1 would overstate by one — the guard re-reads
    // instead (a count query runs) and the number is exact.
    expect(countUsageHeadCounts(queryLog)).toBeGreaterThan(headCountsBeforeRegister);
    const fresh = await getUsageCount(client, 'user-1', 'facebook');
    expect(result.usedCount).toBe(fresh);
    expect(result.usedCount).toBe(0);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('the cap decision is unchanged: a second destination at cap is still blocked', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 1);
    seedDestination(tables, 'dest-1', 'active');
    seedDestination(tables, 'dest-2', 'active');

    const first = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );
    expect(first.alreadyUsed).toBe(false);
    expect(first.usedCount).toBe(1);
    await expect(
      registerUsage(client, 'user-1', 'facebook', 'page-2', 'destination-queue', 'dest-2', NOW)
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
    expect(tables['subscription_usage']).toHaveLength(1);
  });
});

describe('Pre-insert re-check — a stale shared read cannot publish over the cap', () => {
  it('a competing usage row for a different destination landing after the gate read makes the register throw, with no row written', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 1);
    seedDestination(tables, 'dest-1', 'active');

    // The route's single read, taken while usage is 0 of 1.
    const shared = await getEntitlement(client, 'user-1', NOW);
    expect(shared.usage['facebook']).toBe(0);

    // The competitor: another request registers a different
    // destination after the gate read and before this register —
    // the mirror-route span (duplicate check + paid external
    // profile fetch + mirror insert) in miniature.
    seedUsage(tables, 'user-1', 'facebook', 'page-0', 'destination-queue', 'dest-0');

    await expect(
      registerUsage(
        client,
        'user-1',
        'facebook',
        'page-1',
        'destination-queue',
        'dest-1',
        NOW,
        shared
      )
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CAP_REACHED' });
    // The competing row is the only row: nothing was written for
    // page-1, so no over-cap destination will publish.
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['destination_key']).toBe('page-0');
  });

  it('an already-used destination at cap is still already-used, never refused', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 1);
    seedDestination(tables, 'dest-1', 'active');
    seedUsage(tables, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1');

    const shared = await getEntitlement(client, 'user-1', NOW);
    expect(shared.usage['facebook']).toBe(1);

    // At cap, but this destination already holds the unit: the
    // re-check must not turn a re-register into a cap error.
    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW,
      shared
    );
    // R4: the register returns the entitlement it gated on — here
    // the shared read passed in, unchanged.
    expect(result).toEqual({ alreadyUsed: true, usedCount: 1, entitlement: shared });
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('a competing row linked to a disconnected destination does not trip the re-check', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 1);
    seedWorkspace(tables, 'user-1');
    seedDestination(tables, 'dest-0', 'disconnected');
    seedDestination(tables, 'dest-1', 'active');

    const shared = await getEntitlement(client, 'user-1', NOW);
    expect(shared.usage['facebook']).toBe(0);

    // The competitor's row links to a disconnected destination,
    // so it does not count — at the gate read or at the re-check,
    // which uses the same exclusion.
    seedUsage(tables, 'user-1', 'facebook', 'page-0', 'destination-queue', 'dest-0');

    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW,
      shared
    );
    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(2);
  });

  it('without a shared read the register pays only its own fresh entitlement read — no extra re-check', async () => {
    // What one fresh entitlement read costs in head counts, so
    // the assertion below stays exact if platforms are added.
    const freshRead = makeClient();
    seedPaidPeriod(freshRead.tables);
    seedDestination(freshRead.tables, 'dest-1', 'active');
    await getEntitlement(freshRead.client, 'user-1', NOW);
    const freshReadHeadCounts = countUsageHeadCounts(freshRead.queryLog);

    const { client, tables, queryLog } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    const result = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );
    expect(result.alreadyUsed).toBe(false);
    expect(result.usedCount).toBe(1);
    // The register's own fresh read is the last usage read before
    // the insert here, so the re-check — shared-read only — pays
    // nothing on top of it.
    expect(countUsageHeadCounts(queryLog)).toBe(freshReadHeadCounts);
  });
});
