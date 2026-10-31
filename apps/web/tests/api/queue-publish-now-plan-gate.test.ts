import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handlePublishNow } from '../../src/app/api/tenant/[subdomain]/publishing/queue/[itemId]/publish-now/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-secret-for-publish-now-plan-gate';

/**
 * Audit fix 2026-11-01 (fix 12): queue-item Publish Now IS Publish
 * Now, so it carries the plan-only gate. Free users are refused
 * with 403, a missing billing client fails closed with 503, and
 * admins are exempt (they reach the item lookup and 404 on a
 * missing item instead of hitting the gate). Retry is a different
 * route and stays ungated.
 */

const billingState = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => billingState.client,
  };
});

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

class BillingBuilder {
  constructor(
    private table: string,
    private periods: unknown[]
  ) {}
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
      resolve({ data: this.periods, error: null });
    } else {
      resolve({ data: [], count: 0, error: null });
    }
  }
}

function billingClient(periods: unknown[]): { from(table: string): BillingBuilder } {
  return {
    from(table: string): BillingBuilder {
      return new BillingBuilder(table, periods);
    },
  };
}

describe('queue publish-now plan gate', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const itemId = '55555555-5555-4555-a555-555555555555';

  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
  });

  async function sessionCookie(role: 'user' | 'admin'): Promise<string> {
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role,
        status: 'active',
      },
      TEST_SECRET
    );
    return `fbup_session=${token}`;
  }

  function mockDb(): DatabaseClient {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return [{ id: 'ws-1' }];
      return [];
    });
    return { query } as unknown as DatabaseClient;
  }

  async function callGate(role: 'user' | 'admin'): Promise<Response> {
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/publishing/queue/${itemId}/publish-now`,
      {
        method: 'POST',
        headers: { cookie: await sessionCookie(role) },
      }
    );
    return handlePublishNow(req, 'acme', itemId, mockDb());
  }

  it('refuses a Free user with 403 before any item lookup', async () => {
    billingState.client = billingClient([]);
    const res = await callGate('user');
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('fails closed with 503 when the billing client is missing', async () => {
    billingState.client = null;
    const res = await callGate('user');
    expect(res.status).toBe(503);
  });

  it('exempts admins: they pass the gate and reach the item lookup', async () => {
    billingState.client = null;
    const res = await callGate('admin');
    // No queue row in the fake db, so the item lookup 404s — the
    // point is the admin never sees the 403/503 gate response.
    expect(res.status).toBe(404);
  });

  it('lets a paid user through the gate to the item lookup', async () => {
    billingState.client = billingClient([paidPeriodRow]);
    const res = await callGate('user');
    expect(res.status).toBe(404);
  });
});
