/**
 * Spec 163 + spec 240 — manual insights-followers run endpoint.
 *
 * Drives the worker's `fetch` export directly (the first tests to do
 * so — the handler previously answered only /health). Fake Supabase
 * client (same shape as the tick test's fake) + a fake queue. The
 * bearer token here is a dummy test string, never a real secret.
 *
 * Spec 240: the handler answers 202 immediately after enqueueing
 * the cycle as chunked queue messages — one message per 200-row
 * offset page — and returns the runId. It never runs the cycle
 * inside the request (the old code did, and died at ~271s once the
 * page count doubled; the waitUntil version died at 30s). The run
 * record is the in-flight guard: a second call while one is live
 * 409s, and the guard is shared across isolates because it lives
 * in the database, not in a module boolean.
 *
 * - No/wrong/missing-secret token → 401 and nothing is enqueued:
 *   zero DB writes, zero queue messages, zero Graph calls.
 * - Correct token → 202 accepted with runId; exactly one
 *   sendBatch carries the chunk messages; no Graph call, no
 *   writes yet — the chunks run in the queue consumers.
 * - A second call while one is live → 409; the first run stays
 *   live and no second batch is sent.
 * - Enqueue throw or a missing queue binding → 500 and the run
 *   is marked failed.
 * - Start throw → 503; no run row sticks, so the next call can
 *   start a new run.
 * - DB/master-key missing → 503. GET on the path → 404 (POST only).
 * - The 03:00 cron enqueues the same chunks when no run is live
 *   and skips (warn + no batch) while one is.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptToken, InternalError } from '@fbuploadpro/contracts';
import worker, { type Env, handleScheduled } from './index.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const TEST_TOKEN = 'test-manual-run-token-abc123';
const URL = 'https://worker.test/admin/insights-followers/run';

type Row = Record<string, unknown>;

interface FakeDb {
  destinations: Row[];
  adu_configs: Row[];
  mirrors: Row[];
  insights_runs: Row[];
  insights_run_chunks: Row[];
  updates: Array<{ table: string; patch: Row; count: number }>;
  throwOnScan: boolean;
}

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private orderColumn: string | null = null;
  private orderAscending = true;
  private updatePatch: Row | null = null;
  private updateCountExact = false;
  private selectCountExact = false;
  private selectHead = false;
  private insertRows: Row[] | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(
    _columns?: string,
    options?: { count?: string; head?: boolean }
  ): this {
    this.selectCountExact = options?.count === 'exact';
    this.selectHead = options?.head === true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  lt(col: string, val: unknown): this {
    // ISO timestamps compare lexicographically = chronologically.
    this.filters.push((r) => String(r[col] ?? '') < String(val));
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = opts?.ascending ?? true;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  update(patch: Row, opts?: { count?: string }): this {
    this.updatePatch = patch;
    this.updateCountExact = opts?.count === 'exact';
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  private tableRows(): Row[] {
    if (this.table === 'destinations') return this.db.destinations;
    if (this.table === 'adu_configs') return this.db.adu_configs;
    if (this.table === 'insights_runs') return this.db.insights_runs;
    if (this.table === 'insights_run_chunks') return this.db.insights_run_chunks;
    return this.db.mirrors;
  }

  private matched(): Row[] {
    return this.tableRows().filter((r) => this.filters.every((f) => f(r)));
  }

  then(
    resolve: (value: {
      data: Row[] | null;
      error: unknown;
      count: number | null;
    }) => void
  ): void {
    if (this.insertRows) {
      const rows = this.insertRows;
      // The partial unique index on insights_runs (status='running')
      // and the unique (run_id, chunk_index) on chunks: a violating
      // insert fails with 23505, exactly like PostgREST surfaces it.
      for (const row of rows) {
        if (this.table === 'insights_runs' && row.status === 'running') {
          if (this.tableRows().some((r) => r.status === 'running')) {
            resolve({
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "insights_runs_live_idx"',
              },
              count: null,
            });
            return;
          }
        }
        if (this.table === 'insights_run_chunks') {
          if (
            this.tableRows().some(
              (r) => r.run_id === row.run_id && r.chunk_index === row.chunk_index
            )
          ) {
            resolve({
              data: null,
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "insights_run_chunks_run_chunk_idx"',
              },
              count: null,
            });
            return;
          }
        }
      }
      const inserted: Row[] = [];
      for (const row of rows) {
        // The migration's column defaults (status 'pending', zero
        // counters) — the real DB applies them; the fake must too,
        // or a chunk row has status undefined and the lookup treats
        // it as missing.
        const copy: Row = {
          ...(this.table === 'insights_runs'
            ? {
                chunks_done: 0,
                chunks_failed: 0,
                scanned: 0,
                updated: 0,
                skipped: 0,
                failed: 0,
                adu_updated: 0,
                mirrors_updated: 0,
              }
            : this.table === 'insights_run_chunks'
              ? {
                  status: 'pending',
                  attempts: 0,
                  scanned: 0,
                  updated: 0,
                  skipped: 0,
                  failed: 0,
                  adu_updated: 0,
                  mirrors_updated: 0,
                }
              : {}),
          ...row,
        };
        if (typeof copy.id !== 'string') {
          // The DB generates the header id (gen_random_uuid()) — the
          // fake does the same, so the runId passes the chunk
          // message's uuid validation downstream.
          copy.id =
            this.table === 'insights_runs'
              ? randomUUID()
              : `${this.table}-row-${this.tableRows().length + inserted.length + 1}`;
        }
        this.tableRows().push(copy);
        inserted.push(copy);
      }
      resolve({ data: inserted, error: null, count: null });
      return;
    }
    if (this.updatePatch) {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.updatePatch);
      this.db.updates.push({
        table: this.table,
        patch: this.updatePatch,
        count: matched.length,
      });
      resolve({
        data: matched,
        error: null,
        count: this.updateCountExact ? matched.length : null,
      });
      return;
    }
    if (this.db.throwOnScan) {
      resolve({
        data: null,
        error: { code: 'XX', message: 'boom' },
        count: null,
      });
      return;
    }
    let matched = this.matched();
    if (this.orderColumn !== null) {
      const column = this.orderColumn;
      const ascending = this.orderAscending;
      matched = [...matched].sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        const cmp = String(av) < String(bv) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      matched = matched.slice(this.rangeFrom, this.rangeTo + 1);
    }
    resolve({
      data: this.selectHead ? null : matched,
      error: null,
      count: this.selectCountExact ? matched.length : null,
    });
  }
}

function fakeDb(): FakeDb {
  return {
    destinations: [],
    adu_configs: [],
    mirrors: [],
    insights_runs: [],
    insights_run_chunks: [],
    updates: [],
    throwOnScan: false,
  };
}

function fakeClient(db: FakeDb): unknown {
  return { from: (table: string) => new FakeBuilder(db, table) };
}

async function seedDestination(
  db: FakeDb,
  overrides: Partial<Row> = {}
): Promise<Row> {
  const token = await encryptToken('page-token-A', MASTER_KEY);
  const row: Row = {
    id: 'dest-a',
    external_destination_id: 'fb-page-a',
    encrypted_destination_token: token,
    status: 'active',
    metadata: { starting_followers: 1000, current_followers: 1200 },
    platform: 'facebook',
    ...overrides,
  };
  db.destinations.push(row);
  return row;
}

function seedAduConfig(db: FakeDb, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'adu-a',
    destination_id: 'dest-a',
    status: 'active',
    starting_followers: 1000,
    current_followers: 1200,
    followers_updated_at: null,
    ...overrides,
  };
  db.adu_configs.push(row);
  return row;
}

function seedMirror(db: FakeDb, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'mirror-a',
    target_platform: 'facebook',
    target_external_id: 'fb-page-a',
    status: 'active',
    fb_status: null,
    starting_followers: null,
    current_followers: null,
    followers_updated_at: null,
    ...overrides,
  };
  db.mirrors.push(row);
  return row;
}

function testEnv(
  db: unknown,
  overrides: Record<string, unknown> = {}
): Env {
  return {
    __TEST_DB__: db,
    TOKEN_ENCRYPTION_KEY: MASTER_KEY,
    INSIGHTS_MANUAL_RUN_TOKEN: TEST_TOKEN,
    ...overrides,
  } as unknown as Env;
}

function authHeaders(token = TEST_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface ChunkMessage {
  runId: string;
  chunkIndex: number;
  offset: number;
  limit: number;
}

class FakeQueue {
  sent: Array<Array<{ body: ChunkMessage }>> = [];
  throwOnSend = false;

  async sendBatch(messages: Array<{ body: ChunkMessage }>): Promise<void> {
    if (this.throwOnSend) throw new InternalError('queue down');
    this.sent.push(messages);
  }
}

function postRun(
  env: Env,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<Response> {
  return worker.fetch(
    new Request(URL, { method, headers }),
    env,
    undefined as never
  );
}

function graphOk(count: number): Response {
  return {
    ok: true,
    json: async () => ({ followers_count: count }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /admin/insights-followers/run', () => {
  it('no token → 401 and the cycle never runs', async () => {
    const db = fakeDb();
    await seedDestination(db);
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return graphOk(5000);
    });
    const res = await postRun(testEnv(fakeClient(db)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(db.updates).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it('wrong token → 401 and the cycle never runs', async () => {
    const db = fakeDb();
    await seedDestination(db);
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return graphOk(5000);
    });
    const res = await postRun(
      testEnv(fakeClient(db)),
      authHeaders('not-the-token')
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(db.updates).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it('unconfigured secret → 401 even with a header', async () => {
    const db = fakeDb();
    await seedDestination(db);
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return graphOk(5000);
    });
    const env = testEnv(fakeClient(db), {
      INSIGHTS_MANUAL_RUN_TOKEN: undefined,
    });
    const res = await postRun(env, authHeaders());
    expect(res.status).toBe(401);
    expect(db.updates).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  it('correct token → 202 accepted with runId; exactly one sendBatch carries the chunk messages; no Graph call', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    // 450 destinations → 3 chunk messages (200 + 200 + 50).
    for (let i = 0; i < 449; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return graphOk(5000);
    });
    const queue = new FakeQueue();
    const res = await postRun(
      testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue }),
      authHeaders()
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      message: string;
      runId: string;
    };
    expect(body.status).toBe('accepted');
    expect(body.message).toBe('Insights followers run started in the background.');
    expect(typeof body.runId).toBe('string');
    // One live run row with three chunk rows.
    expect(db.insights_runs).toHaveLength(1);
    expect(db.insights_runs[0]!.id).toBe(body.runId);
    expect(db.insights_runs[0]!.trigger).toBe('manual');
    expect(db.insights_runs[0]!.status).toBe('running');
    expect(db.insights_runs[0]!.chunks_total).toBe(3);
    expect(db.insights_run_chunks).toHaveLength(3);
    // Exactly one sendBatch with the three chunk messages, each
    // wrapped as a queue message body (the Cloudflare sendBatch
    // shape — claimer.ts does the same for the publish queues).
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toEqual([
      { body: { runId: body.runId, chunkIndex: 0, offset: 0, limit: 200 } },
      { body: { runId: body.runId, chunkIndex: 1, offset: 200, limit: 200 } },
      { body: { runId: body.runId, chunkIndex: 2, offset: 400, limit: 200 } },
    ]);
    // The handler enqueues only — no Graph call, no writes yet.
    // The chunks run in the queue consumers, after the response.
    // (startInsightsRun's stale-supersede update still runs — it
    // matched zero rows — so only the three stores are asserted.)
    expect(fetchCalls).toBe(0);
    expect(
      db.updates.filter(
        (u) =>
          u.table === 'destinations' ||
          u.table === 'adu_configs' ||
          u.table === 'mirrors'
      )
    ).toEqual([]);
    expect((dest.metadata as Row).current_followers).toBe(1200);
  });

  it('second call while one is in flight → 409; the first run stays live and no second batch is sent', async () => {
    const db = fakeDb();
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    const queue = new FakeQueue();
    const env = testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue });
    const first = await postRun(env, authHeaders());
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { runId: string };
    const second = await postRun(env, authHeaders());
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: 'insights_followers_cycle_in_flight',
    });
    expect(queue.sent).toHaveLength(1);
    expect(db.insights_runs).toHaveLength(1);
    expect(db.insights_runs[0]!.id).toBe(firstBody.runId);
    expect(db.insights_runs[0]!.status).toBe('running');
  });

  it('scheduled cron skips while a manual run is in flight (the run record is the guard, shared across isolates)', async () => {
    const db = fakeDb();
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    // A live run seeded directly: the cron sees it in the run
    // table without any in-flight boolean on this isolate.
    db.insights_runs.push({
      id: 'run-live',
      trigger: 'manual',
      status: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      chunks_total: 1,
      chunks_done: 0,
      chunks_failed: 0,
      scanned: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      adu_updated: 0,
      mirrors_updated: 0,
    });
    const queue = new FakeQueue();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handleScheduled(
        { cron: '0 22 * * *', scheduledTime: Date.now() } as never,
        testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue }) as never,
        undefined,
        { db: fakeClient(db) as never, now: new Date() }
      );
      expect(queue.sent).toHaveLength(0);
      expect(db.insights_runs).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('already in flight')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('scheduled cron enqueues the chunks when no run is live', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const queue = new FakeQueue();
    await handleScheduled(
      { cron: '0 22 * * *', scheduledTime: Date.now() } as never,
      testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue }) as never,
      undefined,
      { db: fakeClient(db) as never, now: new Date() }
    );
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toHaveLength(2);
    expect(queue.sent[0]![0]!.body.chunkIndex).toBe(0);
    expect(queue.sent[0]![1]!.body.offset).toBe(200);
    expect(db.insights_runs).toHaveLength(1);
    expect(db.insights_runs[0]!.trigger).toBe('cron');
    expect(db.insights_runs[0]!.status).toBe('running');
    expect(db.insights_runs[0]!.chunks_total).toBe(2);
  });

  it('start throw → 503; no run row sticks, so the next call can start a new run', async () => {
    const db = fakeDb();
    db.throwOnScan = true;
    await seedDestination(db);
    vi.stubGlobal('fetch', async () => graphOk(5000));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postRun(
        testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: new FakeQueue() }),
        authHeaders()
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'insights_followers_unavailable',
      });
      expect(db.insights_runs).toHaveLength(0);
      // The failed start left no live run: the next call starts cleanly.
      db.throwOnScan = false;
      const queue = new FakeQueue();
      const second = await postRun(
        testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue }),
        authHeaders()
      );
      expect(second.status).toBe(202);
      expect(queue.sent).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('enqueue throw → 500 and the run is marked failed', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const queue = new FakeQueue();
    queue.throwOnSend = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postRun(
        testEnv(fakeClient(db), { INSIGHTS_CYCLE_QUEUE: queue }),
        authHeaders()
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'insights_followers_enqueue_failed',
      });
      expect(queue.sent).toHaveLength(0);
      expect(db.insights_runs).toHaveLength(1);
      expect(db.insights_runs[0]!.status).toBe('failed');
      expect(db.insights_runs[0]!.finished_at).not.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('missing queue binding → 500 and the run is marked failed', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await postRun(testEnv(fakeClient(db)), authHeaders());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'insights_followers_enqueue_failed',
      });
      expect(db.insights_runs).toHaveLength(1);
      expect(db.insights_runs[0]!.status).toBe('failed');
      expect(db.insights_runs[0]!.finished_at).not.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('db unconfigured → 503', async () => {
    vi.stubGlobal('fetch', async () => graphOk(5000));
    const env = {
      TOKEN_ENCRYPTION_KEY: MASTER_KEY,
      INSIGHTS_MANUAL_RUN_TOKEN: TEST_TOKEN,
    } as unknown as Env;
    const res = await postRun(env, authHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'insights_followers_unavailable',
    });
  });

  it('master key missing → 503', async () => {
    const db = fakeDb();
    vi.stubGlobal('fetch', async () => graphOk(5000));
    const env = testEnv(fakeClient(db), {
      TOKEN_ENCRYPTION_KEY: undefined,
    });
    const res = await postRun(env, authHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'insights_followers_unavailable',
    });
  });

  it('GET on the path → 404 (POST only)', async () => {
    const db = fakeDb();
    vi.stubGlobal('fetch', async () => graphOk(5000));
    const res = await postRun(
      testEnv(fakeClient(db)),
      authHeaders(),
      'GET'
    );
    expect(res.status).toBe(404);
    expect(db.updates).toEqual([]);
  });
});
