/**
 * Page toggle reactivates from any status — spec 236.
 *
 * The automation toggle is the single switch for intent: ON
 * reactivates the page from ANY Facebook error status (the stored
 * error markers are cleared and the worker retries at the next
 * posting time; a failed publish re-stamps the real error via the
 * publisher mapping), OFF pauses from any status. Only a truly
 * disconnected page has no toggle — it comes back by re-adding.
 * A linked account stamped `expired` by a failed publish is
 * flipped back to `active` on ON (the claim RPCs and the worker
 * gates both require an active account); an account that is
 * `revoked`/`error` still blocks with a reconnect message.
 *
 * Each ON case below FAILS on the old gate (409
 * PAGE_STATUS_NOT_ALLOWED) — verified by running this file before
 * the route change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveWorkspaceIdFromSession: vi.fn(),
}));

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...actual,
    getSessionSecret: () => 'test-secret',
    verifySessionToken: vi.fn(async () => ({
      userId: 'user-1',
      role: 'admin',
      subdomain: 'acme',
      status: 'active',
    })),
    canAccessTenant: () => ({ allowed: true }),
  };
});
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(() => null),
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: mocks.resolveWorkspaceIdFromSession,
}));

import { handleUpdatePage } from './route';

const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/tenant/acme/pages/x', {
    method: 'PATCH',
    headers: {
      cookie: 'fbup_session=test-session',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const FRESH_ANCHOR = new Date(Date.now() - 60_000).toISOString();

interface StoredPage {
  status: string;
  metadata: Record<string, unknown>;
  accountId: string;
  accountStatus: string;
}

/** Wire status of a stored (status, metadata) pair — mirrors DESTINATION_STATUS_TO_WIRE_SQL. */
function wireStatus(stored: { status: string; metadata: Record<string, unknown> }): string {
  const fb = stored.metadata.fb_status;
  if (stored.status === 'disconnected' && fb === 'paused') return 'paused';
  if (stored.status === 'error' && fb === 'checkpoint') return 'page_checkpoint';
  if (
    stored.status === 'error' &&
    typeof fb === 'string' &&
    [
      'invalid_token',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ].includes(fb)
  ) {
    return fb;
  }
  if (stored.status === 'active') return 'active';
  if (stored.status === 'rate_limited') return 'fb_rate_limited';
  if (stored.status === 'error') return 'invalid_token';
  return 'disconnected';
}

function detailRow(stored: StoredPage) {
  return {
    id: PAGE_ID,
    facebook_account_id: ACCOUNT_ID,
    account_display_name: 'Acct',
    account_avatar_url: null,
    fb_page_id: '123',
    page_name: 'Page',
    profile_picture_url: null,
    category: null,
    timezone: 'Asia/Karachi',
    starting_followers: 0,
    current_followers: 0,
    status: wireStatus(stored),
    tasks: [],
    unmatched_post_types: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: new Date().toISOString(),
    rate_limited_at:
      typeof stored.metadata.rate_limited_at === 'string'
        ? stored.metadata.rate_limited_at
        : null,
  };
}

/** Stateful fake for the SQL path: applies the route's UPDATEs to the stored row. */
function fakeSqlDb(stored: StoredPage) {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<unknown[]> => {
    // Gate read (old and new select lists both match): the stored
    // row, account included — the old code ignores the extra field.
    if (
      sql.includes('SELECT status, metadata') &&
      sql.includes('FROM destinations') &&
      !sql.includes('FROM destinations d')
    ) {
      return [
        {
          status: stored.status,
          metadata: stored.metadata,
          account_id: stored.accountId,
          updated_at: new Date().toISOString(),
        },
      ];
    }
    if (sql.includes('FROM destinations d')) {
      return [detailRow(stored)];
    }
    if (sql.includes('FROM social_accounts')) {
      return [{ status: stored.accountStatus }];
    }
    if (sql.trimStart().startsWith('UPDATE social_accounts')) {
      // WHERE status = 'expired': only an expired account flips.
      if (stored.accountStatus === 'expired') stored.accountStatus = 'active';
      return [];
    }
    if (sql.trimStart().startsWith('UPDATE destinations')) {
      const [status, _timezone, _id, pausedMarker, _ws, detailMarker] =
        (params ?? []) as Array<string | boolean | null>;
      if (typeof status === 'string') stored.status = status;
      if (typeof detailMarker === 'string') {
        stored.metadata.fb_status = detailMarker;
      } else if (detailMarker === null) {
        delete stored.metadata.fb_status;
        delete stored.metadata.rate_limited_at;
      } else if (pausedMarker === true) {
        stored.metadata.fb_status = 'paused';
      } else if (pausedMarker === false) {
        delete stored.metadata.fb_status;
        delete stored.metadata.rate_limited_at;
      }
      return [];
    }
    if (sql.includes('FROM destinations d')) {
      return [detailRow(stored)];
    }
    return [];
  });
  return { query, stored };
}

type Row = Record<string, unknown>;

type Filter = { op: 'eq' | 'in'; col: string; val: unknown };

/** Stateful fake for the Supabase path: applies updates to an in-memory store. */
class FakeSupabaseQuery {
  private filters: Filter[] = [];
  private mode: 'select' | 'update' = 'select';
  private updateValues: Row | null = null;
  private selectCols = '';

  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>
  ) {}

  select(cols: string) {
    this.mode = 'select';
    this.selectCols = cols;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.filters.push({ op: 'in', col, val });
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
        f.op === 'eq'
          ? row[f.col] === f.val
          : (f.val as unknown[]).includes(row[f.col])
      )
    );
  }

  async maybeSingle() {
    const rows = this.matched();
    return { data: rows[0] ?? null, error: null };
  }

  then(resolve: (value: { data: Row[] | null; error: null }) => void) {
    if (this.mode === 'update') {
      for (const row of this.matched()) Object.assign(row, this.updateValues);
      resolve({ data: null, error: null });
    } else {
      resolve({ data: this.matched(), error: null });
    }
  }
}

function fakeSupabaseDb(stored: StoredPage) {
  const store: Record<string, Row[]> = {
    destinations: [
      {
        id: PAGE_ID,
        workspace_id: WORKSPACE_ID,
        account_id: stored.accountId,
        external_destination_id: '123',
        name: 'Page',
        avatar_url: null,
        platform: 'facebook',
        timezone: 'Asia/Karachi',
        metadata: stored.metadata,
        status: stored.status,
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: new Date().toISOString(),
        social_accounts: { display_name: 'Acct', avatar_url: null },
      },
    ],
    social_accounts: [
      { id: stored.accountId, workspace_id: WORKSPACE_ID, status: stored.accountStatus },
    ],
  };
  // The destination row's metadata object is the stored one, so the
  // route's read-modify-write and the assertions below see the same state.
  const from = vi.fn((table: string) => new FakeSupabaseQuery(table, store));
  return { from, store, stored };
}

/** Stored (status, metadata, account) per wire status for the ON matrix. */
const ON_CASES: Array<{
  wire: string;
  status: string;
  metadata: Record<string, unknown>;
  accountStatus: string;
}> = [
  {
    wire: 'invalid_token',
    status: 'error',
    metadata: { fb_status: 'invalid_token' },
    accountStatus: 'expired',
  },
  {
    wire: 'page_checkpoint',
    status: 'error',
    metadata: { fb_status: 'checkpoint' },
    accountStatus: 'active',
  },
  {
    wire: 'fb_rate_limited',
    status: 'rate_limited',
    metadata: { rate_limited_at: FRESH_ANCHOR },
    accountStatus: 'active',
  },
  {
    wire: 'page_not_accessible',
    status: 'error',
    metadata: { fb_status: 'page_not_accessible' },
    accountStatus: 'active',
  },
  {
    wire: 'missing_page_access',
    status: 'error',
    metadata: { fb_status: 'missing_page_access' },
    accountStatus: 'active',
  },
  {
    wire: 'missing_permission',
    status: 'error',
    metadata: { fb_status: 'missing_permission' },
    accountStatus: 'active',
  },
  {
    wire: 'check_developer_app',
    status: 'error',
    metadata: { fb_status: 'check_developer_app' },
    accountStatus: 'active',
  },
  {
    wire: 'account_suspended',
    status: 'error',
    metadata: { fb_status: 'account_suspended' },
    accountStatus: 'active',
  },
  {
    wire: '2fa_required_on_BM',
    status: 'error',
    metadata: { fb_status: '2fa_required_on_BM' },
    accountStatus: 'active',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWorkspaceIdFromSession.mockResolvedValue(WORKSPACE_ID);
});

describe('handleUpdatePage toggle reactivates from any status (spec 236)', () => {
  it.each(ON_CASES)(
    'SQL path: ON from $wire reactivates the page and clears the markers',
    async ({ status, metadata, accountStatus }) => {
      const stored: StoredPage = {
        status,
        metadata: { ...metadata },
        accountId: ACCOUNT_ID,
        accountStatus,
      };
      const db = fakeSqlDb(stored);
      const res = await handleUpdatePage(
        request({ status: 'active' }),
        'acme',
        PAGE_ID,
        db as never
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; page: { status: string } };
      expect(body.success).toBe(true);
      expect(body.page.status).toBe('active');
      expect(stored.status).toBe('active');
      expect(stored.metadata.fb_status).toBeUndefined();
      expect(stored.metadata.rate_limited_at).toBeUndefined();
      expect(stored.accountStatus).toBe('active');
    }
  );

  it('SQL path: ON from fb_rate_limited clears the rate-limit anchor', async () => {
    const stored: StoredPage = {
      status: 'rate_limited',
      metadata: { rate_limited_at: FRESH_ANCHOR },
      accountId: ACCOUNT_ID,
      accountStatus: 'active',
    };
    const db = fakeSqlDb(stored);
    const res = await handleUpdatePage(
      request({ status: 'active' }),
      'acme',
      PAGE_ID,
      db as never
    );
    expect(res.status).toBe(200);
    expect(stored.metadata.rate_limited_at).toBeUndefined();
    const body = (await res.json()) as { page: { status: string } };
    expect(body.page.status).toBe('active');
  });

  it.each(
    ON_CASES.filter((c) => c.wire === 'invalid_token' || c.wire === 'fb_rate_limited')
  )(
    'Supabase path: ON from $wire reactivates the page and clears the markers',
    async ({ status, metadata, accountStatus }) => {
      const stored: StoredPage = {
        status,
        metadata: { ...metadata },
        accountId: ACCOUNT_ID,
        accountStatus,
      };
      const db = fakeSupabaseDb(stored);
      const res = await handleUpdatePage(
        request({ status: 'active' }),
        'acme',
        PAGE_ID,
        db as never
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; page: { status: string } };
      expect(body.success).toBe(true);
      expect(body.page.status).toBe('active');
      const row = db.store.destinations[0] as Row;
      expect(row.status).toBe('active');
      const meta = row.metadata as Record<string, unknown>;
      expect(meta.fb_status).toBeUndefined();
      expect(meta.rate_limited_at).toBeUndefined();
      expect((db.store.social_accounts[0] as Row).status).toBe('active');
    }
  );

  it.each(['invalid_token', 'fb_rate_limited'])(
    'SQL path: OFF from %s pauses the page',
    async (wire) => {
      const c = ON_CASES.find((x) => x.wire === wire)!;
      const stored: StoredPage = {
        status: c.status,
        metadata: { ...c.metadata },
        accountId: ACCOUNT_ID,
        accountStatus: c.accountStatus,
      };
      const db = fakeSqlDb(stored);
      const res = await handleUpdatePage(
        request({ status: 'paused' }),
        'acme',
        PAGE_ID,
        db as never
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { page: { status: string } };
      expect(body.page.status).toBe('paused');
      expect(stored.status).toBe('disconnected');
      expect(stored.metadata.fb_status).toBe('paused');
    }
  );

  it('Supabase path: OFF from invalid_token pauses the page and leaves the account alone', async () => {
    const stored: StoredPage = {
      status: 'error',
      metadata: { fb_status: 'invalid_token' },
      accountId: ACCOUNT_ID,
      accountStatus: 'expired',
    };
    const db = fakeSupabaseDb(stored);
    const res = await handleUpdatePage(
      request({ status: 'paused' }),
      'acme',
      PAGE_ID,
      db as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: { status: string } };
    expect(body.page.status).toBe('paused');
    expect((db.store.social_accounts[0] as Row).status).toBe('expired');
  });

  it.each(['active', 'paused'] as const)(
    'SQL path: disconnected still refuses %s with the re-add message',
    async (requested) => {
      const stored: StoredPage = {
        status: 'disconnected',
        metadata: {},
        accountId: ACCOUNT_ID,
        accountStatus: 'active',
      };
      const db = fakeSqlDb(stored);
      const res = await handleUpdatePage(
        request({ status: requested }),
        'acme',
        PAGE_ID,
        db as never
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('PAGE_STATUS_NOT_ALLOWED');
      expect(body.message).toBe(
        'Cannot change automation on a disconnected Page. Add it again first.'
      );
      expect(stored.status).toBe('disconnected');
    }
  );

  it('Supabase path: disconnected still refuses active', async () => {
    const stored: StoredPage = {
      status: 'disconnected',
      metadata: {},
      accountId: ACCOUNT_ID,
      accountStatus: 'active',
    };
    const db = fakeSupabaseDb(stored);
    const res = await handleUpdatePage(
      request({ status: 'active' }),
      'acme',
      PAGE_ID,
      db as never
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('PAGE_STATUS_NOT_ALLOWED');
    expect(body.message).toBe(
      'Cannot change automation on a disconnected Page. Add it again first.'
    );
  });

  it('SQL path: ON with a revoked account refuses with the reconnect message', async () => {
    const stored: StoredPage = {
      status: 'error',
      metadata: { fb_status: 'invalid_token' },
      accountId: ACCOUNT_ID,
      accountStatus: 'revoked',
    };
    const db = fakeSqlDb(stored);
    const res = await handleUpdatePage(
      request({ status: 'active' }),
      'acme',
      PAGE_ID,
      db as never
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('PAGE_STATUS_NOT_ALLOWED');
    expect(body.message).toContain('Reconnect');
    expect(stored.status).toBe('error');
    expect(stored.accountStatus).toBe('revoked');
  });
});
