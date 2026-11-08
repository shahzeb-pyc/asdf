/**
 * Reconnect flips ONLY invalid_token ADU configs (spec §3.3, B2).
 *
 * refreshConnectedPageTokens still refreshes page tokens for ALL
 * pages under the account; the ADU flip is scoped to configs with
 * status `invalid_token` whose destination was actually refreshed.
 * Every other config status keeps its own recovery path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { decryptToken } from '@fbuploadpro/contracts';
import { refreshConnectedPageTokens } from '../../src/app/api/auth/facebook/callback/route';

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKSPACE_ID = 'ws-1';
const ACCOUNT_ROW_ID = 'acc-1';

type Row = Record<string, unknown>;

type Filter =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'in'; col: string; val: unknown[] };

class FakeBuilder {
  filters: Filter[] = [];
  private mode: 'select' | 'update' = 'select';
  private updateValues: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>
  ) {}

  select() {
    this.mode = 'select';
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  update(values: Row) {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  private matched(): Row[] {
    return (this.store[this.table] ?? []).filter((row) =>
      this.filters.every((f) =>
        f.op === 'eq' ? row[f.col] === f.val : true
      )
    );
  }

  then(resolve: (value: { data?: Row[] | null; error: null }) => void) {
    if (this.mode === 'update') {
      for (const row of this.matched()) Object.assign(row, this.updateValues);
      resolve({ error: null });
    } else {
      resolve({ data: this.matched(), error: null });
    }
  }
}

function buildStore(): Record<string, Row[]> {
  return {
    destinations: [
      {
        id: 'dest-1',
        external_destination_id: 'fb-page-1',
        status: 'error',
        metadata: {},
        account_id: ACCOUNT_ROW_ID,
        workspace_id: WORKSPACE_ID,
        platform: 'facebook',
      },
      {
        id: 'dest-2',
        external_destination_id: 'fb-page-2',
        status: 'active',
        metadata: {},
        account_id: ACCOUNT_ROW_ID,
        workspace_id: WORKSPACE_ID,
        platform: 'facebook',
      },
      {
        id: 'dest-3',
        external_destination_id: 'fb-page-3',
        status: 'error',
        metadata: {},
        account_id: 'acc-other',
        workspace_id: WORKSPACE_ID,
        platform: 'facebook',
      },
    ],
    adu_configs: [
      { id: 'cfg-invalid', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'invalid_token' },
      { id: 'cfg-verify', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'fb_verification_required' },
      { id: 'cfg-rate', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'fb_rate_limited' },
      { id: 'cfg-missing', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'missing_page_access' },
      { id: 'cfg-not-accessible', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'page_not_accessible' },
      { id: 'cfg-suspended', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'account_suspended' },
      { id: 'cfg-paused', destination_id: 'dest-1', workspace_id: WORKSPACE_ID, status: 'paused' },
      { id: 'cfg-invalid-2', destination_id: 'dest-2', workspace_id: WORKSPACE_ID, status: 'invalid_token' },
      { id: 'cfg-foreign', destination_id: 'dest-3', workspace_id: WORKSPACE_ID, status: 'invalid_token' },
    ],
  };
}

function fakeSupabase(store: Record<string, Row[]>) {
  return {
    from: (table: string) => new FakeBuilder(table, store),
  } as never;
}

function mockPageList(pages: Array<{ id: string; access_token: string }>) {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: pages }))
  );
}

function configStatus(store: Record<string, Row[]>, id: string): string {
  return String(
    store.adu_configs.find((c) => c.id === id)?.status ?? ''
  );
}

describe('refreshConnectedPageTokens — ADU invalid_token flip', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  it('flips only invalid_token configs under refreshed destinations, refreshes all page tokens', async () => {
    const store = buildStore();
    mockPageList([
      { id: 'fb-page-1', access_token: 'fresh-token-1' },
      { id: 'fb-page-2', access_token: 'fresh-token-2' },
    ]);
    await refreshConnectedPageTokens(
      fakeSupabase(store),
      'user-1',
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-access-token',
      new Date(),
      TEST_ENCRYPTION_KEY
    );

    // Flipped: the only invalid_token configs under refreshed pages.
    expect(configStatus(store, 'cfg-invalid')).toBe('active');
    expect(configStatus(store, 'cfg-invalid-2')).toBe('active');
    // Kept: every other status has its own recovery path.
    expect(configStatus(store, 'cfg-verify')).toBe('fb_verification_required');
    expect(configStatus(store, 'cfg-rate')).toBe('fb_rate_limited');
    expect(configStatus(store, 'cfg-missing')).toBe('missing_page_access');
    expect(configStatus(store, 'cfg-not-accessible')).toBe('page_not_accessible');
    expect(configStatus(store, 'cfg-suspended')).toBe('account_suspended');
    expect(configStatus(store, 'cfg-paused')).toBe('paused');
    // Untouched: a config under another account's page.
    expect(configStatus(store, 'cfg-foreign')).toBe('invalid_token');
    // Both destinations got fresh tokens; the error one reactivated.
    const dest1 = store.destinations.find((d) => d.id === 'dest-1');
    const dest2 = store.destinations.find((d) => d.id === 'dest-2');
    expect(dest1?.status).toBe('active');
    expect(dest2?.status).toBe('active');
    expect(
      await decryptToken(
        String(dest1?.encrypted_destination_token ?? ''),
        TEST_ENCRYPTION_KEY
      )
    ).toBe('fresh-token-1');
    expect(
      await decryptToken(
        String(dest2?.encrypted_destination_token ?? ''),
        TEST_ENCRYPTION_KEY
      )
    ).toBe('fresh-token-2');
  });

  it('flips nothing when the page has no fresh token in the list', async () => {
    const store = buildStore();
    // Only page 2 refreshes; page 1 (with the invalid_token configs)
    // is absent from the list, so nothing under it flips.
    mockPageList([{ id: 'fb-page-2', access_token: 'fresh-token-2' }]);
    await refreshConnectedPageTokens(
      fakeSupabase(store),
      'user-1',
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-access-token',
      new Date(),
      TEST_ENCRYPTION_KEY
    );
    expect(configStatus(store, 'cfg-invalid')).toBe('invalid_token');
    expect(configStatus(store, 'cfg-invalid-2')).toBe('active');
  });

  it('flips via the legacy path with the same invalid_token-only scope', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const legacyDb = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM destinations')) {
          return [
            { id: 'dest-1', fb_page_id: 'fb-page-1', status: 'error' },
          ];
        }
        return [];
      }),
    };
    mockPageList([{ id: 'fb-page-1', access_token: 'fresh-token-1' }]);
    await refreshConnectedPageTokens(
      legacyDb as never,
      'user-1',
      WORKSPACE_ID,
      ACCOUNT_ROW_ID,
      'long-access-token',
      new Date(),
      TEST_ENCRYPTION_KEY
    );
    const aduFlip = queries.find((q) => q.sql.includes('UPDATE adu_configs'));
    expect(aduFlip).toBeDefined();
    expect(aduFlip?.sql).toContain("status = 'invalid_token'");
    expect(aduFlip?.params).toEqual(['dest-1', WORKSPACE_ID]);
  });
});
