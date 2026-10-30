import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptToken, signSessionToken } from '@fbuploadpro/contracts';
import {
  GET as getPlatformCredentials,
  PUT as savePlatformCredentials,
  DELETE as deletePlatformCredentials,
} from '@/app/api/tenant/[subdomain]/settings/platform-credentials/[platform]/route';
import { POST as revealPlatformSecret } from '@/app/api/tenant/[subdomain]/settings/platform-credentials/[platform]/reveal/route';
import * as authModule from '@/lib/auth/clients';
import * as sessionModule from '@/lib/auth/session';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function selectChain(result: { data: unknown; error: unknown }) {
  const builder: any = {
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return builder;
}

interface MockOptions {
  workspaceId: string | null;
  credsRow?: Record<string, unknown> | null;
  upsertMock?: ReturnType<typeof vi.fn>;
  updateMock?: ReturnType<typeof vi.fn>;
  deleteMock?: ReturnType<typeof vi.fn>;
  tablesUsed?: string[];
}

function makeSupabase(opts: MockOptions) {
  return {
    from: vi.fn((table: string) => {
      opts.tablesUsed?.push(table);
      if (table === 'workspaces') {
        return {
          select: () =>
            selectChain({
              data: opts.workspaceId ? { id: opts.workspaceId } : null,
              error: null,
            }),
        };
      }
      if (table === 'platform_credentials') {
        return {
          select: () => selectChain({ data: opts.credsRow ?? null, error: null }),
          upsert: opts.upsertMock ?? vi.fn().mockResolvedValue({ error: null }),
          update:
            opts.updateMock ??
            vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
            }),
          delete:
            opts.deleteMock ??
            vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
            }),
        };
      }
      return {};
    }),
  };
}

describe('Platform Credentials Settings API Routes (instagram/threads)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const workspaceId = '22222222-2222-4222-a222-222222222222';
  const subdomain = 'acme';
  let validSessionCookie: string;
  let otherTenantSessionCookie: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // Audit S1: these route tests are about platform-credentials
    // behaviour, not session validation (which has its own dedicated
    // session-invalidation tests). The routes now live-validate the
    // session, and the per-test supabase mocks below do not stub the
    // users lookup that validation needs, so a valid session is
    // assumed here.
    vi.spyOn(sessionModule, 'validateSessionActive').mockResolvedValue(true);
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    const token = await signSessionToken(
      { userId, email: 'alexfounder@gmail.com', name: 'Alex Founder', subdomain, role: 'user', status: 'active' },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;

    const otherToken = await signSessionToken(
      { userId, email: 'alexfounder@gmail.com', name: 'Alex Founder', subdomain: 'other-brand', role: 'user', status: 'active' },
      TEST_SECRET
    );
    otherTenantSessionCookie = `fbup_session=${otherToken}`;
  });

  function reqFor(platform: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
    return new NextRequest(
      `http://localhost:3000/api/tenant/${subdomain}/settings/platform-credentials/${platform}`,
      init
    );
  }

  function ctx(platform: string) {
    return { params: Promise.resolve({ subdomain, platform }) };
  }

  describe('auth + platform guard', () => {
    it('returns 401 when request lacks authentication session', async () => {
      const res = await getPlatformCredentials(reqFor('instagram'), ctx('instagram'));
      expect(res.status).toBe(401);
    });

    it('returns 403 when session subdomain does not match request tenant', async () => {
      const res = await getPlatformCredentials(
        reqFor('instagram', { headers: { cookie: otherTenantSessionCookie } }),
        ctx('instagram')
      );
      expect(res.status).toBe(403);
    });

    it.each(['facebook', 'youtube', 'x', 'tiktok', 'myspace'])(
      'returns 400 for platform "%s" on this route',
      async (platform) => {
        const res = await getPlatformCredentials(
          reqFor(platform, { headers: { cookie: validSessionCookie } }),
          ctx(platform)
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(typeof json.error).toBe('string');
        expect(json.error.length).toBeGreaterThan(0);
      }
    );

    it('returns 400 for a non-BYOC platform on PUT and DELETE too', async () => {
      const putRes = await savePlatformCredentials(
        reqFor('youtube', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '12345', appSecret: 'some-secret-value' }),
        }),
        ctx('youtube')
      );
      expect(putRes.status).toBe(400);

      const deleteRes = await deletePlatformCredentials(
        reqFor('tiktok', { method: 'DELETE', headers: { cookie: validSessionCookie } }),
        ctx('tiktok')
      );
      expect(deleteRes.status).toBe(400);
    });

    it('returns 404 when workspace is not found for tenant', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId: null }) as any
      );
      const res = await getPlatformCredentials(
        reqFor('threads', { headers: { cookie: validSessionCookie } }),
        ctx('threads')
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET', () => {
    it('matches the frozen response contract when credentials are saved — masked, never the secret (spec 139 N3)', async () => {
      const encrypted = await encryptToken('instagram-secret-999', TEST_ENCRYPTION_KEY);
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({
          workspaceId,
          credsRow: {
            workspace_id: workspaceId,
            platform: 'instagram',
            client_id: '123456789012345',
            encrypted_client_secret: encrypted,
            status: 'valid',
            last_tested_at: '2026-10-14T10:00:00Z',
            created_at: '2026-10-14T09:00:00Z',
            updated_at: '2026-10-14T11:00:00Z',
          },
        }) as any
      );

      const res = await getPlatformCredentials(
        reqFor('instagram', { headers: { cookie: validSessionCookie } }),
        ctx('instagram')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(
        [
          'workspaceId',
          'subdomain',
          'platform',
          'appId',
          'secretHint',
          'hasSecret',
          'status',
          'lastTestedAt',
          'connectedAt',
        ].sort()
      );
      expect(json.workspaceId).toBe(workspaceId);
      expect(json.subdomain).toBe(subdomain);
      expect(json.platform).toBe('instagram');
      expect(json.appId).toBe('123456789012345');
      // The masked hint (bullets + last four) is all the GET carries.
      expect(json.secretHint).toBe('••••-999');
      expect(json).not.toHaveProperty('appSecret');
      // Deep-scan: the full secret appears NOWHERE in the payload.
      expect(JSON.stringify(json)).not.toContain('instagram-secret-999');
      expect(json.hasSecret).toBe(true);
      expect(json.status).toBe('valid');
      expect(json.lastTestedAt).toBe('2026-10-14T10:00:00Z');
      expect(json.connectedAt).toBe('2026-10-14T09:00:00Z');
    });

    it('returns empty fields with unverified status when nothing is saved', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId, credsRow: null }) as any
      );

      const res = await getPlatformCredentials(
        reqFor('threads', { headers: { cookie: validSessionCookie } }),
        ctx('threads')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.platform).toBe('threads');
      expect(json.appId).toBe('');
      expect(json.secretHint).toBeNull();
      expect(json).not.toHaveProperty('appSecret');
      expect(json.hasSecret).toBe(false);
      expect(json.status).toBe('unverified');
      expect(json.lastTestedAt).toBeNull();
      expect(json.connectedAt).toBeNull();
    });
  });

  describe('edge branches', () => {
    it('GET returns hasSecret with a null hint when decryption fails', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({
          workspaceId,
          credsRow: {
            workspace_id: workspaceId,
            platform: 'threads',
            client_id: '111222333',
            encrypted_client_secret: 'not-a-valid-ciphertext',
            status: 'unverified',
            last_tested_at: null,
            created_at: '2026-10-14T09:00:00Z',
            updated_at: '2026-10-14T09:00:00Z',
          },
        }) as any
      );

      const res = await getPlatformCredentials(
        reqFor('threads', { headers: { cookie: validSessionCookie } }),
        ctx('threads')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.appId).toBe('111222333');
      expect(json.secretHint).toBeNull();
      expect(json).not.toHaveProperty('appSecret');
      expect(json.hasSecret).toBe(true);
    });

    it('GET returns 503 when the database service is unavailable', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(null);
      const res = await getPlatformCredentials(
        reqFor('instagram', { headers: { cookie: validSessionCookie } }),
        ctx('instagram')
      );
      expect(res.status).toBe(503);
    });

    it('PUT returns 400 for an invalid JSON body', async () => {
      const res = await savePlatformCredentials(
        reqFor('instagram', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: '{not json',
        }),
        ctx('instagram')
      );
      expect(res.status).toBe(400);
    });

    it('PUT returns 404 when the workspace is not found', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId: null }) as any
      );
      const res = await savePlatformCredentials(
        reqFor('instagram', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '123456789', appSecret: 'some-secret-value' }),
        }),
        ctx('instagram')
      );
      expect(res.status).toBe(404);
    });

    it('DELETE returns 404 when the workspace is not found', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId: null }) as any
      );
      const res = await deletePlatformCredentials(
        reqFor('threads', { method: 'DELETE', headers: { cookie: validSessionCookie } }),
        ctx('threads')
      );
      expect(res.status).toBe(404);
    });

    it('DELETE returns 403 when session subdomain does not match request tenant', async () => {
      const res = await deletePlatformCredentials(
        reqFor('instagram', { method: 'DELETE', headers: { cookie: otherTenantSessionCookie } }),
        ctx('instagram')
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PUT', () => {
    it('returns 400 when appId is empty', async () => {
      const res = await savePlatformCredentials(
        reqFor('instagram', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '', appSecret: 'some-secret-value' }),
        }),
        ctx('instagram')
      );
      expect(res.status).toBe(400);
    });

    it('saves threads credentials into platform_credentials and returns the frozen shape', async () => {
      const upsertMock = vi.fn().mockResolvedValue({ error: null });
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId, upsertMock }) as any
      );

      const res = await savePlatformCredentials(
        reqFor('threads', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '987654321', appSecret: 'threads-secret-123' }),
        }),
        ctx('threads')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.hasSecret).toBe(true);
      expect(json.status).toBe('unverified');
      expect(typeof json.connectedAt).toBe('string');

      expect(upsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          platform: 'threads',
          client_id: '987654321',
          status: 'unverified',
        }),
        { onConflict: 'workspace_id,platform' }
      );
      const row = upsertMock.mock.calls[0][0];
      expect(row.encrypted_client_secret).toBeTruthy();
      expect(row.encrypted_client_secret).not.toBe('threads-secret-123');
    });

    it('returns 400 when omitting the secret on first-time setup', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId, credsRow: null }) as any
      );

      const res = await savePlatformCredentials(
        reqFor('instagram', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '123456789' }),
        }),
        ctx('instagram')
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Enter your Instagram App Secret');
    });

    it('keeps the existing secret when saving a new App ID without one', async () => {
      const encrypted = await encryptToken('existing-ig-secret', TEST_ENCRYPTION_KEY);
      const updateMock = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
      });
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({
          workspaceId,
          credsRow: { encrypted_client_secret: encrypted },
          updateMock,
        }) as any
      );

      const res = await savePlatformCredentials(
        reqFor('instagram', {
          method: 'PUT',
          headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: '555444333' }),
        }),
        ctx('instagram')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ client_id: '555444333', status: 'unverified' })
      );
    });
  });

  describe('DELETE', () => {
    it('returns 401 when request lacks authentication session', async () => {
      const res = await deletePlatformCredentials(
        reqFor('instagram', { method: 'DELETE' }),
        ctx('instagram')
      );
      expect(res.status).toBe(401);
    });

    it('deletes only that platform\'s credentials row and returns the frozen shape', async () => {
      const platformEqMock = vi.fn().mockResolvedValue({ error: null });
      const workspaceEqMock = vi.fn().mockReturnValue({ eq: platformEqMock });
      const deleteMock = vi.fn().mockReturnValue({ eq: workspaceEqMock });
      const tablesUsed: string[] = [];
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId, deleteMock, tablesUsed }) as any
      );

      const res = await deletePlatformCredentials(
        reqFor('instagram', { method: 'DELETE', headers: { cookie: validSessionCookie } }),
        ctx('instagram')
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, disconnected: true });
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(workspaceEqMock).toHaveBeenCalledWith('workspace_id', workspaceId);
      expect(platformEqMock).toHaveBeenCalledWith('platform', 'instagram');
      expect(tablesUsed).not.toContain('social_accounts');
      expect(tablesUsed).not.toContain('destinations');
    });
  });

  describe('POST reveal (spec 139 N3)', () => {
    const SAVED_SECRET = 'threads-secret-777';

    function revealReq(platform: string, cookie?: string) {
      return new NextRequest(
        `http://localhost:3000/api/tenant/${subdomain}/settings/platform-credentials/${platform}/reveal`,
        { method: 'POST', headers: cookie ? { cookie } : {} }
      );
    }

    it('returns 401 when request lacks authentication session', async () => {
      const res = await revealPlatformSecret(revealReq('threads'), ctx('threads'));
      expect(res.status).toBe(401);
    });

    it('returns 403 when session subdomain does not match request tenant', async () => {
      const res = await revealPlatformSecret(
        revealReq('threads', otherTenantSessionCookie),
        ctx('threads')
      );
      expect(res.status).toBe(403);
    });

    it('returns 400 for a non-BYOC platform', async () => {
      const res = await revealPlatformSecret(
        revealReq('facebook', validSessionCookie),
        ctx('facebook')
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when no secret is saved for the workspace', async () => {
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({ workspaceId, credsRow: null }) as any
      );
      const res = await revealPlatformSecret(
        revealReq('threads', validSessionCookie),
        ctx('threads')
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain(SAVED_SECRET);
    });

    it('returns the saved secret once, no-store, and logs the reveal WITHOUT the value', async () => {
      const encrypted = await encryptToken(SAVED_SECRET, TEST_ENCRYPTION_KEY);
      vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(
        makeSupabase({
          workspaceId,
          credsRow: {
            workspace_id: workspaceId,
            platform: 'threads',
            client_id: '987654321',
            encrypted_client_secret: encrypted,
            status: 'valid',
            last_tested_at: '2026-10-14T10:00:00Z',
            created_at: '2026-10-14T09:00:00Z',
            updated_at: '2026-10-14T09:00:00Z',
          },
        }) as any
      );
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const res = await revealPlatformSecret(
        revealReq('threads', validSessionCookie),
        ctx('threads')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const json = await res.json();
      expect(json).toEqual({ appSecret: SAVED_SECRET });

      // The reveal is audited — and the audit line must not carry
      // the secret value anywhere in any argument.
      expect(infoSpy).toHaveBeenCalled();
      for (const call of infoSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SAVED_SECRET);
      }
    });
  });
});
