/**
 * ADU picker data loading — the fail-loud fixes for the launch-eve
 * "Failed to load pages" / "0 Connected" reports:
 * - A missing ADU RPC (PostgREST PGRST202) counts as a missing
 *   migration, so an unapplied ADU migration renders the
 *   migration-missing banner instead of "Failed to load pages."
 * - The picker loads every account/page/config row with range paging:
 *   an unbounded select silently truncates at 1,000 rows.
 * - A non-missing-table configs error throws (500), never an empty
 *   configured list that invites duplicate configs.
 * - The dialog fetch rejects on a non-OK response: the old code parsed
 *   the error body without checking response.ok, so a 500 rendered as
 *   an empty picker — "0 Connected" with no error shown.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { aduRpcMissing, loadAduOptionsLists } from '../../src/lib/server/adu';
import { fetchAduOptions } from '../../src/components/auto-download-upload/adu-hub-page';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

function makeSupabase(
  tables: Record<string, Row[]>,
  tableError?: { table: string; error: { message: string; code: string } },
) {
  return {
    from: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return chain;
        },
        order: (col: string) => {
          rows = [...rows].sort((a, b) =>
            String(a[col] ?? '').localeCompare(String(b[col] ?? '')),
          );
          return chain;
        },
        range: (from: number, to: number) => {
          if (tableError?.table === table) {
            return Promise.resolve({ data: null, error: tableError.error });
          }
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const account = (id: string): Row => ({
  id,
  external_account_id: `fb-${id}`,
  display_name: `Account ${id}`,
  avatar_url: null,
  status: 'active',
  workspace_id: 'ws-1',
  platform: 'facebook',
});
const page = (id: string): Row => ({
  id,
  account_id: 'acc-1',
  external_destination_id: `dest-${id}`,
  name: `Page ${id}`,
  avatar_url: null,
  status: 'active',
  metadata: null,
  workspace_id: 'ws-1',
  platform: 'facebook',
});
const configured = (id: string): Row => ({
  destination_id: id,
  source_platform: 'instagram',
  source_username: 'someone',
  workspace_id: 'ws-1',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aduRpcMissing', () => {
  it('treats a missing RPC (PGRST202) like a missing table', () => {
    expect(aduRpcMissing({ code: 'PGRST202' })).toBe(true);
    expect(aduRpcMissing({ code: '42P01' })).toBe(true);
    expect(aduRpcMissing({ code: '42883' })).toBe(true);
  });

  it('does not treat other errors as missing', () => {
    expect(aduRpcMissing({ code: '23505' })).toBe(false);
    expect(aduRpcMissing(null)).toBe(false);
    expect(aduRpcMissing(undefined)).toBe(false);
  });
});

describe('loadAduOptionsLists', () => {
  it('pages past the 1,000-row PostgREST truncation', async () => {
    const accounts = Array.from({ length: 1001 }, (_, i) => account(`acc-${i}`));
    const supabase = makeSupabase({ social_accounts: accounts, destinations: [], adu_configs: [] });
    const lists = await loadAduOptionsLists(supabase, 'ws-1');
    expect(lists.accounts).toHaveLength(1001);
    // Paging completeness, not position: display_name order is
    // lexicographic, so acc-1000 is not at index 1000 — but every row
    // past the 1,000-row truncation point must still be present.
    expect(lists.accounts.map((a) => a.id)).toContain('acc-1000');
    expect(lists.migrationMissing).toBe(false);
  });

  it('returns accounts and pages with migrationMissing when adu_configs is absent', async () => {
    const supabase = makeSupabase(
      { social_accounts: [account('acc-1')], destinations: [page('p-1')], adu_configs: [] },
      { table: 'adu_configs', error: { message: 'missing', code: '42P01' } },
    );
    const lists = await loadAduOptionsLists(supabase, 'ws-1');
    expect(lists.accounts).toHaveLength(1);
    expect(lists.pages).toHaveLength(1);
    expect(lists.configured).toEqual([]);
    expect(lists.migrationMissing).toBe(true);
  });

  it('throws on a non-missing-table configs error instead of an empty list', async () => {
    const supabase = makeSupabase(
      { social_accounts: [account('acc-1')], destinations: [page('p-1')], adu_configs: [] },
      { table: 'adu_configs', error: { message: 'db boom', code: '500' } },
    );
    await expect(loadAduOptionsLists(supabase, 'ws-1')).rejects.toThrow('db boom');
  });

  it('throws on an accounts load error', async () => {
    const supabase = makeSupabase(
      { social_accounts: [], destinations: [], adu_configs: [] },
      { table: 'social_accounts', error: { message: 'accounts boom', code: '500' } },
    );
    await expect(loadAduOptionsLists(supabase, 'ws-1')).rejects.toThrow('accounts boom');
  });
});

describe('fetchAduOptions', () => {
  it('returns picker data on an OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          accounts: [{ id: 'a1' }],
          pages: [{ id: 'p1' }],
          configured: [],
          migrationMissing: false,
        }),
      })),
    );
    const body = await fetchAduOptions('acme');
    expect(body.accounts).toEqual([{ id: 'a1' }]);
    expect(body.migrationMissing).toBe(false);
  });

  it('rejects with the server error on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Database unavailable' }),
      })),
    );
    await expect(fetchAduOptions('acme')).rejects.toThrow('Database unavailable');
  });

  it('rejects with a fallback message when the error body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(fetchAduOptions('acme')).rejects.toThrow(
      'Could not load Facebook accounts and pages.',
    );
  });

  it('defaults missing lists to empty arrays on an OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const body = await fetchAduOptions('acme');
    expect(body).toEqual({ accounts: [], pages: [], configured: [], migrationMissing: false });
  });
});
