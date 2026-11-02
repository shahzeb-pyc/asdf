import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...original,
    getSessionSecret: () => 'test-session-secret',
    verifySessionToken: vi.fn(async (token: string) => {
      if (token === 'bad-token') throw new Error('invalid token');
      if (token === 'suspended-token') {
        return {
          userId: '11111111-1111-4111-a111-111111111111',
          email: 'user@example.com',
          status: 'suspended',
          iat: 1000,
          exp: 2000,
          role: 'user',
          subdomain: 'user',
        };
      }
      return {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'user@example.com',
        status: 'active',
        iat: 1000,
        exp: 2000,
        role: 'user',
        subdomain: 'user',
      };
    }),
  };
});

import { authenticateTenantRoute } from '../../src/lib/route-auth';

function tenantRequest(token?: string): NextRequest {
  return new NextRequest('http://user.localhost:3000/api/tenant/user/pages', {
    method: 'GET',
    headers: token ? { Cookie: `fbup_session=${token}` } : {},
  });
}

/**
 * Route-auth session gate (session-global-check spec §2.1): JWT
 * only — signature + expiry + status claim. No database lookup
 * per call, so no lookup failure can surface as a 401 here.
 */
describe('authenticateTenantRoute session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the session for a valid active-claim token', async () => {
    const result = await authenticateTenantRoute(tenantRequest('good-token'), 'user');
    expect(result.errorResponse).toBeUndefined();
    expect(result.session?.email).toBe('user@example.com');
  });

  it('answers 401 for a suspended status claim without any database lookup', async () => {
    const result = await authenticateTenantRoute(tenantRequest('suspended-token'), 'user');
    expect(result.session).toBeUndefined();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('answers 401 when the token does not verify', async () => {
    const result = await authenticateTenantRoute(tenantRequest('bad-token'), 'user');
    expect(result.session).toBeUndefined();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('answers 401 when no session cookie is present', async () => {
    const result = await authenticateTenantRoute(tenantRequest(), 'user');
    expect(result.session).toBeUndefined();
    expect(result.errorResponse?.status).toBe(401);
  });

  it('still answers 403 for a tenant the session cannot access', async () => {
    const result = await authenticateTenantRoute(tenantRequest('good-token'), 'other');
    expect(result.session).toBeUndefined();
    expect(result.errorResponse?.status).toBe(403);
  });
});
