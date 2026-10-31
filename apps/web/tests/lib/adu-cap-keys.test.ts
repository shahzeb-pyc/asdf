/**
 * ADU cap key loader (feature-cap display, PR #80).
 *
 * aduDestinationKeysForCap resolves the destination ids an ADU batch
 * would register into the registry keys the Facebook cap counts:
 * the destination's external id when present, else its row id.
 * These tests drive it with a fake Supabase client that filters
 * canned destination rows by the chain's filters, and prove the
 * mapping, dedupe, unknown-id skipping, workspace/platform scoping,
 * and the loud error path.
 */
import { describe, expect, it, vi } from 'vitest';

import { aduDestinationKeysForCap } from '../../src/lib/server/adu';

// adu.ts imports route collaborators that are irrelevant here;
// mock them the way the other ADU lib tests do.
vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(),
  getRouteSupabase: vi.fn(),
}));
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: vi.fn(),
}));

type Row = Record<string, unknown>;

class FakeBuilder {
  private filters: Array<{ op: 'eq' | 'in'; col: string; val: unknown }> = [];

  constructor(
    private readonly rows: Row[],
    private readonly error: { message: string } | null,
    private readonly calls: string[]
  ) {}

  select(_cols: string): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ op: 'in', col, val: vals });
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: Row[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let rows = [...this.rows];
    for (const f of this.filters) {
      if (f.op === 'eq') rows = rows.filter((row) => row[f.col] === f.val);
      if (f.op === 'in')
        rows = rows.filter((row) => (f.val as unknown[]).includes(row[f.col]));
    }
    const result = { data: rows, error: this.error };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function fakeClient(rows: Row[], error: { message: string } | null, calls: string[]) {
  return {
    from: (table: string) => {
      calls.push(table);
      return new FakeBuilder(rows, error, calls);
    },
  } as unknown as Parameters<typeof aduDestinationKeysForCap>[0];
}

const DESTINATIONS: Row[] = [
  {
    id: 'dest-1',
    workspace_id: 'ws-1',
    platform: 'facebook',
    external_destination_id: 'fb-page-1',
  },
  { id: 'dest-2', workspace_id: 'ws-1', platform: 'facebook', external_destination_id: null },
  { id: 'dest-3', workspace_id: 'ws-1', platform: 'facebook' },
  {
    id: 'dest-4',
    workspace_id: 'ws-2',
    platform: 'facebook',
    external_destination_id: 'fb-page-4',
  },
  {
    id: 'dest-5',
    workspace_id: 'ws-1',
    platform: 'instagram',
    external_destination_id: 'ig-acct-5',
  },
];

describe('aduDestinationKeysForCap', () => {
  it('returns [] without querying for an empty id list', async () => {
    const calls: string[] = [];
    const result = await aduDestinationKeysForCap(
      fakeClient(DESTINATIONS, null, calls),
      'ws-1',
      'facebook',
      []
    );
    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('maps matched rows to their external id, falling back to the row id', async () => {
    const calls: string[] = [];
    const result = await aduDestinationKeysForCap(
      fakeClient(DESTINATIONS, null, calls),
      'ws-1',
      'facebook',
      ['dest-1', 'dest-2', 'dest-3']
    );
    expect(result).toEqual(['fb-page-1', 'dest-2', 'dest-3']);
    expect(calls).toEqual(['destinations']);
  });

  it('dedupes repeated ids in one request', async () => {
    const calls: string[] = [];
    const result = await aduDestinationKeysForCap(
      fakeClient(DESTINATIONS, null, calls),
      'ws-1',
      'facebook',
      ['dest-1', 'dest-1', 'dest-1']
    );
    expect(result).toEqual(['fb-page-1']);
  });

  it('skips unknown ids and rows from other workspaces or platforms', async () => {
    const calls: string[] = [];
    const result = await aduDestinationKeysForCap(
      fakeClient(DESTINATIONS, null, calls),
      'ws-1',
      'facebook',
      ['dest-1', 'dest-unknown', 'dest-4', 'dest-5']
    );
    expect(result).toEqual(['fb-page-1']);
  });

  it('throws loudly when the lookup errors', async () => {
    const calls: string[] = [];
    await expect(
      aduDestinationKeysForCap(fakeClient(DESTINATIONS, { message: 'db down' }, calls), 'ws-1', 'facebook', [
        'dest-1',
      ])
    ).rejects.toThrow('ADU cap key lookup failed: db down');
  });
});
