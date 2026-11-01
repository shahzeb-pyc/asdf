import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, type DatabaseClient } from '@fbuploadpro/contracts';
import {
  handleGetPage,
  handleUpdatePage,
} from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/route';
import { handlePublishNow } from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now/route';

/**
 * Pages status family (audit R1/R2/R3/R21, Shahzeb's locked
 * 1A/2A/4A/5A decisions): the status PATCH gate, the Queue/Dashboard
 * Publish Now gate, and the dedicated detail rate-limit cooldown
 * flip. Mocks model RAW destinations rows (unified vocabulary:
 * 'active' / 'disconnected' + fb_status marker / 'error' +
 * checkpoint marker / 'rate_limited'), never the wire-formatted
 * detail row — a mock that returns a wire 'paused' status for the
 * gate query would map to 'disconnected' and wrongly 409.
 */

const TEST_SECRET = ['pages', 'status', 'family', 'test', 'secret', 'key'].join('-');

const userId = '11111111-1111-4111-a111-111111111111';
const pageId = '22222222-2222-4222-a222-222222222222';
const accountId = '33333333-3333-4333-a333-333333333333';
const itemId = '55555555-5555-4555-a555-555555555555';

let validSessionCookie: string;

function patchRequest(body: unknown) {
  return new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
    method: 'PATCH',
    headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { cookie: validSessionCookie },
  });
}

/** SQL mock: gate row (raw) + detail row (wire) are distinct queries. */
function sqlMock(gateRow: Record<string, unknown> | null, detailRow: Record<string, unknown> | null) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM workspaces')) {
        return Promise.resolve([{ id: 'ws_123' }]);
      }
      if (sql.includes('SELECT status, metadata, updated_at')) {
        return Promise.resolve(gateRow ? [gateRow] : []);
      }
      if (sql.includes('UPDATE destinations')) {
        return Promise.resolve([]);
      }
      if (sql.includes('FROM destinations')) {
        return Promise.resolve(detailRow ? [detailRow] : []);
      }
      if (sql.includes('FROM queue_items')) {
        return Promise.resolve([{ queued: 0, publishing: 0, published: 0, failed: 0 }]);
      }
      return Promise.resolve([]);
    }),
  } as unknown as DatabaseClient;
}

function wireDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: pageId,
    facebook_account_id: accountId,
    account_display_name: 'Alex Acme Account',
    fb_page_id: 'fb_page_999',
    page_name: 'Acme Brand',
    profile_picture_url: null,
    category: 'Brand',
    timezone: 'UTC',
    starting_followers: 100,
    current_followers: 150,
    status: 'active',
    tasks: ['CREATE_CONTENT'],
    unmatched_post_types: [],
    created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
    updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
    ...overrides,
  };
}

/**
 * Audit fix 2026-11-01 (fix 12): the queue-item Publish Now route
 * carries the plan-only gate, so these tests give it a billing
 * client with an active paid period. The fake ignores the user_id
 * filter — every gated user reads as paid here, which preserves
 * every downstream expectation (ownership/item checks still run
 * after the gate).
 */
const paidPeriodRow = {
  id: 'period-paid',
  user_id: 'paid-user',
  facebook_count: 5,
  instagram_count: 5,
  threads_count: 5,
  x_count: 0,
  tiktok_count: 0,
  youtube_count: 0,
  starts_at: '2020-01-01T00:00:00.000Z',
  ends_at: '2030-01-01T00:00:00.000Z',
  superseded_at: null,
};

class PaidBillingBuilder {
  constructor(private table: string) {}
  select(): this { return this; }
  eq(): this { return this; }
  is(): this { return this; }
  lte(): this { return this; }
  gt(): this { return this; }
  neq(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  then(resolve: (value: unknown) => void): void {
    if (this.table === 'subscription_periods') {
      resolve({ data: [paidPeriodRow], error: null });
    } else {
      resolve({ data: [], count: 0, error: null });
    }
  }
}

const paidBillingClient = {
  from(table: string): PaidBillingBuilder {
    return new PaidBillingBuilder(table);
  },
};

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => paidBillingClient,
  };
});

describe('Pages status family', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  describe('status PATCH gate (SQL path)', () => {
    it('blocks Pause on a checkpoint page (409, update never runs)', async () => {
      const mockDb = sqlMock(
        { status: 'error', metadata: { fb_status: 'checkpoint' }, updated_at: new Date().toISOString() },
        null
      );
      const res = await handleUpdatePage(patchRequest({ status: 'paused' }), 'acme', pageId, mockDb);
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe('PAGE_STATUS_NOT_ALLOWED');
      const calls = (mockDb.query as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>;
      expect(calls.some(([sql]) => sql.includes('UPDATE destinations'))).toBe(false);
    });

    it('blocks Resume on an expired-token page (409)', async () => {
      const mockDb = sqlMock(
        { status: 'error', metadata: {}, updated_at: new Date().toISOString() },
        null
      );
      const res = await handleUpdatePage(patchRequest({ status: 'active' }), 'acme', pageId, mockDb);
      expect(res.status).toBe(409);
    });

    it('blocks Resume on a rate-limited page before the cooldown (409)', async () => {
      const now = new Date().toISOString();
      const mockDb = sqlMock(
        { status: 'rate_limited', metadata: { rate_limited_at: now }, updated_at: now },
        null
      );
      const res = await handleUpdatePage(patchRequest({ status: 'active' }), 'acme', pageId, mockDb);
      expect(res.status).toBe(409);
    });

    it('allows Pause on a rate-limited page past the cooldown (200)', async () => {
      const past = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const mockDb = sqlMock(
        { status: 'rate_limited', metadata: { rate_limited_at: past }, updated_at: past },
        wireDetailRow({ status: 'paused' })
      );
      const res = await handleUpdatePage(patchRequest({ status: 'paused' }), 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });

    it('blocks Pause on a disconnected page (409, not success)', async () => {
      const mockDb = sqlMock(
        { status: 'disconnected', metadata: {}, updated_at: new Date().toISOString() },
        null
      );
      const res = await handleUpdatePage(patchRequest({ status: 'paused' }), 'acme', pageId, mockDb);
      expect(res.status).toBe(409);
      expect((await res.json()).success).not.toBe(true);
    });
  });

  describe('status PATCH gate (Supabase path) — Mark Verified preserved', () => {
    function supabaseMock(readRow: Record<string, unknown>, detailRow: Record<string, unknown>) {
      const workspacesChain: Record<string, unknown> = {
        eq: vi.fn(() => workspacesChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ws_123' }, error: null }),
      };
      const readChain: Record<string, unknown> = {
        eq: vi.fn(() => readChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: readRow, error: null }),
      };
      const detailChain: Record<string, unknown> = {
        eq: vi.fn(() => detailChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: detailRow, error: null }),
      };
      const updateBuilder: Record<string, unknown> = {
        eq: vi.fn(() => updateBuilder),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return { select: vi.fn(() => workspacesChain) };
          if (table === 'destinations') {
            return {
              select: vi.fn((fields: string) =>
                fields.includes('social_accounts') ? detailChain : readChain
              ),
              update: vi.fn(() => updateBuilder),
            };
          }
          return {};
        }),
      };
    }

    function supabaseDetailRow(status: string, metadata: Record<string, unknown>) {
      return {
        id: pageId,
        account_id: accountId,
        external_destination_id: 'fb_page_999',
        name: 'Acme Brand',
        avatar_url: null,
        timezone: 'UTC',
        metadata: {
          category: 'Brand',
          tasks: ['CREATE_CONTENT'],
          starting_followers: 100,
          current_followers: 150,
          ...metadata,
        },
        status,
        created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
        updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
        social_accounts: { display_name: 'Alex Acme Account', avatar_url: null },
      };
    }

    it('allows checkpoint -> active (Mark Verified) and clears the marker path', async () => {
      const mock = supabaseMock(
        { status: 'error', metadata: { fb_status: 'checkpoint' }, updated_at: new Date().toISOString() },
        supabaseDetailRow('active', {})
      );
      const res = await handleUpdatePage(
        patchRequest({ status: 'active' }),
        'acme',
        pageId,
        mock as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.page.status).toBe('active');
    });

    it('blocks checkpoint -> paused (409)', async () => {
      const mock = supabaseMock(
        { status: 'error', metadata: { fb_status: 'checkpoint' }, updated_at: new Date().toISOString() },
        supabaseDetailRow('error', { fb_status: 'checkpoint' })
      );
      const res = await handleUpdatePage(
        patchRequest({ status: 'paused' }),
        'acme',
        pageId,
        mock as never
      );
      expect(res.status).toBe(409);
    });
  });

  describe('timezone PATCH on a disconnected page (P1-5)', () => {
    function capturingSqlMock(
      gateRow: Record<string, unknown> | null,
      detailRow: Record<string, unknown> | null
    ) {
      const capturedSql: string[] = [];
      const db = {
        query: vi.fn().mockImplementation((sql: string) => {
          capturedSql.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT status, metadata, updated_at')) {
            return Promise.resolve(gateRow ? [gateRow] : []);
          }
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve(detailRow ? [detailRow] : []);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
      return { db, capturedSql };
    }

    function supabaseMockP15(readRow: Record<string, unknown> | null) {
      const workspacesChain: Record<string, unknown> = {
        eq: vi.fn(() => workspacesChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ws_123' }, error: null }),
      };
      const readChain: Record<string, unknown> = {
        eq: vi.fn(() => readChain),
        maybeSingle: vi.fn().mockResolvedValue({ data: readRow, error: null }),
      };
      const detailChain: Record<string, unknown> = {
        eq: vi.fn(() => detailChain),
        maybeSingle: vi.fn().mockResolvedValue({
          data: readRow
            ? {
                id: pageId,
                account_id: accountId,
                external_destination_id: 'fb_page_999',
                name: 'Acme Brand',
                avatar_url: null,
                timezone: 'UTC',
                metadata: { category: 'Brand', ...(readRow.metadata as Record<string, unknown>) },
                status: readRow.status,
                created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
                updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
                social_accounts: { display_name: 'Alex Acme Account', avatar_url: null },
              }
            : null,
          error: null,
        }),
      };
      const updateBuilder: Record<string, unknown> = {
        eq: vi.fn(() => updateBuilder),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      const updateSpy = vi.fn(() => updateBuilder);
      return {
        updateSpy,
        mock: {
          from: vi.fn((table: string) => {
            if (table === 'workspaces') return { select: vi.fn(() => workspacesChain) };
            if (table === 'destinations') {
              return {
                select: vi.fn((fields: string) =>
                  fields.includes('social_accounts') ? detailChain : readChain
                ),
                update: updateSpy,
              };
            }
            return {};
          }),
        },
      };
    }

    it('rejects a timezone-only PATCH on a plain disconnected page via SQL (409, update never runs)', async () => {
      const { db, capturedSql } = capturingSqlMock(
        { status: 'disconnected', metadata: {}, updated_at: new Date().toISOString() },
        wireDetailRow()
      );
      const res = await handleUpdatePage(
        patchRequest({ timezone: 'Asia/Karachi' }),
        'acme',
        pageId,
        db
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('PAGE_NOT_EDITABLE');
      expect(capturedSql.some((sql) => sql.includes('UPDATE destinations'))).toBe(false);
    });

    it('still 404s a timezone-only PATCH on a missing page via SQL', async () => {
      const { db } = capturingSqlMock(null, null);
      const res = await handleUpdatePage(
        patchRequest({ timezone: 'Asia/Karachi' }),
        'acme',
        pageId,
        db
      );
      expect(res.status).toBe(404);
    });

    it('applies a timezone-only PATCH on a visible page via SQL (200)', async () => {
      const { db } = capturingSqlMock(
        { status: 'active', metadata: {}, updated_at: new Date().toISOString() },
        wireDetailRow()
      );
      const res = await handleUpdatePage(
        patchRequest({ timezone: 'Asia/Karachi' }),
        'acme',
        pageId,
        db
      );
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    });

    it('rejects a timezone-only PATCH on a plain disconnected page via Supabase (409, update never runs)', async () => {
      const { mock, updateSpy } = supabaseMockP15({
        status: 'disconnected',
        metadata: {},
        updated_at: new Date().toISOString(),
      });
      const res = await handleUpdatePage(
        patchRequest({ timezone: 'Asia/Karachi' }),
        'acme',
        pageId,
        mock as never
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('PAGE_NOT_EDITABLE');
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('applies a timezone-only PATCH on a visible page via Supabase (200)', async () => {
      const { mock, updateSpy } = supabaseMockP15({
        status: 'active',
        metadata: {},
        updated_at: new Date().toISOString(),
      });
      const res = await handleUpdatePage(
        patchRequest({ timezone: 'Asia/Karachi' }),
        'acme',
        pageId,
        mock as never
      );
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      expect(updateSpy).toHaveBeenCalled();
    });
  });

  describe('dedicated detail rate-limit cooldown flip (5A)', () => {
    it('reads a rate-limited page past cooldown as Active via SQL', async () => {
      const past = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const mockDb = sqlMock(
        null,
        wireDetailRow({ status: 'fb_rate_limited', rate_limited_at: past, updated_at: past })
      );
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleGetPage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.page.status).toBe('active');
    });

    it('reads a rate-limited page before cooldown as Rate Limited via SQL', async () => {
      const now = new Date().toISOString();
      const mockDb = sqlMock(
        null,
        wireDetailRow({ status: 'fb_rate_limited', rate_limited_at: now, updated_at: now })
      );
      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleGetPage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.page.status).toBe('fb_rate_limited');
    });
  });

  describe('Queue/Dashboard Publish Now gate (2A)', () => {
    it('blocks Publish Now on a paused destination via SQL (409 PAGE_NOT_PUBLISHABLE)', async () => {
      let updateRan = false;
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_123' }]);
          if (sql.includes('FROM queue_items')) {
            return Promise.resolve([{ id: itemId, status: 'queued', destination_id: pageId }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([
              { status: 'disconnected', metadata: { fb_status: 'paused' }, updated_at: new Date().toISOString() },
            ]);
          }
          if (sql.includes('UPDATE queue_items')) {
            updateRan = true;
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
      const res = await handlePublishNow(
        postRequest(`/api/tenant/acme/publishing/queue/${itemId}/publish-now`),
        'acme',
        itemId,
        mockDb
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe('PAGE_NOT_PUBLISHABLE');
      expect(updateRan).toBe(false);
    });

    it('blocks Publish Now on a disconnected destination via Supabase (409)', async () => {
      const builderFor = (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.update = () => b;
        b.maybeSingle = () =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: { id: 'ws_123' }, error: null }
              : table === 'destinations'
                ? { data: { status: 'disconnected', metadata: {}, updated_at: new Date().toISOString() }, error: null }
                : { data: { id: itemId, status: 'queued', destination_id: pageId }, error: null }
          );
        b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(onOk, onErr);
        return b;
      };
      const fake = { from: builderFor, rpc: vi.fn().mockResolvedValue({ error: null }) };
      const res = await handlePublishNow(
        postRequest(`/api/tenant/acme/publishing/queue/${itemId}/publish-now`),
        'acme',
        itemId,
        fake as never
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe('PAGE_NOT_PUBLISHABLE');
    });

    it('fails loud on a Supabase destinations-fetch error (500, update never runs)', async () => {
      let updateRan = false;
      const builderFor = (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.update = () => {
          updateRan = true;
          return b;
        };
        b.maybeSingle = () =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: { id: 'ws_123' }, error: null }
              : table === 'destinations'
                ? { data: null, error: { message: 'destinations fetch failed' } }
                : { data: { id: itemId, status: 'queued', destination_id: pageId }, error: null }
          );
        b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(onOk, onErr);
        return b;
      };
      const fake = { from: builderFor, rpc: vi.fn().mockResolvedValue({ error: null }) };
      const res = await handlePublishNow(
        postRequest(`/api/tenant/acme/publishing/queue/${itemId}/publish-now`),
        'acme',
        itemId,
        fake as never
      );
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Failed to load destination');
      expect(updateRan).toBe(false);
    });

    it('fails loud on a missing Supabase destination row (404, update never runs)', async () => {
      let updateRan = false;
      const builderFor = (table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.update = () => {
          updateRan = true;
          return b;
        };
        b.maybeSingle = () =>
          Promise.resolve(
            table === 'workspaces'
              ? { data: { id: 'ws_123' }, error: null }
              : table === 'destinations'
                ? { data: null, error: null }
                : { data: { id: itemId, status: 'queued', destination_id: pageId }, error: null }
          );
        b.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(onOk, onErr);
        return b;
      };
      const fake = { from: builderFor, rpc: vi.fn().mockResolvedValue({ error: null }) };
      const res = await handlePublishNow(
        postRequest(`/api/tenant/acme/publishing/queue/${itemId}/publish-now`),
        'acme',
        itemId,
        fake as never
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Destination not found');
      expect(updateRan).toBe(false);
    });

    it('fails loud on a missing SQL destination row (404, update never runs)', async () => {
      let updateRan = false;
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_123' }]);
          if (sql.includes('FROM queue_items')) {
            return Promise.resolve([{ id: itemId, status: 'queued', destination_id: pageId }]);
          }
          if (sql.includes('FROM destinations')) return Promise.resolve([]);
          if (sql.includes('UPDATE queue_items')) {
            updateRan = true;
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
      const res = await handlePublishNow(
        postRequest(`/api/tenant/acme/publishing/queue/${itemId}/publish-now`),
        'acme',
        itemId,
        mockDb
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('Destination not found');
      expect(updateRan).toBe(false);
    });
  });
});
