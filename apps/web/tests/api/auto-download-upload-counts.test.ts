/**
 * ADU card counts — Pending means everything except failed.
 *
 * Pending = reels in (pending, processing, downloaded) MINUS reels
 * whose post failed terminally (failed_to_publish, publish_error,
 * integrity_error). Failed (big and today) counts failed posting
 * jobs only; download failures live in neither Pending nor Failed.
 * Today line is unchanged: Pending = posts-per-day minus posted
 * today, Posted = posted today, Failed = failed posts today.
 *
 * Exactness: since adu-opt-f1 both terms of the subtraction come
 * from ONE grouped `adu_config_counts` RPC — six counts per config
 * computed in SQL, never rows, so no 1,000-row truncation applies
 * (the fake below answers the RPC from the same canned rows). The
 * subtraction is exact because a reel has at most one posting
 * job (both intake paths claim only 'downloaded' reels, retries
 * reuse the same job), so the failed-job count equals the count
 * of distinct reels with a failed job. The 1,500-failed-jobs
 * test below pins the arithmetic at a scale past the truncation
 * limit.
 */
import { describe, expect, it } from 'vitest';
import { buildAduConfigView } from '@/lib/server/adu';
import type { AduConfigRow } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

interface Filter {
  col: string;
  op: 'eq' | 'in' | 'gte';
  val: unknown;
}

class FakeBuilder {
  filters: Filter[] = [];
  private headCount = false;
  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>,
  ) {}

  select(_fields: string, options?: { count?: string; head?: boolean }) {
    this.headCount = options?.head === true;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, op: 'eq', val });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: 'in', val: vals });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ col, op: 'gte', val });
    return this;
  }

  private rows(): Row[] {
    return (this.store[this.table] ?? []).filter((row) =>
      this.filters.every((f) => {
        // Embedded-join filter (buildAduConfigView's failed-in-pipeline
        // count selects `adu_reels!inner(status)` and filters on
        // `adu_reels.status`): resolve the reel through the job's
        // reel_id, exactly as the join does. A plain row lookup would
        // read `undefined` for every job and count zero.
        const v =
          f.col === 'adu_reels.status'
            ? (this.store['adu_reels'] ?? []).find((r) => r.id === row['reel_id'])
                ?.status
            : row[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'in') return (f.val as unknown[]).includes(v);
        return String(v) >= String(f.val);
      }),
    );
  }

  async maybeSingle() {
    const rows = this.rows();
    return { data: rows[0] ?? null, error: null };
  }

  // Thenable so `await builder` resolves a head-count query to
  // { count, error } and a row query to { data, error }.
  then(resolve: (value: unknown) => void) {
    if (this.headCount) {
      resolve({ count: this.rows().length, error: null });
    } else {
      resolve({ data: this.rows(), error: null });
    }
  }
}

const ADU_FAILED_STATUSES = ['failed_to_publish', 'publish_error', 'integrity_error'];
const ADU_PIPELINE_STATUSES = ['pending', 'processing', 'downloaded'];

/** Page-local midnight for a timezone, exactly like startOfDayInTimezone. */
function aduMidnightIso(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).formatToParts(new Date());
    const year = parts.find((x) => x.type === 'year')?.value ?? '1970';
    const month = parts.find((x) => x.type === 'month')?.value ?? '01';
    const day = parts.find((x) => x.type === 'day')?.value ?? '01';
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
  } catch {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }
}

/**
 * The grouped-counts RPC, answered from the same canned rows the old
 * count queries read. Fixtures here are all UTC, so the midnight is
 * UTC midnight; the timezone lookup keeps the helper exact for any
 * seeded adu_configs row.
 */
function fakeSupabase(db: Record<string, Row[]>) {
  return {
    rpc: (name: string, params: { p_workspace_id: string; p_config_ids: string[] }) => {
      if (name !== 'adu_config_counts') {
        return Promise.resolve({ data: null, error: { code: '42883', message: 'not found' } });
      }
      const data = (params.p_config_ids ?? []).map((id) => {
        const timezone = String(
          (db['adu_configs'] ?? []).find((c) => c.id === id)?.['timezone'] ?? 'UTC',
        );
        const midnight = aduMidnightIso(timezone);
        const reels = (db['adu_reels'] ?? []).filter((r) => r['config_id'] === id);
        const jobs = (db['adu_posting_jobs'] ?? []).filter((j) => j['config_id'] === id);
        const inPipeline = reels.filter((r) =>
          ADU_PIPELINE_STATUSES.includes(String(r['status'])),
        ).length;
        const published = jobs.filter((j) => j['status'] === 'published');
        const failed = jobs.filter((j) => ADU_FAILED_STATUSES.includes(String(j['status'])));
        const failedInPipeline = failed.filter((j) => {
          const reel = reels.find((r) => r['id'] === j['reel_id']);
          return reel && ADU_PIPELINE_STATUSES.includes(String(reel['status']));
        }).length;
        return {
          config_id: id,
          in_pipeline: inPipeline,
          published: published.length,
          failed: failed.length,
          failed_in_pipeline: failedInPipeline,
          published_today: published.filter((j) => String(j['created_at']) >= midnight).length,
          failed_today: failed.filter((j) => String(j['created_at']) >= midnight).length,
        };
      });
      return Promise.resolve({ data, error: null });
    },
    from: (table: string) => new FakeBuilder(table, db),
  } as unknown as SupabaseClient;
}

const NOW = new Date();
const TODAY_ISO = NOW.toISOString();
const YESTERDAY_ISO = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();

function configRow(overrides: Partial<Row> = {}): AduConfigRow {
  return {
    id: 'cfg-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    source_platform: 'tiktok',
    source_username: 'sdf',
    timezone: 'UTC',
    posts_per_day: 2,
    schedule_type: 'fixed',
    posting_times: ['09:00', '17:30'],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 0,
    current_followers: 0,
    followers_updated_at: null,
    display_name: null,
    created_at: '2026-11-02T10:00:00.000Z',
    updated_at: '2026-11-02T10:00:00.000Z',
    ...overrides,
  } as unknown as AduConfigRow;
}

function destinationRow(): Row {
  return {
    id: 'dest-1',
    name: 'Ellie Blossom',
    external_destination_id: '432724216597352',
    avatar_url: null,
    status: 'active',
    account_id: 'acc-1',
    handle: null,
    platform: 'facebook',
    social_accounts: { display_name: 'Shahzeb Malik', avatar_url: null },
  };
}

describe('buildAduConfigView — Pending counts', () => {
  it('Pending includes pending, processing, downloaded and in-flight reels; excludes download_failed, posted, skipped and failed-job reels', async () => {
    const db: Record<string, Row[]> = {
      destinations: [destinationRow()],
      adu_reels: [
        { id: 'r-pending', config_id: 'cfg-1', status: 'pending' },
        { id: 'r-processing', config_id: 'cfg-1', status: 'processing' },
        { id: 'r-downloaded', config_id: 'cfg-1', status: 'downloaded' },
        // Claimed for an in-flight job: still pending, not posted.
        { id: 'r-inflight', config_id: 'cfg-1', status: 'processing' },
        // Post failed terminally: the reel stays 'processing' in the
        // data, but the owner decision leaves it OUT of Pending.
        { id: 'r-failedjob', config_id: 'cfg-1', status: 'processing' },
        { id: 'r-failedjob-old', config_id: 'cfg-1', status: 'processing' },
        { id: 'r-dlfailed', config_id: 'cfg-1', status: 'download_failed' },
        { id: 'r-posted', config_id: 'cfg-1', status: 'posted' },
        { id: 'r-posted-old', config_id: 'cfg-1', status: 'posted' },
        { id: 'r-skipped', config_id: 'cfg-1', status: 'skipped' },
      ],
      adu_posting_jobs: [
        { id: 'j-inflight', config_id: 'cfg-1', reel_id: 'r-inflight', status: 'pending_publish', created_at: TODAY_ISO },
        { id: 'j-failed', config_id: 'cfg-1', reel_id: 'r-failedjob', status: 'failed_to_publish', created_at: TODAY_ISO },
        { id: 'j-failed-old', config_id: 'cfg-1', reel_id: 'r-failedjob-old', status: 'publish_error', created_at: YESTERDAY_ISO },
        { id: 'j-published', config_id: 'cfg-1', reel_id: 'r-posted', status: 'published', created_at: TODAY_ISO },
        { id: 'j-published-old', config_id: 'cfg-1', reel_id: 'r-posted-old', status: 'published', created_at: YESTERDAY_ISO },
      ],
    };
    const view = await buildAduConfigView(fakeSupabase(db), configRow());
    // In pipeline: pending, processing, downloaded, inflight,
    // failedjob, failedjob-old = 6; minus 2 failed jobs = 4.
    expect(view.pendingCount).toBe(4);
    expect(view.postedCount).toBe(2);
    expect(view.failedCount).toBe(2);
    // Today line unchanged: posted/failed since midnight UTC,
    // Pending = posts-per-day minus posted today.
    expect(view.postedToday).toBe(1);
    expect(view.failedToday).toBe(1);
    expect(view.pendingToday).toBe(1);
  });

  it('a download failure is in neither Pending nor Failed', async () => {
    const db: Record<string, Row[]> = {
      destinations: [destinationRow()],
      adu_reels: [{ id: 'r-dlfailed', config_id: 'cfg-1', status: 'download_failed' }],
      adu_posting_jobs: [],
    };
    const view = await buildAduConfigView(fakeSupabase(db), configRow());
    expect(view.pendingCount).toBe(0);
    expect(view.failedCount).toBe(0);
    expect(view.failedToday).toBe(0);
  });

  it('counts exactly past 1,000 failed jobs', async () => {
    const reels: Row[] = [
      { id: 'r-keep-1', config_id: 'cfg-1', status: 'pending' },
      { id: 'r-keep-2', config_id: 'cfg-1', status: 'downloaded' },
      { id: 'r-keep-3', config_id: 'cfg-1', status: 'processing' },
    ];
    const jobs: Row[] = [];
    for (let i = 0; i < 1500; i++) {
      reels.push({ id: `r-fail-${i}`, config_id: 'cfg-1', status: 'processing' });
      jobs.push({
        id: `j-fail-${i}`,
        config_id: 'cfg-1',
        reel_id: `r-fail-${i}`,
        status: 'failed_to_publish',
        created_at: TODAY_ISO,
      });
    }
    const db: Record<string, Row[]> = {
      destinations: [destinationRow()],
      adu_reels: reels,
      adu_posting_jobs: jobs,
    };
    const view = await buildAduConfigView(fakeSupabase(db), configRow());
    expect(view.failedCount).toBe(1500);
    expect(view.pendingCount).toBe(3);
  });
});
