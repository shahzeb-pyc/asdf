/**
 * loadAduOptionsLists (adu-opt-a F11): the three picker selects
 * (accounts, pages, configured) run concurrently, and the error
 * precedence of the old sequential code is preserved — accounts
 * first, then pages, then configured (missing table → migrationMissing).
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAduOptionsLists } from './adu';

type Row = Record<string, unknown>;

interface TableBehavior {
  rows?: Row[];
  error?: { message: string; code?: string } | null;
  gate?: Promise<void>;
  started?: string[];
}

class FakeOptionsQuery {
  private ops: Array<{ kind: string; args: unknown[] }> = [];
  constructor(
    private readonly table: string,
    private readonly behavior: TableBehavior,
  ) {}

  select(...args: unknown[]) {
    this.ops.push({ kind: 'select', args });
    return this;
  }

  eq(col: string, val: unknown) {
    this.ops.push({ kind: 'eq', args: [col, val] });
    return this;
  }

  order(col: string) {
    this.ops.push({ kind: 'order', args: [col] });
    return this;
  }

  range(from: number, to: number) {
    this.ops.push({ kind: 'range', args: [from, to] });
    return this;
  }

  then(resolve: (value: unknown) => void) {
    const result = { data: this.behavior.rows ?? [], error: this.behavior.error ?? null };
    if (this.behavior.gate) {
      this.behavior.started?.push(this.table);
      void this.behavior.gate.then(() => resolve(result));
      return;
    }
    resolve(result);
  }
}

function makeFakeSupabase(behaviors: Record<string, TableBehavior>) {
  return {
    from: (table: string) =>
      new FakeOptionsQuery(table, behaviors[table] ?? { rows: [] }),
  } as unknown as SupabaseClient;
}

const accountRow = {
  id: 'acc-1',
  external_account_id: 'fb-1',
  display_name: 'Test Account',
  avatar_url: null,
  status: 'active',
};
const pageRow = {
  id: 'dest-1',
  account_id: 'acc-1',
  external_destination_id: 'page-1',
  name: 'Test Page',
  avatar_url: null,
  status: 'active',
  metadata: {},
};
const configuredRow = {
  destination_id: 'dest-1',
  source_platform: 'facebook',
  source_username: 'somepage',
};

describe('loadAduOptionsLists (adu-opt-a F11)', () => {
  it('loads all three lists', async () => {
    const db = makeFakeSupabase({
      social_accounts: { rows: [accountRow] },
      destinations: { rows: [pageRow] },
      adu_configs: { rows: [configuredRow] },
    });
    const lists = await loadAduOptionsLists(db, 'ws-1');
    expect(lists.accounts).toEqual([accountRow]);
    expect(lists.pages).toEqual([pageRow]);
    expect(lists.configured).toEqual([configuredRow]);
    expect(lists.migrationMissing).toBe(false);
  });

  it('starts all three selects before any of them resolves', async () => {
    const started: string[] = [];
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const poll = setInterval(() => {
      if (started.length >= 3) {
        clearInterval(poll);
        openGate?.();
      }
    }, 0);
    try {
      const behaviors: Record<string, TableBehavior> = {
        social_accounts: { rows: [accountRow], gate, started },
        destinations: { rows: [pageRow], gate, started },
        adu_configs: { rows: [configuredRow], gate, started },
      };
      const db = makeFakeSupabase(behaviors);
      const lists = await Promise.race([
        loadAduOptionsLists(db, 'ws-1'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('options selects ran serially: gate never opened')),
            3000,
          ),
        ),
      ]);
      expect(started.sort()).toEqual(['adu_configs', 'destinations', 'social_accounts']);
      expect(lists.accounts).toEqual([accountRow]);
      expect(lists.pages).toEqual([pageRow]);
      expect(lists.configured).toEqual([configuredRow]);
    } finally {
      clearInterval(poll);
    }
  });

  it('accounts error wins over pages and configured errors', async () => {
    const db = makeFakeSupabase({
      social_accounts: { error: { message: 'accounts boom' } },
      destinations: { error: { message: 'pages boom' } },
      adu_configs: { error: { message: 'configs boom' } },
    });
    await expect(loadAduOptionsLists(db, 'ws-1')).rejects.toThrow('accounts boom');
  });

  it('pages error wins over a configured error', async () => {
    const db = makeFakeSupabase({
      social_accounts: { rows: [accountRow] },
      destinations: { error: { message: 'pages boom' } },
      adu_configs: { error: { message: 'configs boom' } },
    });
    await expect(loadAduOptionsLists(db, 'ws-1')).rejects.toThrow('pages boom');
  });

  it('a missing adu_configs table returns migrationMissing with accounts and pages', async () => {
    const db = makeFakeSupabase({
      social_accounts: { rows: [accountRow] },
      destinations: { rows: [pageRow] },
      adu_configs: { error: { message: 'relation does not exist', code: '42P01' } },
    });
    const lists = await loadAduOptionsLists(db, 'ws-1');
    expect(lists.migrationMissing).toBe(true);
    expect(lists.accounts).toEqual([accountRow]);
    expect(lists.pages).toEqual([pageRow]);
    expect(lists.configured).toEqual([]);
  });

  it('a non-missing configured error throws', async () => {
    const db = makeFakeSupabase({
      social_accounts: { rows: [accountRow] },
      destinations: { rows: [pageRow] },
      adu_configs: { error: { message: 'configs boom' } },
    });
    await expect(loadAduOptionsLists(db, 'ws-1')).rejects.toThrow('configs boom');
  });
});
