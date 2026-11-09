import { describe, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getSessionSecret, signSessionToken } from '@fbuploadpro/contracts';

/**
 * Spec 152 O4 — the session-status endpoint's token mode must prove
 * the session from the JWT alone and NEVER touch the database:
 * `validateSessionDetailed` is spied to fail the test if called.
 * The full mode keeps the database-backed verdict.
 */

const mocks = vi.hoisted(() => ({
  validateSessionDetailed: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  validateSessionDetailed: mocks.validateSessionDetailed,
}));

import { GET } from './route';

async function signedToken(status: 'active' | 'suspended'): Promise<string> {
  return signSessionToken(
    {
      userId: '11111111-1111-4111-a111-111111111111',
      email: 'testuser@gmail.com',
      subdomain: 'ws',
      role: 'user',
      status,
    },
    getSessionSecret()
  );
}

function request(token: string | null, mode?: 'token'): NextRequest {
  const url = `http://localhost/api/auth/session${mode ? '?mode=token' : ''}`;
  return new NextRequest(url, {
    headers: token ? { cookie: `fbup_session=${token}` } : {},
  });
}

describe('GET /api/auth/session token mode (spec 152 O4)', () => {
  beforeEach(() => {
    mocks.validateSessionDetailed.mockReset();
  });

  it('token mode + active token answers 200 without a database lookup', async () => {
    const token = await signedToken('active');
    const response = await GET(request(token, 'token'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: true });
    expect(mocks.validateSessionDetailed).not.toHaveBeenCalled();
  });

  it('token mode + suspended claim answers 401 without a database lookup', async () => {
    const token = await signedToken('suspended');
    const response = await GET(request(token, 'token'));
    expect(response.status).toBe(401);
    expect(mocks.validateSessionDetailed).not.toHaveBeenCalled();
  });

  it('token mode + bad token answers 401 without a database lookup', async () => {
    const response = await GET(request('not-a-token', 'token'));
    expect(response.status).toBe(401);
    expect(mocks.validateSessionDetailed).not.toHaveBeenCalled();
  });

  it('token mode + no cookie answers 401', async () => {
    const response = await GET(request(null, 'token'));
    expect(response.status).toBe(401);
    expect(mocks.validateSessionDetailed).not.toHaveBeenCalled();
  });

  it('full mode still runs the database-backed verdict', async () => {
    mocks.validateSessionDetailed.mockResolvedValue('active');
    const token = await signedToken('active');
    const response = await GET(request(token));
    expect(response.status).toBe(200);
    expect(mocks.validateSessionDetailed).toHaveBeenCalledTimes(1);
  });

  it('full mode maps a dead verdict to 401 and an error verdict to 503', async () => {
    const token = await signedToken('active');
    mocks.validateSessionDetailed.mockResolvedValue('dead');
    expect((await GET(request(token))).status).toBe(401);
    mocks.validateSessionDetailed.mockResolvedValue('error');
    expect((await GET(request(token))).status).toBe(503);
  });
});
