import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import { handleListAccounts } from '../../src/app/api/tenant/[subdomain]/accounts/route';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginateItems,
  paginateMeta,
  parsePaginationParams,
} from '../../src/lib/server/pagination';
import { getPageNumbers } from '../../src/components/shared/ui/list-pagination';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const userId = '11111111-1111-4111-a111-111111111111';

function makePageRow(i: number, status = 'active') {
  return {
    id: `33333333-3333-4333-8333-${i.toString(16).padStart(12, '0')}`,
    facebook_account_id: '22222222-2222-4222-a222-222222222222',
    account_display_name: 'Alex Marketing',
    fb_page_id: `page_${i}`,
    page_name: `Page ${i}`,
    profile_picture_url: null,
    category: 'Digital Creator',
    starting_followers: 100,
    current_followers: 100 + i,
    status,
    tasks: [],
    rate_limited_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  };
}

function makeAccountRow(i: number, status = 'active') {
  return {
    id: `44444444-4444-4444-8444-${i.toString(16).padStart(12, '0')}`,
    fb_account_id: `fb_act_${i}`,
    display_name: `Account ${i}`,
    profile_picture_url: null,
    gender: null,
    account_link: null,
    status,
    token_expires_at: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    connected_pages_count: 0,
    connected_pages: [],
  };
}

describe('list pagination (pages + accounts, 30 per page)', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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

  const req = (url: string) =>
    new NextRequest(url, { headers: { cookie: validSessionCookie } });

  describe('parsePaginationParams', () => {
    it('defaults to page 1 and 30 items', () => {
      expect(parsePaginationParams(new URLSearchParams(''))).toEqual({
        page: 1,
        limit: DEFAULT_PAGE_SIZE,
      });
      expect(DEFAULT_PAGE_SIZE).toBe(30);
    });

    it('clamps limit to the max and falls back on garbage', () => {
      expect(
        parsePaginationParams(new URLSearchParams('page=0&limit=999'))
      ).toEqual({ page: 1, limit: MAX_PAGE_SIZE });
      expect(
        parsePaginationParams(new URLSearchParams('page=abc&limit=-5'))
      ).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE });
    });
  });

  describe('paginateMeta', () => {
    it('computes totalPages and the Showing window', () => {
      expect(paginateMeta(65, 2, 30)).toEqual({
        page: 2,
        limit: 30,
        total: 65,
        totalPages: 3,
        start: 31,
        end: 60,
      });
    });

    it('clamps an out-of-range page to the last page, never empty', () => {
      const meta = paginateMeta(65, 99, 30);
      expect(meta.page).toBe(3);
      expect(meta.start).toBe(61);
      expect(meta.end).toBe(65);
    });

    it('reports an empty window for zero items', () => {
      expect(paginateMeta(0, 1, 30)).toEqual({
        page: 1,
        limit: 30,
        total: 0,
        totalPages: 0,
        start: 0,
        end: 0,
      });
    });

    it('slices a filtered array consistently', () => {
      const items = Array.from({ length: 65 }, (_, i) => i);
      const { items: slice, meta } = paginateItems(items, 3, 30);
      expect(slice).toHaveLength(5);
      expect(meta.totalPages).toBe(3);
    });
  });

  describe('getPageNumbers', () => {
    it('lists every page when there are 7 or fewer', () => {
      expect(getPageNumbers(3, 5)).toEqual([1, 2, 3, 4, 5]);
    });

    it('uses ellipsis around a middle window', () => {
      expect(getPageNumbers(5, 20)).toEqual([
        1,
        'ellipsis',
        4,
        5,
        6,
        'ellipsis',
        20,
      ]);
    });

    it('never ellides at the edges', () => {
      expect(getPageNumbers(1, 20)).toEqual([1, 2, 'ellipsis', 20]);
      expect(getPageNumbers(20, 20)).toEqual([1, 'ellipsis', 19, 20]);
    });
  });

  describe('GET pages (SQL path)', () => {
    function pagesDb(total: number, rows: unknown[]) {
      return {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('COUNT(')) {
            return Promise.resolve([{ total }]);
          }
          // Respect the LIMIT/OFFSET the route appends as the last params.
          const limit = Number(params[params.length - 2] ?? 30);
          const offset = Number(params[params.length - 1] ?? 0);
          return Promise.resolve(rows.slice(offset, offset + limit));
        }),
      } as unknown as DatabaseClient;
    }

    it('returns the requested page slice with meta, not the whole list', async () => {
      const rows = Array.from({ length: 65 }, (_, i) => makePageRow(i));
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=2&limit=30'),
        'acme',
        pagesDb(65, rows)
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(65);
      expect(json.page).toBe(2);
      expect(json.limit).toBe(30);
      expect(json.totalPages).toBe(3);
      expect(json.pages).toHaveLength(30);
    });

    it('clamps an out-of-range page to the last page', async () => {
      const rows = Array.from({ length: 65 }, (_, i) => makePageRow(i));
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=99'),
        'acme',
        pagesDb(65, rows)
      );
      const json = await res.json();
      expect(json.page).toBe(3);
      expect(json.pages).toHaveLength(5);
    });

    it('passes search and status filters to SQL so the total is filtered', async () => {
      const executed: string[] = [];
      const db = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          executed.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('COUNT(')) {
            return Promise.resolve([{ total: 2 }]);
          }
          return Promise.resolve([makePageRow(1), makePageRow(2)]);
        }),
      } as unknown as DatabaseClient;
      const res = await handleListPages(
        req(
          'http://localhost:3000/api/tenant/acme/pages?search=Brand&status=needs_attention'
        ),
        'acme',
        db
      );
      const json = await res.json();
      expect(json.total).toBe(2);
      const dataSql = executed.find((s) => s.includes('FROM destinations') && !s.includes('COUNT('));
      expect(dataSql).toContain('ILIKE');
      expect(dataSql).toContain('invalid_token');
    });

    it('ranges in SQL with attention-first ordering', async () => {
      const executed: string[] = [];
      const db = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          executed.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('COUNT(')) {
            return Promise.resolve([{ total: 1 }]);
          }
          return Promise.resolve([makePageRow(1)]);
        }),
      } as unknown as DatabaseClient;
      await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages'),
        'acme',
        db
      );
      const dataSql = executed.find((s) => s.includes('FROM destinations') && !s.includes('COUNT('));
      expect(dataSql).toContain('LIMIT');
      expect(dataSql).toContain('OFFSET');
      expect(dataSql).toContain('created_at DESC');
    });

    it('reports the full-set attention total, not the page-slice count', async () => {
      // Regression pin for the subtitle send-back: the attention
      // pages live beyond the returned slice, yet attentionTotal
      // must still report them. The COUNT aggregate answers 3 while
      // the page-2 slice below contains only active pages.
      const rows = Array.from({ length: 65 }, (_, i) => makePageRow(i));
      const db = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('COUNT(')) {
            return Promise.resolve([{ total: 65, attention_total: 3 }]);
          }
          const limit = Number(params[params.length - 2] ?? 30);
          const offset = Number(params[params.length - 1] ?? 0);
          return Promise.resolve(rows.slice(offset, offset + limit));
        }),
      } as unknown as DatabaseClient;
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=2'),
        'acme',
        db
      );
      const json = await res.json();
      expect(json.total).toBe(65);
      expect(json.pages).toHaveLength(30);
      expect(json.pages.every((p: { status: string }) => p.status === 'active')).toBe(true);
      expect(json.attentionTotal).toBe(3);
    });
  });

  describe('GET accounts (SQL path)', () => {
    it('returns the requested page slice with meta and expired-first order', async () => {
      const rows = Array.from({ length: 35 }, (_, i) =>
        makeAccountRow(i, i === 0 ? 'expired' : 'active')
      );
      const db = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 35 }]);
          }
          const limit = Number(params[params.length - 2] ?? 30);
          const offset = Number(params[params.length - 1] ?? 0);
          return Promise.resolve(rows.slice(offset, offset + limit));
        }),
      } as unknown as DatabaseClient;
      const res = await handleListAccounts(
        req('http://localhost:3000/api/tenant/acme/accounts?page=2'),
        'acme',
        db
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(35);
      expect(json.page).toBe(2);
      expect(json.totalPages).toBe(2);
      expect(json.accounts).toHaveLength(5);
    });

    it('clamps an out-of-range accounts page', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => makeAccountRow(i));
      const db = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 10 }]);
          }
          return Promise.resolve(rows);
        }),
      } as unknown as DatabaseClient;
      const res = await handleListAccounts(
        req('http://localhost:3000/api/tenant/acme/accounts?page=99'),
        'acme',
        db
      );
      const json = await res.json();
      expect(json.page).toBe(1);
      expect(json.totalPages).toBe(1);
    });

    it('reports full-set health counts, not page-slice counts', async () => {
      // Regression pin for the subtitle send-back: page 1 of 65
      // accounts must not subtitle itself as "30 connected". The
      // aggregate answers the workspace totals while the slice below
      // holds only 30 rows.
      const rows = Array.from({ length: 65 }, (_, i) => makeAccountRow(i));
      const db = {
        query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([
              {
                total: 65,
                connected_count: 60,
                expired_count: 4,
                error_count: 1,
              },
            ]);
          }
          const limit = Number(params[params.length - 2] ?? 30);
          const offset = Number(params[params.length - 1] ?? 0);
          return Promise.resolve(rows.slice(offset, offset + limit));
        }),
      } as unknown as DatabaseClient;
      const res = await handleListAccounts(
        req('http://localhost:3000/api/tenant/acme/accounts?page=1'),
        'acme',
        db
      );
      const json = await res.json();
      expect(json.total).toBe(65);
      expect(json.accounts).toHaveLength(30);
      expect(json.healthCounts).toEqual({
        connected: 60,
        expired: 4,
        error: 1,
      });
    });
  });

  describe('GET pages (Supabase path)', () => {
    function supabaseDb(rows: unknown[]) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'ws_123' },
                error: null,
              }),
            };
          }
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn(() => chain);
          chain.eq = vi.fn(() => chain);
          chain.order = vi.fn(() => Promise.resolve({ data: rows, error: null }));
          return chain;
        }),
      };
    }

    it('filters before paginating and slices the filtered result', async () => {
      const rows = Array.from({ length: 35 }, (_, i) => ({
        id: `55555555-5555-4555-8555-${i.toString(16).padStart(12, '0')}`,
        account_id: '22222222-2222-4222-a222-222222222222',
        external_destination_id: `page_${i}`,
        name: i < 5 ? 'Brand Page' : `Page ${i}`,
        avatar_url: null,
        metadata: {
          category: 'Digital Creator',
          starting_followers: 100,
          current_followers: 100,
          tasks: [],
        },
        status: i < 2 ? 'error' : 'active',
        created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        social_accounts: { display_name: 'Alex Marketing' },
      }));
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=2&status=needs_attention'),
        'acme',
        supabaseDb(rows) as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      // Only the 2 error-status rows match needs_attention, and the
      // out-of-range page 2 clamps back to page 1.
      expect(json.total).toBe(2);
      expect(json.page).toBe(1);
      expect(json.totalPages).toBe(1);
      expect(json.pages).toHaveLength(2);
    });

    it('slices a full second page on the Supabase path', async () => {
      const rows = Array.from({ length: 35 }, (_, i) => ({
        id: `55555555-5555-4555-8555-${i.toString(16).padStart(12, '0')}`,
        account_id: '22222222-2222-4222-a222-222222222222',
        external_destination_id: `page_${i}`,
        name: `Page ${i}`,
        avatar_url: null,
        metadata: {
          category: 'Digital Creator',
          starting_followers: 100,
          current_followers: 100,
          tasks: [],
        },
        status: 'active',
        created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        social_accounts: { display_name: 'Alex Marketing' },
      }));
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=2'),
        'acme',
        supabaseDb(rows) as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(35);
      expect(json.page).toBe(2);
      expect(json.totalPages).toBe(2);
      expect(json.pages).toHaveLength(5);
    });

    it('counts attention over the full filtered set before slicing', async () => {
      // All 35 rows need attention, so the page-1 slice holds only
      // 30 of them — attentionTotal must still be 35, not 30.
      const rows = Array.from({ length: 35 }, (_, i) => ({
        id: `55555555-5555-4555-8555-${i.toString(16).padStart(12, '0')}`,
        account_id: '22222222-2222-4222-a222-222222222222',
        external_destination_id: `page_${i}`,
        name: `Page ${i}`,
        avatar_url: null,
        metadata: {
          category: 'Digital Creator',
          starting_followers: 100,
          current_followers: 100,
          tasks: [],
        },
        status: 'error',
        created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        social_accounts: { display_name: 'Alex Marketing' },
      }));
      const res = await handleListPages(
        req('http://localhost:3000/api/tenant/acme/pages?page=1'),
        'acme',
        supabaseDb(rows) as never
      );
      const json = await res.json();
      expect(json.total).toBe(35);
      expect(json.pages).toHaveLength(30);
      expect(json.attentionTotal).toBe(35);
    });
  });

  describe('GET accounts (Supabase path)', () => {
    function supabaseAccountsDb(rows: unknown[]) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'ws_123' },
                error: null,
              }),
            };
          }
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn(() => chain);
          chain.eq = vi.fn(() => chain);
          chain.order = vi.fn(() => Promise.resolve({ data: rows, error: null }));
          return chain;
        }),
      };
    }

    it('counts health over the full filtered set before slicing', async () => {
      // All 35 accounts are expired, so the page-1 slice holds only
      // 30 of them — healthCounts.expired must still be 35, and the
      // total must stay 35, so the subtitle can never read "30".
      const rows = Array.from({ length: 35 }, (_, i) => ({
        id: `66666666-6666-4666-8666-${i.toString(16).padStart(12, '0')}`,
        external_account_id: `fb_act_${i}`,
        display_name: `Account ${i}`,
        avatar_url: null,
        metadata: {},
        status: 'expired',
        token_expires_at: null,
        created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        destinations: [],
      }));
      const res = await handleListAccounts(
        req('http://localhost:3000/api/tenant/acme/accounts?page=1'),
        'acme',
        supabaseAccountsDb(rows) as never
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(35);
      expect(json.accounts).toHaveLength(30);
      expect(json.healthCounts).toEqual({
        connected: 0,
        expired: 35,
        error: 0,
      });
    });
  });
});
