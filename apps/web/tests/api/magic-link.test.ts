import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signMagicLinkToken,
  signOAuthState,
  signSessionToken,
  verifyOAuthState,
} from '@fbuploadpro/contracts';
import { POST as generateMagicLink } from '../../src/app/api/tenant/[subdomain]/accounts/magic-link/route';
import { GET as forwardMagicLink } from '../../src/app/connect/facebook/route';
import { handleFacebookCallback } from '../../src/app/api/auth/facebook/callback/route';
import * as authModule from '@/lib/auth/clients';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Magic Link Facebook Connection Endpoints (Spec 027)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let validEncryptedFbAppSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.FACEBOOK_APP_ID = 'fb_app_id_123';
    process.env.FACEBOOK_APP_SECRET = 'fb_app_secret_456';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

    validEncryptedFbAppSecret = await encryptToken('fb_app_secret_456', TEST_ENCRYPTION_KEY);

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
                client_id: 'fb_app_id_123',
                encrypted_client_secret: validEncryptedFbAppSecret,
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

  describe('POST /api/tenant/[subdomain]/accounts/magic-link', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/accounts/magic-link',
        { method: 'POST' }
      );
      const res = await generateMagicLink(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 403 on tenant subdomain mismatch', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/other-tenant/accounts/magic-link',
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await generateMagicLink(req, {
        params: Promise.resolve({ subdomain: 'other-tenant' }),
      });

      expect(res.status).toBe(403);
    });

    it('generates 15-minute signed magic link url on valid session', async () => {
      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/accounts/magic-link',
        {
          method: 'POST',
          headers: { cookie: validSessionCookie },
        }
      );
      const res = await generateMagicLink(req, {
        params: Promise.resolve({ subdomain: 'acme' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.magicUrl).toContain('http://localhost:3000/connect/facebook?token=');
      expect(data.expiresInSeconds).toBe(900);
      expect(data.expiresAt).toBeDefined();
    });
  });

  describe('GET /connect/facebook (Magic Link Forwarder)', () => {
    it('redirects to error page when token is missing', async () => {
      const req = new NextRequest('http://localhost:3000/connect/facebook');
      const res = await forwardMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/facebook/error?reason=missing_token'
      );
    });

    it('redirects to error page when token is invalid or expired', async () => {
      const req = new NextRequest(
        'http://localhost:3000/connect/facebook?token=invalid.token.signature'
      );
      const res = await forwardMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/facebook/error?reason=expired_or_invalid'
      );
    });

    it('redirects to Facebook OAuth dialog with isMagic=true in signed state', async () => {
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
        `http://localhost:3000/connect/facebook?token=${magicToken}`
      );
      const res = await forwardMagicLink(req);

      expect(res.status).toBe(307);
      const location = res.headers.get('location');
      expect(location).toBeDefined();

      const url = new URL(location!);
      expect(url.origin).toBe('https://www.facebook.com');
      expect(url.pathname).toBe('/v26.0/dialog/oauth');

      const state = url.searchParams.get('state');
      expect(state).toBeDefined();

      const statePayload = await verifyOAuthState(state!, TEST_SECRET);
      expect(statePayload.tenantSubdomain).toBe('acme');
      expect(statePayload.userId).toBe(userId);
      expect(statePayload.isMagic).toBe(true);
    });

    it('resolves workspace BYOC app_id if configured in platform_credentials', async () => {
      const now = Math.floor(Date.now() / 1000);
      const magicToken = await signMagicLinkToken(
        {
          tenantSubdomain: 'custom-agency',
          userId,
          nonce: 'test_nonce_byoc_123',
          iat: now,
          exp: now + 900,
        },
        TEST_SECRET
      );

      const authModule = await import('../../src/lib/auth/clients');
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'workspace-custom-agency-id' },
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
                  client_id: 'byoc_custom_fb_app_999',
                  encrypted_client_secret: validEncryptedFbAppSecret,
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
      const spy = vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);

      const req = new NextRequest(
        `http://localhost:3000/connect/facebook?token=${magicToken}`
      );
      const res = await forwardMagicLink(req);

      expect(res.status).toBe(307);
      const location = res.headers.get('location');
      expect(location).toBeDefined();

      const url = new URL(location!);
      expect(url.searchParams.get('client_id')).toBe('byoc_custom_fb_app_999');

      spy.mockRestore();
    });

    it('redirects to error page if neither BYOC nor process.env.FACEBOOK_APP_ID is configured', async () => {
      const savedEnv = process.env.FACEBOOK_APP_ID;
      delete process.env.FACEBOOK_APP_ID;

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
        `http://localhost:3000/connect/facebook?token=${magicToken}`
      );
      const res = await forwardMagicLink(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/facebook/error?reason=app_not_configured'
      );

      process.env.FACEBOOK_APP_ID = savedEnv;
    });
  });

  describe('OAuth Callback with isMagic Flag', () => {
    it('redirects to /connect/facebook/success when isMagic is true', async () => {
      const now = Math.floor(Date.now() / 1000);
      const state = await signOAuthState(
        {
          tenantSubdomain: 'acme',
          userId,
          nonce: 'test_nonce_12345678',
          iat: now,
          exp: now + 600,
          isMagic: true,
        },
        TEST_SECRET
      );

      // Mock Graph API token exchange
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_short_token_123',
            token_type: 'bearer',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_long_token_456',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'fb_user_magic_999',
            name: 'Magic User',
            gender: 'female',
            link: 'https://facebook.com/magicuser',
            picture: {
              data: {
                url: 'https://graph.facebook.com/v26.0/magic/picture',
              },
            },
          }),
        });

      const mockDb: DatabaseClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'workspace_acme_123' }]);
          }
          if (sql.includes('FROM platform_credentials')) {
            return Promise.resolve([
              {
                client_id: 'fb_app_id_123',
                encrypted_client_secret: validEncryptedFbAppSecret,
              },
            ]);
          }
          return Promise.resolve([{ id: 'mock-account-uuid' }]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        `http://localhost:3000/api/auth/facebook/callback?code=mock_code&state=${state}`
      );
      const res = await handleFacebookCallback(req, mockDb);

      expect(res.status).toBe(307);
      // Option B dialogue: the fresh magic redirect now carries the
      // account name so the success page can confirm "[Name] connected".
      expect(res.headers.get('location')).toBe(
        'http://localhost:3000/connect/facebook/success?accountName=Magic+User'
      );
    });
  });

  // Magic-link host fix: the callback runs on the workspace-subdomain
  // host, but the connect pages only exist on the app host. Every
  // magic redirect out of the callback must therefore land on the app
  // host, or the magic browser (which holds no fbup_session) is sent
  // to /login by the tenant login gate despite the account having
  // just connected.
  describe('OAuth callback on a tenant host redirects magic flows to the app host', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
      process.env.NEXT_PUBLIC_APP_URL = 'https://app.fbuploadpro.com';
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    });

    const signMagicState = async () =>
      signOAuthState(
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

    const mockGraphSuccess = () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_short_token',
            token_type: 'bearer',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock_long_token',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'fb_user_magic_999',
            name: 'Magic User',
            gender: 'female',
            link: 'https://facebook.com/magicuser',
            picture: {
              data: {
                url: 'https://graph.facebook.com/v26.0/magic/picture',
              },
            },
          }),
        });
    };

    const mockDbFor = (alreadyExisted: boolean): DatabaseClient =>
      ({
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'workspace_acme_123' }]);
          }
          if (sql.includes('FROM platform_credentials')) {
            return Promise.resolve([
              {
                client_id: 'fb_app_id_123',
                encrypted_client_secret: validEncryptedFbAppSecret,
              },
            ]);
          }
          if (sql.includes('SELECT id, status FROM social_accounts')) {
            return Promise.resolve(
              alreadyExisted ? [{ id: 'existing_acct', status: 'active' }] : []
            );
          }
          return Promise.resolve([{ id: 'mock-account-uuid' }]);
        }),
      }) as unknown as DatabaseClient;

    const tenantCallbackUrl = (query: string) =>
      `https://acme.fbuploadpro.com/api/auth/facebook/callback?${query}`;

    it('redirects a fresh magic success to the app host, not the tenant host', async () => {
      const state = await signMagicState();
      mockGraphSuccess();
      const req = new NextRequest(
        tenantCallbackUrl(`code=mock_code&state=${state}`)
      );
      const res = await handleFacebookCallback(req, mockDbFor(false));

      expect(res.status).toBe(307);
      // Option B dialogue: fresh magic redirect also carries the name
      // for the "[Name] connected" success page.
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/facebook/success?accountName=Magic+User'
      );
    });

    it('redirects an already-connected magic success to the app host with already_connected=1', async () => {
      const state = await signMagicState();
      mockGraphSuccess();
      const req = new NextRequest(
        tenantCallbackUrl(`code=mock_code&state=${state}`)
      );
      const res = await handleFacebookCallback(req, mockDbFor(true));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get('location')!);
      expect(location.origin).toBe('https://app.fbuploadpro.com');
      expect(location.pathname).toBe('/connect/facebook/success');
      expect(location.searchParams.get('already_connected')).toBe('1');
      expect(location.searchParams.get('accountName')).toBe('Magic User');
    });

    it('redirects a magic cancellation to the app-host error page', async () => {
      const state = await signMagicState();
      const req = new NextRequest(
        tenantCallbackUrl(
          `error=access_denied&error_description=User+denied&state=${state}`
        )
      );
      const res = await handleFacebookCallback(req, mockDbFor(false));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/facebook/error?reason=cancelled'
      );
    });

    it('redirects a magic token-exchange failure to the app-host error page', async () => {
      const state = await signMagicState();
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Invalid verification code' } }),
          { status: 400 }
        )
      );
      const req = new NextRequest(
        tenantCallbackUrl(`code=bad_code&state=${state}`)
      );
      const res = await handleFacebookCallback(req, mockDbFor(false));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/facebook/error?reason=oauth_failed'
      );
    });

    it('redirects a magic credentials failure to the app-host error page', async () => {
      const state = await signMagicState();
      const noWorkspaceDb = {
        query: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseClient;
      const req = new NextRequest(
        tenantCallbackUrl(`code=mock_code&state=${state}`)
      );
      const res = await handleFacebookCallback(req, noWorkspaceDb);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/facebook/error?reason=credentials_required'
      );
    });

    it('redirects a magic internal error to the app-host error page', async () => {
      const state = await signMagicState();
      global.fetch = vi.fn().mockRejectedValue(new Error('graph down'));
      const req = new NextRequest(
        tenantCallbackUrl(`code=mock_code&state=${state}`)
      );
      const res = await handleFacebookCallback(req, mockDbFor(false));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://app.fbuploadpro.com/connect/facebook/error?reason=internal_oauth_error'
      );
    });
  });
});
