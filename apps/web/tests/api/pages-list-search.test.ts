/**
 * Pages list search tests (Area 3: R18 + K9 wildcard search).
 *
 * - SQL path: % and _ in a search term match literally (escaped
 *   ILIKE with an explicit ESCAPE), never as wildcards.
 * - Supabase ranged path: the or() ilike pattern carries the same
 *   escaping, so the two paths agree.
 * - Supabase fallback path (terms with , ( ) "): the fetch is
 *   paginated in 1,000-row chunks, so a metacharacter search over
 *   a large workspace searches the full set — the old single
 *   fetch silently truncated at PostgREST's 1,000-row cap. The
 *   mock below enforces that cap on un-ranged fetches, which is
 *   what makes the chunking observable (and what makes this test
 *   fail on the old code).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';

describe('Pages list search (R18, K9 wildcards)', () => {
  let validSessionCookie: string;

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

  function listRequest(search: string) {
    return new NextRequest(
      `http://localhost:3000/api/tenant/acme/pages?search=${encodeURIComponent(search)}`,
      { headers: { cookie: validSessionCookie } }
    );
  }

  it('SQL path escapes % and _ so they match literally, with an explicit ESCAPE', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        calls.push([sql, params ?? []]);
        return Promise.resolve([
          {
            id: '33333333-3333-4333-a333-333333333333',
            facebook_account_id: accountId,
            account_display_name: 'Alex Marketing',
            fb_page_id: 'page_pct',
            page_name: '100%_x Deals',
            profile_picture_url: null,
            category: 'Retail',
            starting_followers: 10,
            current_followers: 12,
            status: 'active',
            tasks: [],
            created_at: '2026-10-10T10:00:00.000Z',
            updated_at: '2026-10-10T10:00:00.000Z',
          },
        ]);
      }),
    } as unknown as DatabaseClient;

    const res = await handleListPages(listRequest('100%_x'), 'acme', mockDb);
    expect(res.status).toBe(200);
    const ilikeCalls = calls.filter(([sql]) => sql.includes('ILIKE'));
    expect(ilikeCalls.length).toBeGreaterThan(0);
    // The LIKE parameter carries the escaped term, not the raw
    // wildcards: unescaped, '100%_x' would match '1000ax' too.
    expect(
      ilikeCalls.some(([, params]) =>
        (params as unknown[]).includes('%100\\%\\_x%')
      )
    ).toBe(true);
    expect(ilikeCalls.some(([sql]) => sql.includes("ESCAPE '\\'"))).toBe(
      true
    );
  });

  it('Supabase ranged path builds the same escaped ilike pattern in or()', async () => {
    const orFilters: string[] = [];
    const destChain: Record<string, unknown> = {};
    destChain.select = () => destChain;
    destChain.eq = () => destChain;
    destChain.or = (filters: string) => {
      orFilters.push(filters);
      return destChain;
    };
    destChain.not = () => destChain;
    destChain.order = () => destChain;
    destChain.range = () => destChain;
    destChain.then = (resolve: (value: unknown) => void) => {
      resolve({ data: [], error: null, count: 0 });
    };
    const wsChain = {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { id: 'ws_123' }, error: null }),
          }),
          maybeSingle: () =>
            Promise.resolve({ data: { id: 'ws_123' }, error: null }),
        }),
      }),
    };
    const mockSupabase = {
      from: (table: string) => (table === 'workspaces' ? wsChain : destChain),
    };

    const res = await handleListPages(
      listRequest('100%_x'),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    expect(
      orFilters.some((filters) =>
        filters.includes('name.ilike.%100\\%\\_x%')
      )
    ).toBe(true);
  });

  it('Supabase fallback path pages past 1,000 rows in chunks for metacharacter searches', async () => {
    const rangeCalls: Array<[number, number]> = [];
    const seed: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1000; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      seed.push({
        id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
        account_id: accountId,
        external_destination_id: `filler_${i}`,
        name: `Filler ${i}`,
        avatar_url: null,
        metadata: {
          category: 'Misc',
          tasks: [],
          starting_followers: 0,
          current_followers: 0,
        },
        status: 'active',
        created_at: `2026-10-${day}T10:00:00.000Z`,
        updated_at: `2026-10-${day}T10:00:00.000Z`,
        social_accounts: { display_name: 'Alex', avatar_url: null },
      });
    }
    // The target is the OLDEST row, so it lands in the second
    // 1,000-row chunk — past the old single-fetch cap.
    seed.push({
      id: '22222222-2222-4222-8222-222222222222',
      account_id: accountId,
      external_destination_id: 'old_page',
      name: 'Old,Page Shop',
      avatar_url: null,
      metadata: {
        category: 'Shop',
        tasks: [],
        starting_followers: 5,
        current_followers: 7,
      },
      status: 'active',
      created_at: '2025-01-01T10:00:00.000Z',
      updated_at: '2025-01-01T10:00:00.000Z',
      social_accounts: { display_name: 'Alex', avatar_url: null },
    });

    function makeChain(table: string) {
      const chain: Record<string, unknown> = {
        ranged: false,
        from: 0,
        to: 0,
      };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.order = () => chain;
      chain.range = (from: number, to: number) => {
        (chain as { ranged: boolean }).ranged = true;
        (chain as { from: number }).from = from;
        (chain as { to: number }).to = to;
        if (table === 'destinations') rangeCalls.push([from, to]);
        return chain;
      };
      chain.then = (resolve: (value: unknown) => void) => {
        if (table === 'queue_items') {
          resolve({ data: [], error: null, count: 0 });
          return;
        }
        let rows = [...seed].sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
        // PostgREST's cap, enforced by this mock: an un-ranged
        // fetch returns at most the first 1,000 rows.
        if ((chain as { ranged: boolean }).ranged) {
          rows = rows.slice(
            (chain as { from: number }).from,
            (chain as { to: number }).to + 1
          );
        } else {
          rows = rows.slice(0, 1000);
        }
        resolve({ data: rows, error: null });
      };
      return chain;
    }
    const wsChain = {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: { id: 'ws_123' }, error: null }),
          }),
          maybeSingle: () =>
            Promise.resolve({ data: { id: 'ws_123' }, error: null }),
        }),
      }),
    };
    const mockSupabase = {
      from: (table: string) =>
        table === 'workspaces' ? wsChain : makeChain(table),
    };

    const res = await handleListPages(
      listRequest('Old,Page'),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.pages).toHaveLength(1);
    expect(json.pages[0].pageName).toBe('Old,Page Shop');
    // The second chunk was actually requested.
    expect(rangeCalls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});
