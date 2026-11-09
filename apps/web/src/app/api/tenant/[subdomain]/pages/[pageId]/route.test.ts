/**
 * Page toggle 409s — spec 155 SEND BACK (PR 199, item 6).
 *
 * The status-family gate rejects a Pause/Resume on a page in any
 * Facebook error state with 409 and a per-status message
 * (`STATUS_TOGGLE_BLOCKED_MESSAGES`), never the generic fallback.
 * Each new spec 155 status gets its own refusal; the matrix below
 * pins every message in the SQL path and spot-checks the Supabase
 * path (same gate, same table). `page_checkpoint` is the one
 * asymmetric case: Resume (→active) is allowed — it is the Mark
 * Verified banner — so its 409 fires on Pause instead.
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

/** Stored (status, metadata) per wire status + the 409 message. */
const CASES: Array<{
  wire: string;
  status: string;
  metadata: Record<string, unknown>;
  requested: 'active' | 'paused';
  message: string;
}> = [
  {
    wire: 'invalid_token',
    status: 'error',
    metadata: {},
    requested: 'active',
    message:
      "Cannot change automation while this Page's connection has expired. Reconnect the parent Facebook account first.",
  },
  {
    wire: 'page_checkpoint',
    status: 'error',
    metadata: { fb_status: 'checkpoint' },
    requested: 'paused',
    message:
      'Cannot pause a Page waiting on a Facebook identity check. Use Mark Verified & Reactivate Page first.',
  },
  {
    wire: 'fb_rate_limited',
    status: 'rate_limited',
    metadata: { rate_limited_at: FRESH_ANCHOR },
    requested: 'active',
    message: 'Cannot resume a rate-limited Page yet. It auto-resumes after 3 days.',
  },
  {
    wire: 'page_not_accessible',
    status: 'error',
    metadata: { fb_status: 'page_not_accessible' },
    requested: 'active',
    message:
      'Cannot change automation while this Page is not accessible. Confirm the page still exists and reconnect the parent Facebook account first.',
  },
  {
    wire: 'missing_page_access',
    status: 'error',
    metadata: { fb_status: 'missing_page_access' },
    requested: 'active',
    message:
      'Cannot change automation while this Page is missing access. Ask an admin to restore your role in Business Manager first.',
  },
  {
    wire: 'missing_permission',
    status: 'error',
    metadata: { fb_status: 'missing_permission' },
    requested: 'active',
    message:
      'Cannot change automation while this Page is missing a permission. Ask an admin to grant the permission first.',
  },
  {
    wire: 'check_developer_app',
    status: 'error',
    metadata: { fb_status: 'check_developer_app' },
    requested: 'active',
    message:
      'Cannot change automation while this Page is blocked in the developer app. Fix the problem in your developer app first.',
  },
  {
    wire: 'account_suspended',
    status: 'error',
    metadata: { fb_status: 'account_suspended' },
    requested: 'active',
    message:
      'Cannot change automation while the connected Facebook account is suspended. Once Facebook clears the restriction, try again.',
  },
  {
    wire: '2fa_required_on_BM',
    status: 'error',
    metadata: { fb_status: '2fa_required_on_BM' },
    requested: 'active',
    message:
      'Cannot change automation until Business Manager two-factor authentication is complete.',
  },
];

function fakeSqlDb(current: { status: string; metadata: Record<string, unknown> }) {
  const query = vi.fn(async (sql: string): Promise<unknown[]> => {
    if (sql.includes('SELECT status, metadata, updated_at')) {
      return [{ status: current.status, metadata: current.metadata, updated_at: new Date().toISOString() }];
    }
    return [];
  });
  return { query };
}

class FakeSupabaseQuery {
  private current: { status: string; metadata: Record<string, unknown> };
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(current: { status: string; metadata: Record<string, unknown> }) {
    this.current = current;
  }

  select(_columns: string) {
    this.calls.push({ method: 'select', args: [_columns] });
    return this;
  }

  eq(column: string, value: unknown) {
    this.calls.push({ method: 'eq', args: [column, value] });
    return this;
  }

  update(_updates: unknown) {
    this.calls.push({ method: 'update', args: [_updates] });
    return this;
  }

  async maybeSingle() {
    return {
      data: {
        status: this.current.status,
        metadata: this.current.metadata,
        updated_at: new Date().toISOString(),
      },
      error: null,
    };
  }

  then(
    onFulfilled: (value: { data: null; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) {
    return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
  }
}

function fakeSupabaseDb(current: { status: string; metadata: Record<string, unknown> }) {
  const queries: FakeSupabaseQuery[] = [];
  const from = vi.fn(() => {
    const q = new FakeSupabaseQuery(current);
    queries.push(q);
    return q;
  });
  return { from, queries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWorkspaceIdFromSession.mockResolvedValue(WORKSPACE_ID);
});

describe('handleUpdatePage toggle gate (spec 155)', () => {
  it.each(CASES)(
    'SQL path: $wire refuses $requested with its own 409 message',
    async ({ status, metadata, requested, message }) => {
      const db = fakeSqlDb({ status, metadata });
      const res = await handleUpdatePage(request({ status: requested }), 'acme', PAGE_ID, db as never);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('PAGE_STATUS_NOT_ALLOWED');
      expect(body.message).toBe(message);
    }
  );

  it.each(CASES.filter((c) => c.wire === 'missing_permission' || c.wire === 'fb_rate_limited'))(
    'Supabase path: $wire refuses $requested with its own 409 message',
    async ({ status, metadata, requested, message }) => {
      const db = fakeSupabaseDb({ status, metadata });
      const res = await handleUpdatePage(request({ status: requested }), 'acme', PAGE_ID, db as never);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('PAGE_STATUS_NOT_ALLOWED');
      expect(body.message).toBe(message);
    }
  );

  it('SQL path: checkpoint -> active is allowed (Mark Verified), not a 409', async () => {
    const db = fakeSqlDb({ status: 'error', metadata: { fb_status: 'checkpoint' } });
    // The gate passes; the UPDATE runs (fake answers []), then the
    // re-read must return the reactivated page for the 200.
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT status, metadata, updated_at')) {
        return [{ status: 'error', metadata: { fb_status: 'checkpoint' }, updated_at: new Date().toISOString() }];
      }
      if (sql.trimStart().startsWith('UPDATE')) return [];
      return [
        {
          id: PAGE_ID,
          facebook_account_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          account_display_name: 'Acct',
          account_avatar_url: null,
          fb_page_id: '123',
          page_name: 'Page',
          profile_picture_url: null,
          category: null,
          timezone: 'Asia/Karachi',
          starting_followers: 0,
          current_followers: 0,
          status: 'active',
          tasks: [],
          unmatched_post_types: [],
          created_at: '2026-11-01T00:00:00.000Z',
          updated_at: new Date().toISOString(),
          rate_limited_at: null,
        },
      ];
    });
    const res = await handleUpdatePage(request({ status: 'active' }), 'acme', PAGE_ID, db as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
