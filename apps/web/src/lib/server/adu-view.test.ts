/**
 * buildAduConfigView Pending count (spec §3.5): a terminally-failed
 * reel leaves the pipeline, so its failed job must NOT be subtracted
 * a second time. Only failed jobs whose reel is still in the pipeline
 * (the crash window between the job settling and the reel going
 * 'failed') subtract.
 *
 * - 1 failed job + reel 'failed' → Pending 0, Failed 1.
 * - 1 failed job + reel still 'processing' → Pending 0, Failed 1.
 * Posted / Failed counts are job-based and unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AduConfigRow } from '@fbuploadpro/contracts';
import { buildAduConfigView, buildAduConfigViews } from './adu';

type Row = Record<string, unknown>;

interface Op {
  kind: string;
  args: unknown[];
}

interface CountSetup {
  pipeline: number;
  published: number;
  failed: number;
  failedInPipeline: number;
  publishedToday: number;
  failedToday: number;
}

class FakeQuery {
  private ops: Op[] = [];
  constructor(
    private readonly table: string,
    private readonly resolve: (table: string, ops: Op[]) => unknown,
    private readonly calls: Array<{ table: string; ops: Op[] }>,
  ) {}

  select(...args: unknown[]) {
    this.ops.push({ kind: 'select', args });
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

  maybeSingle() {
    this.ops.push({ kind: 'maybeSingle', args: [] });
    return this;
  }

  then(resolve: (value: unknown) => void) {
    this.calls.push({ table: this.table, ops: [...this.ops] });
    resolve(this.resolve(this.table, this.ops));
  }
}

function countsRow(configId: string, c: CountSetup) {
  return {
    config_id: configId,
    in_pipeline: c.pipeline,
    published: c.published,
    failed: c.failed,
    failed_in_pipeline: c.failedInPipeline,
    published_today: c.publishedToday,
    failed_today: c.failedToday,
  };
}

function makeFakeSupabase(
  counts: CountSetup,
  destinationPlatform = 'facebook',
  perConfig?: Record<string, CountSetup>,
  rpcOverride?: (
    name: string,
    params: { p_workspace_id: string; p_config_ids: string[] },
  ) => { data: unknown; error: { code?: string; message?: string } | null },
) {
  const calls: Array<{ table: string; ops: Op[] }> = [];
  const destination: Row = {
    id: 'dest-1',
    name: 'Test Page',
    external_destination_id: 'page-1',
    avatar_url: null,
    status: 'active',
    account_id: 'acc-1',
    handle: null,
    platform: destinationPlatform,
    social_accounts: { display_name: 'Test Account', avatar_url: null },
  };
  const resolveCounts = (configId: string): CountSetup =>
    perConfig?.[configId] ?? counts;
  const db = {
    calls,
    rpc: (
      name: string,
      params: { p_workspace_id: string; p_config_ids: string[] },
    ) => {
      calls.push({ table: 'rpc', ops: [{ kind: 'rpc', args: [name, params] }] });
      if (rpcOverride) return Promise.resolve(rpcOverride(name, params));
      if (name !== 'adu_config_counts') {
        return Promise.resolve({ data: null, error: { code: '42883', message: 'not found' } });
      }
      return Promise.resolve({
        data: (params.p_config_ids ?? []).map((id) => countsRow(id, resolveCounts(id))),
        error: null,
      });
    },
    from: (table: string) =>
      new FakeQuery(table, (t, ops) => {
        if (t === 'destinations') {
          // Single-config lookup uses maybeSingle (one row); the batch
          // path uses .in('id', [...]) and reads an array.
          const single = ops.some((o) => o.kind === 'maybeSingle');
          return single
            ? { data: destination, error: null }
            : { data: [destination], error: null };
        }
        const configId =
          (ops.find((o) => o.kind === 'eq' && o.args[0] === 'config_id')?.args[1] as string) ??
          'c1';
        const c = resolveCounts(configId);
        const hasReelFilter = ops.some(
          (o) => o.kind === 'in' && o.args[0] === 'adu_reels.status',
        );
        const hasGte = ops.some((o) => o.kind === 'gte');
        const inStatus = ops.find(
          (o) => o.kind === 'in' && o.args[0] === 'status',
        )?.args[1] as string[] | undefined;
        const eqStatus = ops.find(
          (o) => o.kind === 'eq' && o.args[0] === 'status',
        )?.args[1] as string | undefined;
        if (t === 'adu_reels') return { count: c.pipeline, error: null };
        if (hasReelFilter) return { count: c.failedInPipeline, error: null };
        if (inStatus) {
          return { count: hasGte ? c.failedToday : c.failed, error: null };
        }
        if (eqStatus === 'published') {
          return { count: hasGte ? c.publishedToday : c.published, error: null };
        }
        return { count: 0, error: null };
      }, calls),
  };
  return db as unknown as SupabaseClient;
}

function configRow(): AduConfigRow {
  return {
    id: 'c1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    source_platform: 'facebook',
    source_username: 'somepage',
    timezone: 'UTC',
    posts_per_day: 2,
    schedule_type: 'dailyrandom',
    posting_times: ['09:00'],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 10,
    current_followers: 1,
    followers_updated_at: null,
    display_name: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

describe('buildAduConfigView pendingCount (spec §3.5)', () => {
  it('1 failed job + reel failed → Pending 0, Failed 1 (no double-subtract)', async () => {
    const db = makeFakeSupabase({
      pipeline: 0,
      published: 0,
      failed: 1,
      failedInPipeline: 0,
      publishedToday: 0,
      failedToday: 1,
    });
    const view = await buildAduConfigView(db, configRow());
    expect(view.pendingCount).toBe(0);
    expect(view.failedCount).toBe(1);
    expect(view.postedCount).toBe(0);
  });

  it('1 failed job + reel still processing (crash window) → Pending 0, Failed 1', async () => {
    const db = makeFakeSupabase({
      pipeline: 1,
      published: 0,
      failed: 1,
      failedInPipeline: 1,
      publishedToday: 0,
      failedToday: 1,
    });
    const view = await buildAduConfigView(db, configRow());
    expect(view.pendingCount).toBe(0);
    expect(view.failedCount).toBe(1);
  });

  it('subtracts only failed jobs whose reel is still in the pipeline', async () => {
    const db = makeFakeSupabase({
      pipeline: 3,
      published: 1,
      failed: 2,
      failedInPipeline: 1,
      publishedToday: 1,
      failedToday: 2,
    });
    const view = await buildAduConfigView(db, configRow());
    // 3 in the pipeline, 1 of them with a failed job → 2 pending;
    // the other failed job's reel already left the pipeline.
    expect(view.pendingCount).toBe(2);
    expect(view.failedCount).toBe(2);
    expect(view.postedCount).toBe(1);
  });

  it('counts the pipeline untouched when nothing failed', async () => {
    const db = makeFakeSupabase({
      pipeline: 2,
      published: 1,
      failed: 0,
      failedInPipeline: 0,
      publishedToday: 1,
      failedToday: 0,
    });
    const view = await buildAduConfigView(db, configRow());
    expect(view.pendingCount).toBe(2);
    expect(view.failedCount).toBe(0);
    expect(view.postedCount).toBe(1);
  });

  it('zero posts: pending 0, pendingToday is the full daily quota', async () => {
    const db = makeFakeSupabase({
      pipeline: 0,
      published: 0,
      failed: 0,
      failedInPipeline: 0,
      publishedToday: 0,
      failedToday: 0,
    });
    const view = await buildAduConfigView(db, configRow());
    expect(view.pendingCount).toBe(0);
    expect(view.postedCount).toBe(0);
    expect(view.failedCount).toBe(0);
    expect(view.pendingToday).toBe(2);
  });

  it('pendingToday floors at 0 when postedToday exceeds the daily quota', async () => {
    const db = makeFakeSupabase({
      pipeline: 0,
      published: 5,
      failed: 0,
      failedInPipeline: 0,
      publishedToday: 5,
      failedToday: 0,
    });
    const view = await buildAduConfigView(db, configRow());
    expect(view.postedToday).toBe(5);
    expect(view.pendingToday).toBe(0);
  });
});

describe('buildAduConfigViews grouped counts (adu-opt-f1)', () => {
  const callsOf = (db: unknown) =>
    (db as unknown as { calls: Array<{ table: string; ops: Op[] }> }).calls;

  function configWithId(id: string): AduConfigRow {
    return { ...configRow(), id };
  }

  it('one batch of 9 configs issues exactly 1 destinations query + 1 counts RPC', async () => {
    const db = makeFakeSupabase({
      pipeline: 3,
      published: 1,
      failed: 2,
      failedInPipeline: 1,
      publishedToday: 1,
      failedToday: 2,
    });
    const configs = Array.from({ length: 9 }, (_, i) => configWithId(`c${i + 1}`));
    const views = await buildAduConfigViews(db, configs, { hub: true });
    expect(views).toHaveLength(9);
    // Order is preserved and every view carries the grouped counts.
    expect(views.map((v) => v.id)).toEqual(configs.map((c) => c.id));
    for (const view of views) {
      expect(view.pendingCount).toBe(2);
      expect(view.failedCount).toBe(2);
      expect(view.postedCount).toBe(1);
      expect(view.pendingToday).toBe(1);
    }
    const calls = callsOf(db);
    expect(calls.filter((c) => c.table === 'destinations')).toHaveLength(1);
    expect(
      calls.filter(
        (c) =>
          c.table === 'rpc' &&
          c.ops.some((o) => o.kind === 'rpc' && o.args[0] === 'adu_config_counts'),
      ),
    ).toHaveLength(1);
    // No per-config count queries at all on the RPC path.
    expect(calls.filter((c) => c.table === 'adu_reels')).toHaveLength(0);
    expect(calls.filter((c) => c.table === 'adu_posting_jobs')).toHaveLength(0);
    // The single destinations query carries every config's destination.
    const destCall = calls.find((c) => c.table === 'destinations');
    const inOp = destCall?.ops.find((o) => o.kind === 'in' && o.args[0] === 'id');
    expect(inOp?.args[1]).toEqual(['dest-1']);
  });

  it('per-config counts stay distinct in one batch (parity across configs)', async () => {
    const perConfig: Record<string, CountSetup> = {
      c1: { pipeline: 3, published: 1, failed: 2, failedInPipeline: 1, publishedToday: 1, failedToday: 2 },
      c2: { pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0 },
      c3: { pipeline: 1, published: 4, failed: 1, failedInPipeline: 1, publishedToday: 4, failedToday: 1 },
    };
    const db = makeFakeSupabase(
      { pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0 },
      'facebook',
      perConfig,
    );
    const views = await buildAduConfigViews(
      db,
      [configWithId('c1'), configWithId('c2'), configWithId('c3')],
      { hub: true },
    );
    expect(views[0]?.pendingCount).toBe(2);
    expect(views[0]?.pendingToday).toBe(1);
    expect(views[1]?.pendingCount).toBe(0);
    expect(views[1]?.pendingToday).toBe(2);
    expect(views[2]?.pendingCount).toBe(0);
    expect(views[2]?.postedCount).toBe(4);
    expect(views[2]?.pendingToday).toBe(0);
    expect(views[2]?.failedToday).toBe(1);
  });

  it('an empty batch issues no queries at all', async () => {
    const db = makeFakeSupabase({
      pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0,
    });
    expect(await buildAduConfigViews(db, [], { hub: true })).toEqual([]);
    expect(callsOf(db)).toHaveLength(0);
  });

  it('a config missing from the RPC result reads as zeros (logged, not fatal)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = makeFakeSupabase(
        { pipeline: 3, published: 1, failed: 2, failedInPipeline: 1, publishedToday: 1, failedToday: 2 },
        'facebook',
        undefined,
        () => ({ data: [], error: null }),
      );
      const [view] = await buildAduConfigViews(db, [configRow()], { hub: true });
      expect(view?.pendingCount).toBe(0);
      expect(view?.postedCount).toBe(0);
      expect(view?.pendingToday).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADU counts missing for config c1'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('buildAduConfigViews legacy fallback (adu-opt-f1)', () => {
  it('a missing counts RPC (migration not applied) falls back to the per-config counts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = makeFakeSupabase(
        { pipeline: 3, published: 1, failed: 2, failedInPipeline: 1, publishedToday: 1, failedToday: 2 },
        'facebook',
        undefined,
        () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }),
      );
      const view = await buildAduConfigView(db, configRow());
      expect(view.pendingCount).toBe(2);
      expect(view.failedCount).toBe(2);
      expect(view.postedCount).toBe(1);
      expect(view.pendingToday).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ADU counts RPC missing'),
      );
      // The fallback still issues the embedded-reel filtered count
      // for the crash-window subtraction.
      const embedded = (
        db as unknown as { calls: Array<{ table: string; ops: Op[] }> }
      ).calls.find(
        (c) =>
          c.table === 'adu_posting_jobs' &&
          c.ops.some(
            (o) =>
              o.kind === 'select' &&
              typeof o.args[0] === 'string' &&
              (o.args[0] as string).includes('adu_reels!inner(status)'),
          ) &&
          c.ops.some((o) => o.kind === 'in' && o.args[0] === 'adu_reels.status'),
      );
      expect(embedded).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('any other counts RPC error fails loud (no silent zeros)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = makeFakeSupabase(
        { pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0 },
        'facebook',
        undefined,
        () => ({ data: null, error: { code: 'XX000', message: 'boom' } }),
      );
      await expect(buildAduConfigView(db, configRow())).rejects.toThrow(
        /ADU counts failed/,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('an invalid counts row fails loud (no wrong numbers rendered)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = makeFakeSupabase(
        { pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0 },
        'facebook',
        undefined,
        () => ({
          data: [{ config_id: 'c1', in_pipeline: 1 }],
          error: null,
        }),
      );
      await expect(buildAduConfigView(db, configRow())).rejects.toThrow(
        /invalid row/,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('legacy midnight is page-local midnight in the config timezone', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Frozen at 02:30 UTC on 2026-11-13: New York is still on
      // 2026-11-12, UTC is on 2026-11-13 — the two midnights differ.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-13T02:30:00.000Z'));
      const zero: CountSetup = {
        pipeline: 0, published: 0, failed: 0, failedInPipeline: 0, publishedToday: 0, failedToday: 0,
      };
      const missingRpc = () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } });
      const nyDb = makeFakeSupabase(zero, 'facebook', undefined, missingRpc);
      await buildAduConfigView(nyDb, { ...configRow(), timezone: 'America/New_York' });
      const utcDb = makeFakeSupabase(zero, 'facebook', undefined, missingRpc);
      await buildAduConfigView(utcDb, { ...configRow(), timezone: 'UTC' });
      const gteValues = (db: unknown) =>
        (db as unknown as { calls: Array<{ table: string; ops: Op[] }> }).calls
          .flatMap((c) => c.ops)
          .filter((o) => o.kind === 'gte')
          .map((o) => o.args[1]);
      expect(new Set(gteValues(nyDb))).toEqual(new Set(['2026-11-12T00:00:00.000Z']));
      expect(new Set(gteValues(utcDb))).toEqual(new Set(['2026-11-13T00:00:00.000Z']));
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });
});

describe('buildAduConfigView alert wording follows the destination platform (B5)', () => {
  const zeroCounts: CountSetup = {
    pipeline: 0,
    published: 0,
    failed: 0,
    failedInPipeline: 0,
    publishedToday: 0,
    failedToday: 0,
  };

  it('uses the Instagram alert for an Instagram destination, never Facebook copy', async () => {
    const db = makeFakeSupabase(zeroCounts, 'instagram');
    const view = await buildAduConfigView(db, { ...configRow(), status: 'invalid_token' });
    expect(view.alert).toContain('Instagram Accounts');
    expect(view.alert).not.toMatch(/Facebook/i);
  });

  it('uses the Threads alert for a Threads destination', async () => {
    const db = makeFakeSupabase(zeroCounts, 'threads');
    const view = await buildAduConfigView(db, { ...configRow(), status: 'invalid_token' });
    expect(view.alert).toContain('Threads Accounts');
    expect(view.alert).not.toMatch(/Facebook/i);
  });

  it('keeps the Facebook alert for a Facebook destination', async () => {
    const db = makeFakeSupabase(zeroCounts, 'facebook');
    const view = await buildAduConfigView(db, { ...configRow(), status: 'invalid_token' });
    expect(view.alert).toContain('Facebook Accounts');
  });

  it('uses the decided creator-suspended copy on every platform', async () => {
    for (const platform of ['facebook', 'instagram', 'threads']) {
      const db = makeFakeSupabase(zeroCounts, platform);
      const view = await buildAduConfigView(db, {
        ...configRow(),
        status: 'creator_suspended',
      });
      expect(view.alert).toMatch(/more than 50 failed downloads/i);
      expect(view.alert).not.toContain('Change the source in Settings');
    }
  });
});

describe('buildAduConfigView hub view (adu-opt-a F7)', () => {
  const counts: CountSetup = {
    pipeline: 3,
    published: 1,
    failed: 2,
    failedInPipeline: 1,
    publishedToday: 1,
    failedToday: 2,
  };
  const dropped = [
    'scheduleType',
    'postingTimes',
    'syncStatus',
    'alert',
    'displayName',
    'updatedAt',
    'destinationHandle',
    'destinationPlatform',
    'accountAvatarUrl',
    'destinationStatus',
  ] as const;

  it('omits exactly the fields the hub card never renders, keeping the rest identical', async () => {
    const db = makeFakeSupabase(counts);
    const full = await buildAduConfigView(db, configRow());
    const hub = await buildAduConfigView(db, configRow(), { hub: true });
    for (const key of dropped) {
      expect(hub).not.toHaveProperty(key);
      expect(full).toHaveProperty(key);
    }
    // Every kept field carries the same value as the full view.
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      if ((dropped as readonly string[]).includes(key)) continue;
      expect(hub).toHaveProperty(key, full[key]);
    }
    expect(hub.pendingCount).toBe(2);
    expect(hub.failedCount).toBe(2);
    expect(hub.postedCount).toBe(1);
    expect(hub.accountName).toBe('Test Account');
  });

  it('trims the hub destination select: no handle, account display name only', async () => {
    const db = makeFakeSupabase(counts);
    await buildAduConfigView(db, configRow(), { hub: true });
    const destCall = (
      db as unknown as { calls: Array<{ table: string; ops: Op[] }> }
    ).calls.find((c) => c.table === 'destinations');
    const selectArg = destCall?.ops.find((o) => o.kind === 'select')?.args[0] as string;
    expect(selectArg).toContain('social_accounts(display_name)');
    expect(selectArg).not.toContain('handle');
    expect(selectArg).not.toContain('social_accounts(display_name, avatar_url)');
  });

  it('keeps the full destination select for the detail shape', async () => {
    const db = makeFakeSupabase(counts);
    await buildAduConfigView(db, configRow());
    const destCall = (
      db as unknown as { calls: Array<{ table: string; ops: Op[] }> }
    ).calls.find((c) => c.table === 'destinations');
    const selectArg = destCall?.ops.find((o) => o.kind === 'select')?.args[0] as string;
    expect(selectArg).toContain('handle');
    expect(selectArg).toContain('social_accounts(display_name, avatar_url)');
  });
});

// F3 (adu-opt-a) is superseded by F1: the six per-config counts no
// longer exist on the RPC path, so there is nothing to run
// concurrently. Concurrency of the legacy fallback's six counts is
// covered by the fallback test above (it returns the same values the
// old F3 test asserted), and the trip-count test in the grouped-counts
// describe pins the one-RPC shape that replaces it.
describe('buildAduConfigView follower last-updated (spec 162)', () => {
  const zeroCounts: CountSetup = {
    pipeline: 0,
    published: 0,
    failed: 0,
    failedInPipeline: 0,
    publishedToday: 0,
    failedToday: 0,
  };

  it('exposes followers_updated_at on the view when the worker stamped it', async () => {
    const db = makeFakeSupabase(zeroCounts, 'facebook');
    const view = await buildAduConfigView(db, {
      ...configRow(),
      followers_updated_at: '2026-11-10T22:00:00.000Z',
    });
    expect(view.followersUpdatedAt).toBe('2026-11-10T22:00:00.000Z');
    expect(view.followersCount).toBe(10);
    expect(view.followersGained).toBe(1);
  });

  it('reads null, never a faked time, when no check has ever stamped the config', async () => {
    const db = makeFakeSupabase(zeroCounts, 'facebook');
    const view = await buildAduConfigView(db, configRow());
    expect(view.followersUpdatedAt).toBeNull();
  });
});
