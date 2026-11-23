/**
 * Mirror detail loader — spec 155 SEND BACK (PR 199, B1).
 *
 * `loadMirror` must select the mirror's own Facebook detail
 * (`fb_status`, `fb_rate_limited_at`) in BOTH paths — the detail
 * header, the Resume lock (B2) and the tick's own-anchor skip (B3)
 * all read it, and the original spec 155 build selected the old
 * column list here (a comment-only diff). The assertions below pin
 * the SELECT text itself, so removing either column from either
 * path fails the test — verified by hand: deleting both columns
 * from both SELECTs fails all four assertions, restoring them
 * passes again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  isLegacyClient: vi.fn(),
  authenticateTenantRoute: vi.fn(),
  resolveWorkspaceIdFromSession: vi.fn(),
}));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: mocks.authenticateTenantRoute,
  getRouteSupabase: vi.fn(() => null),
  isLegacyClient: mocks.isLegacyClient,
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveWorkspaceIdFromSession: mocks.resolveWorkspaceIdFromSession,
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: vi.fn(),
  subscriptionGateResponse: vi.fn(),
}));
vi.mock('@/lib/billing/entitlement', () => ({
  assertFeatureAddWithinCap: vi.fn(),
  getEntitlement: vi.fn(),
  registerUsage: vi.fn(),
  releaseUsageForFeature: vi.fn(),
  SubscriptionGateError: class SubscriptionGateError extends Error {},
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));
vi.mock('@/lib/server/pagination', () => ({
  paginateMeta: vi.fn(),
  parsePaginationParams: vi.fn(),
}));

import { loadMirror, handleUpdateMirror } from './route';

const MIRROR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MIRROR_ROW = {
  id: MIRROR_ID,
  workspace_id: WORKSPACE_ID,
  source_platform: 'tiktok',
  source_username: 'creator',
  source_display_name: 'Creator',
  source_avatar_url: null,
  target_platform: 'facebook',
  target_external_id: '123456',
  target_display_name: 'Page',
  target_avatar_url: null,
  status: 'error',
  catch_up_pending: false,
  last_posted_source_id: null,
  last_posted_create_time: null,
  last_checked_at: null,
  next_check_at: null,
  last_error: 'boom',
  fb_status: 'fb_rate_limited',
  fb_rate_limited_at: '2026-11-01T00:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
};

describe('loadMirror (spec 155 B1)', () => {
  it('selects fb_status and fb_rate_limited_at in the legacy SQL path', async () => {
    mocks.isLegacyClient.mockReturnValue(true);
    const query = vi.fn(async (sql: string, _params: unknown[]) => [MIRROR_ROW]);
    const mirror = await loadMirror({ query } as never, WORKSPACE_ID, MIRROR_ID);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('fb_status');
    expect(sql).toContain('fb_rate_limited_at');
    expect(mirror?.fb_status).toBe('fb_rate_limited');
    expect(mirror?.fb_rate_limited_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('selects fb_status and fb_rate_limited_at in the Supabase path', async () => {
    mocks.isLegacyClient.mockReturnValue(false);
    let selectArg = '';
    const maybeSingle = vi.fn(async () => ({ data: MIRROR_ROW, error: null }));
    const eq = vi.fn(() => ({ eq, maybeSingle }));
    const select = vi.fn((arg: string) => {
      selectArg = arg;
      return { eq };
    });
    const from = vi.fn(() => ({ select }));
    const mirror = await loadMirror({ from } as never, WORKSPACE_ID, MIRROR_ID);
    expect(from).toHaveBeenCalledWith('mirrors');
    expect(selectArg).toContain('fb_status');
    expect(selectArg).toContain('fb_rate_limited_at');
    expect(mirror?.fb_status).toBe('fb_rate_limited');
    expect(mirror?.fb_rate_limited_at).toBe('2026-11-01T00:00:00.000Z');
  });
});

/**
 * Mirror toggle reactivates from any status — spec 236.
 *
 * ON clears the mirror's own Facebook detail (fb_status +
 * fb_rate_limited_at) AND the mirror-section target destination's
 * error state, so the tick's error-skip rule (own fresh cooldown,
 * or error mirror + uncheckable target) cannot block the retry.
 * OFF pauses from any status and leaves the stored detail alone —
 * the card reads Paused from the mirror status. Instagram mirrors
 * never touch a destination. Each ON case FAILS on the old code,
 * which left the fb detail and the target error in place.
 */
type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in'; col: string; val: unknown };

class MirrorFakeBuilder {
  private filters: Filter[] = [];
  private mode: 'select' | 'update' = 'select';
  private updateValues: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>,
    private readonly updatedTables: string[]
  ) {}

  select() {
    this.mode = 'select';
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

  then(resolve: (value: { data?: Row[] | null; error: null }) => void) {
    if (this.mode === 'update') {
      this.updatedTables.push(this.table);
      for (const row of this.matched()) Object.assign(row, this.updateValues);
      resolve({ error: null });
    } else {
      resolve({ data: this.matched(), error: null });
    }
  }
}

interface MirrorSeed {
  status: string;
  targetPlatform?: string;
  fbStatus?: string | null;
  fbRateLimitedAt?: string | null;
  catchUpPending?: boolean;
  destStatus?: string | null;
  destMetadata?: Record<string, unknown>;
}

function mirrorStore(seed: MirrorSeed): {
  store: Record<string, Row[]>;
  updatedTables: string[];
  fake: unknown;
} {
  const store: Record<string, Row[]> = {
    mirrors: [
      {
        id: MIRROR_ID,
        workspace_id: WORKSPACE_ID,
        source_platform: 'tiktok',
        source_username: 'creator',
        source_display_name: 'Creator',
        source_avatar_url: null,
        target_platform: seed.targetPlatform ?? 'facebook',
        target_external_id: '123456',
        target_display_name: 'Page',
        target_avatar_url: null,
        status: seed.status,
        catch_up_pending: seed.catchUpPending ?? false,
        last_posted_source_id: null,
        last_posted_create_time: null,
        last_checked_at: null,
        next_check_at: null,
        last_error: 'boom',
        fb_status: seed.fbStatus ?? null,
        fb_rate_limited_at: seed.fbRateLimitedAt ?? null,
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    destinations:
      seed.destStatus === null || seed.destStatus === undefined
        ? []
        : [
            {
              id: 'dest-1',
              workspace_id: WORKSPACE_ID,
              account_id: 'acc-1',
              external_destination_id: '123456',
              name: 'Page',
              avatar_url: null,
              encrypted_destination_token: 'enc-token',
              platform: seed.targetPlatform ?? 'facebook',
              section: 'mirror',
              status: seed.destStatus,
              metadata: seed.destMetadata ?? {},
              created_at: '2026-11-01T00:00:00.000Z',
              updated_at: '2026-11-01T00:00:00.000Z',
            },
          ],
  };
  const updatedTables: string[] = [];
  const fake = {
    from: (table: string) => new MirrorFakeBuilder(table, store, updatedTables),
  };
  return { store, updatedTables, fake };
}

function patchMirrorRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/tenant/acme/tiktok-mirrors/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockMirrorAuth() {
  mocks.authenticateTenantRoute.mockResolvedValue({
    session: { userId: 'user-1', role: 'user' },
  });
  mocks.resolveWorkspaceIdFromSession.mockResolvedValue(WORKSPACE_ID);
}

describe('handleUpdateMirror toggle reactivates from any status (spec 236)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLegacyClient.mockReturnValue(false);
  });

  it('ON from error clears the mirror fb detail and the target destination error', async () => {
    const { store, fake } = mirrorStore({
      status: 'error',
      fbStatus: 'invalid_token',
      fbRateLimitedAt: null,
      destStatus: 'error',
      destMetadata: { fb_status: 'invalid_token' },
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      MIRROR_ID,
      fake as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toEqual({ ok: true, status: 'active' });
    const mirror = store.mirrors[0] as Row;
    expect(mirror.status).toBe('active');
    expect(mirror.fb_status).toBeNull();
    expect(mirror.fb_rate_limited_at).toBeNull();
    expect(mirror.next_check_at).not.toBeNull();
    // Error -> active does NOT arm catch-up (only paused -> active does).
    expect(mirror.catch_up_pending).toBe(false);
    const dest = store.destinations[0] as Row;
    expect(dest.status).toBe('active');
    expect((dest.metadata as Record<string, unknown>).fb_status).toBeUndefined();
  });

  it('ON from paused with a target fb error clears the target (the Resume-lock case)', async () => {
    const { store, fake } = mirrorStore({
      status: 'paused',
      fbStatus: 'invalid_token',
      destStatus: 'error',
      destMetadata: { fb_status: 'invalid_token' },
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      MIRROR_ID,
      fake as never
    );
    expect(res.status).toBe(200);
    const mirror = store.mirrors[0] as Row;
    expect(mirror.status).toBe('active');
    expect(mirror.fb_status).toBeNull();
    // Paused -> active arms the catch-up rule (existing behaviour).
    expect(mirror.catch_up_pending).toBe(true);
    const dest = store.destinations[0] as Row;
    expect(dest.status).toBe('active');
    expect((dest.metadata as Record<string, unknown>).fb_status).toBeUndefined();
  });

  it('ON from error with a rate-limited target clears the target anchor', async () => {
    const { store, fake } = mirrorStore({
      status: 'error',
      fbStatus: 'fb_rate_limited',
      fbRateLimitedAt: new Date(Date.now() - 60_000).toISOString(),
      destStatus: 'rate_limited',
      destMetadata: { rate_limited_at: new Date(Date.now() - 60_000).toISOString() },
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      MIRROR_ID,
      fake as never
    );
    expect(res.status).toBe(200);
    const mirror = store.mirrors[0] as Row;
    expect(mirror.fb_status).toBeNull();
    expect(mirror.fb_rate_limited_at).toBeNull();
    const dest = store.destinations[0] as Row;
    expect(dest.status).toBe('active');
    expect((dest.metadata as Record<string, unknown>).rate_limited_at).toBeUndefined();
  });

  it('OFF from error pauses the mirror and leaves the stored detail and target alone', async () => {
    const { store, updatedTables, fake } = mirrorStore({
      status: 'error',
      fbStatus: 'invalid_token',
      destStatus: 'error',
      destMetadata: { fb_status: 'invalid_token' },
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'paused' }),
      'acme',
      MIRROR_ID,
      fake as never
    );
    expect(res.status).toBe(200);
    const mirror = store.mirrors[0] as Row;
    expect(mirror.status).toBe('paused');
    expect(mirror.next_check_at).toBeNull();
    // The detail is kept on pause — the card reads Paused from the
    // mirror status, and the tick clears the detail on a clean check.
    expect(mirror.fb_status).toBe('invalid_token');
    expect((store.destinations[0] as Row).status).toBe('error');
    expect(updatedTables).not.toContain('destinations');
  });

  it('ON for an Instagram mirror never touches a destination', async () => {
    const { store, updatedTables, fake } = mirrorStore({
      status: 'error',
      targetPlatform: 'instagram',
      fbStatus: null,
      destStatus: 'error',
      destMetadata: {},
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      MIRROR_ID,
      fake as never
    );
    expect(res.status).toBe(200);
    expect((store.mirrors[0] as Row).status).toBe('active');
    expect(updatedTables).not.toContain('destinations');
    expect((store.destinations[0] as Row).status).toBe('error');
  });

  it('404s for an unknown mirror', async () => {
    const { fake } = mirrorStore({ status: 'paused' });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      fake as never
    );
    expect(res.status).toBe(404);
  });

  it('legacy SQL path: ON from error clears the mirror detail and the target', async () => {
    mocks.isLegacyClient.mockReturnValue(true);
    const mirrorRow = { ...MIRROR_ROW };
    const destRow = {
      id: 'dest-1',
      account_id: 'acc-1',
      external_destination_id: '123456',
      name: 'Page',
      avatar_url: null,
      encrypted_destination_token: 'enc-token',
      status: 'error',
      metadata: { fb_status: 'invalid_token' },
    };
    const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      sqlCalls.push({ sql, params });
      if (sql.includes('FROM mirrors')) return [mirrorRow];
      if (sql.includes('FROM destinations')) return [destRow];
      return [];
    });
    mockMirrorAuth();
    const res = await handleUpdateMirror(
      patchMirrorRequest({ status: 'active' }),
      'acme',
      MIRROR_ID,
      { query } as never
    );
    expect(res.status).toBe(200);
    const mirrorUpdate = sqlCalls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate).toBeDefined();
    expect(mirrorUpdate!.sql).toContain('fb_status = NULL');
    expect(mirrorUpdate!.sql).toContain('fb_rate_limited_at = NULL');
    const destUpdate = sqlCalls.find((c) => c.sql.includes('UPDATE destinations'));
    expect(destUpdate).toBeDefined();
    expect(destUpdate!.sql).toContain("status = 'active'");
    expect(destUpdate!.sql).toContain("metadata - 'fb_status' - 'rate_limited_at'");
  });
});
