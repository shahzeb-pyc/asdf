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
import { aduRpcMissing } from '../../src/lib/server/adu';
import { fetchAduOptions } from '../../src/components/auto-download-upload/adu-hub-page';

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

// The loader cases lived here until F21 collapsed Facebook's
// loadAduOptionsLists into the shared loadAduOptionsListsForPlatform
// (apps/web/src/lib/adu-hub-helpers.ts) — the facebook cases now
// live in apps/web/src/lib/adu-hub-helpers.test.ts, including the
// 1,000-row paging, migrationMissing, and fail-loud coverage.
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
