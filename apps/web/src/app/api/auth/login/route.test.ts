/**
 * POST /api/auth/login — brand-aware email validation (spec 199).
 * The route validates the body with the contracts `LoginRequestSchema`
 * (Gmail-only) on fbuploadpro and with the white-label variant on the
 * nextrise host. `loginTenantUser` itself is mocked: this suite proves
 * the validation gate, which is the server step that used to reject
 * non-Gmail addresses.
 */
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  loginTenantUser: vi.fn(),
  setSessionCookie: vi.fn(),
  resendSignupOtpViaSupabase: vi.fn(),
  checkRateLimit: vi.fn(),
  findPendingSignup: vi.fn(),
}));

vi.mock('@/lib/auth/login', () => ({
  loginTenantUser: mocks.loginTenantUser,
}));

vi.mock('@/lib/auth/session', () => ({
  setSessionCookie: mocks.setSessionCookie,
}));

vi.mock('@/lib/auth/signup', () => ({
  resendSignupOtpViaSupabase: mocks.resendSignupOtpViaSupabase,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: mocks.checkRateLimit,
  extractClientIp: () => '127.0.0.1',
  RATE_LIMIT_WINDOW_MS: 60_000,
}));

vi.mock('@/lib/otp-service', () => ({
  findPendingSignup: mocks.findPendingSignup,
  verifyPendingSignupPassword: vi.fn(),
}));

import { POST } from './route';

const LOGIN_RESULT = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'student@protonmail.com',
    name: 'Student',
    subdomain: 'ws',
    role: 'user',
    status: 'active',
  },
  token: 'fake-session-token',
  redirectUrl: '/tenant/ws',
};

function request(host: string, body: unknown): NextRequest {
  return new NextRequest(`http://${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.loginTenantUser.mockReset();
  mocks.setSessionCookie.mockReset();
  mocks.resendSignupOtpViaSupabase.mockReset();
  mocks.checkRateLimit.mockReset();
  mocks.findPendingSignup.mockReset();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.findPendingSignup.mockReturnValue(null);
  mocks.loginTenantUser.mockResolvedValue(LOGIN_RESULT);
});

describe('POST /api/auth/login brand-aware email rule (spec 199)', () => {
  it('white-label host accepts a non-Gmail address', async () => {
    const response = await POST(
      request('app.sajidaliai.online', {
        email: 'student@protonmail.com',
        password: 'correct-password-1',
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.loginTenantUser).toHaveBeenCalledTimes(1);
    expect(mocks.loginTenantUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'student@protonmail.com' })
    );
    expect(mocks.setSessionCookie).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.redirectUrl).toBe('/tenant/ws');
  });

  it('white-label host accepts a subdomain of the white-label host', async () => {
    const response = await POST(
      request('student.app.sajidaliai.online', {
        email: 'student@protonmail.com',
        password: 'correct-password-1',
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.loginTenantUser).toHaveBeenCalledTimes(1);
  });

  it('fbuploadpro host rejects a non-Gmail address with the Gmail message', async () => {
    const response = await POST(
      request('app.fbuploadpro.com', {
        email: 'owner@example.com',
        password: 'correct-password-1',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Validation failed');
    expect(body.details.email).toEqual([
      'Only @gmail.com (or @googlemail.com) email addresses are permitted',
    ]);
    expect(mocks.loginTenantUser).not.toHaveBeenCalled();
  });

  it('fbuploadpro host still accepts a Gmail address', async () => {
    const response = await POST(
      request('app.fbuploadpro.com', {
        email: 'owner@gmail.com',
        password: 'correct-password-1',
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.loginTenantUser).toHaveBeenCalledTimes(1);
    // The contracts schema canonicalizes the Gmail address.
    expect(mocks.loginTenantUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@gmail.com' })
    );
  });

  it('white-label host still rejects a malformed address', async () => {
    const response = await POST(
      request('app.sajidaliai.online', {
        email: 'not-an-email',
        password: 'correct-password-1',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details.email).toEqual(['Valid email address is required']);
    expect(mocks.loginTenantUser).not.toHaveBeenCalled();
  });
});
