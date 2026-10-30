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
  createPublisherRegistry,
  encryptToken,
  InternalError,
  type Publisher,
} from '@fbuploadpro/contracts';
import { ADU_JOB_RETENTION_DAYS, ADU_TICK_PAGE_SIZE, runAduTick } from './adu-tick.js';

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

  not() {
    this.ops.push({ kind: 'not', args: [] });
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
    const configCalls = db.calls.filter((c) => c.table === 'adu_configs');
    expect(configCalls.length).toBe(2);
    expect(configCalls[1]!.ops.find((o) => o.kind === 'gt')?.args[1]).toBe(
      `c${String(ADU_TICK_PAGE_SIZE - 1).padStart(4, '0')}`,
    );
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
        return { data: { destination_id: 'dest-1' }, error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
      if (table === 'destinations') {
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
        return { data: { destination_id: 'dest-1' }, error: null };
      }
      if (table === 'adu_configs') return { data: [], error: null };
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
});
