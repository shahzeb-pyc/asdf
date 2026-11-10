/**
 * Spec 162 — daily insights-followers worker.
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
 * - The scan is bounded and paged (200 rows per page).
 * - A 429 backs off exponentially (1s, then 2s) and retries.
 */
import { describe, expect, it } from 'vitest';
import { encryptToken, InternalError } from '@fbuploadpro/contracts';
import {
  INSIGHTS_FOLLOWERS_PAGE_SIZE,
  runInsightsFollowersCycle,
} from './insights-followers-tick.js';

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const NOW = new Date('2026-11-10T22:00:00.000Z'); // 03:00 PKT
const NOW_ISO = NOW.toISOString();

type Row = Record<string, unknown>;

interface FakeDb {
  destinations: Row[];
  adu_configs: Row[];
  mirrors: Row[];
  /** Every range() call the tick made (pins the bounded scan). */
  ranges: Array<{ table: string; from: number | null; to: number | null }>;
  /** Every update the tick applied (table + patch + matched rows). */
  updates: Array<{ table: string; patch: Row; count: number }>;
}

class FakeBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
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
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      matched = matched.slice(this.rangeFrom, this.rangeTo + 1);
    }
    resolve({ data: matched, error: null, count: null });
  }
}

function fakeDb(): FakeDb {
  return { destinations: [], adu_configs: [], mirrors: [], ranges: [], updates: [] };
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

describe('runInsightsFollowersCycle', () => {
  it('updates current, never starting, over two runs with a changed live count', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db);
    const adu = seedAduConfig(db);
    seedMirror(db, { starting_followers: 900, current_followers: 1100 });
    const liveByRun = [5000, 5200];
    const fetchFollowers = async () => liveByRun.shift() ?? 5200;

    const first = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers,
    });
    expect(first.updated).toBe(1);
    expect(first.failed).toBe(0);
    expect((dest.metadata as Row).starting_followers).toBe(1000);
    expect((dest.metadata as Row).current_followers).toBe(5000);
    expect((dest.metadata as Row).followers_updated_at).toBe(NOW_ISO);
    expect(adu.starting_followers).toBe(1000);
    expect(adu.current_followers).toBe(5000);
    expect(adu.followers_updated_at).toBe(NOW_ISO);

    const second = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers,
    });
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

    await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers,
    });
    expect(mirror.starting_followers).toBe(5000);
    expect(mirror.current_followers).toBe(5000);
    expect(mirror.followers_updated_at).toBe(NOW_ISO);

    await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers,
    });
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
    const updatesBefore = db.updates.length;

    const result = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers: async () => {
        throw new InternalError('Graph checkpoint');
      },
    });
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
    expect(JSON.stringify({ dest, adu, mirror })).toBe(before);
    expect(db.updates.length).toBe(updatesBefore);
  });

  it('a decrypt failure and an exhausted 429 both leave the row untouched', async () => {
    const db = fakeDb();
    const dest = await seedDestination(db, { encrypted_destination_token: 'not-a-token' });
    const adu = seedAduConfig(db);
    const before = JSON.stringify({ dest, adu });

    const decryptResult = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers: async () => 5000,
    });
    expect(decryptResult.failed).toBe(1);
    expect(JSON.stringify({ dest, adu })).toBe(before);

    const dest2 = await seedDestination(db, {
      id: 'dest-b',
      external_destination_id: 'fb-page-b',
    });
    const sleeps: number[] = [];
    const rateLimited = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
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
    const result = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
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

    const result = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers: async () => 5000,
    });
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

  it('pages the scan in 200-row bounds', async () => {
    const db = fakeDb();
    for (let i = 0; i < 201; i += 1) {
      await seedDestination(db, {
        id: `dest-${i}`,
        external_destination_id: `fb-page-${i}`,
      });
    }
    const result = await runInsightsFollowersCycle({
      db: fakeClient(db) as never,
      masterKey: MASTER_KEY,
      now: NOW,
      fetchFollowers: async () => 5000,
    });
    expect(result.scanned).toBe(201);
    expect(result.updated).toBe(201);
    const destRanges = db.ranges.filter((r) => r.table === 'destinations');
    expect(destRanges).toEqual([
      { table: 'destinations', from: 0, to: INSIGHTS_FOLLOWERS_PAGE_SIZE - 1 },
      {
        table: 'destinations',
        from: INSIGHTS_FOLLOWERS_PAGE_SIZE,
        to: 2 * INSIGHTS_FOLLOWERS_PAGE_SIZE - 1,
      },
    ]);
  });
});
