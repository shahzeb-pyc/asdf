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

function makeFakeSupabase(counts: CountSetup) {
  const calls: Array<{ table: string; ops: Op[] }> = [];
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
    followers_count: 10,
    followers_gained: 1,
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
