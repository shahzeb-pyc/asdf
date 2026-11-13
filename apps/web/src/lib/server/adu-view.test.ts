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
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AduConfigRow } from '@fbuploadpro/contracts';
import { buildAduConfigView } from './adu';

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

function makeFakeSupabase(counts: CountSetup, destinationPlatform = 'facebook') {
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
  const db = {
    calls,
    from: (table: string) =>
      new FakeQuery(table, (t, ops) => {
        if (t === 'destinations') return { data: destination, error: null };
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
        if (t === 'adu_reels') return { count: counts.pipeline, error: null };
        if (hasReelFilter) return { count: counts.failedInPipeline, error: null };
        if (inStatus) {
          return { count: hasGte ? counts.failedToday : counts.failed, error: null };
        }
        if (eqStatus === 'published') {
          return { count: hasGte ? counts.publishedToday : counts.published, error: null };
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

  it('issues the embedded-reel filtered count for the subtraction', async () => {
    const db = makeFakeSupabase({
      pipeline: 1,
      published: 0,
      failed: 1,
      failedInPipeline: 1,
      publishedToday: 0,
      failedToday: 1,
    });
    await buildAduConfigView(db, configRow());
    const embedded = (db as unknown as { calls: Array<{ table: string; ops: Op[] }> }).calls.find(
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

describe('buildAduConfigView counts run concurrently (adu-opt-a F3)', () => {
  it('issues all six counts before any of them resolves', async () => {
    const started: string[] = [];
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const poll = setInterval(() => {
      if (started.length >= 6) {
        clearInterval(poll);
        openGate?.();
      }
    }, 0);
    try {
      const counts: CountSetup = {
        pipeline: 3,
        published: 1,
        failed: 2,
        failedInPipeline: 1,
        publishedToday: 1,
        failedToday: 2,
      };
      const destination: Row = {
        id: 'dest-1',
        name: 'Test Page',
        external_destination_id: 'page-1',
        avatar_url: null,
        status: 'active',
        account_id: 'acc-1',
        handle: null,
        platform: 'facebook',
        social_accounts: { display_name: 'Test Account', avatar_url: null },
      };
      const db = {
        from: (table: string) => {
          const ops: Op[] = [];
          const query = {
            select(...args: unknown[]) {
              ops.push({ kind: 'select', args });
              return query;
            },
            eq(col: string, val: unknown) {
              ops.push({ kind: 'eq', args: [col, val] });
              return query;
            },
            in(col: string, val: unknown[]) {
              ops.push({ kind: 'in', args: [col, val] });
              return query;
            },
            gte(col: string, val: unknown) {
              ops.push({ kind: 'gte', args: [col, val] });
              return query;
            },
            maybeSingle() {
              ops.push({ kind: 'maybeSingle', args: [] });
              return query;
            },
            then(resolve: (value: unknown) => void) {
              if (ops.some((o) => o.kind === 'maybeSingle')) {
                resolve({ data: destination, error: null });
                return;
              }
              // A count query: record the start and wait for the gate.
              // Sequential code would start one count and wait on it
              // forever — the gate only opens once all six started.
              started.push(table);
              void gate.then(() => {
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
                let count = 0;
                if (table === 'adu_reels') count = counts.pipeline;
                else if (hasReelFilter) count = counts.failedInPipeline;
                else if (inStatus) count = hasGte ? counts.failedToday : counts.failed;
                else if (eqStatus === 'published') {
                  count = hasGte ? counts.publishedToday : counts.published;
                }
                resolve({ count, error: null });
              });
            },
          };
          return query;
        },
      } as unknown as SupabaseClient;
      const view = await Promise.race([
        buildAduConfigView(db, configRow()),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('counts ran serially: gate never opened')),
            3000,
          ),
        ),
      ]);
      expect(started.length).toBe(6);
      expect(view.pendingCount).toBe(2);
      expect(view.failedCount).toBe(2);
      expect(view.postedCount).toBe(1);
      expect(view.pendingToday).toBe(1);
    } finally {
      clearInterval(poll);
    }
  });
});

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
