import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureAduDestinationCopy } from './adu';

/**
 * Spec 174 1B — direct unit tests for `ensureAduDestinationCopy`
 * (apps/web/src/lib/server/adu.ts).
 *
 * The happy paths are covered transitively by the Instagram/Threads
 * ADU route tests, but the four failure paths were not: a load error,
 * a refresh error, the 23505 race (including the raced-reload
 * failure), and a non-race insert error. Those 11 lines were the
 * whole Sonar new-code shortfall on pull request 228 (64.9% vs the 80% gate).
 *
 * Fake pattern follows threads-adu.test.ts: a thenable query builder
 * over an in-memory destinations table, with per-operation error
 * injection. The 23505 case simulates the race faithfully — the
 * concurrent call's row lands while this call's insert is rejected,
 * so the raced reload finds it; when no raced row is scripted, the
 * reload finds nothing and the function fails loud.
 */
type Row = Record<string, unknown>;
type DbError = { code: string; message: string };

interface FakeState {
  rows: Row[];
  selects: number;
  loadError: DbError | null;
  racedError: DbError | null;
  refreshError: DbError | null;
  insertError: DbError | null;
  racedRow: Row | null;
  inserts: Row[];
  updates: Row[];
}

class FakeQuery {
  private readonly mode: 'select' | 'insert' | 'update';
  private readonly payload: Row | null;
  private readonly filters: Array<(row: Row) => boolean> = [];
  private terminal: 'maybeSingle' | 'single' | null = null;

  constructor(
    private readonly state: FakeState,
    mode: 'select' | 'insert' | 'update',
    payload?: Row
  ) {
    this.mode = mode;
    this.payload = payload ?? null;
  }

  select(_cols?: string): this {
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] === value);
    return this;
  }

  maybeSingle(): this {
    this.terminal = 'maybeSingle';
    return this;
  }

  single(): this {
    this.terminal = 'single';
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => filter(row));
  }

  private run(): { data: unknown; error: DbError | null } {
    if (this.mode === 'update') {
      this.state.updates.push({ ...(this.payload ?? {}) });
      if (this.state.refreshError) return { data: null, error: this.state.refreshError };
      const updated: Row[] = [];
      for (const row of this.state.rows) {
        if (this.matches(row)) {
          Object.assign(row, this.payload);
          updated.push({ ...row });
        }
      }
      return { data: updated, error: null };
    }
    if (this.mode === 'insert') {
      this.state.inserts.push({ ...(this.payload ?? {}) });
      if (this.state.insertError) {
        // The concurrent insert won the race: its row lands now,
        // so the raced reload finds it.
        if (this.state.insertError.code === '23505' && this.state.racedRow) {
          this.state.rows.push({ ...this.state.racedRow });
        }
        return { data: null, error: this.state.insertError };
      }
      const fresh: Row = { id: `fake-${this.state.rows.length + 1}`, ...(this.payload ?? {}) };
      this.state.rows.push(fresh);
      return {
        data: this.terminal === 'single' ? { ...fresh } : [{ ...fresh }],
        error: null,
      };
    }
    // select
    this.state.selects += 1;
    const isRacedReload = this.state.selects > 1;
    if (!isRacedReload && this.state.loadError) {
      return { data: null, error: this.state.loadError };
    }
    if (isRacedReload && this.state.racedError) {
      return { data: null, error: this.state.racedError };
    }
    const found = this.state.rows.find((row) => this.matches(row)) ?? null;
    return { data: found, error: null };
  }

  then(
    resolve: (value: { data: unknown; error: DbError | null }) => unknown,
    reject?: (reason: unknown) => unknown
  ): Promise<unknown> {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
}

interface FakeOptions {
  destinations?: Row[];
  loadError?: DbError | null;
  racedError?: DbError | null;
  refreshError?: DbError | null;
  insertError?: DbError | null;
  racedRow?: Row | null;
}

function makeClient(options: FakeOptions = {}): { client: SupabaseClient; state: FakeState } {
  const state: FakeState = {
    rows: [...(options.destinations ?? [])],
    selects: 0,
    loadError: options.loadError ?? null,
    racedError: options.racedError ?? null,
    refreshError: options.refreshError ?? null,
    insertError: options.insertError ?? null,
    racedRow: options.racedRow ?? null,
    inserts: [],
    updates: [],
  };
  const client = {
    from(table: string) {
      if (table !== 'destinations') throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols?: string) => new FakeQuery(state, 'select'),
        insert: (payload: Row) => new FakeQuery(state, 'insert', payload),
        update: (payload: Row) => new FakeQuery(state, 'update', payload),
      };
    },
  };
  return { client: client as unknown as SupabaseClient, state };
}

// Same mock as the sibling adu.test.ts: the module under test imports
// the billing route helpers, and nothing under test here calls them.
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: () => null,
}));

const SOURCE = {
  account_id: 'acc-1',
  external_destination_id: 'ig-1',
  name: 'My Instagram',
  avatar_url: 'https://example.invalid/avatar.jpg',
  metadata: { followers: 12 },
};

const ADU_COPY_KEYS = {
  workspace_id: 'ws-1',
  account_id: 'acc-1',
  platform: 'instagram',
  section: 'adu',
  external_destination_id: 'ig-1',
};

function aduCopyRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'dest-1',
    ...ADU_COPY_KEYS,
    name: 'Old name',
    avatar_url: null,
    status: 'active',
    metadata: { followers: 5 },
    ...overrides,
  };
}

describe('ensureAduDestinationCopy failure paths (spec 174 1B)', () => {
  it('a load error fails loud and never attempts an insert', async () => {
    const { client, state } = makeClient({
      loadError: { code: '500', message: 'db down' },
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({
      ok: false,
      error: 'Could not add this account. Please try again.',
    });
    expect(state.selects).toBe(1);
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('a refresh error fails loud, leaves the copy untouched, and never inserts', async () => {
    const { client, state } = makeClient({
      destinations: [aduCopyRow()],
      refreshError: { code: '500', message: 'db down' },
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({
      ok: false,
      error: 'Could not add this account. Please try again.',
    });
    // The refresh was attempted with the source identity…
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ name: 'My Instagram' });
    // …but it did not land, and no second copy was created.
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.['name']).toBe('Old name');
    expect(state.inserts).toHaveLength(0);
  });

  it('a 23505 race returns the copy the other call created', async () => {
    const raced = aduCopyRow({ id: 'dest-raced', metadata: { followers: 99 } });
    const { client, state } = makeClient({
      insertError: { code: '23505', message: 'duplicate key' },
      racedRow: raced,
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({ ok: true, destinationId: 'dest-raced', metadata: { followers: 99 } });
    // The insert was attempted once, stamped as the adu copy…
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      ...ADU_COPY_KEYS,
      name: 'My Instagram',
      status: 'active',
    });
    expect(Object.keys(state.inserts[0] ?? {})).not.toContain('token');
    // …then the raced reload found the winner's row; the failed
    // insert left no second row behind.
    expect(state.selects).toBe(2);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.['id']).toBe('dest-raced');
  });

  it('a 23505 race whose raced reload errors fails loud', async () => {
    const { client, state } = makeClient({
      insertError: { code: '23505', message: 'duplicate key' },
      racedRow: aduCopyRow({ id: 'dest-raced' }),
      racedError: { code: '500', message: 'db down' },
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({
      ok: false,
      error: 'Could not add this account. Please try again.',
    });
    expect(state.selects).toBe(2);
    expect(state.inserts).toHaveLength(1);
  });

  it('a 23505 race whose raced reload finds nothing fails loud', async () => {
    const { client, state } = makeClient({
      insertError: { code: '23505', message: 'duplicate key' },
      racedRow: null,
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({
      ok: false,
      error: 'Could not add this account. Please try again.',
    });
    expect(state.selects).toBe(2);
    expect(state.inserts).toHaveLength(1);
    expect(state.rows).toHaveLength(0);
  });

  it('a non-race insert error fails loud without a raced reload', async () => {
    const { client, state } = makeClient({
      insertError: { code: '500', message: 'db down' },
    });

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({
      ok: false,
      error: 'Could not add this account. Please try again.',
    });
    // Only the initial load ran — the raced reload is 23505-only.
    expect(state.selects).toBe(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.rows).toHaveLength(0);
  });

  it('a clean insert stamps the adu copy and returns its id', async () => {
    const { client, state } = makeClient();

    const result = await ensureAduDestinationCopy(client, 'ws-1', 'instagram', SOURCE);

    expect(result).toEqual({ ok: true, destinationId: 'fake-1', metadata: { followers: 12 } });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toEqual({
      ...ADU_COPY_KEYS,
      name: 'My Instagram',
      avatar_url: 'https://example.invalid/avatar.jpg',
      status: 'active',
      metadata: { followers: 12 },
    });
    expect(state.rows).toHaveLength(1);
  });
});
