import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  _resetMockSupabaseClients,
  _setMockSupabaseServiceClient,
} from '../../src/lib/auth/clients';
import { handleImportPages } from '../../src/app/api/tenant/[subdomain]/pages/import/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

const TEST_SECRET = 'test-session-secret-0123456789abcdef0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';

/**
 * Minimal thenable query builder answering ONLY the billing queries
 * the import cap gate issues: the active-period row list, the
 * per-platform usage head counts, and the already-used keys list.
 * Anything else resolves to an empty result, so a test failure that
 * reaches past the gate surfaces as a wrong status, never a hang.
 */
class BillingBuilder {
  private filters: Array<{ col: string; val: unknown }> = [];
  private headCount = false;

  constructor(
    private readonly table: string,
    private readonly usageCounts: Record<string, number>
  ) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }): this {
    if (opts?.head) this.headCount = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }

  or(_cond: string): this {
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    // Session validation looks the user up by email: active, no
    // password change, so the session stays valid into the gate.
    if (this.table === 'users') {
      return {
        data: {
          id: userId,
          email: 'alexander@gmail.com',
          name: 'Alex Acme',
          phone: null,
          role: 'user',
          status: 'active',
          password_updated_at: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    return { data: null, error: null };
  }

  is(_col: string, _val: unknown): this {
    return this;
  }

  lte(_col: string, _val: unknown): this {
    return this;
  }

  gt(_col: string, _val: unknown): this {
    return this;
  }

  in(_col: string, _val: unknown): this {
    return this;
  }

  order(_col: string, _opts?: { ascending?: boolean }): this {
    return this;
  }

  limit(_n: number): this {
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: Record<string, unknown>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.compute()).then(onfulfilled, onrejected);
  }

  private compute(): Record<string, unknown> {
    if (this.table === 'subscription_periods') {
      return {
        data: [
          {
            id: 'period-1',
            user_id: userId,
            facebook_count: 1,
            instagram_count: 0,
            threads_count: 0,
            x_count: 0,
            tiktok_count: 0,
            youtube_count: 0,
            starts_at: '2026-10-01T00:00:00.000Z',
            ends_at: '2027-01-01T00:00:00.000Z',
            superseded_at: null,
          },
        ],
        error: null,
      };
    }
    if (this.table === 'subscription_usage') {
      if (this.headCount) {
        const platform = this.filters.find((f) => f.col === 'platform')?.val as string;
        return { count: this.usageCounts[platform] ?? 0, error: null };
      }
      // Already-used keys lookup: the new page is not used yet.
      return { data: [], error: null };
    }
    return { data: [], error: null };
  }
}

function billingClient(usageCounts: Record<string, number>): SupabaseClient {
  return {
    from: (table: string) => new BillingBuilder(table, usageCounts),
  } as unknown as SupabaseClient;
}

describe('Feature cap gate on page import (POST /api/tenant/[subdomain]/pages/import)', () => {
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

  afterEach(() => {
    _resetMockSupabaseClients();
  });

  it('rejects an over-cap import with SUBSCRIPTION_CAP_REACHED before any Graph fetch or write', async () => {
    // Active period allows 1 Facebook page; usage already at 1, and
    // the imported page is new — so 1 used + 1 new exceeds the cap.
    // The gate reads the admin client (the mock service client here),
    // never the route's working client.
    _setMockSupabaseServiceClient(billingClient({ facebook: 1 }));
    const mockDb = {
      query: vi.fn().mockResolvedValue([]),
    } as unknown as DatabaseClient;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

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
          selectedPageIds: ['page_1002'],
        }),
      }
    );

    const res = await handleImportPages(req, 'acme', mockDb);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('SUBSCRIPTION_CAP_REACHED');
    // The gate runs before workspace resolution, account lookup, and
    // the Graph fetch: nothing external was touched, nothing written.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
