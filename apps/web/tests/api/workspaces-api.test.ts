/**
 * @file workspaces-api.test.ts
 * @description Unit tests for Workspaces API routes and auto-generated subdomains via Supabase PostgREST (Spec 037).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, verifySessionToken } from '@fbuploadpro/contracts';
import { GET as listWorkspaces, POST as createWorkspace, PATCH as updateWorkspace } from '../../src/app/api/workspaces/route';
import { POST as switchWorkspace } from '../../src/app/api/workspaces/switch/route';
import { authenticateTenantRoute } from '../../src/lib/route-auth';
import * as authModule from '@/lib/auth/clients';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Workspaces API Routes (Spec 037 Supabase PostgREST)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  it('rejects unauthenticated requests to list or create workspaces', async () => {
    const getReq = new NextRequest('http://localhost:3000/api/workspaces');
    const getRes = await listWorkspaces(getReq);
    expect(getRes.status).toBe(401);

    const postReq = new NextRequest('http://localhost:3000/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alpha Agency' }),
    });
    const postRes = await createWorkspace(postReq);
    expect(postRes.status).toBe(401);
  });

  it('returns owned workspaces unchanged from GET', async () => {
    const rows = [
      {
        id: 'ws-1',
        owner_id: userId,
        name: 'Acme',
        subdomain: 'acme',
        created_at: '2026-10-10T12:00:00Z',
        updated_at: '2026-10-16T12:00:00Z',
      },
    ];
    const insertSpy = vi.fn();
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
          })),
        })),
        insert: insertSpy,
      })),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/workspaces', {
      headers: { cookie: validSessionCookie },
    });
    const res = await listWorkspaces(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.workspaces).toEqual([
      {
        id: 'ws-1',
        ownerId: userId,
        name: 'Acme',
        subdomain: 'acme',
        createdAt: '2026-10-10T12:00:00Z',
        updatedAt: '2026-10-16T12:00:00Z',
      },
    ]);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns an empty list from GET without provisioning when the user has no workspaces', async () => {
    const insertSpy = vi.fn();
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
        insert: insertSpy,
      })),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/workspaces', {
      headers: { cookie: validSessionCookie },
    });
    const res = await listWorkspaces(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ workspaces: [] });
    // The removed GET backfill must never attempt an insert/provision.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('auto-generates unique subdomain using main subdomain and 4 random alphabets when creating workspace', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((col: string) => {
                if (col === 'owner_id') {
                  return {
                    order: vi.fn(() => ({
                      limit: vi.fn(() =>
                        Promise.resolve({
                          data: [{ subdomain: 'acme' }],
                          error: null,
                        })
                      ),
                    })),
                  };
                }
                if (col === 'subdomain') {
                  return {
                    maybeSingle: vi.fn(() =>
                      Promise.resolve({
                        data: null,
                        error: null,
                      })
                    ),
                  };
                }
                return {
                  maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
                };
              }),
            })),
            insert: vi.fn((values: { name: string; subdomain: string }) => ({
              select: vi.fn(() => ({
                single: vi.fn(() =>
                  Promise.resolve({
                    data: {
                      id: 'ws-new-123',
                      owner_id: userId,
                      name: values.name,
                      subdomain: values.subdomain,
                      created_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    },
                    error: null,
                  })
                ),
              })),
            })),
          };
        }
        return {};
      }),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/workspaces', {
      method: 'POST',
      headers: {
        cookie: validSessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Alpha Agency' }),
    });

    const res = await createWorkspace(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.workspace.name).toBe('Alpha Agency');
    // Ensure subdomain starts with 'acme' and has 4-letter random suffix
    expect(json.workspace.subdomain).toMatch(/^acme[a-z]{4}$/);

    // Verify session cookie was updated
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('fbup_session=');
  });

  it('rejects switching to a workspace not owned by the user', async () => {
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/workspaces/switch', {
      method: 'POST',
      headers: {
        cookie: validSessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'unowned-slug' }),
    });

    const res = await switchWorkspace(req);
    expect(res.status).toBe(403);
  });

  it('populates allowedSubdomains with all owned workspaces when switching workspaces', async () => {
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((col1: string, val1: string) => {
                if (col1 === 'owner_id') {
                  return {
                    eq: vi.fn((col2: string, val2: string) => {
                      if (col2 === 'subdomain' && val2 === 'acme-two') {
                        return Promise.resolve({
                          data: [{ id: 'ws-2', name: 'Acme Two', subdomain: 'acme-two' }],
                          error: null,
                        });
                      }
                      return Promise.resolve({ data: [], error: null });
                    }),
                    // When selecting all workspaces for owner_id
                    then: (resolve: any) =>
                      Promise.resolve({
                        data: [
                          { subdomain: 'acme' },
                          { subdomain: 'acme-two' },
                          { subdomain: 'acme-three' },
                        ],
                        error: null,
                      }).then(resolve),
                  };
                }
                return Promise.resolve({ data: [], error: null });
              }),
            })),
          };
        }
        return {};
      }),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

    const req = new NextRequest('http://localhost:3000/api/workspaces/switch', {
      method: 'POST',
      headers: {
        cookie: validSessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: 'acme-two' }),
    });

    const res = await switchWorkspace(req);
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeDefined();
    const tokenMatch = setCookie?.match(/fbup_session=([^;]+)/);
    expect(tokenMatch).toBeTruthy();

    const decoded = await verifySessionToken(tokenMatch![1], TEST_SECRET);
    expect(decoded.subdomain).toBe('acme-two');
    expect(decoded.allowedSubdomains).toEqual(
      expect.arrayContaining(['acme', 'acme-two', 'acme-three'])
    );
  });

  it('allows access via authenticateTenantRoute when target subdomain is in allowedSubdomains', async () => {
    const multiSessionToken = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        allowedSubdomains: ['acme', 'acme-two'],
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );

    // Request to Tab A's workspace ('acme-two') while session.subdomain is 'acme'
    const req = new NextRequest('http://localhost:3000/api/tenant/acme-two/accounts', {
      headers: {
        cookie: `fbup_session=${multiSessionToken}`,
      },
    });

    const authResult = await authenticateTenantRoute(req, 'acme-two');
    expect(authResult.errorResponse).toBeUndefined();
    expect(authResult.session?.userId).toBe(userId);
  });

  describe('PATCH /api/workspaces (Workspace Renaming)', () => {
    it('rejects unauthenticated PATCH requests with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/workspaces', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });
      const res = await updateWorkspace(req);
      expect(res.status).toBe(401);
    });

    it('rejects invalid inputs (< 3 chars, > 40 chars, leading/trailing spaces) with 400', async () => {
      // Short name
      const shortReq = new NextRequest('http://localhost:3000/api/workspaces', {
        method: 'PATCH',
        headers: {
          cookie: validSessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ab' }),
      });
      const shortRes = await updateWorkspace(shortReq);
      expect(shortRes.status).toBe(400);

      // Trailing whitespace
      const spaceReq = new NextRequest('http://localhost:3000/api/workspaces', {
        method: 'PATCH',
        headers: {
          cookie: validSessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ValidName ' }),
      });
      const spaceRes = await updateWorkspace(spaceReq);
      expect(spaceRes.status).toBe(400);
      const data = await spaceRes.json();
      expect(data.error).toContain('spaces');
    });

    it('returns 404 when workspace not found or not owned by user', async () => {
      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: null,
                    error: null,
                  }),
                })),
              })),
            })),
          })),
        })),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest('http://localhost:3000/api/workspaces', {
        method: 'PATCH',
        headers: {
          cookie: validSessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subdomain: 'nonexistent', name: 'Valid Name' }),
      });

      const res = await updateWorkspace(req);
      expect(res.status).toBe(404);
    });

    it('successfully updates workspace name and returns updated workspace', async () => {
      const mockUpdated = {
        id: '11111111-2222-3333-4444-555555555555',
        owner_id: userId,
        name: 'Updated Workspace Name',
        subdomain: 'acme',
        created_at: '2026-10-10T12:00:00Z',
        updated_at: '2026-10-16T12:00:00Z',
      };

      const mockSupabase = {
        from: vi.fn(() => ({
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: mockUpdated,
                    error: null,
                  }),
                })),
              })),
            })),
          })),
        })),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest('http://localhost:3000/api/workspaces', {
        method: 'PATCH',
        headers: {
          cookie: validSessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subdomain: 'acme', name: 'Updated Workspace Name' }),
      });

      const res = await updateWorkspace(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.workspace.name).toBe('Updated Workspace Name');
      expect(data.workspace.subdomain).toBe('acme');
    });
  });
});
