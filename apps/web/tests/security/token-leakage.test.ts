import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleListAccounts } from '../../src/app/api/tenant/[subdomain]/accounts/route';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import { handleDiscoverPages } from '../../src/app/api/tenant/[subdomain]/accounts/[accountId]/pages/discover/route';
import { handleImportPages } from '../../src/app/api/tenant/[subdomain]/pages/import/route';
import type { Database } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Security Audit: Zero Token & Credential Leakage (T075)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const accountId = '22222222-2222-4222-a222-222222222222';
  const pageId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;
  let sampleCiphertext: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;

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
    sampleCiphertext = await encryptToken('super_confidential_raw_fb_token_xyz', TEST_KEY);
  });

  it('GET /accounts never leaks raw or encrypted access tokens in JSON body or headers', async () => {
    // Evaluating PostgREST double for the accounts Supabase path.
    // The F3 route pushes the counts, the status/rank predicates
    // (or/ilike/in) and the page range down to PostgREST, so the old
    // chain stub cannot answer it. Predicate shapes mirror the F3
    // fake in accounts-list-bg11.test.ts.
    type LeakRow = Record<string, unknown>;
    const fakeValue = (row: LeakRow, column: string): unknown => {
      const arrow = column.indexOf('->>');
      if (arrow >= 0) {
        const holder = row[column.slice(0, arrow)];
        if (holder !== null && typeof holder === 'object' && !Array.isArray(holder)) {
          return (holder as Record<string, unknown>)[column.slice(arrow + 3)];
        }
        return undefined;
      }
      return row[column];
    };
    const compareValues = (
      actual: unknown,
      operator: string,
      expected: string
    ): boolean => {
      if (operator === 'is') {
        return expected === 'null'
          ? actual === null || actual === undefined
          : false;
      }
      if (actual === null || actual === undefined) return false;
      const a = String(actual);
      switch (operator) {
        case 'eq':
          return a === expected;
        case 'neq':
          return a !== expected;
        case 'lt':
          return a < expected;
        case 'lte':
          return a <= expected;
        case 'gt':
          return a > expected;
        case 'gte':
          return a >= expected;
        default:
          throw new Error(`mock: unsupported operator ${operator}`);
      }
    };
    const parseOrClause = (clause: string): ((row: LeakRow) => boolean) => {
      const trimmed = clause.trim();
      if (trimmed.startsWith('and(') || trimmed.startsWith('or(')) {
        throw new Error(`mock: nested or() clause not supported: ${trimmed}`);
      }
      const firstDot = trimmed.indexOf('.');
      const secondDot = trimmed.indexOf('.', firstDot + 1);
      if (firstDot < 0 || secondDot < 0) {
        throw new Error(`mock: cannot parse or() clause ${clause}`);
      }
      const column = trimmed.slice(0, firstDot);
      const operator = trimmed.slice(firstDot + 1, secondDot);
      const value = trimmed.slice(secondDot + 1);
      return (row) => compareValues(fakeValue(row, column), operator, value);
    };
    const ilikeMatches = (value: string, pattern: string): boolean => {
      let re = '^';
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern.charAt(i);
        if (ch === '\\' && i + 1 < pattern.length) {
          re += pattern.charAt(i + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          i++;
        } else if (ch === '%') {
          re += '.*';
        } else if (ch === '_') {
          re += '.';
        } else {
          re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
      }
      re += '$';
      return new RegExp(re, 'i').test(value);
    };
    const accountRows: LeakRow[] = [
      {
        id: accountId,
        external_account_id: 'fb_123',
        display_name: 'Marketing Lead',
        avatar_url: null,
        metadata: {},
        status: 'active',
        token_expires_at: new Date(Date.now() + 86400000).toISOString(),
        encrypted_access_token: sampleCiphertext,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        workspace_id: 'ws_123',
        platform: 'facebook',
        destinations: [
          {
            id: pageId,
            name: 'Brand Main Page',
            avatar_url: null,
            status: 'active',
            workspace_id: 'ws_123',
            metadata: {},
          },
        ],
      },
    ];
    class FakeAccountsQuery {
      private filters: Array<(row: LeakRow) => boolean> = [];
      private orders: Array<{ column: string; ascending: boolean }> = [];
      private rangeFrom: number | null = null;
      private rangeTo: number | null = null;
      private head = false;
      private patch: LeakRow | null = null;
      constructor(private rows: LeakRow[]) {}
      select(
        _columns?: string,
        options?: { count?: string; head?: boolean }
      ): this {
        this.head = options?.head === true && options.count === 'exact';
        return this;
      }
      eq(col: string, val: unknown): this {
        this.filters.push((row) => fakeValue(row, col) === val);
        return this;
      }
      neq(col: string, val: unknown): this {
        this.filters.push((row) => fakeValue(row, col) !== val);
        return this;
      }
      gt(col: string, val: unknown): this {
        this.filters.push((row) =>
          compareValues(fakeValue(row, col), 'gt', String(val))
        );
        return this;
      }
      gte(col: string, val: unknown): this {
        this.filters.push((row) =>
          compareValues(fakeValue(row, col), 'gte', String(val))
        );
        return this;
      }
      lt(col: string, val: unknown): this {
        this.filters.push((row) =>
          compareValues(fakeValue(row, col), 'lt', String(val))
        );
        return this;
      }
      lte(col: string, val: unknown): this {
        this.filters.push((row) =>
          compareValues(fakeValue(row, col), 'lte', String(val))
        );
        return this;
      }
      ilike(col: string, pattern: string): this {
        this.filters.push((row) => {
          const v = fakeValue(row, col);
          return typeof v === 'string' && ilikeMatches(v, pattern);
        });
        return this;
      }
      in(col: string, values: unknown[]): this {
        this.filters.push((row) => values.includes(fakeValue(row, col)));
        return this;
      }
      or(clause: string): this {
        const clauses = clause.split(',').map(parseOrClause);
        this.filters.push((row) => clauses.some((fn) => fn(row)));
        return this;
      }
      order(col: string, options?: { ascending?: boolean }): this {
        this.orders.push({ column: col, ascending: options?.ascending !== false });
        return this;
      }
      range(from: number, to: number): this {
        this.rangeFrom = from;
        this.rangeTo = to;
        return this;
      }
      update(patch: LeakRow): this {
        this.patch = patch;
        return this;
      }
      then(
        resolve: (v: {
          data: LeakRow[] | null;
          error: null;
          count: number | null;
        }) => void
      ): void {
        let rows = this.rows.filter((row) =>
          this.filters.every((fn) => fn(row))
        );
        if (this.patch) {
          for (const row of rows) Object.assign(row, this.patch);
        }
        if (this.head) {
          resolve({ data: [], error: null, count: rows.length });
          return;
        }
        for (let i = this.orders.length - 1; i >= 0; i--) {
          const { column, ascending } = this.orders[i] as {
            column: string;
            ascending: boolean;
          };
          rows = [...rows].sort((a, b) => {
            const av = fakeValue(a, column);
            const bv = fakeValue(b, column);
            if (av === bv) return 0;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            const cmp = String(av) < String(bv) ? -1 : 1;
            return ascending ? cmp : -cmp;
          });
        }
        if (this.rangeFrom !== null && this.rangeTo !== null) {
          rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
        }
        resolve({ data: rows, error: null, count: null });
      }
    }
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          return new FakeAccountsQuery(accountRows);
        }
        return new FakeAccountsQuery([]);
      }),
    } as unknown as SupabaseClient<Database>;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListAccounts(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('super_confidential_raw_fb_token_xyz');
    expect(bodyText).not.toContain(sampleCiphertext);
    expect(bodyText).not.toContain('encrypted_access_token');
    expect(bodyText).not.toContain('encryptedAccessToken');
    expect(bodyText).not.toContain('TOKEN_ENCRYPTION_KEY');
  });

  it('GET /pages never leaks raw or encrypted access tokens in JSON body', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            order: vi.fn(() => builder),
              data: [
                {
                  id: pageId,
                  account_id: accountId,
                  workspace_id: 'ws_123',
                  external_destination_id: 'page_987',
                  name: 'Brand Main Page',
                  avatar_url: null,
                  status: 'active',
                  metadata: {
                    category: 'Retail',
                    starting_followers: 50000,
                    current_followers: 50000,
                    tasks: ['CREATE_CONTENT'],
                  },
                  encrypted_destination_token: sampleCiphertext,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  social_accounts: {
                    display_name: 'Marketing Lead',
                  },
                },
              ],
              error: null,
          };
          builder.eq = vi.fn(() => builder);
          builder.neq = vi.fn(() => builder);
          builder.or = vi.fn(() => builder);
          builder.not = vi.fn(() => builder);
          builder.range = vi.fn(() =>
            Promise.resolve({ data: builder.data, error: null })
          );
          builder.then = vi.fn((resolve: (value: unknown) => void) =>
            resolve({
              count: (builder.data as unknown[]).length,
              data: builder.data,
              error: null,
            })
          );
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListPages(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('super_confidential_raw_fb_token_xyz');
    expect(bodyText).not.toContain(sampleCiphertext);
    expect(bodyText).not.toContain('encrypted_access_token');
    expect(bodyText).not.toContain('encryptedAccessToken');
  });

  it('GET /discover strips Graph API Page access tokens from client payload', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          const builder: any = {
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: accountId,
                external_account_id: 'fb_123',
                display_name: 'Marketing Lead',
                encrypted_access_token: sampleCiphertext,
                status: 'active',
              },
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            then: (resolve: (val: any) => void) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
            // Audit N1: the discover route now pages existing pages
            // with chained .order().range().
            order: vi.fn(() => builder),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page_12345',
              name: 'Enterprise Page',
              category: 'Business',
              followers_count: 1000,
              tasks: ['MANAGE'],
              access_token: 'EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK',
            },
          ],
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/accounts/${accountId}/pages/discover`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleDiscoverPages(req, 'acme', accountId, mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK');
    expect(bodyText).not.toContain('access_token');
    expect(bodyText).not.toContain(sampleCiphertext);
  });

  it('POST /import returns sanitized confirmation without leaking tokens', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          const builder: any = {
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: accountId,
                external_account_id: 'fb_123',
                display_name: 'Marketing Lead',
                encrypted_access_token: sampleCiphertext,
                status: 'active',
              },
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            in: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: pageId,
                    external_destination_id: 'page_12345',
                    name: 'Enterprise Page',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page_12345',
              name: 'Enterprise Page',
              category: 'Business',
              followers_count: 1000,
              tasks: ['MANAGE'],
              access_token: 'EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK',
            },
          ],
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/pages/import',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: validSessionCookie,
        },
        body: JSON.stringify({
          accountId,
          selectedPageIds: ['page_12345'],
        }),
      }
    );

    const res = await handleImportPages(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK');
    expect(bodyText).not.toContain('access_token');
    expect(bodyText).not.toContain(sampleCiphertext);
  });
});
