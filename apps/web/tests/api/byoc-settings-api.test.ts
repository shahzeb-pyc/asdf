import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptToken, signSessionToken } from '@fbuploadpro/contracts';
import { GET as getBYOC, PUT as saveBYOC, DELETE as deleteBYOC } from '@/app/api/tenant/[subdomain]/settings/byoc/route';
import { POST as revealBYOCSecret } from '@/app/api/tenant/[subdomain]/settings/byoc/reveal/route';
import * as authModule from '@/lib/auth/clients';
import * as sessionModule from '@/lib/auth/session';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Chainable select builder: any number of .eq() calls, then .maybeSingle(). */
function selectChain(result: { data: unknown; error: unknown }) {
  const builder: any = {
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return builder;
}

function workspaceFound(workspaceId: string) {
  return {
    select: () => selectChain({ data: { id: workspaceId }, error: null }),
  };
}

function workspaceMissing() {
  return {
    select: () => selectChain({ data: null, error: null }),
  };
}

describe('Facebook BYOC Settings API Routes', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const workspaceId = '22222222-2222-4222-a222-222222222222';
  const subdomain = 'acme';
  let validSessionCookie: string;
  let otherTenantSessionCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Audit S1: these route tests are about BYOC behaviour, not session
    // validation (which has its own dedicated session-invalidation
    // tests). The routes now live-validate the session, and the
    // per-test supabase mocks below do not stub the users lookup that
    // validation needs, so a valid session is assumed here.
    vi.spyOn(sessionModule, 'validateSessionActive').mockResolvedValue(true);
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    const token = await signSessionToken(
      {
        userId,
        email: 'alexfounder@gmail.com',
        name: 'Alex Founder',
        subdomain,
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;

    const otherToken = await signSessionToken(
      {
        userId,
        email: 'alexfounder@gmail.com',
        name: 'Alex Founder',
        subdomain: 'other-brand',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    otherTenantSessionCookie = `fbup_session=${otherToken}`;
  });

  describe('GET /api/tenant/[subdomain]/settings/byoc', () => {
    it('returns 401 when request lacks authentication session', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`);
      const res = await getBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(401);
    });

    it('returns 403 when session subdomain does not match request tenant', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        headers: { cookie: otherTenantSessionCookie },
      });
      const res = await getBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(403);
    });

    it('returns 404 when workspace is not found for tenant', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceMissing();
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        headers: { cookie: validSessionCookie },
      });
      const res = await getBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(404);
    });

    it('returns 200 with unverified status and empty fields when no BYOC credentials exist', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return { select: () => selectChain({ data: null, error: null }) };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        headers: { cookie: validSessionCookie },
      });
      const res = await getBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.workspaceId).toBe(workspaceId);
      expect(json.fbAppId).toBe('');
      expect(json.hasSecret).toBe(false);
      expect(json.status).toBe('unverified');
      // Spec 139 N3: no secret saved — the hint is null and there is
      // no secret field of any kind in the payload.
      expect(json.fbAppSecretHint).toBeNull();
      expect(json).not.toHaveProperty('fbAppSecret');
    });

    it('returns 200 with credentials info when BYOC is saved — masked, never the secret (spec 139 N3)', async () => {
      // A REAL ciphertext for an obvious fake secret, so the route's
      // decrypt path genuinely runs and the masking is really tested.
      const SAVED_SECRET = 'fake-fb-secret-1234';
      const encryptedSecret = await encryptToken(SAVED_SECRET, TEST_ENCRYPTION_KEY);
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () =>
                selectChain({
                  data: {
                    workspace_id: workspaceId,
                    platform: 'facebook',
                    client_id: '123456789012345',
                    encrypted_client_secret: encryptedSecret,
                    status: 'valid',
                    last_tested_at: '2026-10-14T10:00:00Z',
                    app_name: 'Acme App',
                    created_at: '2026-10-14T09:00:00Z',
                  },
                  error: null,
                }),
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        headers: { cookie: validSessionCookie },
      });
      const res = await getBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.workspaceId).toBe(workspaceId);
      expect(json.fbAppId).toBe('123456789012345');
      expect(json.hasSecret).toBe(true);
      expect(json.status).toBe('valid');
      expect(json.lastTestedAt).toBe('2026-10-14T10:00:00Z');
      expect(json.fbAppName).toBe('Acme App');
      expect(json.connectedAt).toBe('2026-10-14T09:00:00Z');
      // The masked hint (bullets + last four) is all the GET carries.
      expect(json.fbAppSecretHint).toBe('••••1234');
      expect(json).not.toHaveProperty('fbAppSecret');
      // Deep-scan: the full secret appears NOWHERE in the payload.
      expect(JSON.stringify(json)).not.toContain(SAVED_SECRET);
    });
  });

  describe('PUT /api/tenant/[subdomain]/settings/byoc', () => {
    // The route verifies the pair against Graph before saving, so every
    // PUT test below stubs the Graph fetch; unstub after each so no
    // stub leaks into the next test.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubGraphSuccess(name = 'Acme App') {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ name }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );
    }

    function stubGraphError(status: number, body: unknown) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );
    }

    function stubGraphThrow() {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('fetch failed');
        })
      );
    }

    function putRequest(body: Record<string, unknown>) {
      return new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'PUT',
        headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('returns 400 when request body fails validation', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'PUT',
        headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fbAppId: '' }),
      });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(400);
    });

    it('returns 400 when omitting secret on first-time setup without existing secret', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return { select: () => selectChain({ data: null, error: null }) };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'PUT',
        headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fbAppId: '123456789012345' }),
      });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Enter your Facebook App Secret');
    });

    it('returns 200 and encrypts secret when saving new credentials', async () => {
      stubGraphSuccess('Acme App');
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () => selectChain({ data: null, error: null }),
              upsert: upsertMock,
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = putRequest({
        fbAppId: '123456789012345',
        fbAppSecret: 'super_secret_fb_key_999',
      });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.hasSecret).toBe(true);
      // Verified save: the Graph name is stored and the row is valid.
      expect(json.status).toBe('valid');
      expect(json.fbAppName).toBe('Acme App');
      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          platform: 'facebook',
          client_id: '123456789012345',
          status: 'valid',
          app_name: 'Acme App',
        }),
        { onConflict: 'workspace_id,platform' }
      );
      const upsertArg = upsertMock.mock.calls[0][0];
      expect(upsertArg.encrypted_client_secret).toBeTruthy();
      expect(upsertArg.encrypted_client_secret).not.toBe('super_secret_fb_key_999');
      expect(upsertArg.last_tested_at).toBeTruthy();
      expect(upsertArg).not.toHaveProperty('user_id');
    });

    it('returns 200 when updating fbAppId without changing existing secret', async () => {
      stubGraphSuccess('Acme App');
      // A REAL ciphertext for the stored secret, so the route's
      // decrypt-for-verification path genuinely runs.
      const storedEncrypted = await encryptToken('stored-secret-123456', TEST_ENCRYPTION_KEY);
      const finalEqMock = vi.fn().mockResolvedValue({ error: null });
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ eq: finalEqMock }),
      });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () =>
                selectChain({
                  data: {
                    client_id: '111111111111111',
                    encrypted_client_secret: storedEncrypted,
                    status: 'valid',
                    app_name: 'Old App Name',
                  },
                  error: null,
                }),
              update: updateMock,
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = putRequest({ fbAppId: '987654321098765' });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.fbAppName).toBe('Acme App');
      // Changed App ID with the stored secret: verified with the new
      // pair, so the update carries the fresh name and valid status.
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          client_id: '987654321098765',
          status: 'valid',
          app_name: 'Acme App',
        })
      );
    });

    it('returns 400 and saves NOTHING when Graph rejects the pair', async () => {
      stubGraphError(400, {
        error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 },
      });
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () => selectChain({ data: null, error: null }),
              upsert: upsertMock,
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = putRequest({
        fbAppId: '123456789012345',
        fbAppSecret: 'wrong_secret_value_123',
      });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe(
        'Facebook rejected this App ID and App Secret. Please check them and try again.'
      );
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('returns 503 with a DISTINCT message and saves NOTHING when Graph is unreachable', async () => {
      stubGraphThrow();
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () => selectChain({ data: null, error: null }),
              upsert: upsertMock,
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = putRequest({
        fbAppId: '123456789012345',
        fbAppSecret: 'super_secret_fb_key_999',
      });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe("Couldn't reach Facebook to verify your app. Please try again.");
      expect(json.error).not.toContain('rejected');
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('skips the Graph fetch and the write when neither the App ID nor the secret changed', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('Graph must not be called for an unchanged pair');
      });
      vi.stubGlobal('fetch', fetchMock);
      const storedEncrypted = await encryptToken('stored-secret-123456', TEST_ENCRYPTION_KEY);
      const updateMock = vi.fn();
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () =>
                selectChain({
                  data: {
                    client_id: '123456789012345',
                    encrypted_client_secret: storedEncrypted,
                    status: 'valid',
                    app_name: 'Acme App',
                    created_at: '2026-10-14T09:00:00Z',
                    updated_at: '2026-10-14T11:00:00Z',
                  },
                  error: null,
                }),
              update: updateMock,
            };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = putRequest({ fbAppId: '123456789012345' });
      const res = await saveBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.status).toBe('valid');
      expect(json.fbAppName).toBe('Acme App');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/tenant/[subdomain]/settings/byoc', () => {
    it('returns 401 when request lacks authentication session', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'DELETE',
      });
      const res = await deleteBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(401);
    });

    it('returns 403 when session subdomain does not match request tenant', async () => {
      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'DELETE',
        headers: { cookie: otherTenantSessionCookie },
      });
      const res = await deleteBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(403);
    });

    it('returns 404 when workspace is not found for tenant', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceMissing();
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });
      const res = await deleteBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(404);
    });

    it('returns 200 with success when deleting credentials from platform_credentials', async () => {
      const platformEqMock = vi.fn().mockResolvedValue({ error: null });
      const workspaceEqMock = vi.fn().mockReturnValue({ eq: platformEqMock });
      const deleteMock = vi.fn().mockReturnValue({ eq: workspaceEqMock });
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return { delete: deleteMock };
          }
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/settings/byoc`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });
      const res = await deleteBYOC(req, { params: Promise.resolve({ subdomain }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.disconnected).toBe(true);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(workspaceEqMock).toHaveBeenCalledWith('workspace_id', workspaceId);
      expect(platformEqMock).toHaveBeenCalledWith('platform', 'facebook');
    });
  });

  describe('POST /api/tenant/[subdomain]/settings/byoc/reveal (spec 139 N3)', () => {
    const SAVED_SECRET = 'fake-fb-secret-1234';

    function savedCredentialsSupabase(encryptedSecret: string | null) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceFound(workspaceId);
          if (table === 'platform_credentials') {
            return {
              select: () =>
                selectChain({
                  data: encryptedSecret
                    ? {
                        workspace_id: workspaceId,
                        platform: 'facebook',
                        client_id: '123456789012345',
                        encrypted_client_secret: encryptedSecret,
                        status: 'valid',
                        last_tested_at: '2026-10-14T10:00:00Z',
                        created_at: '2026-10-14T09:00:00Z',
                      }
                    : null,
                  error: null,
                }),
            };
          }
          return {};
        }),
      };
    }

    function revealRequest(cookie?: string) {
      return new NextRequest(
        `http://localhost:3000/api/tenant/${subdomain}/settings/byoc/reveal`,
        {
          method: 'POST',
          headers: cookie ? { cookie } : {},
        }
      );
    }

    it('returns 401 when request lacks authentication session', async () => {
      const res = await revealBYOCSecret(revealRequest(), {
        params: Promise.resolve({ subdomain }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when session subdomain does not match request tenant', async () => {
      const res = await revealBYOCSecret(revealRequest(otherTenantSessionCookie), {
        params: Promise.resolve({ subdomain }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 when workspace is not found for tenant', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return workspaceMissing();
          return {};
        }),
      };
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const res = await revealBYOCSecret(revealRequest(validSessionCookie), {
        params: Promise.resolve({ subdomain }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when no secret is saved for the workspace', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        savedCredentialsSupabase(null) as any
      );

      const res = await revealBYOCSecret(revealRequest(validSessionCookie), {
        params: Promise.resolve({ subdomain }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain(SAVED_SECRET);
    });

    it('returns the saved secret once, no-store, and logs the reveal WITHOUT the value', async () => {
      const encryptedSecret = await encryptToken(SAVED_SECRET, TEST_ENCRYPTION_KEY);
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        savedCredentialsSupabase(encryptedSecret) as any
      );
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const res = await revealBYOCSecret(revealRequest(validSessionCookie), {
        params: Promise.resolve({ subdomain }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const json = await res.json();
      expect(json).toEqual({ fbAppSecret: SAVED_SECRET });

      // The reveal is audited — and the audit line must not carry
      // the secret value anywhere in any argument.
      expect(infoSpy).toHaveBeenCalled();
      for (const call of infoSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SAVED_SECRET);
      }
    });
  });
});
