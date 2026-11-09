/**
 * Facebook OAuth callback — reconnect marker clearing (spec 155
 * SEND BACK, PR 199, item 6).
 *
 * A reconnect hands the page a fresh token, which reactivates an
 * `error` destination — and must also clear its detail marker
 * (`fb_status`) + rate-limit anchor, or the stale marker resurfaces
 * as the wrong status the next time the page flips to error. The
 * Supabase path strips the keys in JS; the legacy path strips them
 * in SQL (`metadata - 'fb_status' - 'rate_limited_at'`). Paused
 * pages keep their marker (their status is not 'error').
 *
 * `refreshConnectedPageTokens` swallows its own errors (best-effort
 * refresh), so every test asserts the update actually happened and
 * that no warning was logged — a broken fake would otherwise pass
 * silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...actual,
    fetchAllFacebookPages: vi.fn(async () => ({
      pages: [
        { id: '111', access_token: 'new-token-111' },
        { id: '222', access_token: 'new-token-222' },
      ],
      truncated: false,
      truncationReason: null,
    })),
    encryptToken: vi.fn(async (token: string) => `enc:${token}`),
  };
});
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(() => null),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
  trackServerEvent: vi.fn(),
}));

import { refreshConnectedPageTokens } from './route';

const USER_ID = 'user-1';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_ROW_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAUSED_PAGE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const ERROR_METADATA = {
  fb_status: 'missing_permission',
  rate_limited_at: '2026-11-01T00:00:00.000Z',
  category: 'Comedy',
};

/** Thenable PostgREST builder recording updates per table. */
class FakeSupabaseQuery {
  table: string;
  calls: Array<{ method: string; args: unknown[] }> = [];
  private pages: Array<Record<string, unknown>>;
  updates: Array<{ table: string; payload: Record<string, unknown> }> = [];

  constructor(table: string, pages: Array<Record<string, unknown>>, updates: FakeSupabaseQuery['updates']) {
    this.table = table;
    this.pages = pages;
    this.updates = updates;
  }

  select(_columns: string) {
    this.calls.push({ method: 'select', args: [_columns] });
    return this;
  }

  eq(column: string, value: unknown) {
    this.calls.push({ method: 'eq', args: [column, value] });
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.calls.push({ method: 'update', args: [payload] });
    this.updates.push({ table: this.table, payload });
    return this;
  }

  then(
    onFulfilled: (value: { data: unknown; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) {
    const value =
      this.calls.some((c) => c.method === 'update')
        ? { data: null, error: null }
        : { data: this.pages, error: null };
    return Promise.resolve(value).then(onFulfilled, onRejected);
  }
}

function fakeSupabaseDb(pages: Array<Record<string, unknown>>) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const queries: FakeSupabaseQuery[] = [];
  const from = vi.fn((table: string) => {
    const q = new FakeSupabaseQuery(table, pages, updates);
    queries.push(q);
    return q;
  });
  return { from, queries, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshConnectedPageTokens marker clearing (spec 155)', () => {
  it('Supabase path: an error page reactivates with fb_status + anchor stripped, other keys kept', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeSupabaseDb([
      {
        id: PAGE_ID,
        external_destination_id: '111',
        status: 'error',
        metadata: { ...ERROR_METADATA },
      },
    ]);
    await refreshConnectedPageTokens(
      db as never,
      USER_ID,
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-token',
      new Date(),
      'test-key'
    );
    expect(warnSpy).not.toHaveBeenCalled();
    const destUpdate = db.updates.find((u) => u.table === 'destinations');
    expect(destUpdate).toBeDefined();
    expect(destUpdate?.payload.status).toBe('active');
    expect(destUpdate?.payload.metadata).toEqual({ category: 'Comedy' });
  });

  it('Supabase path: a paused page keeps its marker (status is not error)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = fakeSupabaseDb([
      {
        id: PAUSED_PAGE_ID,
        external_destination_id: '222',
        status: 'disconnected',
        metadata: { fb_status: 'paused', category: 'Comedy' },
      },
    ]);
    await refreshConnectedPageTokens(
      db as never,
      USER_ID,
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-token',
      new Date(),
      'test-key'
    );
    expect(warnSpy).not.toHaveBeenCalled();
    const destUpdate = db.updates.find((u) => u.table === 'destinations');
    expect(destUpdate).toBeDefined();
    expect(destUpdate?.payload.status).toBe('disconnected');
    expect(destUpdate?.payload).not.toHaveProperty('metadata');
  });

  it('legacy path: an error page reactivates with the SQL marker strip', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, external_destination_id')) {
        return [
          {
            id: PAGE_ID,
            fb_page_id: '111',
            status: 'error',
            metadata: { ...ERROR_METADATA },
          },
        ];
      }
      return [];
    });
    await refreshConnectedPageTokens(
      { query } as never,
      USER_ID,
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-token',
      new Date(),
      'test-key'
    );
    expect(warnSpy).not.toHaveBeenCalled();
    const destUpdate = calls.find((c) => c.sql.includes('UPDATE destinations'));
    expect(destUpdate).toBeDefined();
    expect(destUpdate?.sql).toContain("metadata - 'fb_status' - 'rate_limited_at'");
    expect(destUpdate?.sql).toContain("status = CASE WHEN status = 'error' THEN 'active' ELSE status END");
    expect(calls.some((c) => c.sql.includes('UPDATE adu_configs'))).toBe(true);
  });
});
