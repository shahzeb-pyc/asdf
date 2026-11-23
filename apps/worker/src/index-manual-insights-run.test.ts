/**
 * Spec 163 + spec 240 — manual insights-followers run endpoint.
 *
 * Drives the worker's `fetch` export directly (the first tests to do
 * so — the handler previously answered only /health). Fake Supabase
 * client (same shape as the tick test's fake) + stubbed global fetch
 * for Graph reads. The bearer token here is a dummy test string,
 * never a real secret.
 *
 * Spec 240: the handler answers 202 immediately and runs the cycle
 * in the background via ctx.waitUntil — it never awaits the cycle
 * inside the request (the old code did, and died at ~271s once the
 * page count doubled). The cycle summary lives only in the worker
 * log now; the 202 body carries no counters.
 *
 * - No/wrong/missing-secret token → 401 and the cycle never runs:
 *   zero DB calls, zero Graph calls.
 * - Correct token → 202 accepted; the cycle runs in the background
 *   (via the ctx's waitUntil) and completes after the response.
 * - A second call while one is in flight → 409; the first run
 *   completes and the cycle ran once.
 * - Cycle throw → 202 accepted; the failure is logged and the
 *   guard clears, so the next call can start a new run.
 * - DB/master-key missing → 503. No waitUntil on the context →
 *   503 (fail loud: without it the run could die with the
 *   response). GET on the path → 404 (POST only).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '@fbuploadpro/contracts';
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

  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]));
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

  private tableRows(): Row[] {
    if (this.table === 'destinations') return this.db.destinations;
    if (this.table === 'adu_configs') return this.db.adu_configs;
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
    resolve({ data: matched, error: null, count: null });
  }
}

function fakeDb(): FakeDb {
  return {
    destinations: [],
    adu_configs: [],
    mirrors: [],
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

interface CapturedCtx {
  ctx: { waitUntil: (p: Promise<unknown>) => void };
  promises: Array<Promise<unknown>>;
}

function captureCtx(): CapturedCtx {
  const promises: Array<Promise<unknown>> = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        promises.push(p);
      },
    },
    promises,
  };
}

function postRun(
  env: Env,
  headers: Record<string, string> = {},
  method = 'POST',
  ctx?: { waitUntil: (p: Promise<unknown>) => void }
): Promise<Response> {
  return worker.fetch(
    new Request(URL, { method, headers }),
    env,
    (ctx ?? undefined) as never
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

  it('correct token → 202 accepted; cycle runs in the background and completes', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    const adu = seedAduConfig(db);
    const mirror = seedMirror(db);
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return gate;
    });
    const captured = captureCtx();
    const res = await postRun(
      testEnv(fakeClient(db)),
      authHeaders(),
      'POST',
      captured.ctx
    );
    try {
      // The response arrives while the cycle is still blocked on the
      // Graph fetch: 202, no counters (the cycle hasn't run yet), and
      // no writes yet — the old code would still be awaiting here.
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: 'accepted',
        message: 'Insights followers run started in the background.',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchCalls).toBe(1);
      expect(db.updates).toEqual([]);
      expect((dest.metadata as Row).current_followers).toBe(1200);
    } finally {
      // Always release the gate + settle the background cycle, or a
      // failure here would leak the in-flight flag into later tests.
      release(graphOk(5000));
      await Promise.all(captured.promises);
    }
    expect(fetchCalls).toBe(1);
    expect((dest.metadata as Row).starting_followers).toBe(1000);
    expect((dest.metadata as Row).current_followers).toBe(5000);
    expect(adu.starting_followers).toBe(1000);
    expect(adu.current_followers).toBe(5000);
    expect(mirror.starting_followers).toBe(5000);
    expect(mirror.current_followers).toBe(5000);
  });

  it('second call while one is in flight → 409; first run completes, cycle ran once', async () => {
    const db = fakeDb();
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return gate;
    });
    const env = testEnv(fakeClient(db));
    const captured = captureCtx();
    const first = await postRun(env, authHeaders(), 'POST', captured.ctx);
    expect(first.status).toBe(202);
    // Let the first call's background cycle pass auth + scan and
    // block on the Graph fetch.
    await new Promise((r) => setTimeout(r, 50));
    try {
      const second = await postRun(env, authHeaders(), 'POST', captureCtx().ctx);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error: 'insights_followers_cycle_in_flight',
      });
    } finally {
      release(graphOk(5000));
      await Promise.all(captured.promises);
    }
    expect(fetchCalls).toBe(1);
  });

  it('scheduled cron skips while a manual run is in flight on the same isolate', async () => {
    const db = fakeDb();
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return gate;
    });
    const env = testEnv(fakeClient(db));
    const captured = captureCtx();
    const first = await postRun(env, authHeaders(), 'POST', captured.ctx);
    expect(first.status).toBe(202);
    // Let the manual run's background cycle pass auth + scan and
    // block on the Graph fetch.
    await new Promise((r) => setTimeout(r, 50));
    try {
      await handleScheduled(
        { cron: '0 22 * * *', scheduledTime: Date.now() } as never,
        { TOKEN_ENCRYPTION_KEY: MASTER_KEY } as never,
        undefined,
        { db: fakeClient(db) as never, now: new Date() }
      );
      // The cron did not start a second cycle: no extra Graph call,
      // no writes yet.
      expect(fetchCalls).toBe(1);
      expect(db.updates).toEqual([]);
    } finally {
      release(graphOk(5000));
      await Promise.all(captured.promises);
    }
    expect(fetchCalls).toBe(1);
  });

  it('cycle throw → 202 accepted; failure is logged and the guard clears', async () => {
    const db = fakeDb();
    db.throwOnScan = true;
    await seedDestination(db);
    vi.stubGlobal('fetch', async () => graphOk(5000));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const captured = captureCtx();
      const res = await postRun(
        testEnv(fakeClient(db)),
        authHeaders(),
        'POST',
        captured.ctx
      );
      expect(res.status).toBe(202);
      await Promise.all(captured.promises);
      expect(errorSpy).toHaveBeenCalledWith(
        '[Manual] insights followers cycle failed:',
        expect.anything()
      );
      // The guard cleared: a new run can start instead of 409ing.
      const again = captureCtx();
      const second = await postRun(
        testEnv(fakeClient(db)),
        authHeaders(),
        'POST',
        again.ctx
      );
      expect(second.status).toBe(202);
      await Promise.all(again.promises);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('no waitUntil on the context → 503 and the cycle never runs', async () => {
    const db = fakeDb();
    await seedDestination(db);
    let fetchCalls = 0;
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1;
      return graphOk(5000);
    });
    // No ctx at all: without waitUntil the run could die with the
    // response, so the handler fails loud instead of pretending.
    const res = await postRun(testEnv(fakeClient(db)), authHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'insights_followers_background_unavailable',
    });
    expect(db.updates).toEqual([]);
    expect(fetchCalls).toBe(0);
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
