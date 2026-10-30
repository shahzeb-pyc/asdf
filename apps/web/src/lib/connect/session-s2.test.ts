import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { resolveSocialRouteContext } from '@/lib/connect/session';

// No real database: the admin client is null, so the live check's
// dev fallback applies and the workspace lookup runs against the
// fake client passed in below.
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => null,
}));

const DEV_SECRET =
  'super-secret-session-signing-key-minimum-32-chars-long';

/**
 * Supabase-shaped fake for the workspaces lookup: records every
 * eq() so the test can prove the owner filter was applied, and
 * returns no row (a workspace the caller does not own).
 */
function fakeWorkspacesClient() {
  const eqCalls: Array<[string, unknown]> = [];
  const chain: Record<string, (...args: never[]) => unknown> = {};
  chain.eq = ((column: string, value: unknown) => {
    eqCalls.push([column, value]);
    return chain;
  }) as (...args: never[]) => unknown;
  chain.select = (() => chain) as (...args: never[]) => unknown;
  chain.maybeSingle = (() => ({
    data: null,
    error: null,
  })) as (...args: never[]) => unknown;
  return {
    client: { from: () => chain } as unknown as Parameters<
      typeof resolveSocialRouteContext
    >[2],
    eqCalls,
  };
}

describe('resolveSocialRouteContext admin scoping (S2)', () => {
  it('applies the owner filter even for an admin session, so a foreign workspace resolves to 404', async () => {
    const token = await signSessionToken(
      {
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'adminuser@gmail.com',
        subdomain: 'acme',
        role: 'admin',
        status: 'active',
      },
      DEV_SECRET
    );
    const request = new NextRequest(
      'http://localhost/api/tenant/other/accounts/social',
      { headers: { cookie: `fbup_session=${token}` } }
    );
    const fake = fakeWorkspacesClient();
    const result = await resolveSocialRouteContext(
      request,
      'other',
      fake.client
    );
    // canAccessTenant grants an admin every subdomain, so the
    // request passes the tenant check — but the workspace lookup
    // must still be owner-scoped, find nothing, and 404.
    expect(fake.eqCalls).toContainEqual([
      'owner_id',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(result.errorResponse?.status).toBe(404);
  });
});
