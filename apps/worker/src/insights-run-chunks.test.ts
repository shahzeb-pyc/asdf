/**
 * Spec 240 — chunked insights runs: run record, chunk processor,
 * finisher election, DLQ path, message validation.
 *
 * Tested against a small fake Supabase client (same shape as the
 * tick test's fake, extended with the run tables, insert, count
 * queries and the partial-unique guard) with REAL token encryption
 * and an injected live-count fetch — no real database, no real
 * Graph calls, no real queue.
 *
 * - startInsightsRun creates one header + one chunk row per
 *   200-row page; a second start while one is live returns null.
 * - A stale run (> 2h, status running) is superseded loudly and
 *   the next start proceeds; a fresh live run is not superseded.
 * - A chunk processes only its own offset page; the run aggregates
 *   the chunk counters; the finished line is logged exactly once.
 * - Completing the same chunk twice counts once; a DLQ-marked chunk
 *   finishes the run with failed > 0, logged loudly; marking an
 *   already-done chunk failed is a no-op.
 * - A finish that throws once is retried — on redelivery of a done
 *   chunk, and inside the DLQ mark-failed path — and the run finishes
 *   exactly once.
 * - Malformed messages fail validation at enqueue and at consume.
 * - A zero-row scan finishes immediately, never sticks.
 *
 * Spec 241 — stored analytics ride the same chunk processor (one
 * analytics fetch per page, same 100+ stored-followers gate):
 * - One fetch fills all four columns on the destination row, its ADU
 *   configs and its mirrors; a second run wholesale-replaces them.
 * - A failed analytics fetch leaves the stored columns byte-identical
 *   (followers still update); a no-insights token skips the page.
 * - Pages under 100 stored followers are skipped with no Graph call.
 * - Empty location data keeps the old locations column and still
 *   writes the other three. A followers failure never blocks
 *   analytics, and an analytics failure never blocks followers.
 * - The pre-241 chunk tests stub the analytics fetch to skip
 *   (noAnalytics), so they never hit the Graph endpoint through the
 *   chunk's default.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { encryptToken } from '@fbuploadpro/contracts';
import {
  INSIGHTS_CHUNK_SIZE,
  InsightsChunkMessageSchema,
  markInsightsChunkFailed,
  runInsightsFollowersChunk,
  startInsightsRun,
} from './insights-run-chunks.js';
import { handleQueueBatch } from './consumers.js';
import {
  InsightsGraphError,
  InsightsNoDataError,
  type AnalyticsColumnValues,
} from './insights-followers-tick.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const NOW = new Date('2026-11-10T22:00:00.000Z'); // 03:00 PKT
const NOW_ISO = NOW.toISOString();

/**
 * The pre-241 chunk tests run the followers concern only: the
 * analytics fetch is stubbed to skip (no-insights), so no test ever
 * hits the real Graph endpoint through the chunk's default.
 */
const noAnalytics = async (): Promise<AnalyticsColumnValues> => {
  throw new InsightsNoDataError('test stub: analytics out of scope');
};

// ---------------------------------------------------------------------------
// Spec 241 — stored analytics
// ---------------------------------------------------------------------------

function cannedDay(date: string, mediaViews: number) {
  return {
    date,
    media_views: mediaViews,
    unique_viewers: 50,
    profile_views: 10,
    engagement: 20,
    video_views: 80,
    video_view_time_ms: 60_000,
    total_actions: 5,
    new_follows: 3,
    unfollows: 1,
    video_complete_views_30s: 40,
  };
}

function cannedAnalytics(overrides: Partial<AnalyticsColumnValues> = {}): AnalyticsColumnValues {
  const day = cannedDay('2026-11-09', 100);
  return {
    analytics1d: { ...day },
    analytics7d: { days: [{ ...day }], unique_viewers_7d: 300 },
    analytics28d: { days: [{ ...day }], unique_viewers_28d: 1200 },
    locations: {
      countries: [{ country: 'PK', followers: 900 }],
      cities: [{ city: 'Karachi', followers: 400 }],
    },
    ...overrides,
  };
}

type Row = Record<string, unknown>;

interface FakeDb {
  destinations: Row[];
  adu_configs: Row[];
  mirrors: Row[];
  insights_runs: Row[];
  insights_run_chunks: Row[];
  /** Every update the code applied (table + patch + matched rows). */
  updates: Array<{ table: string; patch: Row; count: number }>;
  /**
   * One-shot transient DB failure: the next operation on this table
   * of this kind resolves with an error instead of succeeding, then
   * clears itself. Used to prove the finish-retry paths recover.
   */
  failNext: { table: string; op: 'select' | 'update' | 'insert' } | null;
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
    if (this.table === 'mirrors') return this.db.mirrors;
    if (this.table === 'insights_runs') return this.db.insights_runs;
    return this.db.insights_run_chunks;
  }

  private matched(): Row[] {
    return this.tableRows().filter((r) => this.filters.every((f) => f(r)));
  }

  then(
    resolve: (value: {
      data: Row[] | Row | null;
      error: unknown;
      count: number | null;
    }) => void
  ): void {
    // One-shot injected failure (see FakeDb.failNext): fires on the
    // next matching operation, then clears itself.
    const fail = this.db.failNext;
    if (fail && fail.table === this.table) {
      const op = this.updatePatch
        ? 'update'
        : this.insertRows
          ? 'insert'
          : 'select';
      if (fail.op === op) {
        this.db.failNext = null;
        resolve({
          data: null,
          error: { code: 'XX000', message: 'injected transient DB failure' },
          count: null,
        });
        return;
      }
    }
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
    failNext: null,
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

function seedRun(db: FakeDb, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'run-seed',
    trigger: 'manual',
    status: 'running',
    started_at: NOW_ISO,
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
    ...overrides,
  };
  db.insights_runs.push(row);
  return row;
}

function seedChunk(db: FakeDb, overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'chunk-seed',
    run_id: 'run-seed',
    chunk_index: 0,
    offset: 0,
    limit: INSIGHTS_CHUNK_SIZE,
    status: 'pending',
    attempts: 0,
    scanned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    adu_updated: 0,
    mirrors_updated: 0,
    updated_at: NOW_ISO,
    ...overrides,
  };
  db.insights_run_chunks.push(row);
  return row;
}

function finishedLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => String(call[0] ?? ''))
    .filter((line) => line.includes('run finished'));
}

describe('startInsightsRun', () => {
  it('creates one header + one chunk row per 200-row page; a second start returns null', async () => {
    const db = fakeDb();
    for (let i = 0; i < 450; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }

    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(started).not.toBeNull();
    expect(started!.chunks).toEqual([
      { runId: started!.runId, chunkIndex: 0, offset: 0, limit: 200 },
      { runId: started!.runId, chunkIndex: 1, offset: 200, limit: 200 },
      { runId: started!.runId, chunkIndex: 2, offset: 400, limit: 200 },
    ]);
    expect(db.insights_runs).toHaveLength(1);
    const header = db.insights_runs[0]!;
    expect(header.trigger).toBe('manual');
    expect(header.status).toBe('running');
    expect(header.chunks_total).toBe(3);
    expect(db.insights_run_chunks).toHaveLength(3);

    const second = await startInsightsRun(fakeClient(db) as never, 'cron', NOW);
    expect(second).toBeNull();
    expect(db.insights_runs).toHaveLength(1);
  });

  it('a stale run is superseded loudly and the next start proceeds; a fresh live run is not superseded', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const stale = seedRun(db, {
      id: 'run-stale',
      started_at: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const started = await startInsightsRun(fakeClient(db) as never, 'cron', NOW);
      expect(started).not.toBeNull();
      expect(stale.status).toBe('stale');
      expect(stale.finished_at).toBe(NOW_ISO);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('superseded stale live run run-stale')
      );
      expect(db.insights_runs).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }

    // A fresh live run blocks the next start instead of being superseded.
    const blocked = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(blocked).toBeNull();
    expect(db.insights_runs).toHaveLength(2);
  });

  it('a zero-row scan finishes immediately with an empty finished line, never sticks', async () => {
    const db = fakeDb();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const started = await startInsightsRun(fakeClient(db) as never, 'cron', NOW);
      expect(started).not.toBeNull();
      expect(started!.chunks).toEqual([]);
      const header = db.insights_runs[0]!;
      expect(header.status).toBe('finished');
      expect(header.finished_at).toBe(NOW_ISO);
      expect(header.chunks_total).toBe(0);
      expect(finishedLines(infoSpy)).toHaveLength(1);
      expect(finishedLines(infoSpy)[0]).toContain('chunks_total=0');
    } finally {
      infoSpy.mockRestore();
    }
    // The finished run never blocks the next start.
    const next = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(next).not.toBeNull();
    expect(next!.chunks).toEqual([]);
  });
});

describe('runInsightsFollowersChunk', () => {
  it('a chunk processes only its own offset page; the run aggregates and finishes once', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(started!.chunks).toHaveLength(2);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const first = await runInsightsFollowersChunk(
        fakeClient(db) as never,
        MASTER_KEY,
        started!.runId,
        0,
        0,
        INSIGHTS_CHUNK_SIZE,
        NOW,
        { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
      );
      expect(first.scanned).toBe(200);
      expect(first.updated).toBe(200);
      // The lexicographically-last row ('dest-99' — ids sort as
      // strings, so 'dest-200' sits inside the first page) is the
      // tail of the scan: untouched by chunk 0.
      const last = db.destinations.find((r) => r.id === 'dest-99')!;
      expect((last.metadata as Row).current_followers).toBe(1200);
      // The run is still live after the first chunk.
      expect(db.insights_runs[0]!.status).toBe('running');

      const second = await runInsightsFollowersChunk(
        fakeClient(db) as never,
        MASTER_KEY,
        started!.runId,
        1,
        200,
        INSIGHTS_CHUNK_SIZE,
        NOW,
        { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
      );
      expect(second.scanned).toBe(1);
      expect(second.updated).toBe(1);
      expect((last.metadata as Row).current_followers).toBe(5000);

      const header = db.insights_runs[0]!;
      expect(header.status).toBe('finished');
      expect(header.scanned).toBe(201);
      expect(header.updated).toBe(201);
      expect(header.chunks_done).toBe(2);
      expect(header.chunks_failed).toBe(0);
      expect(finishedLines(infoSpy)).toHaveLength(1);
      expect(finishedLines(infoSpy)[0]).toContain(`runId=${started!.runId}`);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('two chunks completing concurrently elect exactly one finisher', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const [first, second] = await Promise.all([
        runInsightsFollowersChunk(
          fakeClient(db) as never,
          MASTER_KEY,
          started!.runId,
          0,
          0,
          INSIGHTS_CHUNK_SIZE,
          NOW,
          { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
        ),
        runInsightsFollowersChunk(
          fakeClient(db) as never,
          MASTER_KEY,
          started!.runId,
          1,
          200,
          INSIGHTS_CHUNK_SIZE,
          NOW,
          { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
        ),
      ]);
      expect(first.scanned + second.scanned).toBe(201);
      expect(db.insights_runs[0]!.status).toBe('finished');
      expect(db.insights_runs[0]!.updated).toBe(201);
      expect(finishedLines(infoSpy)).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('completing the same chunk twice counts once', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    let fetches = 0;
    const fetchFollowers = async () => {
      fetches += 1;
      return 5000;
    };
    const args = [
      fakeClient(db) as never,
      MASTER_KEY,
      started!.runId,
      0,
      0,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      { fetchFollowers, fetchAnalytics: noAnalytics },
    ] as const;
    const first = await runInsightsFollowersChunk(...args);
    expect(first.updated).toBe(200);
    expect(fetches).toBe(200);
    const second = await runInsightsFollowersChunk(...args);
    expect(second).toEqual({
      scanned: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      aduUpdated: 0,
      mirrorsUpdated: 0,
    });
    expect(fetches).toBe(200);

    // The run totals still count the chunk once after the other chunk lands.
    await runInsightsFollowersChunk(
      fakeClient(db) as never,
      MASTER_KEY,
      started!.runId,
      1,
      200,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      { fetchFollowers, fetchAnalytics: noAnalytics }
    );
    expect(db.insights_runs[0]!.scanned).toBe(201);
    expect(db.insights_runs[0]!.updated).toBe(201);
    expect(db.insights_runs[0]!.chunks_done).toBe(2);
  });

  it('a chunk for a missing run throws; a chunk for a finished run is a no-op', async () => {
    const db = fakeDb();
    await seedDestination(db);
    await expect(
      runInsightsFollowersChunk(
        fakeClient(db) as never,
        MASTER_KEY,
        '00000000-0000-0000-0000-000000000000',
        0,
        0,
        INSIGHTS_CHUNK_SIZE,
        NOW,
        { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
      )
    ).rejects.toThrow('missing run');

    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    await runInsightsFollowersChunk(
      fakeClient(db) as never,
      MASTER_KEY,
      started!.runId,
      0,
      0,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
    );
    expect(db.insights_runs[0]!.status).toBe('finished');
    const again = await runInsightsFollowersChunk(
      fakeClient(db) as never,
      MASTER_KEY,
      started!.runId,
      0,
      0,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
    );
    expect(again.updated).toBe(0);
  });

  it('a finish that throws once is retried on redelivery and the run finishes exactly once', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(started!.chunks).toHaveLength(1);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // The finish's conditional UPDATE on insights_runs is the only
      // update to that table in the chunk path — fail it once, so the
      // first attempt throws after the chunk is already marked done.
      db.failNext = { table: 'insights_runs', op: 'update' };
      await expect(
        runInsightsFollowersChunk(
          fakeClient(db) as never,
          MASTER_KEY,
          started!.runId,
          0,
          0,
          INSIGHTS_CHUNK_SIZE,
          NOW,
          { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
        )
      ).rejects.toThrow('finish update failed');
      // The chunk is done, but the run is stuck live with no finished line.
      expect(db.insights_run_chunks[0]!.status).toBe('done');
      expect(db.insights_runs[0]!.status).toBe('running');
      expect(finishedLines(infoSpy)).toHaveLength(0);

      // Redelivery: the chunk is already done, so no page is
      // re-processed — but the finish is re-attempted, and the run
      // finishes with exactly one finished line.
      const redelivered = await runInsightsFollowersChunk(
        fakeClient(db) as never,
        MASTER_KEY,
        started!.runId,
        0,
        0,
        INSIGHTS_CHUNK_SIZE,
        NOW,
        { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
      );
      expect(redelivered.updated).toBe(0);
      const header = db.insights_runs[0]!;
      expect(header.status).toBe('finished');
      expect(header.scanned).toBe(1);
      expect(header.updated).toBe(1);
      expect(header.chunks_done).toBe(1);
      expect(header.chunks_failed).toBe(0);
      expect(finishedLines(infoSpy)).toHaveLength(1);
      expect(finishedLines(infoSpy)[0]).toContain(`runId=${started!.runId}`);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('markInsightsChunkFailed', () => {
  it('a DLQ-marked chunk finishes the run with failed > 0, logged loudly; an already-done chunk is a no-op', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    await runInsightsFollowersChunk(
      fakeClient(db) as never,
      MASTER_KEY,
      started!.runId,
      0,
      0,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      { fetchFollowers: async () => 5000, fetchAnalytics: noAnalytics }
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await markInsightsChunkFailed(
        fakeClient(db) as never,
        started!.runId,
        1,
        NOW
      );
      const header = db.insights_runs[0]!;
      expect(header.status).toBe('finished');
      expect(header.chunks_done).toBe(1);
      expect(header.chunks_failed).toBe(1);
      expect(header.scanned).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('run finished')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('chunks_failed=1')
      );
    } finally {
      errorSpy.mockRestore();
    }

    // Marking the already-done chunk failed changes nothing.
    await markInsightsChunkFailed(fakeClient(db) as never, started!.runId, 0, NOW);
    expect(db.insights_runs[0]!.chunks_failed).toBe(1);
    expect(db.insights_runs[0]!.chunks_done).toBe(1);
  });

  it('a finish that throws once is retried and the run still finishes with failed > 0', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    expect(started!.chunks).toHaveLength(1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Fail the finish's conditional UPDATE once: the retry inside
      // markInsightsChunkFailed must recover without a redelivery
      // (the DLQ handler acks in a finally block, so there is none).
      db.failNext = { table: 'insights_runs', op: 'update' };
      await markInsightsChunkFailed(
        fakeClient(db) as never,
        started!.runId,
        0,
        NOW
      );
      const header = db.insights_runs[0]!;
      expect(header.status).toBe('finished');
      expect(header.chunks_done).toBe(0);
      expect(header.chunks_failed).toBe(1);
      expect(header.scanned).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('run finished')
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('chunks_failed=1')
      );
      // The failed finish attempt was logged loudly on its way to the retry.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('finish attempt 1/3'),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('InsightsChunkMessageSchema', () => {
  it('accepts a well-formed chunk message and rejects malformed ones', () => {
    const good = {
      runId: '00000000-0000-4000-8000-000000000000',
      chunkIndex: 0,
      offset: 0,
      limit: 200,
    };
    expect(InsightsChunkMessageSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, runId: 'not-a-uuid' },
      { ...good, chunkIndex: -1 },
      { ...good, offset: -200 },
      { ...good, limit: 0 },
      { ...good, limit: 201 },
      { ...good, extra: 'nope' },
      { runId: good.runId, chunkIndex: 0, offset: 0 },
    ]) {
      expect(InsightsChunkMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('a malformed message on the insights queue throws and processes nothing', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    const ack = vi.fn();
    const batch = {
      queue: 'insights-cycle',
      messages: [
        {
          id: 'msg-bad',
          body: { runId: 'not-a-uuid', chunkIndex: 0, offset: 0, limit: 200 },
          ack,
          attempts: 1,
        },
      ],
    };
    await expect(
      handleQueueBatch(batch as never, {
        db: fakeClient(db) as never,
        registry: {} as never,
        masterKey: MASTER_KEY,
        env: {},
      })
    ).rejects.toThrow('Malformed insights chunk message body');
    expect(ack).not.toHaveBeenCalled();
    expect(db.insights_runs[0]!.status).toBe('running');
    expect(started!.runId).toBe(db.insights_runs[0]!.id);
  });

  it('a malformed message on the insights DLQ is acked loudly without touching the run', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ack = vi.fn();
    try {
      const batch = {
        queue: 'insights-cycle-dlq',
        messages: [
          { id: 'msg-bad', body: { nope: true }, ack, attempts: 4 },
        ],
      };
      await handleQueueBatch(batch as never, {
        db: fakeClient(db) as never,
        registry: {} as never,
        env: {},
      });
      expect(ack).toHaveBeenCalledTimes(1);
      expect(db.insights_run_chunks[0]!.status).toBe('pending');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a DLQ batch marks the chunk failed and finishes the run', async () => {
    const db = fakeDb();
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    const started = await startInsightsRun(fakeClient(db) as never, 'manual', NOW);
    const ack = vi.fn();
    const batch = {
      queue: 'insights-cycle-dlq',
      messages: [
        {
          id: 'msg-dlq',
          body: {
            runId: started!.runId,
            chunkIndex: 0,
            offset: 0,
            limit: 200,
          },
          ack,
          attempts: 4,
        },
      ],
    };
    await handleQueueBatch(batch as never, {
      db: fakeClient(db) as never,
      registry: {} as never,
      env: {},
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(db.insights_run_chunks[0]!.status).toBe('failed');
    expect(db.insights_runs[0]!.status).toBe('finished');
    expect(db.insights_runs[0]!.chunks_failed).toBe(1);
  });
});

describe('runInsightsFollowersChunk — spec 241 analytics', () => {
  const runChunk = (
    db: FakeDb,
    runId: string,
    deps: Parameters<typeof runInsightsFollowersChunk>[7]
  ) =>
    runInsightsFollowersChunk(
      fakeClient(db) as never,
      MASTER_KEY,
      runId,
      0,
      0,
      INSIGHTS_CHUNK_SIZE,
      NOW,
      deps
    );

  // The finisher logs the finished line when the run completes.
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('fills all four columns on destinations, adu_configs and mirrors from one fetch', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db);
    seedAduConfig(db);
    seedMirror(db);
    const columns = cannedAnalytics();
    let fetchCalls = 0;
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 1250,
      fetchAnalytics: async () => {
        fetchCalls += 1;
        return columns;
      },
    });
    expect(fetchCalls).toBe(1);
    // Followers still update alongside analytics.
    expect(result.updated).toBe(1);
    const dest = db.destinations[0]!;
    expect(dest.analytics_1d).toEqual(columns.analytics1d);
    expect(dest.analytics_7d).toEqual(columns.analytics7d);
    expect(dest.analytics_28d).toEqual(columns.analytics28d);
    expect(dest.analytics_locations).toEqual(columns.locations);
    expect((dest.metadata as Record<string, unknown>).analytics_updated_at).toBe(NOW_ISO);
    // Regression: the analytics write builds on the metadata the
    // followers write stored — it must NOT clobber current_followers
    // back to the stale snapshot. The fake mutates rows in place, so
    // the row alone cannot prove it; the patch below is the proof.
    expect((dest.metadata as Record<string, unknown>).current_followers).toBe(1250);
    expect((dest.metadata as Record<string, unknown>).followers_updated_at).toBe(NOW_ISO);
    // Pin it at the write itself, not just the row: the destinations
    // analytics update patch must carry the followers write's
    // current_followers (1250), never the stale snapshot (1200).
    const analyticsPatch = db.updates.find(
      (u) => u.table === 'destinations' && u.patch.analytics_1d !== undefined
    );
    expect(analyticsPatch).toBeDefined();
    expect(
      (analyticsPatch!.patch.metadata as Record<string, unknown>).current_followers
    ).toBe(1250);
    const adu = db.adu_configs[0]!;
    expect(adu.analytics_1d).toEqual(columns.analytics1d);
    expect(adu.analytics_locations).toEqual(columns.locations);
    expect(adu.analytics_updated_at).toBe(NOW_ISO);
    const mirror = db.mirrors[0]!;
    expect(mirror.analytics_1d).toEqual(columns.analytics1d);
    expect(mirror.analytics_locations).toEqual(columns.locations);
    expect(mirror.analytics_updated_at).toBe(NOW_ISO);
  });

  it('a second run wholesale-replaces the columns (no preserved days)', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db);
    const first = cannedAnalytics();
    const second = cannedAnalytics({
      analytics1d: cannedDay('2026-11-09', 777),
      analytics7d: { days: [cannedDay('2026-11-09', 777)], unique_viewers_7d: 999 },
      analytics28d: { days: [cannedDay('2026-11-09', 777)], unique_viewers_28d: 888 },
      locations: {
        countries: [{ country: 'US', followers: 10 }],
        cities: [{ city: 'Lahore', followers: 5 }],
      },
    });
    let current = first;
    const run = (runId: string) =>
      runChunk(db, runId, {
        fetchFollowers: async () => 1250,
        fetchAnalytics: async () => current,
      });
    await run('run-seed');
    current = second;
    seedRun(db, { id: 'run-seed-2' });
    seedChunk(db, { id: 'chunk-seed-2', run_id: 'run-seed-2' });
    await run('run-seed-2');
    const dest = db.destinations[0]!;
    expect(dest.analytics_1d).toEqual(second.analytics1d);
    expect(dest.analytics_7d).toEqual(second.analytics7d);
    expect(dest.analytics_28d).toEqual(second.analytics28d);
    expect(dest.analytics_locations).toEqual(second.locations);
    // The first run's values are gone, not merged.
    expect((dest.analytics_1d as Record<string, unknown>).media_views).toBe(777);
    expect((dest.analytics_locations as Record<string, unknown[]>).countries).toEqual([
      { country: 'US', followers: 10 },
    ]);
  });

  it('a failed analytics fetch leaves the stored columns byte-identical (followers still update)', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    const old = cannedAnalytics();
    await seedDestination(db, {
      metadata: {
        starting_followers: 1000,
        current_followers: 1200,
        analytics_updated_at: '2026-11-09T22:00:00.000Z',
      },
      analytics_1d: old.analytics1d,
      analytics_7d: old.analytics7d,
      analytics_28d: old.analytics28d,
      analytics_locations: old.locations,
    });
    seedAduConfig(db, {
      analytics_1d: old.analytics1d,
      analytics_locations: old.locations,
      analytics_updated_at: '2026-11-09T22:00:00.000Z',
    });
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 1250,
      fetchAnalytics: async () => {
        throw new InsightsGraphError('Graph insights call failed (HTTP 500)');
      },
    });
    // The followers concern still succeeded.
    expect(result.updated).toBe(1);
    const dest = db.destinations[0]!;
    expect(dest.analytics_1d).toEqual(old.analytics1d);
    expect(dest.analytics_7d).toEqual(old.analytics7d);
    expect(dest.analytics_28d).toEqual(old.analytics28d);
    expect(dest.analytics_locations).toEqual(old.locations);
    expect((dest.metadata as Record<string, unknown>).analytics_updated_at).toBe(
      '2026-11-09T22:00:00.000Z'
    );
    expect(db.adu_configs[0]!.analytics_1d).toEqual(old.analytics1d);
  });

  it('a no-insights token skips the page and keeps the old columns', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    const old = cannedAnalytics();
    await seedDestination(db, {
      analytics_1d: old.analytics1d,
      analytics_locations: old.locations,
    });
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 1250,
      fetchAnalytics: async () => {
        throw new InsightsNoDataError('no insights data');
      },
    });
    expect(result.updated).toBe(1);
    expect(db.destinations[0]!.analytics_1d).toEqual(old.analytics1d);
    expect(db.destinations[0]!.analytics_locations).toEqual(old.locations);
  });

  it('a page under 100 stored followers is skipped with no Graph call', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db, {
      metadata: { starting_followers: 10, current_followers: 50 },
    });
    let fetchCalls = 0;
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 55,
      fetchAnalytics: async () => {
        fetchCalls += 1;
        return cannedAnalytics();
      },
    });
    expect(fetchCalls).toBe(0);
    expect(result.updated).toBe(1);
    expect(db.destinations[0]!.analytics_1d).toBeUndefined();
  });

  it('a page with no stored follower count is skipped, never guessed', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db, { metadata: { starting_followers: 0 } });
    let fetchCalls = 0;
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 500,
      fetchAnalytics: async () => {
        fetchCalls += 1;
        return cannedAnalytics();
      },
    });
    expect(fetchCalls).toBe(0);
    expect(result.updated).toBe(1);
  });

  it('empty locations keep the old locations column and still write the other three', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    const oldLocations = {
      countries: [{ country: 'PK', followers: 900 }],
      cities: [{ city: 'Karachi', followers: 400 }],
    };
    await seedDestination(db, { analytics_locations: oldLocations });
    const columns = cannedAnalytics({ locations: null });
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 1250,
      fetchAnalytics: async () => columns,
    });
    expect(result.updated).toBe(1);
    const dest = db.destinations[0]!;
    expect(dest.analytics_1d).toEqual(columns.analytics1d);
    expect(dest.analytics_7d).toEqual(columns.analytics7d);
    expect(dest.analytics_28d).toEqual(columns.analytics28d);
    expect(dest.analytics_locations).toEqual(oldLocations);
  });

  it('a followers failure does not block analytics', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db);
    const columns = cannedAnalytics();
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => {
        throw new InsightsGraphError('Graph followers fetch failed: HTTP 500', 500);
      },
      fetchAnalytics: async () => columns,
    });
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
    expect(db.destinations[0]!.analytics_1d).toEqual(columns.analytics1d);
  });

  it('an analytics failure does not block followers', async () => {
    const db = fakeDb();
    seedRun(db);
    seedChunk(db);
    await seedDestination(db);
    const result = await runChunk(db, 'run-seed', {
      fetchFollowers: async () => 1250,
      fetchAnalytics: async () => {
        throw new InsightsGraphError('Graph insights call failed (HTTP 500)');
      },
    });
    expect(result.updated).toBe(1);
    expect(db.destinations[0]!.analytics_1d).toBeUndefined();
  });
});
