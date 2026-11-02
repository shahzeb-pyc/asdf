import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@fbuploadpro/contracts')>();
  return {
    ...original,
    getSessionSecret: () => 'test-session-secret',
    verifySessionToken: vi.fn(async (token: string) => {
      if (token === 'bad-token') throw new Error('invalid token');
      return {
        userId: '11111111-1111-4111-a111-111111111111',
        email: 'user@example.com',
        status: token === 'suspended-token' ? 'suspended' : 'active',
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + 3600,
        role: 'user',
        subdomain: 'user',
      };
    }),
  };
});

const { validateSessionDetailedMock } = vi.hoisted(() => ({ validateSessionDetailedMock: vi.fn() }));

vi.mock('../../src/lib/auth/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/auth/session')>();
  return {
    ...original,
    validateSessionDetailed: validateSessionDetailedMock,
  };
});

import { GET as handleSessionStatus } from '../../src/app/api/auth/session/route';

function sessionRequest(token?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/session', {
    method: 'GET',
    headers: token ? { Cookie: `fbup_session=${token}` } : {},
  });
}

/**
 * Session-status endpoint contract (session-global-check spec §2.2
 * and §3): 200 only for a proven-alive session, 401 only for a
 * proven-dead one, 503 when the user lookup itself fails. A lookup
 * failure must never look like an expired session.
 */
describe('GET /api/auth/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 401 when no session cookie is present', async () => {
    const res = await handleSessionStatus(sessionRequest());
    expect(res.status).toBe(401);
    expect(validateSessionDetailedMock).not.toHaveBeenCalled();
  });

  it('answers 401 when the token does not verify', async () => {
    const res = await handleSessionStatus(sessionRequest('bad-token'));
    expect(res.status).toBe(401);
    expect(validateSessionDetailedMock).not.toHaveBeenCalled();
  });

  it('answers 200 with active:true when the detailed verdict is active', async () => {
    validateSessionDetailedMock.mockResolvedValue('active');
    const res = await handleSessionStatus(sessionRequest('good-token'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ active: true });
  });

  it('answers 401 when the detailed verdict is dead', async () => {
    validateSessionDetailedMock.mockResolvedValue('dead');
    const res = await handleSessionStatus(sessionRequest('good-token'));
    expect(res.status).toBe(401);
  });

  it('answers 503 (never 401) when the user lookup itself fails', async () => {
    validateSessionDetailedMock.mockResolvedValue('error');
    const res = await handleSessionStatus(sessionRequest('good-token'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Service temporarily unavailable. Please try again.');
  });

  it('never leaks user data in the response', async () => {
    validateSessionDetailedMock.mockResolvedValue('active');
    const res = await handleSessionStatus(sessionRequest('good-token'));
    const body = await res.json();
    expect(body).toEqual({ active: true });
    expect(body.email).toBeUndefined();
  });
});
