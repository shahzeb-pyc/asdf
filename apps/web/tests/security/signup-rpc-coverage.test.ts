/**
 * @file signup-rpc-coverage.test.ts
 * @description Boundary coverage for the signup RPC mechanism (fix 2026-11-01):
 * referral pass-through, RPC result-shape handling, and the fail-loud
 * empty-result path of create_signup_profile. These branches are the
 * ones the SonarCloud new-code coverage gate measures on signup.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as authModule from '@/lib/auth/index';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';

function baseMock(rpcImpl: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    auth: {
      signUp: vi.fn().mockResolvedValue({
        data: { user: { id: VALID_UUID } },
        error: null,
      }),
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
      },
    },
    rpc: vi.fn(rpcImpl),
    from: vi.fn((table: string) => {
      if (table === 'users') {
        return {
          select: vi.fn(() => ({
            or: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
      }
      if (table === 'workspaces') {
        return {
          select: vi.fn(() => ({
            ilike: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        };
      }
      return {};
    }),
  };
}

describe('signup RPC boundary (fix 2026-11-01)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authModule._resetAuthStores();
    process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-123456';
  });

  it('passes referral through to create_signup_profile and maps the returned row', async () => {
    let seenArgs: Record<string, unknown> | null = null;
    const mockSupabase = baseMock((name, args) => {
      if (name === 'create_signup_profile') {
        seenArgs = args;
        return Promise.resolve({
          data: [
            {
              id: VALID_UUID,
              email: 'refd@gmail.com',
              name: 'Refd User',
              phone: '+15555550199',
              subdomain: 'refd',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const result = await authModule.signUpTenantUser({
      name: 'Refd User',
      email: 'refd@gmail.com',
      phone: '+15555550199',
      password: 'Password123!',
      referral: { sellerId: '00000000-0000-4000-a000-000000000099', code: 'SELLER10' },
    });

    expect(seenArgs).toMatchObject({
      p_user_id: VALID_UUID,
      p_email: 'refd@gmail.com',
      p_referred_by_seller_id: '00000000-0000-4000-a000-000000000099',
      p_referred_by_code: 'SELLER10',
    });
    expect(result.user.subdomain).toBe('refd');
    expect(result.requiresOtp).toBe(true);
  });

  it('accepts a non-array RPC result object', async () => {
    const mockSupabase = baseMock((name) => {
      if (name === 'create_signup_profile') {
        return Promise.resolve({
          data: {
            id: VALID_UUID,
            email: 'solo@gmail.com',
            name: 'Solo',
            phone: '+15555550199',
            subdomain: 'solo',
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const result = await authModule.signUpTenantUser({
      name: 'Solo',
      email: 'solo@gmail.com',
      phone: '+15555550199',
      password: 'Password123!',
    });

    expect(result.user.id).toBe(VALID_UUID);
    expect(result.user.subdomain).toBe('solo');
  });

  it('falls back to the derived subdomain and params when the RPC row omits them', async () => {
    const mockSupabase = baseMock((name) => {
      if (name === 'create_signup_profile') {
        return Promise.resolve({
          data: [
            {
              id: VALID_UUID,
              email: null,
              name: null,
              phone: null,
              subdomain: null,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    const result = await authModule.signUpTenantUser({
      name: 'Fallback',
      email: 'fallback@gmail.com',
      phone: '+15555550199',
      password: 'Password123!',
    });

    expect(result.user.email).toBe('fallback@gmail.com');
    expect(result.user.name).toBe('Fallback');
    expect(result.user.phone).toBe('+15555550199');
    expect(result.user.subdomain).toBe('fallback');
  });

  it('throws when the RPC returns no row', async () => {
    const mockSupabase = baseMock((name) => {
      if (name === 'create_signup_profile') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    authModule._setMockSupabaseClient(mockSupabase as any);

    await expect(
      authModule.signUpTenantUser({
        name: 'Nobody',
        email: 'nobody@gmail.com',
        phone: '+15555550199',
        password: 'Password123!',
      })
    ).rejects.toThrow('User profile creation failed');
  });
});
