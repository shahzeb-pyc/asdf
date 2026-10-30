import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signMagicLinkToken,
  signOAuthState,
  signSessionToken,
  verifyMagicLinkToken,
  verifyOAuthState,
} from '@fbuploadpro/contracts';
import { POST as generateInstagramMagicLink } from '../../src/app/api/tenant/[subdomain]/instagram/accounts/magic-link/route';
import { GET as forwardInstagramMagicLink } from '../../src/app/connect/instagram/route';
import { handleInstagramCallback } from '../../src/app/api/auth/instagram/callback/route';
import { handleInitiateInstagramOAuth } from '../../src/app/api/auth/instagram/route';
import * as authModule from '@/lib/auth/clients';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-for-magic-link-tests-0123456789';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Magic Link Instagram Connection Endpoints', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let noCredsSessionCookie: string;
  let validEncryptedIgAppSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;

    validEncryptedIgAppSecret = await encryptToken('ig_app_secret_456', TEST_ENCRYPTION_KEY);

    const defaultMockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockImplementation((col: string, val: string) => {
              if (col === 'subdomain' && val === 'no-creds') {
                return {
                  eq: vi.fn().mockReturnThis(),
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                };
              }
              return {
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { id: 'workspace_acme_123', subdomain: val },
                  error: null,
                }),
              };
            }),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'workspace_acme_123' },
              error: null,
            }),
          };
        }
        if (table === 'platform_credentials') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                client_id: 'ig_app_id_123',
                encrypted_client_secret: validEncryptedIgAppSecret,
              },
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };
    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(defaultMockSupabase as any);

    validSessionCookie = `fbup_session=${await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    )}`;
    noCredsSessionCookie = `fbup_session=${await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'no-creds',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    )}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals?.();
  });

  describe('POST /api/tenant/[subdomain]/instagram/accounts/magic-link', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts/magic-link',
        { method: 'POST' }
      );
      const res = await generateInstagramMagicLink(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 403 on tenant subdomain mismatch', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/other-tenant/instagram/accounts/magic-link',
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await generateInstagramMagicLink(req, {
        params: Promise.resolve({ subdomain: 'other-tenant' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 422 when Instagram BYOC is not configured', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/no-creds/instagram/accounts/magic-link',
        {
          method: 'POST',
          headers: { cookie: noCredsSessionCookie },
        }
      );
      const res = await generateInstagramMagicLink(req, {
        params: Promise.resolve({ subdomain: 'no-creds' }),
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe('BYOC_NOT_CONFIGURED');
    });

    it('generates a 15-minute signed magic link url on valid session', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts/magic-link',
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await generateInstagramMagicLink(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.magicUrl).toContain('http://localhost:3000/connect/instagram?token=');
      expect(data.expiresInSeconds).toBe(900);
      expect(data.expiresAt).toBeDefined();
      // Reusable within the window: the issued token verifies twice.
      const token = new URL(data.magicUrl).searchParams.get('token') ?? '';
      await expect(verifyMagicLinkToken(token, TEST_SECRET)).resolves.toMatchObject({
        tenantSubdomain: 'acme',
      });
      await expect(verifyMagicLinkToken(token, TEST_SECRET)).resolves.toMatchObject({
        tenantSubdomain: 'acme',
      });
    });

    it('carries the expected account hint in the signed token', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/instagram/accounts/magic-link',
        {
          method: 'POST',
          headers: {
            cookie: validSessionCookie,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedInstagramAccountId: 'ig_user_123',
            expectedDisplayName: 'Sunset Bakery',
          }),
        }
      );
      const res = await generateInstagramMagicLink(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      const token = new URL(data.magicUrl).searchParams.get('token') ?? '';
      const payload = await verifyMagicLinkToken(token, TEST_SECRET);
      expect(payload.expectedInstagramAccountId).toBe('ig_user_123');
      expect(payload.expectedDisplayName).toBe('Sunset Bakery');
    });
  });

  describe('GET /connect/instagram (Magic Link Forwarder)', () => {
    it('redirects to error page when token is missing', async () => {
      const req = new NextRequest('http://localhost:3000/connect/instagram');
      const res = await forwardInstagramMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=missing_token'
      );
    });

    it('redirects to error page when token is invalid or expired', async () => {
      const req = new NextRequest(
        'http://localhost:3000/connect/instagram?token=invalid.token.here'
      );
      const res = await forwardInstagramMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=expired_or_invalid'
      );
    });

    it('redirects to Instagram OAuth dialog with isMagic=true in signed state', async () => {
      const now = Math.floor(Date.now() / 1000);
      const magicToken = await signMagicLinkToken(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'test_nonce_12345678',
          iat: now,
          exp: now + 900,
        },
        TEST_SECRET
      );

      const req = new NextRequest(
        `http://localhost:3000/connect/instagram?token=${magicToken}`
      );
      const res = await forwardInstagramMagicLink(req);

      expect(res.status).toBe(307);
      const location = res.headers.get('location') ?? '';
      const url = new URL(location);
      expect(url.origin).toBe('https://api.instagram.com');
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('ig_app_id_123');
      expect(url.searchParams.get('response_type')).toBe('code');
      const state = url.searchParams.get('state') ?? '';
      const payload = await verifyOAuthState(state, TEST_SECRET);
      expect(payload.isMagic).toBe(true);
      expect(payload.tenantSubdomain).toBe('acme');
    });

    it('reuses the same magic token for a second forward (no single-use)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const magicToken = await signMagicLinkToken(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'reuse_nonce_12345678',
          iat: now,
          exp: now + 900,
        },
        TEST_SECRET
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const req = new NextRequest(
          `http://localhost:3000/connect/instagram?token=${magicToken}`
        );
        const res = await forwardInstagramMagicLink(req);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain(
          'https://api.instagram.com/oauth/authorize'
        );
      }
    });

    it('redirects to error page if Instagram BYOC is not configured', async () => {
      const now = Math.floor(Date.now() / 1000);
      const magicToken = await signMagicLinkToken(
        {
          tenantSubdomain: 'no-creds',
          userId,
          nonce: 'test_nonce_no_creds_123',
          iat: now,
          exp: now + 900,
        },
        TEST_SECRET
      );

      const req = new NextRequest(
        `http://localhost:3000/connect/instagram?token=${magicToken}`
      );
      const res = await forwardInstagramMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=app_not_configured'
      );
    });
  });

  describe('GET /api/auth/instagram (Direct Initiate)', () => {
    it('redirects to login without a session', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/instagram');
      const res = await handleInitiateInstagramOAuth(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost:3000/login');
    });

    it('redirects to the Instagram authorize dialog with a non-magic state', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/instagram', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleInitiateInstagramOAuth(req);

      expect(res.status).toBe(307);
      const location = res.headers.get('location') ?? '';
      const url = new URL(location);
      expect(url.origin).toBe('https://api.instagram.com');
      expect(url.pathname).toBe('/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('ig_app_id_123');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/instagram/callback'
      );
      const state = url.searchParams.get('state') ?? '';
      const payload = await verifyOAuthState(state, TEST_SECRET);
      expect(payload.isMagic).toBeUndefined();
      expect(payload.tenantSubdomain).toBe('acme');
    });

    it('redirects to Instagram settings when BYOC is not configured', async () => {
      const req = new NextRequest('http://localhost:3000/api/auth/instagram', {
        headers: { cookie: noCredsSessionCookie },
      });
      const res = await handleInitiateInstagramOAuth(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/tenant/no-creds/settings?tab=instagram&error=credentials_required'
      );
    });
  });

  describe('Instagram OAuth Callback', () => {
    function mockInstagramFetch(profileOverrides: Record<string, unknown> = {}) {
      const profile = {
        id: 'ig_user_999',
        username: 'sunsetbakery',
        name: 'Sunset Bakery',
        account_type: 'BUSINESS',
        profile_picture_url: 'https://cdn.example/pic.jpg',
        ...profileOverrides,
      };
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'ig_short_token', user_id: 'ig_user_999' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'ig_long_token', expires_in: 5184000 }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => profile })
        .mockResolvedValueOnce({ ok: true, json: async () => profile });
    }

    function mockDb(options: { creds?: boolean; existing?: boolean } = {}): DatabaseClient {
      const { creds = true, existing = false } = options;
      return {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'workspace_acme_123' }]);
          }
          if (sql.includes('FROM platform_credentials')) {
            return Promise.resolve(
              creds
                ? [
                    {
                      client_id: 'ig_app_id_123',
                      encrypted_client_secret: validEncryptedIgAppSecret,
                    },
                  ]
                : []
            );
          }
          if (sql.includes('SELECT id FROM social_accounts')) {
            return Promise.resolve(existing ? [{ id: 'existing-account-id' }] : []);
          }
          if (sql.includes('INSERT INTO social_accounts')) {
            return Promise.resolve([{ id: 'mock-account-uuid' }]);
          }
          if (sql.includes('INSERT INTO destinations')) {
            return Promise.resolve([{ id: 'mock-destination-uuid' }]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
    }

    const signState = async (overrides: Record<string, unknown> = {}) =>
      signOAuthState(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'test_nonce_12345678',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          ...overrides,
        },
        TEST_SECRET
      );

    it('redirects to /connect/instagram/success when isMagic is true', async () => {
      mockInstagramFetch();
      const state = await signState({ isMagic: true });
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/success?accountName=Sunset+Bakery'
      );
    });

    it('redirects a direct connect to the tenant Instagram accounts page with connected=1', async () => {
      mockInstagramFetch();
      const state = await signState();
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`,
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/tenant/acme/instagram/accounts?connected=1&accountName=Sunset+Bakery'
      );
    });

    it('reports already-connected on a direct reconnect of a known account', async () => {
      mockInstagramFetch();
      const state = await signState();
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`,
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleInstagramCallback(req, mockDb({ existing: true }));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/tenant/acme/instagram/accounts?connected=already&accountName=Sunset+Bakery'
      );
    });

    it('reports a reconnect mismatch on the magic success page', async () => {
      mockInstagramFetch();
      const state = await signState({
        isMagic: true,
        expectedInstagramAccountId: 'ig_user_other',
        expectedDisplayName: 'Old Account',
      });
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/success?reconnected_mismatch=1&newAccountName=Sunset+Bakery&expectedAccountName=Old+Account'
      );
    });

    it('redirects a cancelled OAuth return to the app-host error page', async () => {
      const state = await signState({ isMagic: true });
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?error=access_denied&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=cancelled'
      );
    });

    it('redirects to the app-host error page when credentials are missing (magic)', async () => {
      const state = await signState({ isMagic: true });
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb({ creds: false }));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=credentials_required'
      );
    });

    it('redirects to the tenant accounts page with an error when credentials are missing (direct)', async () => {
      const state = await signState();
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`,
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleInstagramCallback(req, mockDb({ creds: false }));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/tenant/acme/instagram/accounts?error=credentials_required'
      );
    });

    it('refuses a personal Instagram account with an oauth error (magic)', async () => {
      mockInstagramFetch({ account_type: 'PERSONAL' });
      const state = await signState({ isMagic: true });
      const req = new NextRequest(
        `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=oauth_failed'
      );
    });

    it('lands on the app-host error page for a missing code/state (no tenant known)', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/auth/instagram/callback'
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=missing_code_or_state'
      );
    });

    it('lands on the app-host error page for an unverifiable state', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=garbage.state'
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/instagram/error?reason=expired_or_invalid'
      );
    });
  });

  // Magic-link host rule: the callback runs on the workspace-subdomain
  // host, but the connect pages only exist on the app host. Every magic
  // redirect out of the callback must therefore land on the app host,
  // or the magic browser (which holds no fbup_session) is sent to
  // /login by the tenant login gate despite the account having just
  // connected.
  describe('OAuth callback on a tenant host redirects magic flows to the app host', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    });

    function mockInstagramFetch() {
      const profile = {
        id: 'ig_user_999',
        username: 'sunsetbakery',
        name: 'Sunset Bakery',
        account_type: 'BUSINESS',
        profile_picture_url: 'https://cdn.example/pic.jpg',
      };
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'ig_short_token', user_id: 'ig_user_999' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'ig_long_token', expires_in: 5184000 }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => profile })
        .mockResolvedValueOnce({ ok: true, json: async () => profile });
    }

    function mockDb(): DatabaseClient {
      return {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'workspace_acme_123' }]);
          }
          if (sql.includes('FROM platform_credentials')) {
            return Promise.resolve([
              {
                client_id: 'ig_app_id_123',
                encrypted_client_secret: validEncryptedIgAppSecret,
              },
            ]);
          }
          if (sql.includes('SELECT id FROM social_accounts')) {
            return Promise.resolve([]);
          }
          if (sql.includes('INSERT INTO social_accounts')) {
            return Promise.resolve([{ id: 'mock-account-uuid' }]);
          }
          if (sql.includes('INSERT INTO destinations')) {
            return Promise.resolve([{ id: 'mock-destination-uuid' }]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
    }

    it('redirects magic success to the app host, not the tenant host', async () => {
      mockInstagramFetch();
      const state = await signOAuthState(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'tenant_host_magic_nonce_1234',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          isMagic: true,
        },
        TEST_SECRET
      );
      const req = new NextRequest(
        `https://acme.fbuploadpro.com/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/instagram/success?accountName=Sunset+Bakery'
      );
    });

    it('redirects a magic token-exchange failure to the app-host error page', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: { message: 'bad code' } }),
      });
      const state = await signOAuthState(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'tenant_host_magic_nonce_5678',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 600,
          isMagic: true,
        },
        TEST_SECRET
      );
      const req = new NextRequest(
        `https://acme.fbuploadpro.com/api/auth/instagram/callback?code=mock_code&state=${state}`
      );
      const res = await handleInstagramCallback(req, mockDb());

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/instagram/error?reason=oauth_failed'
      );
    });
  });
});
