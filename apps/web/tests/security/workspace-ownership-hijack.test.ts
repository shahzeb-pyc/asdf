/**
 * @file workspace-ownership-hijack.test.ts
 * @description Security regression tests for ISSUE-01: Cross-Tenant Workspace Ownership Hijack
 * Verifies that workspace creation during signup, registration, login, and password reset
 * uses explicit INSERT with collision avoidance and NEVER mutates owner_id via UPSERT ON CONFLICT (subdomain).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import * as authModule from '@/lib/auth/index';
import * as sessionModule from '@/lib/auth/session';
import { GET as getByocSettings } from '@/app/api/tenant/[subdomain]/settings/byoc/route';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';
const VICTIM_UUID = '00000000-0000-4000-a000-000000000002';

describe('ISSUE-01: Workspace Ownership Hijack Prevention', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Audit S1: the BYOC test below is about workspace-ownership
    // behaviour, not session validation (which has its own dedicated
    // session-invalidation tests). The BYOC route now live-validates
    // the session, and the mock supabase client here returns no user
    // row for that lookup, so a valid session is assumed here.
    vi.spyOn(sessionModule, 'validateSessionActive').mockResolvedValue(true);
    authModule._resetAuthStores();
    process.env.SESSION_SECRET = 'test-secret-at-least-32-chars-long-123456';
  });

  it('never calls workspaces.upsert with onConflict: subdomain during signUpTenantUser', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });
    const insertSpy = vi.fn().mockResolvedValue({ data: { id: '00000000-0000-4000-a000-000000000099' }, error: null });

    const mockSupabase = {
      auth: {
        signUp: vi.fn().mockResolvedValue({
          data: { user: { id: VALID_UUID } },
          error: null,
        }),
        admin: {
          getUserById: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
        },
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            })),
            upsert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: VALID_UUID, email: 'attacker@gmail.com', name: 'Attacker' },
                  error: null,
                }),
              })),
            })),
            insert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: VALID_UUID, email: 'attacker@gmail.com', name: 'Attacker' },
                  error: null,
                }),
              })),
            })),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn((cols: string) => ({
              eq: vi.fn((col: string, val: string) => {
                if (col === 'owner_id') {
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                      })),
                    })),
                  };
                }
                if (col === 'subdomain') {
                  return {
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  };
                }
                return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
              }),
            })),
            upsert: upsertSpy,
            insert: insertSpy,
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    await authModule.signUpTenantUser({
      name: 'Attacker',
      email: 'attacker@gmail.com',
      phone: '+15555550199',
      password: 'SecurePassword123!',
    });

    // CRITICAL: workspaces.upsert MUST NOT be called with onConflict: 'subdomain'
    for (const call of upsertSpy.mock.calls) {
      if (call[1]?.onConflict === 'subdomain') {
        expect.fail('Detected illegal workspaces.upsert with onConflict: subdomain!');
      }
    }

    // Explicit insert must be called instead
    expect(insertSpy).toHaveBeenCalled();
  });

  it('handles PostgreSQL 23505 duplicate key on subdomain during registration by generating unique candidate without hijacking', async () => {
    let insertAttempts = 0;
    const insertedSubdomains: string[] = [];

    const mockSupabase = {
      auth: {
        signUp: vi.fn().mockResolvedValue({
          data: { user: { id: VALID_UUID } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            })),
            insert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: VALID_UUID, email: 'attacker@gmail.com', name: 'Attacker' },
                  error: null,
                }),
              })),
            })),
            upsert: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: { id: VALID_UUID, email: 'attacker@gmail.com', name: 'Attacker' },
                  error: null,
                }),
              })),
            })),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn((cols: string) => ({
              eq: vi.fn((col: string, val: string) => {
                if (col === 'owner_id') {
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                      })),
                    })),
                  };
                }
                return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
              }),
            })),
            upsert: vi.fn((payload: any, options: any) => {
              if (options?.onConflict === 'subdomain') {
                expect.fail('workspaces.upsert with onConflict: subdomain should never be called!');
              }
              return Promise.resolve({ data: null, error: null });
            }),
            insert: vi.fn(async (payload: any) => {
              insertAttempts++;
              insertedSubdomains.push(payload.subdomain);
              if (insertAttempts === 1) {
                // First attempt collides with existing victim subdomain
                return {
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint "workspaces_subdomain_key"' },
                };
              }
              return { data: { id: '00000000-0000-4000-a000-000000000099' }, error: null };
            }),
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    const res = await authModule.signUpTenantUser({
      name: 'Attacker',
      email: 'attacker@gmail.com',
      phone: '+15555550199',
      password: 'SecurePassword123!',
    });

    // Should have retried with a safe non-colliding subdomain
    expect(insertAttempts).toBeGreaterThanOrEqual(2);
    expect(res.user.subdomain).not.toBe(insertedSubdomains[0]);
    expect(res.user.subdomain).toContain('attacker');
  });

  it('never calls workspaces.upsert with onConflict: subdomain during resetUserPasswordWithOtp', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });
    const insertSpy = vi.fn().mockResolvedValue({ data: { id: '00000000-0000-4000-a000-000000000099' }, error: null });

    const mockSupabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: VALID_UUID,
              email: 'resettester@gmail.com',
              user_metadata: { name: 'Reset User', subdomain: 'reset-ws' },
            },
          },
          error: null,
        }),
        updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: VALID_UUID,
              email: 'resettester@gmail.com',
              user_metadata: { name: 'Reset User', subdomain: 'reset-ws' },
            },
          },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            })),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn((cols: string) => ({
              eq: vi.fn((col: string, val: string) => {
                if (col === 'owner_id') {
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                      })),
                    })),
                  };
                }
                return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
              }),
            })),
            upsert: upsertSpy,
            insert: insertSpy,
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    await authModule.resetUserPasswordWithOtp({
      email: 'resettester@gmail.com',
      otp: '123456',
      password: 'NewSecurePassword123!',
    });

    for (const call of upsertSpy.mock.calls) {
      if (call[1]?.onConflict === 'subdomain') {
        expect.fail('workspaces.upsert called during resetUserPasswordWithOtp with onConflict: subdomain!');
      }
    }
    expect(insertSpy).toHaveBeenCalled();
  });

  it('never mutates workspace owner_id during login when provisioning missing user record', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });
    const insertSpy = vi.fn().mockResolvedValue({ data: { id: '00000000-0000-4000-a000-000000000099' }, error: null });

    const mockSupabase = {
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: VALID_UUID,
              email: 'returning@gmail.com',
              user_metadata: { name: 'Returning User', subdomain: 'victim-subdomain' },
            },
          },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table === 'users') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            })),
            upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === 'workspaces') {
          return {
            select: vi.fn((cols: string) => ({
              eq: vi.fn((col: string, val: string) => {
                if (col === 'owner_id') {
                  // User already has their own workspace!
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({
                          data: { id: '00000000-0000-4000-a000-000000000010', subdomain: 'returning-ws' },
                          error: null,
                        }),
                      })),
                    })),
                  };
                }
                return { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
              }),
            })),
            upsert: upsertSpy,
            insert: insertSpy,
          };
        }
        return {};
      }),
    };

    authModule._setMockSupabaseClient(mockSupabase as any);

    const loggedIn = await authModule.loginTenantUser({
      email: 'returning@gmail.com',
      password: 'Password123!',
    });

    // Must not call upsert on workspaces with onConflict: subdomain
    for (const call of upsertSpy.mock.calls) {
      if (call[1]?.onConflict === 'subdomain') {
        expect.fail('workspaces.upsert called during loginTenantUser with onConflict: subdomain!');
      }
    }

    // Must preserve user's existing workspace
    expect(loggedIn.user.subdomain).toBe('returning-ws');
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects with an explicit error when non-conflict database error occurs in ensureWorkspaceForUser', async () => {
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            })),
          })),
        })),
        insert: vi.fn().mockResolvedValue({
          data: null,
          error: { code: '50000', message: 'Internal server error' },
        }),
      })),
    };

    await expect(
      authModule.ensureWorkspaceForUser(
        mockSupabase as any,
        VALID_UUID,
        'Test User',
        'test-subdomain'
      )
    ).rejects.toThrow('Failed to provision workspace');
  });

  it('handles exceptions in select and insert gracefully in ensureWorkspaceForUser', async () => {
    let callCount = 0;
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => {
            throw new Error('Network failure during lookup');
          }),
        })),
        insert: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            throw new Error('PostgREST connection reset');
          }
          return Promise.resolve({ data: { id: 'ws-ok' }, error: null });
        }),
      })),
    };

    const result = await authModule.ensureWorkspaceForUser(
      mockSupabase as any,
      VALID_UUID,
      'Test User',
      'test-subdomain'
    );

    expect(callCount).toBe(2);
    expect(result).toContain('test-subdomain-');
  });

  describe('BYOC Settings API workspace lookup (ISSUE-01 regression)', () => {
    it('never calls workspaces.upsert and returns 404 when workspace is not found', async () => {
      const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            const builder: any = {
              eq: vi.fn(() => builder),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            };
            return {
              select: vi.fn(() => builder),
              upsert: upsertSpy,
            };
          }
          return {};
        }),
      };

      authModule._setMockSupabaseClient(mockSupabase as any);

      const token = await signSessionToken(
        {
          userId: VALID_UUID,
          email: 'operator@gmail.com',
          name: 'Test User',
          subdomain: 'acme',
          role: 'user',
          status: 'active',
        },
        process.env.SESSION_SECRET!
      );

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/settings/byoc', {
        headers: {
          cookie: `fbup_session=${token}`,
        },
      });

      const res = await getByocSettings(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Workspace not found');
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it('returns BYOC settings without calling workspaces.upsert when workspace exists', async () => {
      const upsertSpy = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            const builder: any = {
              eq: vi.fn(() => builder),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: '00000000-0000-4000-a000-000000000099' },
                error: null,
              }),
            };
            return {
              select: vi.fn(() => builder),
              upsert: upsertSpy,
            };
          }
          if (table === 'platform_credentials') {
            const credsBuilder: any = {
              eq: vi.fn(() => credsBuilder),
              maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      workspace_id: '00000000-0000-4000-a000-000000000099',
                      client_id: '123456789',
                      encrypted_client_secret: 'enc_secret',
                      status: 'valid',
                      last_tested_at: '2026-10-14T00:00:00Z',
                    },
                    error: null,
              }),
            };
            return {
              select: vi.fn(() => credsBuilder),
            };
          }
          return {};
        }),
      };

      authModule._setMockSupabaseClient(mockSupabase as any);

      const token = await signSessionToken(
        {
          userId: VALID_UUID,
          email: 'operator@gmail.com',
          name: 'Test User',
          subdomain: 'acme',
          role: 'user',
          status: 'active',
        },
        process.env.SESSION_SECRET!
      );

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/settings/byoc', {
        headers: {
          cookie: `fbup_session=${token}`,
        },
      });

      const res = await getByocSettings(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.workspaceId).toBe('00000000-0000-4000-a000-000000000099');
      expect(json.subdomain).toBe('acme');
      expect(json.fbAppId).toBe('123456789');
      expect(json.hasSecret).toBe(true);
      expect(json.status).toBe('valid');
      expect(upsertSpy).not.toHaveBeenCalled();
    });
  });
});

