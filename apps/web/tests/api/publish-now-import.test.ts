/**
 * Publish Now import route tests (spec 174 1B).
 *
 * The import step runs before the picker: for each selected Facebook
 * account it fetches the account's pages live from Graph and upserts
 * one destination copy per page with `section = 'publish_now'`.
 * The import never adopts or mutates another section's row, a removed
 * stub is reactivated by the import, an active copy keeps its follower
 * baseline, and pages without a Graph token are skipped, never imported.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptToken, signSessionToken } from '@fbuploadpro/contracts';
import { handleImportPublishNowPages } from '../../src/app/api/tenant/[subdomain]/publishing/publish-now/import/route';

const TEST_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WS_ID = 'aaaaaaaa-aaaa-4111-a111-aaaaaaaaaaaa';
const ACCOUNT_ID = '22222222-2222-4222-a222-222222222222';
const ACCOUNT_ID_2 = '33333333-3333-4333-a333-333333333333';

type Row = Record<string, unknown>;

function graphPage(overrides: Row = {}): Row {
  return {
    id: 'page_1001',
    name: 'Brand Flagship Page',
    category: 'Retail Company',
    tasks: ['CREATE_CONTENT'],
    access_token: 'page_token_1001',
    followers_count: 52000,
    picture: { data: { url: 'https://example.com/pic.jpg' } },
    ...overrides,
  };
}

/**
 * Minimal in-memory Supabase fake: the route only ever reads
 * social_accounts (maybeSingle) and destinations (select + upsert),
 * plus the account-probe update on token death.
 */
class FakeBuilder {
  private filters: Array<(row: Row) => boolean> = [];
  private inFilters: Array<(row: Row) => boolean> = [];
  private updateData: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
    private readonly calls: { upserts: Row[][]; updates: Row[] },
    private readonly failUpsert: () => boolean
  ) {}

  select() {
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push((row) => row[col] === val);
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.inFilters.push((row) => vals.includes(row[col]));
    return this;
  }

  update(data: Row) {
    this.updateData = data;
    return this;
  }

  upsert(rows: Row[]) {
    this.calls.upserts.push(rows);
    if (this.failUpsert()) {
      return Promise.resolve({ error: { message: 'upsert boom' } });
    }
    for (const row of rows) {
      const existing = this.db[this.table].find(
        (r) =>
          r.account_id === row.account_id &&
          r.external_destination_id === row.external_destination_id &&
          r.section === row.section
      );
      if (existing) Object.assign(existing, row);
      else this.db[this.table].push({ ...row });
    }
    return Promise.resolve({ error: null });
  }

  async maybeSingle() {
    const rows = this.filtered();
    return { data: rows[0] ?? null, error: null };
  }

  private filtered(): Row[] {
    return this.db[this.table].filter(
      (row) =>
        this.filters.every((f) => f(row)) && this.inFilters.every((f) => f(row))
    );
  }

  then(
    resolve: (v: { data: Row[]; error: null }) => unknown,
    reject?: (e: unknown) => unknown
  ) {
    if (this.updateData) {
      const rows = this.filtered();
      for (const row of rows) Object.assign(row, this.updateData);
      this.calls.updates.push(this.updateData);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
    return Promise.resolve({ data: this.filtered(), error: null }).then(
      resolve,
      reject
    );
  }
}

describe('Publish Now import (POST /publishing/publish-now/import)', () => {
  let validSessionCookie: string;
  let encryptedAccountToken: string;
  let db: Record<string, Row[]>;
  let calls: { upserts: Row[][]; updates: Row[] };
  let failUpsert = false;
  let fetchMock: Mock<typeof fetch>;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
        workspaceId: WS_ID,
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
    encryptedAccountToken = await encryptToken(
      'mock_long_lived_account_token',
      TEST_ENCRYPTION_KEY
    );
    db = { social_accounts: [], destinations: [] };
    calls = { upserts: [], updates: [] };
    failUpsert = false;
    fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  function fakeSupabase() {
    return {
      from: (table: string) =>
        new FakeBuilder(table, db, calls, () => failUpsert),
    };
  }

  function mockGraph(data: Row[], status = 200) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data }), { status })
    );
  }

  function addAccount(overrides: Row = {}) {
    db.social_accounts.push({
      id: ACCOUNT_ID,
      workspace_id: WS_ID,
      platform: 'facebook',
      display_name: 'Shahzeb FB',
      encrypted_access_token: encryptedAccountToken,
      status: 'active',
      ...overrides,
    });
  }

  function req(body: unknown, cookie = validSessionCookie) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (cookie) headers.cookie = cookie;
    return new NextRequest(
      'http://localhost:3000/api/tenant/acme/publishing/publish-now/import',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }
    );
  }

  it('imports discoverable pages as publish_now copies with fresh tokens', async () => {
    addAccount();
    mockGraph([
      graphPage(),
      graphPage({
        id: 'page_1002',
        name: 'Creator Vlog Page',
        access_token: 'page_token_1002',
        followers_count: 14000,
      }),
    ]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.failures).toEqual([]);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].accountId).toBe(ACCOUNT_ID);
    expect(json.groups[0].pages).toHaveLength(2);
    expect(json.groups[0].pages[0]).toMatchObject({
      fbPageId: 'page_1001',
      pageName: 'Brand Flagship Page',
      followers: 52000,
      status: 'active',
    });

    // One upsert, both rows stamped publish_now, active, with the
    // page token encrypted (decrypts back to the Graph token).
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]).toHaveLength(2);
    for (const row of calls.upserts[0]) {
      expect(row.section).toBe('publish_now');
      expect(row.status).toBe('active');
      expect(row.platform).toBe('facebook');
      expect(row.workspace_id).toBe(WS_ID);
      expect(row.account_id).toBe(ACCOUNT_ID);
      const meta = row.metadata as Record<string, unknown>;
      expect(meta).toMatchObject({ starting_followers: meta.current_followers });
    }
    const { decryptToken } = await import('@fbuploadpro/contracts');
    const pageToken = await decryptToken(
      calls.upserts[0][0].encrypted_destination_token as string,
      TEST_ENCRYPTION_KEY
    );
    expect(pageToken).toBe('page_token_1001');
    // The copies are in the store, invisible to any other section.
    expect(
      db.destinations.filter((d) => d.section === 'publish_now')
    ).toHaveLength(2);
  });

  it('preserves the follower baseline of an active existing copy', async () => {
    addAccount();
    db.destinations.push({
      workspace_id: WS_ID,
      account_id: ACCOUNT_ID,
      platform: 'facebook',
      section: 'publish_now',
      external_destination_id: 'page_1001',
      name: 'Brand Flagship Page',
      status: 'active',
      metadata: { starting_followers: 800, current_followers: 1200 },
    });
    mockGraph([graphPage({ followers_count: 53000 })]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const row = calls.upserts[0][0];
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.starting_followers).toBe(800);
    expect(meta.current_followers).toBe(53000);
  });

  it('reactivates a disconnected stub and resets its baseline', async () => {
    addAccount();
    db.destinations.push({
      workspace_id: WS_ID,
      account_id: ACCOUNT_ID,
      platform: 'facebook',
      section: 'publish_now',
      external_destination_id: 'page_1001',
      name: 'Brand Flagship Page',
      status: 'disconnected',
      metadata: { starting_followers: 800, current_followers: 1200 },
    });
    mockGraph([graphPage({ followers_count: 53000 })]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const row = calls.upserts[0][0];
    const meta = row.metadata as Record<string, unknown>;
    expect(row.status).toBe('active');
    expect(meta.starting_followers).toBe(53000);
    expect(meta.current_followers).toBe(53000);
  });

  it('skips pages without a Graph token and non-page nodes', async () => {
    addAccount();
    mockGraph([
      graphPage(),
      // No access_token: can never publish, so never imported.
      graphPage({ id: 'page_1002', name: 'Tokenless Page', access_token: undefined }),
      // Group node: id + name but no category and no tasks.
      { id: 'group_1', name: 'Some Group' },
    ]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.groups[0].pages).toHaveLength(1);
    expect(json.groups[0].pages[0].fbPageId).toBe('page_1001');
    expect(calls.upserts[0]).toHaveLength(1);
  });

  it('records a missing account as a failure and still imports the other account', async () => {
    addAccount({ id: ACCOUNT_ID_2, display_name: 'Second FB' });
    mockGraph([graphPage()]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID, ACCOUNT_ID_2] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.failures).toEqual([ACCOUNT_ID]);
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].accountId).toBe(ACCOUNT_ID_2);
  });

  it('records an account without a stored token as a failure', async () => {
    addAccount({ encrypted_access_token: null });
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.failures).toEqual(['Shahzeb FB']);
    expect(json.groups).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks the account error on a token-dead Graph failure', async () => {
    addAccount();
    mockGraph([], 401);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.failures).toEqual(['Shahzeb FB']);
    expect(json.groups).toEqual([]);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]).toMatchObject({ status: 'error' });
    expect(db.social_accounts[0].status).toBe('error');
  });

  it('records an upsert failure for the account and continues', async () => {
    addAccount();
    failUpsert = true;
    mockGraph([graphPage()]);
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.failures).toEqual(['Shahzeb FB']);
    expect(json.groups).toEqual([]);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await handleImportPublishNowPages(
      req({ accountIds: [ACCOUNT_ID] }, ''),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for an invalid body', async () => {
    addAccount();
    const res = await handleImportPublishNowPages(
      req({ accountIds: [] }),
      'acme',
      fakeSupabase() as never
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
