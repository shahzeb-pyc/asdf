/**
 * @file billing-entitlement-route.test.ts
 * @description Entitlement route fail-loud contract (entitlement
 * rebuild): a broken admin client (misconfigured deployment) must
 * surface as 503 — never as a 200 Free body, which is exactly how
 * paid users randomly saw Free. Genuine Free and genuine Paid still
 * return 200 with the true plan.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/tenant/[subdomain]/billing/entitlement/route';

const { mockGetClient } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
}));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: 'user-1',
      email: 'user@example.com',
      name: 'User',
      subdomain: 'acme',
      role: 'user',
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return { ...actual, getBillingAdminClient: mockGetClient };
});

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;

/** Minimal PostgREST-style chain: every call returns `this`, await resolves rows. */
class FakeBuilder {
  private table: string;
  private rows: Row[];

  constructor(table: string, rows: Row[]) {
    this.table = table;
    this.rows = rows;
  }

  select(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  is(): this {
    return this;
  }

  lte(): this {
    return this;
  }

  gt(): this {
    return this;
  }

  neq(): this {
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  then(
    resolve: (value: { data: Row[]; error: null; count: number }) => void
  ): void {
    resolve({ data: this.rows, error: null, count: this.rows.length });
  }
}

function fakeClient(periods: Row[]): unknown {
  return {
    from: (table: string) => {
      if (table === 'subscription_periods') return new FakeBuilder(table, periods);
      return new FakeBuilder(table, []);
    },
  };
}

function request(): NextRequest {
  return new NextRequest('http://localhost/api/tenant/acme/billing/entitlement');
}

function context(): { params: Promise<{ subdomain: string }> } {
  return { params: Promise.resolve({ subdomain: 'acme' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /billing/entitlement fail-loud contract', () => {
  it('returns 503 (never 200 Free) when the admin-client factory throws', async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not a service-role key');
    });
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('plan');
  });

  it('returns 503 when no admin client exists', async () => {
    mockGetClient.mockReturnValue(null);
    const response = await GET(request(), context());
    expect(response.status).toBe(503);
  });

  it('still returns 200 Free for a genuinely period-less user', async () => {
    mockGetClient.mockReturnValue(fakeClient([]));
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.plan).toBe('free');
    expect(body.active).toBe(false);
    expect(body.hasPriorPeriod).toBe(false);
    expect(body.canPost).toBe(false);
  });

  it('still returns 200 Paid for a user with an active period', async () => {
    mockGetClient.mockReturnValue(
      fakeClient([
        {
          id: 'period-1',
          user_id: 'user-1',
          facebook_count: 10,
          instagram_count: 0,
          threads_count: 0,
          x_count: 0,
          tiktok_count: 0,
          youtube_count: 0,
          starts_at: '2026-01-01T00:00:00.000Z',
          ends_at: '2027-01-01T00:00:00.000Z',
          superseded_at: null,
        },
      ])
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.plan).toBe('paid');
    expect(body.active).toBe(true);
    expect(body.canPost).toBe(true);
  });
});
