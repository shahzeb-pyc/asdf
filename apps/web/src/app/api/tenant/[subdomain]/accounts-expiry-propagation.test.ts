import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { syncExpiredAccountStatus } from './instagram/accounts/route';
import { syncExpiredStatus } from './threads/accounts/route';

/**
 * Spec 174 PR 2B — expiry gap, web half: when an Instagram or
 * Threads account is seen expired in the list, the account flips
 * AND its destinations propagate — every section's copy flips
 * from 'active' to 'error' together, because
 * propagateExpiredAccountDestinations is account-wide by design
 * (no section/platform filter). A propagation failure is logged
 * loudly and never fails the list read; the sync functions never
 * throw.
 *
 * Two stand-ins: a Supabase-shaped client (`from` only — what
 * production runs) and a DatabaseClient-shaped client (`query`
 * only — the test-harness SQL path). The propagation helper
 * picks its path from the client shape, so each test pins the
 * path its client implies.
 */
type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;

  constructor(
    private readonly table: Row[],
    private readonly op: 'select' | 'update',
    private readonly failUpdate: boolean
  ) {}

  update(patch: Row): this {
    this.patch = patch;
    return this;
  }

  select(): this {
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: { message: string } | null } {
    if (this.op === 'update') {
      if (this.failUpdate) return { data: null, error: { message: 'boom' } };
      const updated: Row[] = [];
      for (const row of this.table) {
        if (this.matches(row)) {
          Object.assign(row, this.patch ?? {});
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    return { data: this.table.filter((row) => this.matches(row)), error: null };
  }

  then(
    resolve: (value: { data: unknown; error: { message: string } | null }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

function makeSupabaseClient(
  tables: Record<string, Row[]>,
  opts: { failDestinationsUpdate?: boolean } = {}
) {
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const failUpdate = table === 'destinations' && !!opts.failDestinationsUpdate;
      return {
        update: (patch: Row) => new FakeQuery(rows, 'update', failUpdate).update(patch),
        select: () => new FakeQuery(rows, 'select', false),
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function makeDatabaseClient(tables: Record<string, Row[]>) {
  return {
    async query(sql: string, params: unknown[]): Promise<unknown> {
      if (sql.includes('UPDATE social_accounts')) {
        for (const row of tables['social_accounts'] ?? []) {
          if (row['id'] === params[0] && row['workspace_id'] === params[1]) {
            row['status'] = 'expired';
            row['updated_at'] = new Date().toISOString();
          }
        }
        return [];
      }
      if (sql.includes('UPDATE destinations')) {
        const flipped: Array<{ id: unknown }> = [];
        for (const row of tables['destinations'] ?? []) {
          if (row['account_id'] === params[0] && row['status'] === 'active') {
            row['status'] = 'error';
            flipped.push({ id: row['id'] });
          }
        }
        return flipped;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function seedAccount(
  tables: Record<string, Row[]>,
  id: string,
  platform: string,
  status = 'active'
) {
  tables['social_accounts'].push({
    id,
    workspace_id: 'ws-1',
    platform,
    status,
    token_expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
}

function seedDestination(
  tables: Record<string, Row[]>,
  id: string,
  accountId: string,
  platform: string,
  section: string,
  status = 'active'
) {
  tables['destinations'].push({
    id,
    account_id: accountId,
    workspace_id: 'ws-1',
    platform,
    section,
    status,
  });
}

function seedTables(): Record<string, Row[]> {
  return { social_accounts: [], destinations: [] };
}

describe('Instagram expiry sync propagates to every section (spec 174 PR 2B)', () => {
  it('flips the account and every active destination copy via the Supabase path', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-ig', 'instagram');
    seedDestination(tables, 'dest-sched', 'acct-ig', 'instagram', 'schedule');
    seedDestination(tables, 'dest-adu', 'acct-ig', 'instagram', 'adu');
    seedDestination(tables, 'dest-mirror', 'acct-ig', 'instagram', 'mirror');
    seedDestination(tables, 'dest-error', 'acct-ig', 'instagram', 'schedule', 'error');
    seedDestination(tables, 'dest-disc', 'acct-ig', 'instagram', 'adu', 'disconnected');

    await syncExpiredAccountStatus('acct-ig', 'ws-1', makeSupabaseClient(tables));

    expect(tables['social_accounts'][0]?.['status']).toBe('expired');
    const byId = new Map(tables['destinations'].map((row) => [row['id'], row['status']]));
    expect(byId.get('dest-sched')).toBe('error');
    expect(byId.get('dest-adu')).toBe('error');
    expect(byId.get('dest-mirror')).toBe('error');
    // Non-active rows are untouched: propagation only flips 'active'.
    expect(byId.get('dest-error')).toBe('error');
    expect(byId.get('dest-disc')).toBe('disconnected');
  });

  it('flips the account and every active destination copy via the SQL path', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-ig', 'instagram');
    seedDestination(tables, 'dest-sched', 'acct-ig', 'instagram', 'schedule');
    seedDestination(tables, 'dest-adu', 'acct-ig', 'instagram', 'adu');

    await syncExpiredAccountStatus('acct-ig', 'ws-1', makeDatabaseClient(tables) as never);

    expect(tables['social_accounts'][0]?.['status']).toBe('expired');
    expect(tables['destinations'].map((row) => row['status'])).toEqual(['error', 'error']);
  });

  it('a propagation failure is logged loudly and never throws; the account still flips', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-ig', 'instagram');
    seedDestination(tables, 'dest-sched', 'acct-ig', 'instagram', 'schedule');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      syncExpiredAccountStatus(
        'acct-ig',
        'ws-1',
        makeSupabaseClient(tables, { failDestinationsUpdate: true })
      )
    ).resolves.toBeUndefined();
    expect(tables['social_accounts'][0]?.['status']).toBe('expired');
    // The destination did not flip (the update failed), but the
    // list read is not failed by it — and the failure was loud.
    expect(tables['destinations'][0]?.['status']).toBe('active');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to propagate expired account destinations'),
      expect.anything()
    );
    errorSpy.mockRestore();
  });
});

describe('Threads expiry sync propagates to every section (spec 174 PR 2B)', () => {
  it('flips the account and every active destination copy when the token has passed', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-th', 'threads');
    seedDestination(tables, 'dest-sched', 'acct-th', 'threads', 'schedule');
    seedDestination(tables, 'dest-adu', 'acct-th', 'threads', 'adu');
    const supabase = makeSupabaseClient(tables);
    const row = {
      id: 'acct-th',
      external_account_id: 'threads-acct-1',
      display_name: 'Test',
      avatar_url: null,
      status: 'active',
      token_expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await syncExpiredStatus(supabase, row as never, 'ws-1');

    expect(tables['social_accounts'][0]?.['status']).toBe('expired');
    expect(tables['destinations'].map((r) => r['status'])).toEqual(['error', 'error']);
  });

  it('does nothing when the token is still live', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-th', 'threads');
    seedDestination(tables, 'dest-sched', 'acct-th', 'threads', 'schedule');
    const supabase = makeSupabaseClient(tables);
    const row = {
      id: 'acct-th',
      external_account_id: 'threads-acct-1',
      display_name: 'Test',
      avatar_url: null,
      status: 'active',
      token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await syncExpiredStatus(supabase, row as never, 'ws-1');

    expect(tables['social_accounts'][0]?.['status']).toBe('active');
    expect(tables['destinations'][0]?.['status']).toBe('active');
  });

  it('does nothing when the account is not active', async () => {
    const tables = seedTables();
    seedAccount(tables, 'acct-th', 'threads', 'revoked');
    seedDestination(tables, 'dest-sched', 'acct-th', 'threads', 'schedule');
    const supabase = makeSupabaseClient(tables);
    const row = {
      id: 'acct-th',
      external_account_id: 'threads-acct-1',
      display_name: 'Test',
      avatar_url: null,
      status: 'revoked',
      token_expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await syncExpiredStatus(supabase, row as never, 'ws-1');

    expect(tables['social_accounts'][0]?.['status']).toBe('revoked');
    expect(tables['destinations'][0]?.['status']).toBe('active');
  });
});
