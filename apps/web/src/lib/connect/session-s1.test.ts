import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { resolveSocialRouteContext } from '@/lib/connect/session';

// No database in this suite: the admin client is null, so the
// live check's dev fallback (session.status === 'active') applies
// and a passing session reaches the 503 database-client stage.
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => null,
}));

const DEV_SECRET =
  'super-secret-session-signing-key-minimum-32-chars-long';

async function requestWithSession(status: 'active' | 'suspended') {
  const token = await signSessionToken(
    {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owneruser@gmail.com',
      subdomain: 'acme',
      role: 'user',
      status,
    },
    DEV_SECRET
  );
  return new NextRequest('http://localhost/api/tenant/acme/accounts/social', {
    headers: { cookie: `fbup_session=${token}` },
  });
}

describe('resolveSocialRouteContext live session validation (S1)', () => {
  it('returns 401 for a suspended session before any tenant or database work', async () => {
    const result = await resolveSocialRouteContext(
      await requestWithSession('suspended'),
      'acme'
    );
    expect(result.errorResponse?.status).toBe(401);
  });

  it('does not 401 an active session — it proceeds to the database stage', async () => {
    const result = await resolveSocialRouteContext(
      await requestWithSession('active'),
      'acme'
    );
    // No admin client in this suite, so the next stage is 503
    // (database unavailable) — the point is the live check passed.
    expect(result.errorResponse?.status).toBe(503);
  });
});
