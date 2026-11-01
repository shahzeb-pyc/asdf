import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as postUsage } from '@/app/api/tenant/[subdomain]/billing/usage/route';

/**
 * Usage-route Publish-Now rejection (audit fix 2026-11-01,
 * fix 24): Publish Now is uncapped and writes no usage rows, so
 * a publish-now registration on this route is refused loudly
 * instead of being stored and then ignored by the cap.
 */

const authState = vi.hoisted(() => ({ role: 'user' }));
let clientCalls = 0;

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => ({
    session: {
      userId: '11111111-1111-4111-a111-111111111111',
      email: 'buyer@example.com',
      name: 'Buyer',
      subdomain: 'acme',
      role: authState.role,
      status: 'active',
    },
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => ({
      from: () => {
        clientCalls += 1;
        throw new Error('usage route test client must not be touched for a PN rejection');
      },
    }),
  };
});

const ctx = { params: Promise.resolve({ subdomain: 'acme' }) } as never;

describe('usage route Publish-Now rejection', () => {
  beforeEach(() => {
    authState.role = 'user';
    clientCalls = 0;
  });

  it('rejects every legacy Publish-Now feature with 400 before touching the database', async () => {
    for (const feature of ['publish-now', 'instagram-publish-now', 'threads-publish-now']) {
      const req = new NextRequest('http://localhost:3000/api/tenant/acme/billing/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'facebook',
          destinationKey: 'page-1',
          feature,
        }),
      });
      const res = await postUsage(req, ctx);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('INVALID_REQUEST');
      expect(body.message).toBe('Publish Now does not register usage.');
    }
    expect(clientCalls).toBe(0);
  });
});
