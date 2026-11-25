/**
 * Spec 240 — the chunk processor moves each destination row through
 * the per-page followers tick. A chunk scans one 200-row page,
 * ordered by id; a run is one or more chunks.
 *
 * Tested against a small fake Supabase client (downgrade-tick style)
 * with REAL token encryption (encryptToken fixtures, decryptToken in
 * the tick) and an injected live-count fetch — no real database, no
 * real Graph calls.
 *
 * - Two runs with a changed live count move current, never starting
 *   (destinations metadata + ADU configs).
 * - A mirror's first run sets starting = current = live; the second
 *   run moves current only.
 * - A failed check (Graph error / 429 exhausted / decrypt failure)
 *   leaves the row byte-identical in all three stores.
 * - Facebook-only: an Instagram ADU config and a non-Facebook mirror
 *   are untouched, as are status-gated rows.
 * - The scan is bounded and paged (200 rows per page, ordered by
 *   id) — and an interleaved insert / updated_at churn between
 *   pages skips and duplicates nothing.
 * - A 429 backs off exponentially (1s, then 2s) and retries.
 * - fetchLiveFollowersFromGraph itself is unit-tested with a mock
 *   fetch: URL/fields/token, non-2xx (429 included), malformed
 *   bodies, and the abort timeout.
 *
 * Spec 241 — stored analytics (same fake, same real encryption):
 * - One analytics fetch per page fills all four columns on the
 *   destination row, its ADU configs and its mirrors; a second run
 *   wholesale-replaces them (no preserved days).
 * - A failed analytics fetch leaves the stored columns byte-identical
 *   (followers still update); a no-insights token skips the page.
 * - Pages under 100 stored followers are skipped with no Graph call.
 * - Empty location data keeps the old locations column and still
 *   writes the other three. A followers failure never blocks
 *   analytics, and an analytics failure never blocks followers.
 * - fetchPageAnalyticsFromGraph is unit-tested with a mock fetch:
 *   the 10 verified day metrics (dead metrics never requested),
 *   deduplicated week/days_28 unique viewers (never the daily sum),
 *   missing days as zero, no-insights, empty locations, non-2xx,
 *   and the 429 retry.
 */
import { describe, expect, it } from 'vitest';
import { encryptToken, InternalError } from '@fbuploadpro/contracts';
import {
  ANALYTICS_DAY_METRICS,
  fetchLiveFollowersFromGraph,
  fetchPageAnalyticsFromGraph,
  INSIGHTS_FOLLOWERS_PAGE_SIZE,
  InsightsGraphError,
  InsightsNoDataError,
  type AnalyticsColumnValues,
  type InsightsFollowersResult,
} from './insights-followers-tick.js';
import {
  runInsightsFollowersChunk,
  type InsightsChunkDeps,
  type InsightsRunDb,
} from './insights-run-chunks.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const NOW = new Date('2026-11-10T22:00:00.000Z'); // 03:00 PKT
const NOW_ISO = NOW.toISOString();

/**
 * The followers tests run the followers concern only: the
 * analytics fetch is stubbed to skip (no-insights), so no test ever
 * hits the real Graph endpoint through the chunk's default.
 */
const noAnalytics = async (): Promise<AnalyticsColumnValues> => {
  throw new InsightsNoDataError('test stub: analytics out of scope');
};

type Row = Record<string, unknown>;

interface FakeDb {
  destinations: Row[];
  adu_configs: Row[];
  mirrors: Row[];
  insights_runs: Row[];
  insights_run_chunks: Row[];
  /** Every range() call the tick made (pins the bounded scan). */
  ranges: Array<{ table: string; from: number | null; to: number | null }>;
  /** Every order() call the tick made (pins the stable scan order). */
  orders: Array<{ table: string; column: string; ascending: boolean }>;
  /** Every update the tick applied (table + patch + matched rows). */
  updates: Array<{ table: string; patch: Row; count: number }>;
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

  in(col: string, val: unknown[]): this {
    this.filters.push((r) => val.includes(r[col]));
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = opts?.ascending ?? true;
    this.db.orders.push({ table: this.table, column, ascending: this.orderAscending });
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
    if (this.table === 'insights_runs') return this.db.insights_runs;
    if (this.table === 'insights_run_chunks') return this.db.insights_run_chunks;
    return this.db.mirrors;
  }

  private matched(): Row[] {
    return this.tableRows().filter((r) => this.filters.every((f) => f(r)));
  }

  then(
    resolve: (value: { data: Row[] | null; error: unknown; count: number | null }) => void
  ): void {
    if (this.updatePatch) {
      const matched = this.matched();
      for (const row of matched) Object.assign(row, this.updatePatch);
      this.db.updates.push({ table: this.table, patch: this.updatePatch, count: matched.length });
      resolve({ data: matched, error: null, count: this.updateCountExact ? matched.length : null });
      return;
    }
    this.db.ranges.push({ table: this.table, from: this.rangeFrom, to: this.rangeTo });
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
    insights_runs: [],
    insights_run_chunks: [],
    ranges: [],
    orders: [],
    updates: [],
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

let runCounter = 0;

/**
 * One chunk of a run, seeded directly into the fake run tables
 * (startInsightsRun itself is covered by insights-run-chunks.test.ts).
 * Each call gets its own run row unless the caller passes a runId —
 * the paging tests share one run across two chunks.
 */
async function runCycle(
  db: FakeDb,
  overrides: InsightsChunkDeps = {},
  chunk: {
    runId?: string;
    chunkIndex?: number;
    offset?: number;
    limit?: number;
    totalChunks?: number;
  } = {}
): Promise<InsightsFollowersResult> {
  const runId = chunk.runId ?? `run-${++runCounter}`;
  const chunkIndex = chunk.chunkIndex ?? 0;
  const offset = chunk.offset ?? 0;
  const limit = chunk.limit ?? INSIGHTS_FOLLOWERS_PAGE_SIZE;
  let run = db.insights_runs.find((r) => r.id === runId);
  if (!run) {
    run = {
      id: runId,
      trigger: 'manual',
      status: 'running',
      started_at: NOW_ISO,
      finished_at: null,
      chunks_total: chunk.totalChunks ?? 1,
      chunks_done: 0,
      chunks_failed: 0,
      scanned: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      adu_updated: 0,
      mirrors_updated: 0,
    };
    db.insights_runs.push(run);
    // All chunk rows exist from the start — startInsightsRun inserts
    // them in one bulk insert, and the finisher counts done/failed
    // against the rows that exist, so a lazily-seeded second chunk
    // would finish the run after the first.
    const total = chunk.totalChunks ?? 1;
    for (let i = 0; i < total; i += 1) {
      db.insights_run_chunks.push({
        id: `chunk-${runId}-${i}`,
        run_id: runId,
        chunk_index: i,
        offset: i * limit,
        limit,
        status: 'pending',
        attempts: 0,
        scanned: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        adu_updated: 0,
        mirrors_updated: 0,
        updated_at: NOW_ISO,
      });
    }
  } else if (chunk.totalChunks !== undefined) {
    run.chunks_total = chunk.totalChunks;
  }
  return runInsightsFollowersChunk(
    fakeClient(db) as unknown as InsightsRunDb,
    MASTER_KEY,
    runId,
    chunkIndex,
    offset,
    limit,
    NOW,
    { fetchAnalytics: noAnalytics, ...overrides }
  );
}

describe('runInsightsFollowersChunk', () => {
  it('updates current, never starting, over two runs with a changed live count', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    const adu = seedAduConfig(db);
    seedMirror(db, { starting_followers: 900, current_followers: 1100 });
    const liveByRun = [5000, 5200];
    const fetchFollowers = async () => liveByRun.shift() ?? 5200;

    const first = await runCycle(db, { fetchFollowers });
    expect(first.updated).toBe(1);
    expect(first.failed).toBe(0);
    expect((dest.metadata as Row).starting_followers).toBe(1000);
    expect((dest.metadata as Row).current_followers).toBe(5000);
    expect((dest.metadata as Row).followers_updated_at).toBe(NOW_ISO);
    expect(adu.starting_followers).toBe(1000);
    expect(adu.current_followers).toBe(5000);
    expect(adu.followers_updated_at).toBe(NOW_ISO);

    const second = await runCycle(db, { fetchFollowers });
    expect(second.updated).toBe(1);
    expect((dest.metadata as Row).starting_followers).toBe(1000);
    expect((dest.metadata as Row).current_followers).toBe(5200);
    expect(adu.starting_followers).toBe(1000);
    expect(adu.current_followers).toBe(5200);
  });

  it('mirror first run sets starting = current = live; second run moves current only', async () => {
    const db = fakeDb();
    await seedDestination(db);
    const mirror = seedMirror(db);
    const liveByRun = [5000, 5100];
    const fetchFollowers = async () => liveByRun.shift() ?? 5100;

    await runCycle(db, { fetchFollowers });
    expect(mirror.starting_followers).toBe(5000);
    expect(mirror.current_followers).toBe(5000);
    expect(mirror.followers_updated_at).toBe(NOW_ISO);

    await runCycle(db, { fetchFollowers });
    expect(mirror.starting_followers).toBe(5000);
    expect(mirror.current_followers).toBe(5100);
    expect(mirror.followers_updated_at).toBe(NOW_ISO);
  });

  it('a failed Graph check leaves all three stores byte-identical', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    const adu = seedAduConfig(db);
    const mirror = seedMirror(db, { starting_followers: 900, current_followers: 1100 });
    const before = JSON.stringify({ dest, adu, mirror });
    // Only the three stores count here — the chunk processor still
    // writes its own run/chunk bookkeeping rows (claim, completion,
    // finisher) for a failed page; the stores themselves must see
    // no write at all.
    const storeUpdates = () =>
      db.updates.filter(
        (u) =>
          u.table === 'destinations' ||
          u.table === 'adu_configs' ||
          u.table === 'mirrors'
      ).length;
    const updatesBefore = storeUpdates();

    const result = await runCycle(db, {
      fetchFollowers: async () => {
        throw new InternalError('Graph checkpoint');
      },
    });
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
    expect(JSON.stringify({ dest, adu, mirror })).toBe(before);
    expect(storeUpdates()).toBe(updatesBefore);
  });

  it('a decrypt failure and an exhausted 429 both leave the row untouched', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db, { encrypted_destination_token: 'not-a-token' });
    const adu = seedAduConfig(db);
    const before = JSON.stringify({ dest, adu });

    const decryptResult = await runCycle(db, {
      fetchFollowers: async () => 5000,
    });
    expect(decryptResult.failed).toBe(1);
    expect(JSON.stringify({ dest, adu })).toBe(before);

    const dest2 = await seedDestination(db, {
      id: 'dest-b',
      external_destination_id: 'fb-page-b',
    });
    const sleeps: number[] = [];
    const rateLimited = await runCycle(db, {
      fetchFollowers: async () => {
        const err = new Error('rate limited') as Error & { status: number };
        err.status = 429;
        throw err;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // dest-a still fails decrypt (1) + dest-b exhausts its 429s (1).
    expect(rateLimited.failed).toBe(2);
    expect(dest2.metadata).toEqual({ starting_followers: 1000, current_followers: 1200 });
    // Two retries per failing page, backoff 1s then 2s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('a 429 retries with backoff and then succeeds', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    const adu = seedAduConfig(db);
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await runCycle(db, {
      fetchFollowers: async () => {
        attempts += 1;
        if (attempts <= 2) {
          const err = new Error('rate limited') as Error & { status: number };
          err.status = 429;
          throw err;
        }
        return 5000;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.updated).toBe(1);
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(adu.current_followers).toBe(5000);
    expect((dest.metadata as Row).current_followers).toBe(5000);
  });

  it('skips status-gated rows and never touches Instagram/Threads data', async () => {
    const db = fakeDb();
    const live = await seedDestination(db);
    // Gated destinations: disconnected, and active-but-checkpointed.
    const disconnected = await seedDestination(db, {
      id: 'dest-disc',
      external_destination_id: 'fb-page-disc',
      status: 'disconnected',
    });
    const checkpointed = await seedDestination(db, {
      id: 'dest-chk',
      external_destination_id: 'fb-page-chk',
      metadata: { starting_followers: 1000, current_followers: 1200, fb_status: 'checkpoint' },
    });
    // Gated ADU config (non-active) on the live destination.
    const pausedAdu = seedAduConfig(db, { id: 'adu-paused', status: 'inactive' });
    // Instagram ADU config on an Instagram destination (never scanned).
    const igDest = await seedDestination(db, {
      id: 'dest-ig',
      external_destination_id: 'ig-acct',
      platform: 'instagram',
    });
    const igAdu = seedAduConfig(db, {
      id: 'adu-ig',
      destination_id: 'dest-ig',
      starting_followers: 700,
      current_followers: 800,
    });
    // Non-Facebook mirror for the live page + paused Facebook mirror.
    const tiktokMirror = seedMirror(db, {
      id: 'mirror-tiktok',
      target_platform: 'tiktok',
      starting_followers: 50,
      current_followers: 60,
    });
    const pausedMirror = seedMirror(db, { id: 'mirror-paused', status: 'paused' });
    const before = JSON.stringify({
      disconnected,
      checkpointed,
      pausedAdu,
      igDest,
      igAdu,
      tiktokMirror,
      pausedMirror,
    });

    const result = await runCycle(db, { fetchFollowers: async () => 5000 });
    expect(result.updated).toBe(1);
    expect((live.metadata as Row).current_followers).toBe(5000);
    expect(JSON.stringify({
      disconnected,
      checkpointed,
      pausedAdu,
      igDest,
      igAdu,
      tiktokMirror,
      pausedMirror,
    })).toBe(before);
  });

  it('spec 174 3A: one page in two sections fetches once and writes the same count to both rows', async () => {
    const db = fakeDb();
    // Both rows are the same page (same external id) — the Gate 2A
    // Mineralsrock drift: separate fetches wrote 17525/17528/17530
    // to the copies at slightly different moments.
    const schedule = await seedDestination(db, {
      id: 'dest-schedule',
      metadata: { starting_followers: 1000, current_followers: 1200 },
    });
    const adu = await seedDestination(db, {
      id: 'dest-adu',
      metadata: { starting_followers: 1000, current_followers: 1250 },
    });
    let fetches = 0;
    const result = await runCycle(db, {
      fetchFollowers: async () => {
        fetches += 1;
        return 1300;
      },
    });
    expect(fetches).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect((schedule.metadata as Row).current_followers).toBe(1300);
    expect((adu.metadata as Row).current_followers).toBe(1300);
    expect((schedule.metadata as Row).followers_updated_at).toBe(NOW_ISO);
    expect((adu.metadata as Row).followers_updated_at).toBe(NOW_ISO);
  });

  it('pages the scan in 200-row bounds, ordered by id', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const first = await runCycle(
      db,
      { fetchFollowers: async () => 5000 },
      {
        runId: 'run-paging',
        chunkIndex: 0,
        offset: 0,
        limit: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        totalChunks: 2,
      }
    );
    const second = await runCycle(
      db,
      { fetchFollowers: async () => 5000 },
      {
        runId: 'run-paging',
        chunkIndex: 1,
        offset: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        limit: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        totalChunks: 2,
      }
    );
    expect(first.scanned + second.scanned).toBe(201);
    expect(first.updated + second.updated).toBe(201);
    const destRanges = db.ranges.filter((r) => r.table === 'destinations');
    expect(destRanges).toEqual([
      { table: 'destinations', from: 0, to: INSIGHTS_FOLLOWERS_PAGE_SIZE - 1 },
      {
        table: 'destinations',
        from: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        to: 2 * INSIGHTS_FOLLOWERS_PAGE_SIZE - 1,
      },
    ]);
    // Send-back fix: the scan must pin a stable order — offset paging
    // with no order can silently skip rows, and the tick mutates
    // destinations.updated_at mid-run. Every scan page orders by id.
    expect(db.orders).toEqual([
      { table: 'destinations', column: 'id', ascending: true },
      { table: 'destinations', column: 'id', ascending: true },
    ]);
  });

  it('an interleaved insert and updated_at churn between pages skips and duplicates nothing', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    // Mid-run churn, once, on the first live check (while page 1 is
    // being processed, before page 2 is fetched): a new page is
    // imported (it sorts after every seeded id) and every stored
    // row's updated_at moves — the same mutation the tick itself
    // performs. With the scan ordered by id, neither can shift a
    // page boundary: the new row lands in page 2 and every seeded
    // row is still visited exactly once.
    let churned = false;
    const first = await runCycle(
      db,
      {
        fetchFollowers: async () => {
          if (!churned) {
            churned = true;
            for (const row of db.destinations) row.updated_at = NOW_ISO;
            await seedDestination(db, {
              id: 'dest-zzz',
              external_destination_id: 'fb-page-zzz',
            });
          }
          return 5000;
        },
      },
      {
        runId: 'run-churn',
        chunkIndex: 0,
        offset: 0,
        limit: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        totalChunks: 2,
      }
    );
    const second = await runCycle(
      db,
      { fetchFollowers: async () => 5000 },
      {
        runId: 'run-churn',
        chunkIndex: 1,
        offset: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        limit: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        totalChunks: 2,
      }
    );
    expect(first.scanned + second.scanned).toBe(202);
    expect(first.updated + second.updated).toBe(202);
    expect(db.updates.filter((u) => u.table === 'destinations').length).toBe(202);
    // The interleaved row was picked up in this run, not next day's.
    const inserted = db.destinations.find((r) => r.id === 'dest-zzz');
    expect((inserted?.metadata as Row).current_followers).toBe(5000);
  });
});

describe('fetchLiveFollowersFromGraph', () => {
  /** Minimal Response stand-in: only what the reader touches. */
  function mockResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }

  it('reads the page id, followers_count field and encoded token from the URL, and truncates the count', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return mockResponse(200, { followers_count: 5000.9 });
    };
    const count = await fetchLiveFollowersFromGraph(
      'fb-page-a',
      'tok/en x&y',
      fetchImpl as never
    );
    expect(count).toBe(5000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'https://graph.facebook.com/v26.0/fb-page-a?fields=followers_count&access_token=tok%2Fen%20x%26y'
    );
    // The abort timeout is wired: the call carries a live signal.
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a non-2xx response throws with its status (429 included)', async () => {
    for (const status of [429, 500, 400]) {
      const err = await fetchLiveFollowersFromGraph(
        'fb-page-a',
        'token',
        (async () => mockResponse(status, { error: { message: 'nope' } })) as never
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsightsGraphError);
      expect((err as InsightsGraphError).status).toBe(status);
      expect((err as Error).message).toContain(`HTTP ${status}`);
    }
  });

  it('a missing, non-number, negative or non-finite followers_count throws without a status', async () => {
    for (const body of [
      null,
      {},
      { followers_count: '5000' },
      { followers_count: -1 },
      { followers_count: Number.NaN },
    ]) {
      const err = await fetchLiveFollowersFromGraph(
        'fb-page-a',
        'token',
        (async () => mockResponse(200, body)) as never
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsightsGraphError);
      expect((err as InsightsGraphError).status).toBeUndefined();
    }
  });

  it('a fetch rejection throws without a status', async () => {
    const err = await fetchLiveFollowersFromGraph(
      'fb-page-a',
      'token',
      (async () => {
        // Regression guardrail: worker code throws DomainError, never
        // a bare Error — InternalError is already imported above.
        throw new InternalError('network down');
      }) as never
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightsGraphError);
    expect((err as InsightsGraphError).status).toBeUndefined();
    expect((err as Error).message).toContain('network down');
  });

  it('the abort timeout fires when Graph never answers', async () => {
    const err = await fetchLiveFollowersFromGraph(
      'fb-page-a',
      'token',
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        })) as never,
      5
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightsGraphError);
    expect((err as InsightsGraphError).status).toBeUndefined();
  });
});
describe('fetchPageAnalyticsFromGraph', () => {
  const NOW_241 = new Date('2026-11-10T22:00:00.000Z'); // window ends 2026-11-09
  const DATES_28 = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 13 + i));
    return d.toISOString().slice(0, 10);
  });

  function dayEntry(name: string, base: number, step = 1) {
    return {
      name,
      period: 'day',
      values: DATES_28.map((date, i) => ({
        value: base + i * step,
        end_time: `${date}T08:00:00+0000`,
      })),
    };
  }

  function mockGraph(
    handler: (url: string) => { status: number; body: unknown }
  ): { fetchImpl: never; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
    return { fetchImpl, urls };
  }

  function fullDayPayload() {
    return {
      data: [
        dayEntry('page_media_view', 1000),
        dayEntry('page_total_media_view_unique', 500),
        dayEntry('page_views_total', 100),
        dayEntry('page_post_engagements', 50),
        dayEntry('page_video_views', 800),
        dayEntry('page_video_view_time', 60_000, 1000),
        dayEntry('page_total_actions', 10),
        dayEntry('page_daily_follows_unique', 5),
        dayEntry('page_daily_unfollows_unique', 2, 0),
        dayEntry('page_video_complete_views_30s', 200),
      ],
    };
  }

  function standardHandler(url: string): { status: number; body: unknown } {
    const u = new URL(url);
    const period = u.searchParams.get('period');
    if (period === 'day') return { status: 200, body: fullDayPayload() };
    if (period === 'week') {
      return {
        status: 200,
        body: {
          data: [
            {
              name: 'page_total_media_view_unique',
              period: 'week',
              values: [
                { value: 1_000_000, end_time: '2026-11-03T08:00:00+0000' },
                { value: 1_026_117, end_time: '2026-11-09T08:00:00+0000' },
                // After the window end — must be ignored.
                { value: 9_999_999, end_time: '2026-11-10T08:00:00+0000' },
              ],
            },
          ],
        },
      };
    }
    if (period === 'days_28') {
      return {
        status: 200,
        body: {
          data: [
            {
              name: 'page_total_media_view_unique',
              period: 'days_28',
              values: [{ value: 1_173_333, end_time: '2026-11-09T08:00:00+0000' }],
            },
          ],
        },
      };
    }
    // lifetime — Call D
    return {
      status: 200,
      body: {
        data: [
          {
            name: 'page_follows_country',
            period: 'lifetime',
            values: [{ value: { PK: 9860, US: 1940 }, end_time: '2026-11-09T08:00:00+0000' }],
          },
          {
            name: 'page_follows_city',
            period: 'lifetime',
            values: [{ value: { Karachi: 3420 }, end_time: '2026-11-09T08:00:00+0000' }],
          },
        ],
      },
    };
  }

  it('fills 1d/7d/28d from Call A and takes the deduplicated week/days_28 values, never the daily sums', async () => {
    const { fetchImpl, urls } = mockGraph(standardHandler);
    const out = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    );
    expect(urls).toHaveLength(4);
    // 1d = the last day (2026-11-09, index 27).
    expect(out.analytics1d.date).toBe('2026-11-09');
    expect(out.analytics1d.media_views).toBe(1027);
    expect(out.analytics1d.unique_viewers).toBe(527);
    expect(out.analytics1d.video_view_time_ms).toBe(87_000);
    // 7d / 28d day counts.
    expect(out.analytics7d.days).toHaveLength(7);
    expect(out.analytics7d.days[0]!.date).toBe('2026-11-03');
    expect(out.analytics7d.days[6]!.media_views).toBe(1027);
    expect(out.analytics28d.days).toHaveLength(28);
    expect(out.analytics28d.days[0]!.date).toBe('2026-10-13');
    // Deduplicated values from Calls B/C — the daily sums are larger.
    const dailyViewerSum = out.analytics28d.days.reduce((s, d) => s + d.unique_viewers, 0);
    expect(out.analytics7d.unique_viewers_7d).toBe(1_026_117);
    expect(out.analytics28d.unique_viewers_28d).toBe(1_173_333);
    expect(out.analytics7d.unique_viewers_7d).not.toBe(
      out.analytics7d.days.reduce((s, d) => s + d.unique_viewers, 0)
    );
    expect(out.analytics28d.unique_viewers_28d).not.toBe(dailyViewerSum);
    // Locations — every country/city Facebook returned.
    expect(out.locations).toEqual({
      countries: [
        { country: 'PK', followers: 9860 },
        { country: 'US', followers: 1940 },
      ],
      cities: [{ city: 'Karachi', followers: 3420 }],
    });
  });

  it('requests only the 10 verified day metrics, with the 28-day window ending yesterday', async () => {
    const { fetchImpl, urls } = mockGraph(standardHandler);
    await fetchPageAnalyticsFromGraph('fb-page-a', 'token', fetchImpl, 15_000, async () => {}, NOW_241);
    const dayUrl = new URL(urls[0]!);
    expect(dayUrl.searchParams.get('metric')).toBe(ANALYTICS_DAY_METRICS.join(','));
    expect(dayUrl.searchParams.get('period')).toBe('day');
    expect(dayUrl.searchParams.get('since')).toBe('2026-10-13');
    expect(dayUrl.searchParams.get('until')).toBe('2026-11-09');
    for (const dead of ['page_fan_adds', 'page_video_views_unique', 'page_video_views_10s']) {
      expect(urls.join('|')).not.toContain(dead);
    }
    const weekUrl = new URL(urls[1]!);
    expect(weekUrl.searchParams.get('metric')).toBe('page_total_media_view_unique');
    expect(weekUrl.searchParams.get('period')).toBe('week');
    const days28Url = new URL(urls[2]!);
    expect(days28Url.searchParams.get('period')).toBe('days_28');
    const lifetimeUrl = new URL(urls[3]!);
    expect(lifetimeUrl.searchParams.get('metric')).toBe(
      'page_follows_country,page_follows_city'
    );
    expect(lifetimeUrl.searchParams.get('period')).toBe('lifetime');
  });

  it('Calls B/C pass since/until for their windows ending yesterday (spec 252)', async () => {
    // Facebook's default window (no since/until) ends one day early: the
    // mock returns the trailing value then, and the correct value only
    // when the call asks for its window ending yesterday. The stored
    // values must be the correct ones — this test fails on the pre-fix
    // code, which sent no since/until on Calls B/C.
    const { fetchImpl, urls } = mockGraph((url) => {
      const u = new URL(url);
      const period = u.searchParams.get('period');
      if (period === 'week') {
        const asked =
          u.searchParams.get('since') === '2026-11-03' &&
          u.searchParams.get('until') === '2026-11-09';
        return {
          status: 200,
          body: {
            data: [
              {
                name: 'page_total_media_view_unique',
                period: 'week',
                values: [
                  asked
                    ? { value: 1_026_117, end_time: '2026-11-09T08:00:00+0000' }
                    : { value: 1_000_000, end_time: '2026-11-08T08:00:00+0000' },
                ],
              },
            ],
          },
        };
      }
      if (period === 'days_28') {
        const asked =
          u.searchParams.get('since') === '2026-10-13' &&
          u.searchParams.get('until') === '2026-11-09';
        return {
          status: 200,
          body: {
            data: [
              {
                name: 'page_total_media_view_unique',
                period: 'days_28',
                values: [
                  asked
                    ? { value: 1_173_333, end_time: '2026-11-09T08:00:00+0000' }
                    : { value: 1_150_000, end_time: '2026-11-08T08:00:00+0000' },
                ],
              },
            ],
          },
        };
      }
      return standardHandler(url);
    });
    const out = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    );
    const weekUrl = new URL(urls[1]!);
    expect(weekUrl.searchParams.get('since')).toBe('2026-11-03');
    expect(weekUrl.searchParams.get('until')).toBe('2026-11-09');
    const days28Url = new URL(urls[2]!);
    expect(days28Url.searchParams.get('since')).toBe('2026-10-13');
    expect(days28Url.searchParams.get('until')).toBe('2026-11-09');
    expect(out.analytics7d.unique_viewers_7d).toBe(1_026_117);
    expect(out.analytics28d.unique_viewers_28d).toBe(1_173_333);
  });

  it('a day Facebook does not return is zero, not an error', async () => {
    const { fetchImpl } = mockGraph((url) => {
      const period = new URL(url).searchParams.get('period');
      if (period === 'day') {
        return {
          status: 200,
          body: {
            data: [
              {
                name: 'page_media_view',
                period: 'day',
                values: [{ value: 42, end_time: '2026-11-09T08:00:00+0000' }],
              },
            ],
          },
        };
      }
      return standardHandler(url);
    });
    const out = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    );
    expect(out.analytics28d.days).toHaveLength(28);
    expect(out.analytics28d.days.slice(0, 27).every((d) => d.media_views === 0)).toBe(true);
    expect(out.analytics28d.days[27]!.media_views).toBe(42);
    expect(out.analytics1d.media_views).toBe(42);
    // The other 9 metrics are all zero (missing entries are zero-filled).
    expect(out.analytics1d.unique_viewers).toBe(0);
  });

  it('empty day data throws InsightsNoDataError (token lacks read_insights)', async () => {
    const { fetchImpl } = mockGraph(() => ({ status: 200, body: { data: [] } }));
    const err = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightsNoDataError);
  });

  it('empty location data returns locations null and still fills the other three columns', async () => {
    const { fetchImpl } = mockGraph((url) => {
      if (new URL(url).searchParams.get('period') === 'lifetime') {
        return { status: 200, body: { data: [] } };
      }
      return standardHandler(url);
    });
    const out = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    );
    expect(out.locations).toBeNull();
    expect(out.analytics1d.media_views).toBe(1027);
  });

  it('a one-sided location answer returns locations null (keep the old column, never store an empty side)', async () => {
    // Countries present, cities empty — and the mirror case.
    for (const lifetimeData of [
      [
        {
          name: 'page_follows_country',
          period: 'lifetime',
          values: [{ value: { PK: 9860 }, end_time: '2026-11-09T08:00:00+0000' }],
        },
        {
          name: 'page_follows_city',
          period: 'lifetime',
          values: [{ value: {}, end_time: '2026-11-09T08:00:00+0000' }],
        },
      ],
      [
        {
          name: 'page_follows_country',
          period: 'lifetime',
          values: [{ value: {}, end_time: '2026-11-09T08:00:00+0000' }],
        },
        {
          name: 'page_follows_city',
          period: 'lifetime',
          values: [{ value: { Karachi: 3420 }, end_time: '2026-11-09T08:00:00+0000' }],
        },
      ],
    ]) {
      const { fetchImpl } = mockGraph((url) => {
        if (new URL(url).searchParams.get('period') === 'lifetime') {
          return { status: 200, body: { data: lifetimeData } };
        }
        return standardHandler(url);
      });
      const out = await fetchPageAnalyticsFromGraph(
        'fb-page-a',
        'token',
        fetchImpl,
        15_000,
        async () => {},
        NOW_241
      );
      expect(out.locations).toBeNull();
      expect(out.analytics1d.media_views).toBe(1027);
    }
  });

  it('a non-2xx insights call throws InsightsGraphError with its status', async () => {
    const { fetchImpl } = mockGraph((url) => {
      if (new URL(url).searchParams.get('period') === 'day') {
        return { status: 400, body: { error: { message: '(#100) bad metric', code: 100 } } };
      }
      return standardHandler(url);
    });
    const err = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async () => {},
      NOW_241
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsightsGraphError);
    expect((err as InsightsGraphError).status).toBe(400);
  });

  it('a 429 on the day call retries with backoff and then succeeds', async () => {
    const sleeps: number[] = [];
    let dayAttempts = 0;
    const { fetchImpl } = mockGraph((url) => {
      if (new URL(url).searchParams.get('period') === 'day') {
        dayAttempts += 1;
        if (dayAttempts <= 2) return { status: 429, body: {} };
      }
      return standardHandler(url);
    });
    const out = await fetchPageAnalyticsFromGraph(
      'fb-page-a',
      'token',
      fetchImpl,
      15_000,
      async (ms) => {
        sleeps.push(ms);
      },
      NOW_241
    );
    expect(dayAttempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(out.analytics1d.media_views).toBe(1027);
  });
});
