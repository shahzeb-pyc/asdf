import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  assertCanPost,
  getEntitlement,
  getEntitlementViaQueries,
  registerUsage,
  SubscriptionGateError,
  type Entitlement,
} from './entitlement';

/**
 * Plan-check C2 — parity of the single-query RPC read against the
 * legacy per-table read.
 *
 * The fake below has TWO independent implementations of the same
 * read, mirroring the two production implementations:
 *  - `from()` serves the legacy path (`getEntitlementViaQueries` →
 *    `getActivePeriod` + `getUsageCounts` + `hasAnyPeriod`).
 *  - `rpc('get_entitlement', …)` computes the answer straight from
 *    the fixture tables the way the SQL function does (active
 *    period window, per-platform counts with the disconnected
 *    exclusion and the legacy publish-now exclusion, ever-paid
 *    flag) — it never calls the legacy helpers, so agreement
 *    between the two paths is real parity evidence, not the test
 *    agreeing with itself.
 *
 * The SQL itself is additionally proven against a real Postgres
 * (see the PR body): the same fixture matrix was loaded into a
 * scratch database and the function's output compared row for
 * row. The fake cannot prove the SQL; the Postgres check cannot
 * prove the TypeScript mapper. Together they cover both halves.
 *
 * The clock is the real one (as in entitlement-shared-read.test.ts):
 * all seeds are relative to NOW, so the windows stay valid whenever
 * the suite runs.
 */
type Row = Record<string, unknown>;

const PLATFORMS = ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube'] as const;
const LEGACY_FEATURES = ['publish-now', 'instagram-publish-now', 'threads-publish-now'];

interface QueryLogEntry {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
}

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private limitCount: number | null = null;
  private mode: 'single' | 'maybeSingle' | 'many' = 'many';
  private head = false;
  private sortKey: string | null = null;
  private sortAsc = true;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row | Row[] | null,
    private readonly idSeq: () => string,
    private readonly tableName: string,
    private readonly queryLog: QueryLogEntry[],
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

  order(col: string, opts: { ascending: boolean }): this {
    this.sortKey = col;
    this.sortAsc = opts.ascending;
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
    this.queryLog.push({ table: this.tableName, op: this.op });
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      // The 23505 guard mirrors the ONE unique index the code
      // relies on: subscription_usage (user, platform, key).
      // Other tables have no such index — a period insert must
      // never "clash" with an existing period for the same user.
      if (this.isUsage) {
        for (const row of rows) {
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
      for (let i = this.table.length - 1; i >= 0; i -= 1) {
        if (this.matches(this.table[i] as Row)) this.table.splice(i, 1);
      }
      return { data: [], error: null };
    }
    let rows = this.table.filter((row) => this.matches(row)).map((row) => ({ ...row }));
    const count = rows.length;
    if (this.sortKey) {
      const key = this.sortKey;
      rows = [...rows].sort((a, b) => {
        const av = String(a[key] ?? '');
        const bv = String(b[key] ?? '');
        return this.sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
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

/** The RPC answer, computed straight from the fixture tables the way the SQL does. */
function computeRpcResult(
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
      (PLATFORMS as readonly string[]).includes(dest['platform'] as string)
    ) {
      const set = disconnectedByPlatform.get(dest['platform'] as string) ?? new Set<string>();
      set.add(dest['id'] as string);
      disconnectedByPlatform.set(dest['platform'] as string, set);
    }
  }
  const usage: Row = {};
  for (const platform of PLATFORMS) {
    usage[platform] = tables['subscription_usage'].filter(
      (row) =>
        row['user_id'] === userId &&
        row['platform'] === platform &&
        !LEGACY_FEATURES.includes(row['feature'] as string) &&
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

type RpcOverride = (args: { p_user_id: string; p_now: string }) => {
  data: unknown;
  error: { message: string } | null;
};

function makeClient(rpcOverride?: RpcOverride) {
  const tables: Record<string, Row[]> = {
    subscription_periods: [],
    subscription_usage: [],
    subscription_payments: [],
    seller_commissions: [],
    workspaces: [],
    destinations: [],
  };
  const queryLog: QueryLogEntry[] = [];
  let seq = 0;
  const idSeq = () => `fake-${++seq}`;
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const isUsage = table === 'subscription_usage';
      return {
        select: (cols?: string, opts?: { count?: string; head?: boolean }) =>
          new FakeQuery(rows, 'select', null, idSeq, table, queryLog, isUsage).select(cols, opts),
        insert: (payload: Row | Row[]) =>
          new FakeQuery(rows, 'insert', payload, idSeq, table, queryLog, isUsage),
        update: (payload: Row) =>
          new FakeQuery(rows, 'update', payload, idSeq, table, queryLog, isUsage),
        delete: () => new FakeQuery(rows, 'delete', null, idSeq, table, queryLog, isUsage),
      };
    },
    rpc(fn: string, args: { p_user_id: string; p_now: string }) {
      queryLog.push({ table: fn, op: 'rpc' });
      if (fn !== 'get_entitlement') {
        return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
      }
      if (rpcOverride) {
        return Promise.resolve(rpcOverride(args));
      }
      return Promise.resolve({
        data: computeRpcResult(tables, args.p_user_id, args.p_now),
        error: null,
      });
    },
  };
  return { client: client as unknown as SupabaseClient, tables, queryLog };
}

const NOW = new Date();
const DAY = 86_400_000;
const USER_ID = 'user-1';

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function seedPeriod(
  tables: Record<string, Row[]>,
  overrides: Partial<Row> = {},
  id = 'period-1'
): void {
  tables['subscription_periods'].push({
    id,
    user_id: USER_ID,
    facebook_count: 5,
    instagram_count: 3,
    threads_count: 2,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: iso(-10 * DAY),
    ends_at: iso(20 * DAY),
    superseded_at: null,
    ...overrides,
  });
}

function seedUsage(
  tables: Record<string, Row[]>,
  platform: string,
  key: string,
  feature = 'destination-queue',
  destinationId: string | null = null
): void {
  tables['subscription_usage'].push({
    id: `usage-${platform}-${key}`,
    user_id: USER_ID,
    platform,
    destination_key: key,
    feature,
    destination_id: destinationId,
  });
}

function seedWorkspace(tables: Record<string, Row[]>, workspaceId = 'ws-1'): void {
  tables['workspaces'].push({ id: workspaceId, owner_id: USER_ID });
}

function seedDestination(
  tables: Record<string, Row[]>,
  id: string,
  status: string,
  platform = 'facebook',
  workspaceId = 'ws-1'
): void {
  tables['destinations'].push({ id, platform, status, workspace_id: workspaceId });
}

function seedDueDowngradePayment(
  tables: Record<string, Row[]>,
  overrides: Partial<Row> = {}
): void {
  tables['subscription_payments'].push({
    id: 'payment-downgrade-1',
    user_id: USER_ID,
    method: 'bank',
    bank_method: null,
    status: 'approved',
    facebook_count: 3,
    instagram_count: 1,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 280,
    is_upgrade: false,
    is_downgrade: true,
    scheduled_starts_at: iso(-60 * 60 * 1000),
    rejection_reason: null,
    rejection_detail: null,
    override_reason: null,
    decided_at: null,
    screenshot_storage_key: null,
    coupon_code: null,
    discount_pkr: 0,
    period_id: null,
    approved_at: iso(-2 * DAY),
    created_at: iso(-2 * DAY),
    ...overrides,
  });
}

/**
 * Run both reads on identically-seeded fixtures and compare the
 * full Entitlement objects. Each path gets its own fresh client:
 * the due-downgrade cases mutate the tables (activation inserts
 * a period), so sharing one client would let the first path's
 * write leak into the second path's read.
 */
async function parity(
  setup: (tables: Record<string, Row[]>) => void
): Promise<{ rpc: Entitlement; legacy: Entitlement }> {
  const first = makeClient();
  setup(first.tables);
  const rpc = await getEntitlement(first.client, USER_ID, NOW);
  const second = makeClient();
  setup(second.tables);
  const legacy = await getEntitlementViaQueries(second.client, USER_ID, NOW);
  return { rpc, legacy };
}

describe('C2 — RPC parity with the legacy query read', () => {
  it('paid-active below cap, usage across platforms', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedUsage(tables, 'facebook', 'page-1');
      seedUsage(tables, 'facebook', 'page-2');
      seedUsage(tables, 'instagram', 'ig-1');
      seedUsage(tables, 'threads', 'th-1');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
    expect(rpc.active).toBe(true);
    expect(rpc.canPost).toBe(true);
    expect(rpc.usage).toEqual({
      facebook: 2,
      instagram: 1,
      threads: 1,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
  });

  it('paid-active at cap', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { facebook_count: 2 });
      seedUsage(tables, 'facebook', 'page-1');
      seedUsage(tables, 'facebook', 'page-2');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(2);
    expect(rpc.counts.facebook).toBe(2);
  });

  it('paid-active with a disconnected destination excluded', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedWorkspace(tables);
      seedDestination(tables, 'dest-off', 'disconnected', 'facebook');
      seedDestination(tables, 'dest-on', 'active', 'facebook');
      seedUsage(tables, 'facebook', 'page-off', 'destination-queue', 'dest-off');
      seedUsage(tables, 'facebook', 'page-on', 'destination-queue', 'dest-on');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(1);
  });

  it('a disconnected destination on another platform does not subtract', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedWorkspace(tables);
      // Same destination id, but the destinations row is Instagram:
      // the Facebook usage row linked to it must keep counting.
      seedDestination(tables, 'dest-x', 'disconnected', 'instagram');
      seedUsage(tables, 'facebook', 'page-1', 'destination-queue', 'dest-x');
      seedUsage(tables, 'instagram', 'ig-1', 'destination-queue', 'dest-x');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(1);
    expect(rpc.usage.instagram).toBe(0);
  });

  it('a disconnected destination in another user’s workspace does not subtract', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      tables['workspaces'].push({ id: 'ws-other', owner_id: 'user-2' });
      seedDestination(tables, 'dest-other', 'disconnected', 'facebook', 'ws-other');
      seedUsage(tables, 'facebook', 'page-1', 'destination-queue', 'dest-other');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(1);
  });

  it('non-disconnected statuses keep counting (expired token, paused, rate-limited)', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedWorkspace(tables);
      seedDestination(tables, 'dest-exp', 'invalid_token', 'facebook');
      seedDestination(tables, 'dest-paused', 'paused', 'facebook');
      seedDestination(tables, 'dest-rate', 'rate_limited', 'facebook');
      seedUsage(tables, 'facebook', 'page-exp', 'destination-queue', 'dest-exp');
      seedUsage(tables, 'facebook', 'page-paused', 'destination-queue', 'dest-paused');
      seedUsage(tables, 'facebook', 'page-rate', 'destination-queue', 'dest-rate');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(3);
  });

  it('legacy publish-now rows never count, capped rows still do', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedUsage(tables, 'facebook', 'page-pn', 'publish-now');
      seedUsage(tables, 'instagram', 'ig-pn', 'instagram-publish-now');
      seedUsage(tables, 'threads', 'th-pn', 'threads-publish-now');
      seedUsage(tables, 'facebook', 'page-1');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage).toEqual({
      facebook: 1,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
  });

  it('a disconnected destination’s legacy publish-now row cannot over-subtract', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      seedWorkspace(tables);
      seedDestination(tables, 'dest-off', 'disconnected', 'facebook');
      seedUsage(tables, 'facebook', 'page-pn', 'publish-now', 'dest-off');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.usage.facebook).toBe(0);
  });

  it('paid-lapsed reads expired with usage intact', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
      seedUsage(tables, 'facebook', 'page-1');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('expired');
    expect(rpc.canPost).toBe(false);
    expect(rpc.readOnly).toBe(true);
    expect(rpc.hasPriorPeriod).toBe(true);
    expect(rpc.usage.facebook).toBe(1);
    expect(rpc.reason).toContain('has ended');
  });

  it('never-paid reads free, never expired', async () => {
    const { rpc, legacy } = await parity((tables) => {
      // No periods, no payments, no usage at all.
      expect(tables['subscription_periods']).toHaveLength(0);
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('free');
    expect(rpc.hasPriorPeriod).toBe(false);
    expect(rpc.reason).toContain('Free');
  });

  it('never-paid with orphan usage rows still reads free with the usage shown', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedUsage(tables, 'facebook', 'page-1');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('free');
    expect(rpc.usage.facebook).toBe(1);
  });

  it('zero-count period reads paid with zero counts', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, {
        facebook_count: 0,
        instagram_count: 0,
        threads_count: 0,
      });
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
    expect(rpc.counts).toEqual({
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    });
  });

  it('period with counts but no payments reads paid', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
      expect(tables['subscription_payments']).toHaveLength(0);
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
    expect(rpc.hasPriorPeriod).toBe(true);
  });

  it('two periods: the active one wins, latest ends_at first', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) }, 'period-old');
      seedPeriod(tables, { facebook_count: 7 }, 'period-new');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
    expect(rpc.period?.id).toBe('period-new');
    expect(rpc.counts.facebook).toBe(7);
  });

  it('a superseded in-window row is ignored', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { superseded_at: iso(-1 * DAY) }, 'period-superseded');
      seedPeriod(tables, { facebook_count: 4 }, 'period-live');
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.period?.id).toBe('period-live');
  });

  it('only a superseded in-window row reads expired, not paid', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { superseded_at: iso(-1 * DAY) });
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('expired');
    expect(rpc.period).toBeNull();
  });

  it('period starting exactly now is active; period ending exactly now is not', async () => {
    const startsNow = await parity((tables) => {
      seedPeriod(tables, { starts_at: NOW.toISOString(), ends_at: iso(20 * DAY) });
    });
    expect(startsNow.rpc).toEqual(startsNow.legacy);
    expect(startsNow.rpc.plan).toBe('paid');
    expect(startsNow.rpc.active).toBe(true);
    const endsNow = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-10 * DAY), ends_at: NOW.toISOString() });
    });
    expect(endsNow.rpc).toEqual(endsNow.legacy);
    expect(endsNow.rpc.plan).toBe('expired');
  });

  it('a future period alone reads expired, not paid and not free', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(5 * DAY), ends_at: iso(35 * DAY) });
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('expired');
    expect(rpc.hasPriorPeriod).toBe(true);
  });

  it('due scheduled downgrade activates identically on both paths (still in TS)', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
      seedDueDowngradePayment(tables);
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
    expect(rpc.active).toBe(true);
    expect(rpc.counts.facebook).toBe(3);
    expect(rpc.counts.instagram).toBe(1);
    expect(rpc.period?.id).not.toBe('period-1');
  });

  it('a scheduled downgrade not yet due does not activate', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
      seedDueDowngradePayment(tables, { scheduled_starts_at: iso(1 * DAY) });
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('expired');
  });

  it('a non-downgrade approved payment does not activate', async () => {
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
      seedDueDowngradePayment(tables, { is_downgrade: false });
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('expired');
  });

  it('admin is not an input to getEntitlement — the exemption lives at the call sites', async () => {
    // getEntitlement takes no role: an admin's own read answers the
    // same way as any user's. Callers skip the gates for admins
    // before calling (see assertCanPost docs); C2 does not touch
    // that, and this pins that the read itself has no role branch.
    const { rpc, legacy } = await parity((tables) => {
      seedPeriod(tables);
    });
    expect(rpc).toEqual(legacy);
    expect(rpc.plan).toBe('paid');
  });
});

describe('C2 — one round trip per getEntitlement call', () => {
  it('paid-active: exactly one RPC call and zero table queries', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPeriod(tables);
    seedUsage(tables, 'facebook', 'page-1');
    await getEntitlement(client, USER_ID, NOW);
    const rpcCalls = queryLog.filter((entry) => entry.op === 'rpc').length;
    const tableCalls = queryLog.filter((entry) => entry.op !== 'rpc').length;
    expect(rpcCalls).toBe(1);
    expect(tableCalls).toBe(0);
  });

  it('the legacy path on the same fixture pays many table queries (the contrast)', async () => {
    const { client, tables, queryLog } = makeClient();
    seedPeriod(tables);
    seedUsage(tables, 'facebook', 'page-1');
    await getEntitlementViaQueries(client, USER_ID, NOW);
    const rpcCalls = queryLog.filter((entry) => entry.op === 'rpc').length;
    const tableCalls = queryLog.filter((entry) => entry.op !== 'rpc').length;
    expect(rpcCalls).toBe(0);
    // 1 period + 1 workspaces + 6 head-counts on this fixture.
    expect(tableCalls).toBe(8);
  });

  it('free: the RPC is still called exactly once (activation probes are separate)', async () => {
    const { client, tables, queryLog } = makeClient();
    seedUsage(tables, 'facebook', 'page-1');
    const result = await getEntitlement(client, USER_ID, NOW);
    expect(result.plan).toBe('free');
    expect(queryLog.filter((entry) => entry.op === 'rpc').length).toBe(1);
  });
});

describe('C2 — mutation: a broken RPC fails closed, a flipped gate blocks identically', () => {
  it('an RPC error fails closed with ENTITLEMENT_UNAVAILABLE, never Free', async () => {
    const { client, tables } = makeClient(() => ({
      data: null,
      error: { message: 'database down' },
    }));
    seedPeriod(tables);
    await expect(getEntitlement(client, USER_ID, NOW)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
  });

  it('a malformed RPC answer fails closed instead of inventing counts', async () => {
    const malformed = [
      { data: null, error: null },
      { data: { usage: { facebook: 1 }, has_prior_period: true }, error: null },
      {
        data: {
          period: null,
          usage: {
            facebook: '1',
            instagram: 0,
            threads: 0,
            x: 0,
            tiktok: 0,
            youtube: 0,
          },
          has_prior_period: false,
        },
        error: null,
      },
      {
        data: {
          period: null,
          usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
          has_prior_period: 'yes',
        },
        error: null,
      },
    ];
    for (const answer of malformed) {
      const { client, tables } = makeClient(() => answer);
      seedPeriod(tables);
      await expect(getEntitlement(client, USER_ID, NOW)).rejects.toMatchObject({
        code: 'ENTITLEMENT_UNAVAILABLE',
      });
    }
  });

  it('an RPC period for a different user fails closed', async () => {
    const { client, tables } = makeClient(() => ({
      data: {
        period: {
          id: 'period-other',
          user_id: 'user-2',
          facebook_count: 5,
          instagram_count: 0,
          threads_count: 0,
          x_count: 0,
          tiktok_count: 0,
          youtube_count: 0,
          starts_at: iso(-10 * DAY),
          ends_at: iso(20 * DAY),
          superseded_at: null,
        },
        usage: { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 },
        has_prior_period: true,
      },
      error: null,
    }));
    seedPeriod(tables);
    await expect(getEntitlement(client, USER_ID, NOW)).rejects.toMatchObject({
      code: 'ENTITLEMENT_UNAVAILABLE',
    });
  });

  it('removing the period flips the gate the same way on both paths', async () => {
    const paid = await parity((tables) => {
      seedPeriod(tables);
    });
    expect(paid.rpc.plan).toBe('paid');
    const lapsed = await parity((tables) => {
      seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
    });
    expect(lapsed.rpc).toEqual(lapsed.legacy);
    expect(lapsed.rpc.plan).toBe('expired');
    const { client, tables } = makeClient();
    seedPeriod(tables, { starts_at: iso(-40 * DAY), ends_at: iso(-5 * DAY) });
    await expect(assertCanPost(client, USER_ID, 'facebook', 'page-new', NOW)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Posting is paused. Your paid period has ended — renew it to post again.',
    });
  });

  it('usage at cap blocks with the same code and message through the RPC gate', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables, { facebook_count: 1 });
    seedUsage(tables, 'facebook', 'page-1');
    await expect(assertCanPost(client, USER_ID, 'facebook', 'page-new', NOW)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_CAP_REACHED',
      message: 'You have reached your limit of 1 pages on facebook. Upgrade your plan to use more.',
    });
    // The legacy read agrees on the inputs the gate decided from.
    const { legacy } = await parity((t) => {
      seedPeriod(t, { facebook_count: 1 });
      seedUsage(t, 'facebook', 'page-1');
    });
    expect(legacy.usage.facebook).toBe(legacy.counts.facebook);
  });

  it('an already-registered destination still passes at cap', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables, { facebook_count: 1 });
    seedUsage(tables, 'facebook', 'page-1');
    const period = await assertCanPost(client, USER_ID, 'facebook', 'page-1', NOW);
    expect(period.id).toBe('period-1');
  });
});

describe('C2 — race: the register guards still hold on the RPC gate read', () => {
  it('concurrent double-register yields one unit', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables);
    const [first, second] = await Promise.all([
      registerUsage(client, USER_ID, 'facebook', 'page-1', 'destination-queue', null, NOW),
      registerUsage(client, USER_ID, 'facebook', 'page-1', 'destination-queue', null, NOW),
    ]);
    expect([first.alreadyUsed, second.alreadyUsed].sort()).toEqual([false, true]);
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('concurrent adds at cap both block with SUBSCRIPTION_CAP_REACHED', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables, { facebook_count: 1 });
    seedUsage(tables, 'facebook', 'page-1');
    const outcomes = await Promise.allSettled([
      registerUsage(client, USER_ID, 'facebook', 'page-2', 'destination-queue', null, NOW),
      registerUsage(client, USER_ID, 'facebook', 'page-3', 'destination-queue', null, NOW),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        code: 'SUBSCRIPTION_CAP_REACHED',
      });
    }
    expect(tables['subscription_usage']).toHaveLength(1);
  });

  it('concurrent adds one below cap expose the pre-existing check-then-insert race (unchanged by C2)', async () => {
    // Cap 1, usage 0, two different destinations racing: BOTH
    // re-checks land before either insert, so both inserts succeed
    // and usage ends at 2 on a cap of 1. This is the race window
    // documented in registerUsage ("What it does NOT do:
    // eliminate the race — no check-then-insert can, short of a
    // DB constraint/trigger or a serializable transaction"), and
    // C2 preserves it exactly: the gate read is now one RPC
    // instead of many queries, but the re-check and the 23505
    // guard are untouched, and the interleaving is the same. In
    // production the outcome is timing-dependent — when the
    // second re-check lands after the first insert commits, the
    // second add is refused with SUBSCRIPTION_CAP_REACHED (the
    // plan's "one wins" case); when both re-checks land first,
    // both win, as here. What C2 guarantees, and what this pins,
    // is that the RPC gate read does not change the window: the
    // same-destination case above is still stopped by 23505, and
    // the at-cap case is still refused by the gate.
    const { client, tables } = makeClient();
    seedPeriod(tables, { facebook_count: 1 });
    const outcomes = await Promise.allSettled([
      registerUsage(client, USER_ID, 'facebook', 'page-2', 'destination-queue', null, NOW),
      registerUsage(client, USER_ID, 'facebook', 'page-3', 'destination-queue', null, NOW),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(tables['subscription_usage']).toHaveLength(2);
    const entitlement = await getEntitlement(client, USER_ID, NOW);
    expect(entitlement.usage.facebook).toBe(2);
  });

  it('a legacy publish-now row is still replaced, never double-counted', async () => {
    const { client, tables } = makeClient();
    seedPeriod(tables);
    seedUsage(tables, 'facebook', 'page-1', 'publish-now');
    const result = await registerUsage(
      client,
      USER_ID,
      'facebook',
      'page-1',
      'destination-queue',
      null,
      NOW
    );
    expect(result.alreadyUsed).toBe(false);
    expect(tables['subscription_usage']).toHaveLength(1);
    expect(tables['subscription_usage'][0]?.['feature']).toBe('destination-queue');
    const entitlement = await getEntitlement(client, USER_ID, NOW);
    expect(entitlement.usage.facebook).toBe(1);
  });
});
