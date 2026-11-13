/**
 * ADU worker tick (SEND BACK fix, PR #43 blockers B/C + fail-loud).
 *
 * - A stale-job load failure that is NOT a missing table must throw
 *   (the old code silently skipped the stale reset for that tick).
 * - A missing table (migration unapplied) is still a clean skip.
 * - Config and stale scans are keyset-paged (limit + gt last id),
 *   never whole-table loads: a 501-config tick must request a second
 *   page, not stop at the first.
 * - Intake dedupe (23505) continues without throwing; a config with
 *   nothing downloadable and nothing busy completes.
 * - A job already carrying a Graph post id settles published without
 *   calling the publisher; an auth failure marks the account expired.
 * - Retention deletes only settled jobs older than 90 days.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ADU_STALE_PUBLISHING_SECONDS,
  createPublisherRegistry,
  encryptToken,
  InternalError,
  type IFacebookPublishClient,
  type PublishOutcome,
  type Publisher,
} from '@fbuploadpro/contracts';
import { ADU_JOB_RETENTION_DAYS, ADU_TICK_PAGE_SIZE, runAduTick } from './adu-tick.js';
import { FacebookGraphError } from './fb-client.js';
import { FacebookPublisher } from './publishers/facebook.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const NOW = new Date('2026-10-30T09:00:00.000Z'); // 09:00 UTC

type Row = Record<string, unknown>;

interface Op {
  kind: string;
  args: unknown[];
}

/** Minimal chainable Supabase fake. Handlers answer per table from the
 * recorded ops; every chain call is recorded for assertions. */
class FakeBuilder {
  ops: Op[] = [];
  constructor(
    private readonly table: string,
    private readonly handler: (table: string, ops: Op[], payload?: unknown) => unknown,
  ) {}

  select() {
    this.ops.push({ kind: 'select', args: [] });
    return this;
  }

  eq(col: string, val: unknown) {
    this.ops.push({ kind: 'eq', args: [col, val] });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.ops.push({ kind: 'in', args: [col, val] });
    return this;
  }

  gte(col: string, val: unknown) {
    this.ops.push({ kind: 'gte', args: [col, val] });
    return this;
  }

  lt(col: string, val: unknown) {
    this.ops.push({ kind: 'lt', args: [col, val] });
    return this;
  }

  gt(col: string, val: unknown) {
    this.ops.push({ kind: 'gt', args: [col, val] });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.ops.push({ kind: 'order', args: [col, opts] });
    return this;
  }

  limit(n: number) {
    this.ops.push({ kind: 'limit', args: [n] });
    return this;
  }

  not(col: string, op: string, val: unknown) {
    this.ops.push({ kind: 'not', args: [col, op, val] });
    return this;
  }

  insert(payload: unknown) {
    this.ops.push({ kind: 'insert', args: [payload] });
    return this;
  }

  update(payload: unknown) {
    this.ops.push({ kind: 'update', args: [payload] });
    return this;
  }

  delete() {
    this.ops.push({ kind: 'delete', args: [] });
    return this;
  }

  maybeSingle() {
    this.ops.push({ kind: 'maybeSingle', args: [] });
    return this;
  }

  then(resolve: (value: unknown) => void) {
    resolve(this.handler(this.table, this.ops));
  }
}

interface FakeDb {
  calls: Array<{ table: string; ops: Op[]; payload?: unknown }>;
  from: (table: string) => FakeBuilder;
  /** C4: the shared workspace_has_active_period RPC. Defaults to
   * entitled; the paused test below overrides it to false. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}

function makeDb(
  handler: (table: string, ops: Op[], calls: FakeDb['calls']) => unknown,
): FakeDb {
  const calls: FakeDb['calls'] = [];
  const db = {
    calls,
    from: (table: string) =>
      new FakeBuilder(table, (t, ops, payload) => {
        calls.push({ table: t, ops: [...ops], payload });
        return handler(t, ops, calls);
      }),
    rpc: async () => ({ data: true, error: null }),
  };
  return db;
}

function opValue(ops: Op[], kind: string, col: string): unknown {
  const op = ops.find((o) => o.kind === kind && o.args[0] === col);
  return op?.args[1];
}

function pageOf(rows: Row[], ops: Op[]): Row[] {
  const gtId = opValue(ops, 'gt', 'id') as string | undefined;
  const limitOp = ops.find((o) => o.kind === 'limit');
  const limit = (limitOp?.args[0] as number | undefined) ?? rows.length;
  // Guardrail: never stringify a possibly-falsy id (the fake's rows
  // always carry ids, but the guardrail requires the check before
  // any String(...) call).
  const sorted = [...rows].sort((a, b) => {
    if (!a.id || !b.id) throw new InternalError('pageOf: row without id');
    return String(a.id).localeCompare(String(b.id));
  });
  const after = gtId
    ? sorted.filter((r) => {
        if (!r.id) throw new InternalError('pageOf: row without id');
        return String(r.id) > gtId;
      })
    : sorted;
  return after.slice(0, limit);
}

function emptyDb(): FakeDb {
  return makeDb((table, ops) => {
    if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
      return { error: null };
    }
    if (ops.some((o) => o.kind === 'maybeSingle')) return { data: null, error: null };
    if (ops.some((o) => o.kind === 'insert')) return { error: null };
    if (ops.some((o) => o.kind === 'update')) return { error: null };
    return { data: [], error: null };
  });
}

function fakePublisher(
  publishImpl: Publisher['publish'],
  platform: Publisher['platform'] = 'facebook',
) {
  return {
    platform,
    publish: vi.fn(publishImpl),
    refreshTokens: vi.fn(async () => ({ accessToken: 'x' })),
    mapError: () => ({ kind: 'permanent' as const, code: 'unknown', message: 'unknown' }),
  } as unknown as Publisher;
}

function registryWith(publisher: Publisher | null) {
  const registry = createPublisherRegistry();
  if (publisher) registry.register(publisher);
  return registry;
}

function configRow(id: string, postingTimes: string[]): Row {
  return {
    id,
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    timezone: 'UTC',
    posts_per_day: 1,
    posting_times: postingTimes,
    status: 'active',
    sync_status: 'synced',
  };
}

describe('runAduTick', () => {
  it('throws on a stale-job load failure that is not a missing table', async () => {
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: null, error: { code: '23505', message: 'boom' } };
      }
      return { data: [], error: null };
    });
    await expect(
      runAduTick({ db: db as never, registry: registryWith(null), masterKey: MASTER_KEY, now: NOW }),
    ).rejects.toThrow(/ADU stale job load failed: 23505/);
  });

  it('returns skipped on a missing ADU table', async () => {
    const db = makeDb(() => ({ data: null, error: { code: '42P01', message: 'missing' } }));
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.skipped).toBe(true);
  });

  it('pages config loads with keyset paging past the first page', async () => {
    const configs = Array.from({ length: ADU_TICK_PAGE_SIZE + 1 }, (_, i) =>
      configRow(`c${String(i).padStart(4, '0')}`, []),
    );
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: pageOf(configs, ops), error: null };
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.skipped).toBeUndefined();
    // The rate-limit recovery step also reads adu_configs (eq status
    // 'fb_rate_limited'); only the intake pages (eq status 'active')
    // count here.
    const configCalls = db.calls.filter(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'active'),
    );
    expect(configCalls.length).toBe(2);
    expect(configCalls[1]!.ops.find((o) => o.kind === 'gt')?.args[1]).toBe(
      `c${String(ADU_TICK_PAGE_SIZE - 1).padStart(4, '0')}`,
    );
  });

  it('publishes live jobs behind 100+ dead-head jobs instead of starving them', async () => {
    // Head-of-line regression (spec adu-publish-head-of-line): the old
    // code loaded only the oldest 100 pending jobs, so 100+ dead jobs
    // on error destinations filled the window and live jobs behind
    // them never published. The scan must page past the dead head and
    // publish the live jobs; the dead jobs stay pending_publish.
    const deadCount = ADU_TICK_PAGE_SIZE + 1;
    const base = new Date('2026-10-30T00:00:00.000Z').getTime();
    const at = (i: number) => new Date(base + i * 60_000).toISOString();
    const deadJobs = Array.from({ length: deadCount }, (_, i) => ({
      id: `dead-${String(i).padStart(4, '0')}`,
      config_id: 'c-dead',
      reel_id: `reel-dead-${i}`,
      publish_retries: 0,
      graph_post_id: null,
      status: 'pending_publish',
      created_at: at(i),
      adu_reels: { caption: 'dead', media_url: 'https://example.invalid/dead.mp4' },
    }));
    const liveJobs = [0, 1].map((k) => ({
      id: `live-${k}`,
      config_id: 'c-live',
      reel_id: `reel-live-${k}`,
      publish_retries: 0,
      graph_post_id: null,
      status: 'pending_publish',
      created_at: at(deadCount + k),
      adu_reels: { caption: 'live', media_url: 'https://example.invalid/live.mp4' },
    }));
    const jobs = [...deadJobs, ...liveJobs] as Row[];
    const configs = [
      {
        id: 'c-dead',
        workspace_id: 'ws-1',
        destination_id: 'dest-dead',
        timezone: 'UTC',
        posts_per_day: 1,
        posting_times: [],
        status: 'active',
        sync_status: 'synced',
      },
      {
        id: 'c-live',
        workspace_id: 'ws-1',
        destination_id: 'dest-live',
        timezone: 'UTC',
        posts_per_day: 1,
        posting_times: [],
        status: 'active',
        sync_status: 'synced',
      },
    ] as Row[];
    const destinations = [
      {
        id: 'dest-dead',
        account_id: 'acc-dead',
        workspace_id: 'ws-1',
        platform: 'facebook',
        status: 'error',
        encrypted_destination_token: null,
      },
      {
        id: 'dest-live',
        account_id: 'acc-live',
        workspace_id: 'ws-1',
        platform: 'facebook',
        status: 'active',
        encrypted_destination_token: null,
      },
    ] as Row[];
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const accounts = [
      {
        id: 'acc-dead',
        status: 'active',
        encrypted_access_token: encryptedAccess,
        encrypted_refresh_token: null,
      },
      {
        id: 'acc-live',
        status: 'active',
        encrypted_access_token: encryptedAccess,
        encrypted_refresh_token: null,
      },
    ] as Row[];
    const claimed = new Set<string>();
    const publisher = fakePublisher(async () => ({
      status: 'published',
      externalPostId: 'fb-post',
    }));
    const inList = (ops: Op[], col: string): string[] => {
      const op = ops.find((o) => o.kind === 'in' && o.args[0] === col);
      if (!op) return [];
      return op.args[1] as string[];
    };
    // Regression guardrail: never stringify a possibly-falsy id
    // without a guard. Every row in this fake carries an id by
    // construction; a missing one fails loudly instead of matching
    // the string "undefined".
    const requireId = (row: Row): string => {
      if (!row.id) throw new InternalError('head-of-line test: row without id');
      return String(row.id);
    };
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        const ids = inList(ops, 'id');
        return {
          data: jobs.filter((j) => ids.includes(requireId(j)) && j.status === 'pending_publish'),
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'update')) {
        const payload = ops.find((o) => o.kind === 'update')!.args[0] as Row;
        const id = opValue(ops, 'eq', 'id') as string | undefined;
        const job = jobs.find((j) => j.id === id);
        if (payload.status === 'publishing' && job) {
          if (job.status === 'pending_publish' && id !== undefined && !claimed.has(id)) {
            claimed.add(id);
            job.status = 'publishing';
            return { data: [{ id }], error: null };
          }
          return { data: [], error: null };
        }
        if (job) Object.assign(job, payload);
        return { error: null };
      }
      if (table === 'adu_posting_jobs') {
        // Scan load (eq pending_publish) or stale reset (eq publishing).
        if (opValue(ops, 'eq', 'status') === 'publishing') return { data: [], error: null };
        const gte = ops.find((o) => o.kind === 'gte' && o.args[0] === 'created_at');
        const limitOp = ops.find((o) => o.kind === 'limit');
        const limit = limitOp ? (limitOp.args[0] as number) : jobs.length;
        const sorted = [...jobs]
          .filter((j) => j.status === 'pending_publish')
          .sort(
            (a, b) =>
              String(a.created_at).localeCompare(String(b.created_at)) ||
              requireId(a).localeCompare(requireId(b)),
          );
        const after = gte
          ? sorted.filter((j) => String(j.created_at) >= String(gte.args[1]))
          : sorted;
        return { data: after.slice(0, limit), error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        const ids = inList(ops, 'id');
        return { data: configs.filter((c) => ids.includes(requireId(c))), error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: configs.find((c) => c.id === opValue(ops, 'eq', 'id')) ?? null,
          error: null,
        };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'update')) {
        return { error: null };
      }
      if (table === 'adu_configs') {
        // Intake / recovery list loads: respect the eq filters.
        const filtered = configs.filter((c) =>
          ops.every((o) => o.kind !== 'eq' || c[o.args[0] as string] === o.args[1]),
        );
        return { data: pageOf(filtered, ops), error: null };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        const ids = inList(ops, 'id');
        return {
          data: destinations.filter((d) => ids.includes(requireId(d))),
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: destinations.find((d) => d.id === opValue(ops, 'eq', 'id')) ?? null,
          error: null,
        };
      }
      if (table === 'destinations') return { data: [], error: null };
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        const ids = inList(ops, 'id');
        return { data: accounts.filter((a) => ids.includes(requireId(a))), error: null };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: accounts.find((a) => a.id === opValue(ops, 'eq', 'id')) ?? null,
          error: null,
        };
      }
      if (table === 'social_accounts') return { data: [], error: null };
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.published).toBe(2);
    expect(result.retried).toBe(0);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    // The dead head was never claimed and never bounced: it stays
    // pending_publish, untouched, for a later tick (recoverable).
    expect(deadJobs.every((j) => j.status === 'pending_publish')).toBe(true);
    expect([...claimed].some((id) => id.startsWith('dead-'))).toBe(false);
    expect(liveJobs.every((j) => j.status === 'published')).toBe(true);
    // The scan paged past the first 500-row page to reach the live jobs.
    const scanLoads = db.calls.filter(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some(
          (o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'pending_publish',
        ) &&
        !c.ops.some((o) => o.kind === 'in') &&
        !c.ops.some((o) => o.kind === 'update'),
    );
    expect(scanLoads.length).toBe(2);
  });

  it('intake dedupe (23505) continues without throwing', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: { id: 'reel-1', media_url: 'https://example.invalid/r.mp4' },
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'insert')) {
        return { error: { code: '23505', message: 'duplicate slot' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.intakeJobsCreated).toBe(0);
  });

  it('completes a due config with nothing downloadable and nothing busy', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: null, error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.intakeCompleted).toBe(1);
    const completion = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'completed'),
    );
    expect(completion).toBeDefined();
  });

  it('settles a job with a stored Graph id without calling the publisher', async () => {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: 'graph-123',
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4' },
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'x' }));
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(1);
  });

  it('marks the account expired on an auth failure', async () => {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4' },
    };
    const publisher = fakePublisher(async () => ({
      status: 'failed',
      error: { kind: 'auth', code: 'invalid_token', message: 'Token expired.' },
    }));
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      // The single-row load uses maybeSingle; the invalid-token
      // cascade's list select gets an empty page (no sibling pages).
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: {
            id: 'dest-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'facebook',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'facebook',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') return { data: [], error: null };
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.failed).toBe(1);
    const expired = db.calls.find(
      (c) =>
        c.table === 'social_accounts' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'expired'),
    );
    expect(expired).toBeDefined();
  });

  it('publishes a Threads job through the Threads publisher, not Facebook', async () => {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4', media_object_key: 'r.mp4' },
    };
    const facebookPublisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'fb-post' }));
    const threadsPublisher = fakePublisher(
      async () => ({ status: 'published', externalPostId: 'threads-media-1' }),
      'threads',
    );
    const registry = createPublisherRegistry();
    registry.register(facebookPublisher);
    registry.register(threadsPublisher);
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'threads',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') {
        return {
          data: {
            id: 'dest-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'threads',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry,
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.published).toBe(1);
    expect(facebookPublisher.publish).not.toHaveBeenCalled();
    expect(threadsPublisher.publish).toHaveBeenCalledTimes(1);
    const item = (threadsPublisher.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Row;
    expect(item.platform).toBe('threads');
    expect(item.platform_format).toBe('video');
    expect(item.media_url).toBe('https://example.invalid/r.mp4');
    const settled = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'published'),
    );
    expect(settled).toBeDefined();
  });

  it('takes a Threads job from downloaded reel to published in one tick', async () => {
    // Download-to-upload path at the tick level: a downloaded reel
    // (the state the downloader leaves) is intaken at a due posting
    // time, then the same tick publishes it through the Threads
    // publisher and settles it — no Facebook publisher involvement.
    const reel = {
      id: 'reel-1',
      caption: 'hi',
      media_url: 'https://example.invalid/r.mp4',
      media_object_key: 'r.mp4',
      status: 'downloaded',
    };
    const jobs: Row[] = [];
    const facebookPublisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'fb-post' }));
    const threadsPublisher = fakePublisher(
      async () => ({ status: 'published', externalPostId: 'threads-media-1' }),
      'threads',
    );
    const registry = createPublisherRegistry();
    registry.register(facebookPublisher);
    registry.register(threadsPublisher);
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const encryptedRefresh = await encryptToken('refresh', MASTER_KEY);
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'insert')) {
        const payload = ops.find((o) => o.kind === 'insert')?.args[0] as Row;
        jobs.push({
          id: 'job-1',
          config_id: payload.config_id,
          reel_id: payload.reel_id,
          publish_retries: 0,
          graph_post_id: null,
          adu_reels: reel,
        });
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: jobs, error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs') return { data: [configRow('c1', ['09:00'])], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'download_failed')) {
        return { count: 0, data: [], error: null };
      }
      // Claim-aware (current main claims the reel before inserting the
      // job: update … set processing where status='downloaded' and
      // require a returned row, else it skips the insert). Returning
      // the claimed row here makes this test pass against both the
      // branch's tick (post-insert update, return value ignored) and
      // main's claim-before-insert tick.
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'update')) {
        return { data: [{ id: 'reel-1' }], error: null };
      }
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: reel, error: null };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'threads',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') {
        return {
          data: {
            id: 'dest-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'threads',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: encryptedRefresh,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: encryptedRefresh,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry,
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.intakeJobsCreated).toBe(1);
    expect(result.published).toBe(1);
    expect(facebookPublisher.publish).not.toHaveBeenCalled();
    expect(threadsPublisher.publish).toHaveBeenCalledTimes(1);
    const item = (threadsPublisher.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Row;
    expect(item.platform).toBe('threads');
    expect(item.media_url).toBe('https://example.invalid/r.mp4');
    const processing = db.calls.find(
      (c) =>
        c.table === 'adu_reels' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'processing'),
    );
    expect(processing).toBeDefined();
    // The claim also clears the downloader's stale claim timestamp, so
    // the per-loop stale reset cannot flip the reel back to pending and
    // re-mint it at the next slot (duplicate jobs, Nov 9–13 2026).
    expect(
      (processing!.ops.find((o) => o.kind === 'update')!.args[0] as Row).download_claimed_at,
    ).toBeNull();
    const posted = db.calls.find(
      (c) =>
        c.table === 'adu_reels' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'posted'),
    );
    expect(posted).toBeDefined();
    const settled = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'published'),
    );
    expect(settled).toBeDefined();
  });

  it('publishes an Instagram-destination job through the Instagram publisher', async () => {
    const job = {
      id: 'job-ig-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4', media_object_key: 'r.mp4' },
    };
    const igPublisher = fakePublisher(
      async () => ({ status: 'published', externalPostId: 'ig-123' }),
      'instagram',
    );
    const fbPublisher = fakePublisher(
      async () => ({ status: 'published', externalPostId: 'fb-123' }),
      'facebook',
    );
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const encryptedRefresh = await encryptToken('refresh', MASTER_KEY);
    const registry = createPublisherRegistry();
    registry.register(igPublisher);
    registry.register(fbPublisher);
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-ig-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-ig-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-ig-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'instagram',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') {
        return {
          data: {
            id: 'dest-ig-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'instagram',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: encryptedRefresh,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: encryptedRefresh,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry,
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(igPublisher.publish).toHaveBeenCalledTimes(1);
    expect(fbPublisher.publish).not.toHaveBeenCalled();
    const publishedItem = (igPublisher.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(publishedItem.platform).toBe('instagram');
    expect(publishedItem.platform_format).toBe('reel');
    expect(result.published).toBe(1);
  });

  it('leaves a job for a platform with no registered publisher pending without calling any publisher', async () => {
    const job = {
      id: 'job-x-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4', media_object_key: 'r.mp4' },
    };
    const fbPublisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'fb-123' }));
    const igPublisher = fakePublisher(
      async () => ({ status: 'published', externalPostId: 'ig-123' }),
      'instagram',
    );
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const encryptedRefresh = await encryptToken('refresh', MASTER_KEY);
    const registry = createPublisherRegistry();
    registry.register(fbPublisher);
    registry.register(igPublisher);
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-x-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-x-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-x-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'youtube',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') {
        return {
          data: {
            id: 'dest-x-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'youtube',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: encryptedRefresh,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: encryptedRefresh,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry,
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(fbPublisher.publish).not.toHaveBeenCalled();
    expect(igPublisher.publish).not.toHaveBeenCalled();
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.published).toBe(0);
  });

  it('retention deletes only settled jobs older than 90 days', async () => {
    const db = emptyDb();
    await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    const prune = db.calls.find(
      (c) => c.table === 'adu_posting_jobs' && c.ops.some((o) => o.kind === 'delete'),
    );
    expect(prune).toBeDefined();
    const inOp = prune!.ops.find((o) => o.kind === 'in');
    expect(inOp?.args[0]).toBe('status');
    expect(inOp?.args[1]).toEqual([
      'published',
      'failed_to_publish',
      'publish_error',
      'integrity_error',
    ]);
    const ltOp = prune!.ops.find((o) => o.kind === 'lt');
    const cutoff = new Date(
      NOW.getTime() - ADU_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(ltOp?.args[1]).toBe(cutoff);
  });

  it('stale reset only resets jobs still publishing and still stale', async () => {
    const staleJob = { id: 'job-stale', updated_at: '2026-10-30T08:00:00.000Z' };
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [staleJob], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    const reset = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'pending_publish'),
    );
    expect(reset).toBeDefined();
    // The guard that stops a job settled (or re-touched) between the
    // stale select and this update from being flipped back to
    // pending_publish and published a second time.
    expect(reset!.ops.find((o) => o.kind === 'eq' && o.args[0] === 'status')?.args[1]).toBe(
      'publishing',
    );
    const staleAt = new Date(
      NOW.getTime() - ADU_STALE_PUBLISHING_SECONDS * 1000,
    ).toISOString();
    expect(reset!.ops.find((o) => o.kind === 'lt')?.args[1]).toBe(staleAt);
  });

  it('publish claim lost to another tick skips without publishing', async () => {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4' },
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'g1' }));
    const db = makeDb((table, ops) => {
      // Entitlement gate (audit fix 2026-11-01): the publish
      // loop checks the owning workspace's paid period first.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      // The claim update (update + still-pending guard) finds nothing:
      // another tick claimed this job first.
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'update')) {
        return { data: [], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      // S2: the gate loads the destination row before the claim;
      // without it the job would pause and never reach the claim
      // this test is about.
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: { platform: 'facebook', external_destination_id: 'ext-dest-1' },
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              platform: 'facebook',
              external_destination_id: 'ext-dest-1',
              status: 'active',
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        // The scan only reads id/status; this test never loads the
        // account row itself (the claim is lost first), so no token
        // is modelled here.
        return { data: [{ id: 'acc-1', status: 'active' }], error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'publishing'),
    );
    expect(claim).toBeDefined();
    expect(claim!.ops.find((o) => o.kind === 'eq' && o.args[0] === 'status')?.args[1]).toBe(
      'pending_publish',
    );
  });

  it('intake oldest load failure throws instead of completing the config', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: null, error: { code: '57014', message: 'query cancelled' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    await expect(
      runAduTick({ db: db as never, registry: registryWith(null), masterKey: MASTER_KEY, now: NOW }),
    ).rejects.toThrow(/ADU intake oldest load failed: 57014|query cancelled/);
    const completion = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'completed'),
    );
    expect(completion).toBeUndefined();
  });

  it('intake busy load failure throws instead of completing the config', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: null, error: null };
      }
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'in')) {
        return { data: null, error: { code: '500', message: 'busy boom' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    await expect(
      runAduTick({ db: db as never, registry: registryWith(null), masterKey: MASTER_KEY, now: NOW }),
    ).rejects.toThrow(/ADU intake busy load failed/);
    const completion = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'completed'),
    );
    expect(completion).toBeUndefined();
  });

  it('intake failed-count load failure throws instead of completing the config', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      // The failed-count query is the adu_reels select filtered to
      // status 'download_failed' (count/head); the oldest query filters
      // to 'downloaded' instead, so this match is exact.
      if (
        table === 'adu_reels' &&
        ops.some((o) => o.kind === 'eq' && o.args[1] === 'download_failed')
      ) {
        return { count: null, error: { code: '500', message: 'count boom' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    await expect(
      runAduTick({ db: db as never, registry: registryWith(null), masterKey: MASTER_KEY, now: NOW }),
    ).rejects.toThrow(/ADU intake failed-count load failed/);
    const completion = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'completed'),
    );
    expect(completion).toBeUndefined();
  });

  it('intake busy-job load failure throws instead of completing the config', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: null, error: null };
      }
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'in')) {
        return { data: [], error: null };
      }
      // The busy-job query is the adu_posting_jobs select filtered by
      // an 'in' on status with pending_publish/publishing; the stale
      // query uses eq/lt, not 'in', and the terminal-failed exclusion
      // query uses 'in' with the terminal statuses instead.
      if (
        table === 'adu_posting_jobs' &&
        ops.some(
          (o) =>
            o.kind === 'in' &&
            Array.isArray(o.args[1]) &&
            (o.args[1] as unknown[]).includes('pending_publish'),
        )
      ) {
        return { data: null, error: { code: '500', message: 'busy jobs boom' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    await expect(
      runAduTick({ db: db as never, registry: registryWith(null), masterKey: MASTER_KEY, now: NOW }),
    ).rejects.toThrow(/ADU intake busy-job load failed/);
    const completion = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'completed'),
    );
    expect(completion).toBeUndefined();
  });

  it('intake claims the reel and releases it on a duplicate slot', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs') return { data: [config], error: null };
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: { id: 'reel-1', media_url: 'https://example.invalid/r.mp4' },
          error: null,
        };
      }
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'update')) {
        return { data: [{ id: 'reel-1' }], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'insert')) {
        return { error: { code: '23505', message: 'duplicate slot' } };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.intakeJobsCreated).toBe(0);
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_reels' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'processing'),
    );
    expect(claim).toBeDefined();
    expect(claim!.ops.find((o) => o.kind === 'eq' && o.args[0] === 'status')?.args[1]).toBe(
      'downloaded',
    );
    // The failed insert releases the claim so the reel stays intakable.
    const release = db.calls.find(
      (c) =>
        c.table === 'adu_reels' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'downloaded'),
    );
    expect(release).toBeDefined();
  });
  it('entitlement-paused job stays pending_publish and never reaches the publisher', async () => {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4', media_object_key: 'r.mp4' },
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'g1' }));
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      // S2: the gate loads the destination row for the config's
      // destination and calls can_publish_for with its platform
      // and key (external_destination_id ?? id). The RPC below
      // answers false, so the job pauses; the workspaces row is
      // still read on the false path (owner lookup + activation
      // backstop).
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: { platform: 'facebook', external_destination_id: 'ext-dest-1' },
          error: null,
        };
      }
      // No active period: expired workspace, so the job pauses.
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') return { data: [], error: null };
      return { data: [], error: null };
    });
    db.rpc = async () => ({ data: false, error: null });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    // Never claimed: no update to 'publishing' for this job.
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'publishing'),
    );
    expect(claim).toBeUndefined();
  });

  // --- S2 count gate ---------------------------------------------------
  // The ADU publish gate calls can_publish_for with the config
  // destination's platform and key (external_destination_id ??
  // id). A registered destination at cap passes; an unregistered
  // one at cap stays pending_publish; a missing destination row
  // fails closed without ever calling the RPC.

  /** One pending job through the publish loop with a controlled gate answer. */
  async function s2GateTick(opts: {
    rpcResult: boolean;
    rpcCapture: Array<Record<string, unknown>>;
    destinationRow: Row | null;
  }) {
    const job = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4', media_object_key: 'r.mp4' },
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'g1' }));
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const encryptedDestination = await encryptToken('dest-token', MASTER_KEY);
    const db = makeDb((table, ops) => {
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data:
            opts.destinationRow === null
              ? null
              : {
                  id: 'dest-1',
                  account_id: 'acc-1',
                  workspace_id: 'ws-1',
                  platform: 'facebook',
                  status: 'active',
                  encrypted_destination_token: encryptedDestination,
                  ...opts.destinationRow,
                },
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data:
            opts.destinationRow === null
              ? []
              : [
                  {
                    id: 'dest-1',
                    account_id: 'acc-1',
                    workspace_id: 'ws-1',
                    platform: 'facebook',
                    status: 'active',
                    encrypted_destination_token: encryptedDestination,
                    ...opts.destinationRow,
                  },
                ],
          error: null,
        };
      }
      if (table === 'destinations') return { data: [], error: null };
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    db.rpc = async (fn, args) => {
      opts.rpcCapture.push({ fn, ...args });
      return { data: opts.rpcResult, error: null };
    };
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    return { result, db, publisher };
  }

  it('S2: at-cap owner with a registered destination publishes; the gate passes the external key', async () => {
    const rpcCapture: Array<Record<string, unknown>> = [];
    const { result, publisher } = await s2GateTick({
      rpcResult: true,
      rpcCapture,
      destinationRow: { external_destination_id: 'ext-dest-1' },
    });
    expect(publisher.publish).toHaveBeenCalled();
    expect(result.published).toBe(1);
    // Key agreement (§6 criterion 8): the external id, not the row id.
    expect(rpcCapture).toEqual([
      {
        fn: 'can_publish_for',
        p_workspace_id: 'ws-1',
        p_platform: 'facebook',
        p_destination_key: 'ext-dest-1',
        p_at: NOW.toISOString(),
      },
    ]);
  });

  it('S2: at-cap owner with an unregistered destination stays pending_publish', async () => {
    const rpcCapture: Array<Record<string, unknown>> = [];
    const { result, db, publisher } = await s2GateTick({
      rpcResult: false,
      rpcCapture,
      destinationRow: { external_destination_id: 'ext-dest-1' },
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(rpcCapture).toHaveLength(1);
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'publishing'),
    );
    expect(claim).toBeUndefined();
  });

  it('S2: missing destination row stays pending_publish without calling the RPC', async () => {
    const rpcCapture: Array<Record<string, unknown>> = [];
    const { result, db, publisher } = await s2GateTick({
      rpcResult: true,
      rpcCapture,
      destinationRow: null,
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(rpcCapture).toHaveLength(0);
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'publishing'),
    );
    expect(claim).toBeUndefined();
    // The scan filters a missing-destination job before the loop, so
    // the loop's "paused" log no longer fires for it — the job stays
    // pending silently, recoverable if the destination reappears.
  });

  // --- ADU reel publish stores the Facebook error detail (PR #171
  // treatment) ------------------------------------------------------
  // The queue settles a failed publish's diagnostic (phase, HTTP
  // status, Facebook's raw body, both upload attempts) into
  // publish_logs.detail; ADU has no publish_logs row, so adu-tick
  // must fold the detail into the job row's last_error fields.
  // These tests drive the REAL FacebookPublisher with a stubbed
  // Facebook client, so the ADU path is proven end to end: the R2
  // public URL reaches publishReel, and a failure stores the real
  // reason instead of bare "HTTP 400" / code `unknown`.

  /** Stub Facebook client: only publishReel is wired; the rest throw. */
  function stubFacebookClient(
    publishReelImpl: IFacebookPublishClient['publishReel'],
  ): IFacebookPublishClient {
    return {
      publishReel: vi.fn(publishReelImpl),
      publishPhoto: vi.fn(async () => {
        throw new InternalError('publishPhoto not used in these tests');
      }),
      postComment: vi.fn(async () => {
        throw new InternalError('postComment not used in these tests');
      }),
    } as unknown as IFacebookPublishClient;
  }

  /** Runs one tick for a single pending Facebook ADU job. */
  async function facebookJobTick(job: Row, publisher: Publisher) {
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    // The real Facebook publisher reads the destination (page) token:
    // without it publish() fails before publishReel is ever called.
    const encryptedDestination = await encryptToken('dest-token', MASTER_KEY);
    const db = makeDb((table, ops) => {
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (
        table === 'adu_posting_jobs' &&
        ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')
      ) {
        return { data: [job], error: null };
      }
      if (
        table === 'adu_posting_jobs' &&
        ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')
      ) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }, error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: 'active' }], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      // The single-row load uses maybeSingle; the invalid-token
      // cascade's list select gets an empty page (no sibling pages).
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: {
            id: 'dest-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'facebook',
            status: 'active',
            encrypted_destination_token: encryptedDestination,
          },
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'facebook',
              status: 'active',
              encrypted_destination_token: encryptedDestination,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') return { data: [], error: null };
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    return { result, db };
  }

  function facebookJob(r2Url: string): Row {
    return {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: 0,
      graph_post_id: null,
      adu_reels: {
        caption: 'hi',
        media_url: r2Url,
        media_object_key: 'adu-buffer/c1/reel-1.mp4',
      },
    };
  }

  /** The adu_posting_jobs update that stored a failure reason. */
  function storedFailure(db: FakeDb): Row | undefined {
    const call = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some(
          (o) =>
            o.kind === 'update' && (o.args[0] as Row).last_error_code !== undefined,
        ),
    );
    const update = call?.ops.find((o) => o.kind === 'update');
    return update?.args[0] as Row | undefined;
  }

  /** The adu_posting_jobs update that settled a job as published. */
  function storedPublish(db: FakeDb): Row | undefined {
    const call = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some(
          (o) =>
            o.kind === 'update' && (o.args[0] as Row).status === 'published',
        ),
    );
    const update = call?.ops.find((o) => o.kind === 'update');
    return update?.args[0] as Row | undefined;
  }

  it('stores the Facebook error detail on the job row when a reel publish fails', async () => {
    const r2Url = 'https://pub-abc123.r2.dev/adu-buffer/c1/reel-1.mp4';
    const rawBody =
      '{"error":{"message":"The video file could not be processed.","code":2207026}}';
    const seenVideoUrls: string[] = [];
    const client = stubFacebookClient(async (params) => {
      seenVideoUrls.push(params.videoUrl);
      throw new FacebookGraphError(
        'Facebook Graph API error: HTTP 400 (reel-upload-stream)',
        {
          code: 2207026,
          error_subcode: 123,
          message: 'The video file could not be processed.',
        },
        undefined,
        {
          phase: 'reel-upload-stream',
          httpStatus: 400,
          rawBody,
          attempts: [
            { mode: 'file_url', success: false, httpStatus: 400, rawBody: '' },
            { mode: 'stream', success: false, httpStatus: 400, rawBody },
          ],
        },
      );
    });
    const { result, db } = await facebookJobTick(
      facebookJob(r2Url),
      new FacebookPublisher(client),
    );

    // The ADU media (public R2 URL) reaches publishReel as the video.
    expect(seenVideoUrls).toEqual([r2Url]);
    expect(result.retried).toBe(1);
    const failure = storedFailure(db);
    expect(failure).toBeDefined();
    // The real Graph code, not `unknown`.
    expect(failure!.last_error_code).toBe('2207026');
    const message = String(failure!.last_error_message);
    expect(message).toContain('The video file could not be processed.');
    expect(message).toContain('phase=reel-upload-stream');
    expect(message).toContain('http=400');
    expect(message).toContain('subcode=123');
    expect(message).toContain('body={"error":{"message":"The video file could not be processed.","code":2207026}}');
    expect(message).toContain('attempts=[file_url:400,stream:400]');
  });

  it('stores http_400, never unknown, for a body-less reel upload failure', async () => {
    const r2Url = 'https://pub-abc123.r2.dev/adu-buffer/c1/reel-1.mp4';
    const client = stubFacebookClient(async () => {
      throw new FacebookGraphError(
        'Facebook Graph API error: HTTP 400 (reel-upload-stream)',
        undefined,
        undefined,
        { phase: 'reel-upload-stream', httpStatus: 400, rawBody: '' },
      );
    });
    const { result, db } = await facebookJobTick(
      facebookJob(r2Url),
      new FacebookPublisher(client),
    );

    expect(result.retried).toBe(1);
    const failure = storedFailure(db);
    expect(failure).toBeDefined();
    expect(failure!.last_error_code).toBe('http_400');
    const message = String(failure!.last_error_message);
    expect(message).toContain('phase=reel-upload-stream');
    expect(message).toContain('http=400');
    expect(message).not.toContain('unknown');
  });

  // --- A published job must not keep showing its old error --------
  // The 10 reset 413 posts all published but their rows kept the
  // old `unknown` / `HTTP 413` error, which the detail pages display
  // verbatim. Settling published must clear both error fields.

  it('clears a stale error on the job row when a retried publish succeeds', async () => {
    const job: Row = {
      ...facebookJob('https://pub-abc123.r2.dev/adu-buffer/c1/reel-1.mp4'),
      // The row failed before (a bare 413, as the 10 reset posts had)
      // and is being retried; the publish must not leave that error
      // on the row once it succeeds.
      last_error_code: 'unknown',
      last_error_message: 'Facebook Graph API error: HTTP 413',
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'g1' }));
    const { result, db } = await facebookJobTick(job, publisher);

    expect(result.published).toBe(1);
    const published = storedPublish(db);
    expect(published).toBeDefined();
    expect(published!.status).toBe('published');
    expect(published!.last_error_code).toBeNull();
    expect(published!.last_error_message).toBeNull();
  });

  it('clears a stale error when a job with a stored Graph id settles published', async () => {
    const job: Row = {
      ...facebookJob('https://pub-abc123.r2.dev/adu-buffer/c1/reel-1.mp4'),
      graph_post_id: 'graph-123',
      last_error_code: 'unknown',
      last_error_message: 'Facebook Graph API error: HTTP 413',
    };
    const publisher = fakePublisher(async () => ({ status: 'published', externalPostId: 'x' }));
    const { result, db } = await facebookJobTick(job, publisher);

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(1);
    const published = storedPublish(db);
    expect(published).toBeDefined();
    expect(published!.status).toBe('published');
    expect(published!.last_error_code).toBeNull();
    expect(published!.last_error_message).toBeNull();
  });

  // --- ADU statuses build (spec §3.1/§3.2) --------------------------
  // One tick per failure, with a stubbed publisher returning the exact
  // outcome the real publisher would return for the code: the mapper
  // is the single ADU decision point, so these tests pin the config /
  // destination / account flips, the cascade scope, the publish-loop
  // gate, the rate-limit recovery, the terminal reel, and the generic
  // backend message.

  /** Runs one tick for a single pending Facebook ADU job with a stubbed outcome. */
  async function aduPublishTick(
    outcome: PublishOutcome,
    opts: {
      gateStatus?: string;
      cascadeDestinations?: Row[];
      cascadeConfigs?: Row[];
      publishRetries?: number;
    } = {},
  ) {
    const job: Row = {
      id: 'job-1',
      config_id: 'c1',
      reel_id: 'reel-1',
      publish_retries: opts.publishRetries ?? 0,
      graph_post_id: null,
      adu_reels: { caption: 'hi', media_url: 'https://example.invalid/r.mp4' },
    };
    const publisher = fakePublisher(async () => outcome);
    const encryptedAccess = await encryptToken('access', MASTER_KEY);
    const db = makeDb((table, ops) => {
      if (table === 'workspaces') return { data: { owner_id: 'user-1' }, error: null };
      if (table === 'users') return { data: { role: 'user' }, error: null };
      if (table === 'subscription_periods') {
        return {
          data: [
            {
              starts_at: new Date(NOW.getTime() - 86400000).toISOString(),
              ends_at: new Date(NOW.getTime() + 86400000 * 20).toISOString(),
              superseded_at: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'pending_publish')) {
        return { data: [job], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'eq' && o.args[1] === 'publishing')) {
        return { data: [], error: null };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: { destination_id: 'dest-1', workspace_id: 'ws-1', status: opts.gateStatus ?? 'active' },
          error: null,
        };
      }
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return { data: [{ id: 'c1', destination_id: 'dest-1', workspace_id: 'ws-1', status: opts.gateStatus ?? 'active' }], error: null };
      }
      if (
        table === 'adu_configs' &&
        ops.some((o) => o.kind === 'in' && o.args[0] === 'destination_id')
      ) {
        return { data: opts.cascadeConfigs ?? [], error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations' && ops.some((o) => o.kind === 'maybeSingle')) {
        return {
          data: {
            id: 'dest-1',
            account_id: 'acc-1',
            workspace_id: 'ws-1',
            platform: 'facebook',
            status: 'active',
            encrypted_destination_token: null,
          },
          error: null,
        };
      }
      if (table === 'destinations' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'dest-1',
              account_id: 'acc-1',
              workspace_id: 'ws-1',
              platform: 'facebook',
              status: 'active',
              encrypted_destination_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'destinations') return { data: opts.cascadeDestinations ?? [], error: null };
      if (table === 'social_accounts' && ops.some((o) => o.kind === 'in' && o.args[0] === 'id')) {
        return {
          data: [
            {
              id: 'acc-1',
              status: 'active',
              encrypted_access_token: encryptedAccess,
              encrypted_refresh_token: null,
            },
          ],
          error: null,
        };
      }
      if (table === 'social_accounts') {
        return {
          data: {
            id: 'acc-1',
            status: 'active',
            encrypted_access_token: encryptedAccess,
            encrypted_refresh_token: null,
          },
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(publisher),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    return { result, db, publisher };
  }

  /** The update call that flipped a row to a status, if any. */
  function flippedTo(db: FakeDb, table: string, status: string, id?: string): Row | undefined {
    const call = db.calls.find(
      (c) =>
        c.table === table &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === status) &&
        (id === undefined ||
          c.ops.some((o) => o.kind === 'eq' && o.args[0] === 'id' && o.args[1] === id)),
    );
    const update = call?.ops.find((o) => o.kind === 'update');
    return update?.args[0] as Row | undefined;
  }

  /** True when any update touched the table at all. */
  function touchedTable(db: FakeDb, table: string): boolean {
    return db.calls.some((c) => c.table === table && c.ops.some((o) => o.kind === 'update'));
  }

  it('flips config, account and destination on invalid token and cascades to active siblings only', async () => {
    const { result, db } = await aduPublishTick(
      {
        status: 'failed',
        error: { kind: 'auth', code: '190', message: 'Access token is invalid or revoked.' },
      },
      {
        cascadeDestinations: [{ id: 'dest-2' }],
        cascadeConfigs: [{ id: 'c2' }],
      },
    );
    expect(result.failed).toBe(1);
    // The failing config itself.
    expect(flippedTo(db, 'adu_configs', 'invalid_token', 'c1')).toBeDefined();
    expect(flippedTo(db, 'social_accounts', 'expired', 'acc-1')).toBeDefined();
    expect(flippedTo(db, 'destinations', 'error', 'dest-1')).toBeDefined();
    // The cascade: only currently-active siblings flip.
    expect(flippedTo(db, 'destinations', 'error', 'dest-2')).toBeDefined();
    expect(flippedTo(db, 'adu_configs', 'invalid_token', 'c2')).toBeDefined();
    // The cascade queries only currently-active rows — that filter is
    // the scope pin (error/paused/rate-limited rows keep their own
    // status because the database never returns them here). The find
    // must pin the eq status='active' itself: the publish scan's bulk
    // destinations load is also a select without maybeSingle, and it
    // runs first.
    const cascadeDestCall = db.calls.find(
      (c) =>
        c.table === 'destinations' &&
        !c.ops.some((o) => o.kind === 'maybeSingle') &&
        c.ops.some(
          (o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'active',
        ),
    );
    expect(cascadeDestCall).toBeDefined();
    // Terminal settlement marks the reel failed too.
    expect(flippedTo(db, 'adu_reels', 'failed', 'reel-1')).toBeDefined();
  });

  it('flips verification-required without expiring the account (190/459)', async () => {
    const { result, db } = await aduPublishTick({
      status: 'failed',
      error: { kind: 'auth', code: '190', subcode: '459', message: 'User checkpointed.' },
    });
    expect(result.failed).toBe(1);
    expect(flippedTo(db, 'adu_configs', 'fb_verification_required', 'c1')).toBeDefined();
    expect(flippedTo(db, 'destinations', 'error', 'dest-1')).toBeDefined();
    expect(touchedTable(db, 'social_accounts')).toBe(false);
    // The real reason stays visible for checkpoint codes.
    expect(storedFailure(db)?.last_error_message).toContain('User checkpointed.');
  });

  it('flips rate-limited with the anchor stamped on a retryable 368', async () => {
    const { result, db } = await aduPublishTick({
      status: 'retry',
      error: { kind: 'retryable', code: '368', message: 'We limit how often you can post.' },
    });
    expect(result.retried).toBe(1);
    const flipped = flippedTo(db, 'adu_configs', 'fb_rate_limited', 'c1');
    expect(flipped).toBeDefined();
    expect(flipped?.rate_limited_at).toBe(NOW.toISOString());
    expect(flippedTo(db, 'destinations', 'rate_limited', 'dest-1')).toBeDefined();
    expect(touchedTable(db, 'social_accounts')).toBe(false);
    // The job stays pending_publish for the recovery to resume later.
    const pending = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'pending_publish'),
    );
    expect(pending).toBeDefined();
  });

  it('flips missing_permission and nothing else (200)', async () => {
    const { result, db } = await aduPublishTick({
      status: 'failed',
      error: { kind: 'auth', code: '200', message: 'Permissions error.' },
    });
    expect(result.failed).toBe(1);
    expect(flippedTo(db, 'adu_configs', 'missing_permission', 'c1')).toBeDefined();
    expect(touchedTable(db, 'social_accounts')).toBe(false);
    expect(touchedTable(db, 'destinations')).toBe(false);
  });

  it('stores the generic backend message for app-bug 190/2069032 and flips nothing', async () => {
    const { result, db } = await aduPublishTick({
      status: 'failed',
      error: { kind: 'auth', code: '190', subcode: '2069032', message: 'Wrong token type.' },
    });
    expect(result.failed).toBe(1);
    expect(storedFailure(db)?.last_error_message).toBe(
      'This post could not be published because of a backend issue.',
    );
    expect(touchedTable(db, 'adu_configs')).toBe(false);
    expect(touchedTable(db, 'destinations')).toBe(false);
    expect(touchedTable(db, 'social_accounts')).toBe(false);
  });

  it('stores the generic backend message for app-bug code 3 and flips nothing', async () => {
    const { result, db } = await aduPublishTick({
      status: 'failed',
      error: { kind: 'permanent', code: '3', message: 'API Method not supported.' },
    });
    expect(result.failed).toBe(1);
    expect(storedFailure(db)?.last_error_message).toBe(
      'This post could not be published because of a backend issue.',
    );
    expect(touchedTable(db, 'adu_configs')).toBe(false);
    expect(touchedTable(db, 'destinations')).toBe(false);
    expect(touchedTable(db, 'social_accounts')).toBe(false);
  });

  it('skips publishing when the config is paused', async () => {
    const { result, db, publisher } = await aduPublishTick(
      { status: 'failed', error: { kind: 'permanent', code: '500', message: 'Meta-side failure.' } },
      { gateStatus: 'paused' },
    );
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.retried).toBe(0);
    // Never claimed: no update to 'publishing' for this job.
    const claim = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'publishing'),
    );
    expect(claim).toBeUndefined();
  });

  it('recovers rate-limited configs after 3 days via rate_limited_at', async () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'fb_rate_limited')) {
        return { data: [{ id: 'c-old' }], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.skipped).toBeUndefined();
    // The recovery query's cutoff is exactly 3 days before now.
    const recoveryCall = db.calls.find(
      (c) =>
        c.table === 'adu_configs' &&
        c.ops.some((o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'fb_rate_limited'),
    );
    expect(
      recoveryCall?.ops.find((o) => o.kind === 'lt' && o.args[0] === 'rate_limited_at')?.args[1],
    ).toBe(threeDaysAgo);
    const recovered = flippedTo(db, 'adu_configs', 'active', 'c-old');
    expect(recovered).toBeDefined();
    expect(recovered?.rate_limited_at).toBeNull();
  });

  it('marks the reel failed on terminal failure', async () => {
    const { result, db } = await aduPublishTick({
      status: 'failed',
      error: { kind: 'permanent', code: '500', message: 'Meta-side failure.' },
    });
    expect(result.failed).toBe(1);
    expect(flippedTo(db, 'adu_reels', 'failed', 'reel-1')).toBeDefined();
  });

  it('marks the reel failed when retries exhaust', async () => {
    const { result, db } = await aduPublishTick(
      {
        status: 'retry',
        error: { kind: 'retryable', code: '500', message: 'Meta-side failure.' },
      },
      { publishRetries: 5 },
    );
    expect(result.failed).toBe(1);
    const settled = db.calls.find(
      (c) =>
        c.table === 'adu_posting_jobs' &&
        c.ops.some((o) => o.kind === 'update' && (o.args[0] as Row).status === 'failed_to_publish'),
    );
    expect(settled).toBeDefined();
    expect(flippedTo(db, 'adu_reels', 'failed', 'reel-1')).toBeDefined();
  });

  // SEND BACK fix (PR #190): content codes 368/1404102, 382 and 1363040
  // used to retry through the real FacebookPublisher (1404102 also
  // flipped the Pages-queue destination to rate_limited). They are
  // permanent for the post: the ADU job settles failed_to_publish at
  // retry 0, the reel goes failed, nothing is re-queued, and no
  // config / destination / account flips.
  it('content codes settle failed_to_publish with the reel failed, never re-queued', async () => {
    const r2Url = 'https://pub-abc123.r2.dev/adu-buffer/c1/reel-1.mp4';
    const cases: Array<{
      code: number;
      subcode?: number;
      message: string;
      expectMessage: string;
    }> = [
      {
        code: 368,
        subcode: 1404102,
        message: 'The link you tried to post goes against our Community Standards.',
        expectMessage: 'Community Standards',
      },
      {
        code: 382,
        message: 'The video file is too small.',
        expectMessage: 'too small',
      },
      {
        code: 1363040,
        message: 'Video aspect ratio exceeds the maximum allowed (9:16).',
        expectMessage: 'aspect ratio',
      },
    ];
    for (const c of cases) {
      const client = stubFacebookClient(async () => {
        throw new FacebookGraphError(c.message, {
          message: c.message,
          code: c.code,
          ...(c.subcode !== undefined ? { error_subcode: c.subcode } : {}),
        });
      });
      const { result, db } = await facebookJobTick(
        facebookJob(r2Url),
        new FacebookPublisher(client),
      );

      expect(result.failed).toBe(1);
      expect(result.retried).toBe(0);
      const settled = db.calls.find(
        (call) =>
          call.table === 'adu_posting_jobs' &&
          call.ops.some(
            (o) => o.kind === 'update' && (o.args[0] as Row).status === 'failed_to_publish',
          ),
      );
      expect(settled).toBeDefined();
      expect(flippedTo(db, 'adu_reels', 'failed', 'reel-1')).toBeDefined();
      // NOT re-queued: no pending_publish update for this job.
      const requeued = db.calls.find(
        (call) =>
          call.table === 'adu_posting_jobs' &&
          call.ops.some(
            (o) => o.kind === 'update' && (o.args[0] as Row).status === 'pending_publish',
          ),
      );
      expect(requeued).toBeUndefined();
      // No status flips anywhere: page stays active.
      expect(touchedTable(db, 'adu_configs')).toBe(false);
      expect(touchedTable(db, 'destinations')).toBe(false);
      expect(touchedTable(db, 'social_accounts')).toBe(false);
      // The user sees the real reason.
      expect(String(storedFailure(db)?.last_error_message)).toContain(c.expectMessage);
    }
  });

  it('completes a config whose only busy reel has a terminally-failed job', async () => {
    const config = configRow('c1', ['09:00']);
    const db = makeDb((table, ops) => {
      if (table === 'adu_configs' && ops.some((o) => o.kind === 'eq' && o.args[0] === 'status' && o.args[1] === 'active')) {
        return { data: [config], error: null };
      }
      if (table === 'adu_reels' && ops.some((o) => o.kind === 'maybeSingle')) {
        return { data: null, error: null };
      }
      if (table === 'adu_reels') return { data: [], error: null };
      // The crash window: the reel is still 'processing' but its job
      // already settled terminally.
      if (
        table === 'adu_posting_jobs' &&
        ops.some(
          (o) =>
            o.kind === 'in' &&
            Array.isArray(o.args[1]) &&
            (o.args[1] as unknown[]).includes('failed_to_publish'),
        )
      ) {
        return { data: [{ reel_id: 'reel-1' }], error: null };
      }
      if (table === 'adu_posting_jobs' && ops.some((o) => o.kind === 'delete')) {
        return { error: null };
      }
      return { data: [], error: null };
    });
    const result = await runAduTick({
      db: db as never,
      registry: registryWith(null),
      masterKey: MASTER_KEY,
      now: NOW,
    });
    expect(result.intakeCompleted).toBe(1);
    // The busy check excluded the terminally-failed reel.
    const busyCall = db.calls.find(
      (c) =>
        c.table === 'adu_reels' &&
        c.ops.some((o) => o.kind === 'in' && o.args[0] === 'status'),
    );
    expect(
      busyCall?.ops.some(
        (o) => o.kind === 'not' && o.args[0] === 'id' && String(o.args[2]).includes('reel-1'),
      ),
    ).toBe(true);
    expect(flippedTo(db, 'adu_configs', 'completed', 'c1')).toBeDefined();
  });
});
