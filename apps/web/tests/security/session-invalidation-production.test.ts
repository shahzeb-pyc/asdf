/**
 * @file session-invalidation-production.test.ts
 * @description Security regression tests for ISSUE-02: Existing Sessions Are Never Invalidated After Password Reset in Production
 * Verifies that password resets persist password_updated_at to Supabase PostgREST,
 * findUserByEmail selects it, and validateSessionDetailed rejects sessions created prior to the update.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { signSessionToken, type SessionPayload } from '@fbuploadpro/contracts';
import * as authModule from '@/lib/auth/index';

const SESSION_SECRET = 'test-secret-at-least-32-chars-long-123456';
const USER_ID = '11111111-2222-4333-a444-555555555555';

describe('ISSUE-02: Production Session Invalidation on Password Reset', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authModule._resetAuthStores();
    process.env.SESSION_SECRET = SESSION_SECRET;
  });

  it('selects password_updated_at in findUserByEmail and maps to passwordUpdatedAt seconds', async () => {
    const updatedTimeIso = '2026-10-14T12:00:00.000Z';
    const updatedTimeSeconds = Math.floor(new Date(updatedTimeIso).getTime() / 1000);

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn((cols: string) => {
              expect(cols).toContain('password_updated_at');
              return {
                or: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      id: USER_ID,
                      email: 'victim@gmail.com',
                      name: 'Victim User',
                      role: 'user',
                      status: 'active',
                      password_updated_at: updatedTimeIso,
                    },
                    error: null,
                  }),
                })),
              };
            }),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { subdomain: 'victim-ws' },
                      error: null,
                    }),
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    const user = await authModule.findUserByEmail('victim@gmail.com');
    expect(user).not.toBeNull();
    expect(user?.passwordUpdatedAt).toBe(updatedTimeSeconds);
  });

  it('persists password_updated_at to Supabase in resetUserPasswordWithOtp', async () => {
    const userUpdateSpy = vi.fn().mockResolvedValue({ data: null, error: null });

    const mockSupabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: USER_ID,
              email: 'victim@gmail.com',
            },
          },
          error: null,
        }),
        updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn((cols: string) => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: USER_ID,
                    email: 'victim@gmail.com',
                    name: 'Victim User',
                    role: 'user',
                    status: 'active',
                  },
                  error: null,
                }),
              })),
            })),
            update: userUpdateSpy.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { subdomain: 'victim-ws' },
                      error: null,
                    }),
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    await authModule.resetUserPasswordWithOtp({
      email: 'victim@gmail.com',
      otp: '654321',
      password: 'NewSecurePassword789!',
    });

    expect(userUpdateSpy).toHaveBeenCalled();
    const updatePayload = userUpdateSpy.mock.calls[0][0];
    expect(updatePayload).toHaveProperty('password_updated_at');
    expect(typeof updatePayload.password_updated_at).toBe('string');
  });

  it('invalidates active session after password reset in production Supabase environment', async () => {
    const initialIat = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const initialSession: SessionPayload = {
      userId: USER_ID,
      email: 'victim@gmail.com',
      subdomain: 'victim-ws',
      role: 'user',
      status: 'active',
      iat: initialIat,
      exp: initialIat + 86400 * 30,
    };

    let persistedPasswordUpdatedAt: string | null = null;

    const mockSupabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({
          data: {
            user: { id: USER_ID, email: 'victim@gmail.com' },
          },
          error: null,
        }),
        updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn((cols: string) => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: USER_ID,
                    email: 'victim@gmail.com',
                    name: 'Victim User',
                    role: 'user',
                    status: 'active',
                    password_updated_at: persistedPasswordUpdatedAt,
                  },
                  error: null,
                }),
              })),
            })),
            update: vi.fn((payload: any) => {
              if (payload.password_updated_at) {
                persistedPasswordUpdatedAt = payload.password_updated_at;
              }
              return {
                eq: vi.fn().mockResolvedValue({ data: null, error: null }),
              };
            }),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { subdomain: 'victim-ws' },
                      error: null,
                    }),
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    // Initial session is valid before password reset
    const isValidBefore = await authModule.validateSessionDetailed(initialSession);
    expect(isValidBefore).toBe('active');

    // Perform password reset
    await authModule.resetUserPasswordWithOtp({
      email: 'victim@gmail.com',
      otp: '654321',
      password: 'NewSecurePassword789!',
    });

    // Session issued BEFORE the reset MUST now be invalid
    const isValidAfter = await authModule.validateSessionDetailed(initialSession);
    expect(isValidAfter).toBe('dead');
  });

  it('persists password_updated_at to Supabase in resetUserPassword', async () => {
    let persistedPasswordUpdatedAt: string | null = null;
    const userUpdateSpy = vi.fn((payload: any) => {
      if (payload.password_updated_at) {
        persistedPasswordUpdatedAt = payload.password_updated_at;
      }
      return {
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        or: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    const mockSupabase = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: USER_ID, email: 'victim@gmail.com' } },
          error: null,
        }),
        exchangeCodeForSession: vi.fn().mockResolvedValue({
          data: { session: { user: { id: USER_ID, email: 'victim@gmail.com' } } },
          error: null,
        }),
        updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: USER_ID,
                    email: 'victim@gmail.com',
                    name: 'Victim User',
                    role: 'user',
                    status: 'active',
                  },
                  error: null,
                }),
              })),
            })),
            update: userUpdateSpy,
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { subdomain: 'victim-ws' },
                      error: null,
                    }),
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    await authModule.resetUserPassword({
      code: 'valid-pkce-code',
      password: 'NewSecurePassword789!',
      email: 'victim@gmail.com',
    });

    expect(userUpdateSpy).toHaveBeenCalled();
    expect(persistedPasswordUpdatedAt).not.toBeNull();
  });
});
