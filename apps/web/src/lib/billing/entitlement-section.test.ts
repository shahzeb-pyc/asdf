import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sectionForUsageFeature } from '@fbuploadpro/contracts';
import {
  assertFeatureAddWithinCap,
  getUsageCount,
  registerUsage,
  releaseUsageForFeature,
  SubscriptionGateError,
} from './entitlement';

/**
 * Spec 174 PR 2B — the usage registry is section-scoped: one row
 * per destination per section. A page in two sections counts
 * twice; disconnecting one section's copy excludes only that
 * section's row; releasing frees only its section's row; an
 * unknown feature fails loud; and the legacy delete-and-replace
 * survives only as a defensive backstop for a legacy row
 * stranded in the same section.
 *
 * In-memory Supabase stand-in, same pattern as the other billing
 * tests: filters AND together, and a duplicate (user, platform,
 * section, key) insert fails with 23505 like the real unique
 * index. The `get_entitlement` RPC answer is computed straight
 * from the fixture tables the way the SQL function does it
 * (active period window, per-platform counts with the
 * disconnected exclusion and the legacy publish-now exclusion).
 */
type Row = Record<string, unknown>;

const RPC_PLATFORMS = ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube'] as const;
const RPC_LEGACY_FEATURES = ['publish-now', 'instagram-publish-now', 'threads-publish-now'];

function computeEntitlementRpc(
  tables: Record<string, Row[]>,
  userId: string,
  nowIso: string
): Row {
  const periods = (tables['subscription_periods'] ?? []).filter(
    (row) => row['user_id'] === userId
  );
  const sortedActive = periods
    .filter(
      (row) =>
        row['superseded_at'] === null &&
        typeof row['starts_at'] === 'string' &&
        (row['starts_at'] as string) <= nowIso &&
        typeof row['ends_at'] === 'string' &&
        (row['ends_at'] as string) > nowIso
    )
    .sort((a, b) => String(b['ends_at']).localeCompare(String(a['ends_at'])));
  const active: Row | null = sortedActive.length > 0 ? sortedActive[0] : null;
  const workspaceIds = new Set(
    (tables['workspaces'] ?? [])
      .filter((row) => row['owner_id'] === userId)
      .map((row) => row['id'] as string)
  );
  const disconnectedByPlatform = new Map<string, Set<string>>();
  for (const dest of tables['destinations'] ?? []) {
    if (
      dest['status'] === 'disconnected' &&
      workspaceIds.has(dest['workspace_id'] as string) &&
      (RPC_PLATFORMS as readonly string[]).includes(dest['platform'] as string)
    ) {
      const set = disconnectedByPlatform.get(dest['platform'] as string) ?? new Set<string>();
      set.add(dest['id'] as string);
      disconnectedByPlatform.set(dest['platform'] as string, set);
    }
  }
  const usage: Row = {};
  for (const platform of RPC_PLATFORMS) {
    usage[platform] = (tables['subscription_usage'] ?? []).filter(
      (row) =>
        row['user_id'] === userId &&
        row['platform'] === platform &&
        !RPC_LEGACY_FEATURES.includes(row['feature'] as string) &&
        !(
          typeof row['destination_id'] === 'string' &&
          (disconnectedByPlatform.get(platform) ?? new Set<string>()).has(
            row['destination_id'] as string
          )
        )
    ).length;
  }
  return {
    period: active ? { ...active } : null,
    usage,
    has_prior_period: periods.length > 0,
  };
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
    private readonly tableName: string
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
        // The fake unique index mirrors the real one:
        // (user, platform, section, key).
        const clash = this.table.some(
          (existing) =>
            existing['user_id'] === row['user_id'] &&
            existing['platform'] === row['platform'] &&
            existing['section'] === row['section'] &&
            existing['destination_key'] === row['destination_key']
        );
        if (clash) return { data: null, error: { code: '23505' } };
      }
      const inserted = rows.map((row) => {
        const fresh: Row = { id: this.idSeq(), ...row };
        this.table.push(fresh);
        return { ...fresh };
      });
      if (this.mode === 'single' || this.mode === 'maybeSingle') {
        return { data: inserted[0] ?? null, error: null };
      }
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
      const deleted: Row[] = [];
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) {
          deleted.push({ ...(this.table[i] as Row) });
          this.table.splice(i, 1);
        }
      }
      return { data: deleted, error: null };
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
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table).select(cols, opts),
        insert: (payload: Row | Row[]) => new FakeQuery(rows, 'insert', payload, idSeq, table),
        update: (payload: Row) => new FakeQuery(rows, 'update', payload, idSeq, table),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table),
      };
    },
    rpc(fn: string, args: { p_user_id: string; p_now: string }) {
      if (fn !== 'get_entitlement') {
        return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
      }
      return Promise.resolve({
        data: computeEntitlementRpc(tables, args.p_user_id, args.p_now),
        error: null,
      });
    },
  };
  return { client: client as unknown as SupabaseClient, tables };
}

const NOW = new Date();
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

function seedUsage(
  tables: Record<string, Row[]>,
  userId: string,
  platform: string,
  key: string,
  feature: string,
  destinationId: string | null = null,
  // The section comes from the feature via the contracts mapping,
  // exactly like the migration backfill. The override exists only
  // for the defensive test, which strands a legacy row in a
  // capped section on purpose.
  section: string | null = null
) {
  tables['subscription_usage'].push({
    id: `usage-${feature}-${key}`,
    user_id: userId,
    platform,
    destination_key: key,
    feature,
    section: section ?? sectionForUsageFeature(feature),
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

describe('section-scoped usage (spec 174 PR 2B)', () => {
  it('the same page in two sections registers two rows and counts twice', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-sched', 'active');
    seedDestination(tables, 'dest-adu', 'active');

    const first = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-sched',
      NOW
    );
    expect(first.alreadyUsed).toBe(false);
    expect(first.usedCount).toBe(1);

    // The same page, in a second section, is a second unit — not
    // already-used. The old "counts once" behaviour is gone.
    const second = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'auto-download-upload',
      'dest-adu',
      NOW
    );
    expect(second.alreadyUsed).toBe(false);
    expect(second.usedCount).toBe(2);
    expect(tables['subscription_usage']).toHaveLength(2);
    const sections = tables['subscription_usage']
      .map((row) => row['section'] as string)
      .sort();
    expect(sections).toEqual(['adu', 'schedule']);
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(2);
  });

  it('the same page in the same section twice is already-used, still one row', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-1', 'active');

    await registerUsage(client, 'user-1', 'facebook', 'page-1', 'destination-queue', 'dest-1', NOW);
    const second = await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-1',
      NOW
    );
    expect(second.alreadyUsed).toBe(true);
    expect(second.usedCount).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('the add-gate is per-section: a page registered in ADU only still counts as new for Schedule', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 2);
    seedUsage(tables, 'user-1', 'facebook', 'page-1', 'auto-download-upload', 'dest-adu');

    // For Schedule the page is new (newCount 1, fits in the cap
    // of 2 alongside the ADU unit); for ADU it is already there.
    const schedule = await assertFeatureAddWithinCap(
      client,
      'user-1',
      'facebook',
      ['page-1'],
      'schedule',
      NOW
    );
    expect(schedule).toMatchObject({ allowed: 2, used: 1, newCount: 1 });
    const adu = await assertFeatureAddWithinCap(
      client,
      'user-1',
      'facebook',
      ['page-1'],
      'adu',
      NOW
    );
    expect(adu).toMatchObject({ allowed: 2, used: 1, newCount: 0 });
  });

  it('disconnecting one section\'s copy excludes only that section\'s row', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables, 'user-1', 2);
    seedWorkspace(tables, 'user-1');
    seedDestination(tables, 'dest-sched', 'active');
    seedDestination(tables, 'dest-adu', 'active');

    await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-sched',
      NOW
    );
    await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'auto-download-upload',
      'dest-adu',
      NOW
    );
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(2);

    // The Schedule copy disconnects; the ADU copy stays active.
    // Only the Schedule row stops counting — the page still
    // counts once, for Auto Download.
    const schedRow = tables['destinations'].find((row) => row['id'] === 'dest-sched');
    if (schedRow) schedRow['status'] = 'disconnected';
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(1);
    expect(tables['subscription_usage']).toHaveLength(2);

    // Reconnecting is a status flip, not a re-registration: the row
    // was never deleted, so the count comes back on its own.
    if (schedRow) schedRow['status'] = 'active';
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(2);
  });

  it('release frees only its section\'s row', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    seedDestination(tables, 'dest-sched', 'active');
    seedDestination(tables, 'dest-adu', 'active');

    await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'destination-queue',
      'dest-sched',
      NOW
    );
    await registerUsage(
      client,
      'user-1',
      'facebook',
      'page-1',
      'auto-download-upload',
      'dest-adu',
      NOW
    );
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(2);

    // Deleting the ADU config frees the ADU unit; the Schedule
    // unit stays, and a second release finds nothing to free.
    expect(
      await releaseUsageForFeature(client, 'user-1', 'facebook', 'page-1', 'auto-download-upload')
    ).toBe(true);
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['feature']).toBe('destination-queue');
    expect(await getUsageCount(client, 'user-1', 'facebook')).toBe(1);
    expect(
      await releaseUsageForFeature(client, 'user-1', 'facebook', 'page-1', 'auto-download-upload')
    ).toBe(false);
  });

  it('an unknown feature fails loud on register and release, writing nothing', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);

    await expect(
      registerUsage(client, 'user-1', 'facebook', 'page-1', 'mystery-feature', 'dest-1', NOW)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      releaseUsageForFeature(client, 'user-1', 'facebook', 'page-1', 'mystery-feature')
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(tables['subscription_usage']).toHaveLength(0);
  });

  it('a legacy row stranded in the same section is still replaced (defensive backstop)', async () => {
    const { client, tables } = makeClient();
    seedPaidPeriod(tables);
    // Post-backfill a legacy row lives in 'publish_now' and never
    // collides — this seed strands one in 'schedule' on purpose,
    // the only shape in which the 23505 delete-and-replace can
    // still fire. It must replace, never double-count.
    seedUsage(tables, 'user-1', 'facebook', 'page-1', 'publish-now', 'dest-1', 'schedule');

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
    expect(tables['subscription_usage'][0]?.['section']).toBe('schedule');
  });
});
