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

/**
 * Plan-check C2 fix-up — the `get_entitlement` RPC answer,
 * computed straight from the fixture period rows the way the SQL
 * function does (active period window, ever-paid flag; usage is
 * zero here because this fake carries no usage rows). A real
 * implementation against the tables, not a canned success — a
 * broken RPC still fails the parity tests.
 */
const RPC_PLATFORMS = ['facebook', 'instagram', 'threads', 'x', 'tiktok', 'youtube'] as const;

function computeEntitlementRpc(periods: Row[], userId: string, nowIso: string): Row {
  const mine = periods.filter((row) => row['user_id'] === userId);
  const sortedActive = mine
    .filter(
      (row) =>
        row['superseded_at'] === null &&
        typeof row['starts_at'] === 'string' &&
        (row['starts_at'] as string) <= nowIso &&
        typeof row['ends_at'] === 'string' &&
        (row['ends_at'] as string) > nowIso
    )
    .sort((a, b) => String(b['ends_at']).localeCompare(String(a['ends_at'])));
  const active: Row | null = sortedActive.length > 0 ? sortedActive[0] : null;
  const usage: Row = {};
  for (const platform of RPC_PLATFORMS) usage[platform] = 0;
  return {
    period: active ? { ...active } : null,
    usage,
    has_prior_period: mine.length > 0,
  };
}

function fakeClient(periods: Row[]): unknown {
  return {
    from: (table: string) => {
      if (table === 'subscription_periods') return new FakeBuilder(table, periods);
      return new FakeBuilder(table, []);
    },
    rpc: (fn: string, args: { p_user_id: string; p_now: string }) => {
      if (fn !== 'get_entitlement') {
        return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
      }
      return Promise.resolve({
        data: computeEntitlementRpc(periods, args.p_user_id, args.p_now),
        error: null,
      });
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
