/**
 * @file signup-email-rate-limit.test.ts
 * @description Supabase Auth's project-wide hourly email budget
 * (GoTrue `over_email_send_rate_limit`, message "email rate limit
 * exceeded") as it surfaces through signup and resend:
 * - signUp's raw GoTrue error becomes a dedicated EMAIL_RATE_LIMITED
 *   error carrying the plain message, never the raw dump;
 * - resend's raw GoTrue error becomes { success: false,
 *   emailRateLimited: true } with the plain message and NO cooldown
 *   (no retry timing exists for an hourly budget);
 * - the per-address "after N seconds" cooldown path is unchanged.
 *
 * Uses the mocked Supabase client seam (same pattern as the signup
 * RPC coverage suite): no real Supabase, no real email is sent.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as authModule from '@/lib/auth/index';
import { EMAIL_RATE_LIMIT_MESSAGE } from '@/lib/auth-errors';
import { POST as resendOtpHandler } from '@/app/api/auth/signup/resend-otp/route';
import { _resetRateLimiter } from '@/lib/rate-limiter';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';

function baseMock(overrides: {
  signUp?: unknown;
  resend?: unknown;
  userRow?: Record<string, unknown> | null;
  authUser?: Record<string, unknown> | null;
} = {}) {
  const usersChain = () => ({
    or: () => ({
      maybeSingle: () =>
        Promise.resolve({
          data: overrides.userRow ?? null,
          error: null,
        }),
    }),
  });
  const workspacesChain = () => ({
    ilike: () => Promise.resolve({ data: [], error: null }),
    eq: () => ({
      order: () => ({
        limit: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  });
  return {
    auth: {
      signUp: vi.fn().mockResolvedValue(
        overrides.signUp ?? { data: { user: { id: VALID_UUID } }, error: null }
      ),
      resend: vi.fn().mockResolvedValue(
        overrides.resend ?? { data: {}, error: null }
      ),
      admin: {
        getUserById: vi.fn().mockResolvedValue({
          data: overrides.authUser ? { user: overrides.authUser } : null,
          error: overrides.authUser ? null : { message: 'Not found' },
        }),
      },
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    from: vi.fn((table: string) => {
      if (table === 'users') {
        return { select: () => usersChain() };
      }
      if (table === 'workspaces') {
        return { select: () => workspacesChain() };
      }
      return {};
    }),
  };
}

describe('signup email rate limit (GoTrue hourly budget)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authModule._resetAuthStores();
    _resetRateLimiter();
    process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-1234';
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  it('signUp rate-limit error becomes EMAIL_RATE_LIMITED with the plain message, never the raw dump', async () => {
    const mockSupabase = baseMock({
      signUp: {
        data: { user: null },
        error: {
          message: 'email rate limit exceeded',
          code: 'over_email_send_rate_limit',
        },
      },
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    let caught: (Error & { code?: string }) | null = null;
    try {
      await authModule.signUpTenantUser({
        name: 'Rate Limited',
        email: 'ratelimited@gmail.com',
        phone: '+15555550199',
        password: 'Password123!',
      });
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('EMAIL_RATE_LIMITED');
    expect(caught?.message).toBe(EMAIL_RATE_LIMIT_MESSAGE);
    expect(caught?.message).not.toContain('email rate limit exceeded');
  });

  it('signUp rate-limit error is detected from the message alone, without a code', async () => {
    const mockSupabase = baseMock({
      signUp: {
        data: { user: null },
        error: { message: 'email rate limit exceeded' },
      },
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    await expect(
      authModule.signUpTenantUser({
        name: 'Rate Limited',
        email: 'ratelimited2@gmail.com',
        phone: '+15555550199',
        password: 'Password123!',
      })
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
  });

  it('resend rate-limit error returns the flag with the plain message and no cooldown', async () => {
    const mockSupabase = baseMock({
      resend: { data: {}, error: { message: 'email rate limit exceeded' } },
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const result = await authModule.resendSignupOtpViaSupabase('ratelimited@gmail.com');
    expect(result.success).toBe(false);
    expect(result.emailRateLimited).toBe(true);
    expect(result.error).toBe(EMAIL_RATE_LIMIT_MESSAGE);
    expect(result.cooldownSecondsRemaining).toBeUndefined();
  });

  it('resend per-address cooldown is unchanged (seconds parsed, no flag)', async () => {
    const mockSupabase = baseMock({
      resend: {
        data: {},
        error: {
          message: 'For security purposes, you can only request this after 45 seconds',
        },
      },
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const result = await authModule.resendSignupOtpViaSupabase('cooldown@gmail.com');
    expect(result.success).toBe(false);
    expect(result.emailRateLimited).toBeUndefined();
    expect(result.cooldownSecondsRemaining).toBe(45);
  });

  it('resend-otp route maps the email budget error to 429 with the flag and no countdown', async () => {
    const mockSupabase = baseMock({
      userRow: {
        id: VALID_UUID,
        email: 'ratelimited@gmail.com',
        name: 'Rate Limited',
        phone: '+15555550199',
        role: 'user',
        status: 'active',
      },
      authUser: { id: VALID_UUID, email_confirmed_at: null },
      resend: { data: {}, error: { message: 'email rate limit exceeded' } },
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/auth/signup/resend-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ratelimited@gmail.com' }),
    });
    const res = await resendOtpHandler(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe(EMAIL_RATE_LIMIT_MESSAGE);
    expect(body.error).not.toContain('email rate limit exceeded');
    expect(body.emailRateLimited).toBe(true);
    expect(body.cooldownSecondsRemaining).toBeUndefined();
    expect(body.retryAfterSeconds).toBeUndefined();
  });
});
