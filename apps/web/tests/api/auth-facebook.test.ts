import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  decryptToken,
  encryptToken,
  signOAuthState,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleInitiateFacebookOAuth as initiateFacebookOAuth } from '../../src/app/api/auth/facebook/route';
import { handleFacebookCallback } from '../../src/app/api/auth/facebook/callback/route';
import { handleListAccounts } from '../../src/app/api/tenant/[subdomain]/accounts/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Facebook OAuth Initiation & Callback Handlers (User Story 1 - T058)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let validEncryptedFbAppSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.FACEBOOK_APP_ID = 'fb_app_id_123';
    process.env.FACEBOOK_APP_SECRET = 'fb_app_secret_456';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;

    validEncryptedFbAppSecret = await encryptToken(
      'mock_fb_app_secret_value',
      TEST_ENCRYPTION_KEY
    );

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

  it('redirects unauthenticated users to /login when initiating OAuth', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/facebook');
    const res = await initiateFacebookOAuth(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('redirects authenticated users to Facebook OAuth dialog targeting v26.0 with required scopes and workspace BYOC client_id', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (typeof sql === 'string' && sql.includes('FROM platform_credentials')) {
          return Promise.resolve([
            {
              client_id: 'fb_app_id_byoc_workspace',
              encrypted_client_secret: validEncryptedFbAppSecret,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('http://localhost:3000/api/auth/facebook', {
      headers: { cookie: validSessionCookie },
    });
    const res = await initiateFacebookOAuth(req, mockDb);

    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toBeDefined();

    const url = new URL(location!);
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v26.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('fb_app_id_byoc_workspace');
    expect(url.searchParams.get('scope')).toBe(
      'pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement,business_management'
    );
    expect(url.searchParams.get('state')).toBeDefined();
  });

  it('constructs workspace subdomain redirect_uri in Facebook OAuth dialog URL when NEXT_PUBLIC_ROOT_DOMAIN is configured (Spec 047)', async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'vinsmokemedia.online';
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (typeof sql === 'string' && sql.includes('platform_credentials')) {
          return Promise.resolve([
            {
              workspace_id: 'ws_123',
              client_id: 'fb_app_id_byoc_workspace',
              encrypted_client_secret: validEncryptedFbAppSecret,
              status: 'valid',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('https://acme.vinsmokemedia.online/api/auth/facebook', {
      headers: { cookie: validSessionCookie },
    });
    const res = await initiateFacebookOAuth(req, mockDb);

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://acme.vinsmokemedia.online/api/auth/facebook/callback'
    );
  });

  it('handles Facebook OAuth callback error with safe redirection', async () => {
    const mockDb = { query: vi.fn() } as unknown as DatabaseClient;
    const req = new NextRequest(
      'http://localhost:3000/api/auth/facebook/callback?error=access_denied&error_description=User+denied+permissions&state=fake'
    );

    const res = await handleFacebookCallback(req, mockDb);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/accounts');
    expect(location).toContain('error=access_denied');
  });

  it('processes valid callback, exchanges code for long-lived token, encrypts token, and persists account', async () => {
    const statePayload = {
      tenantSubdomain: 'acme',
      userId,
      nonce: 'random_nonce_1234567890',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const validState = await signOAuthState(statePayload, TEST_SECRET);

    // Mock fetch for Graph API calls
    const mockFetch = vi.fn();
    // 1. Code to short-lived token
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'short_lived_token_abc',
          token_type: 'bearer',
          expires_in: 7200,
        }),
        { status: 200 }
      )
    );
    // 2. Short-lived to long-lived token
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'long_lived_token_xyz_60_days',
          token_type: 'bearer',
          expires_in: 5184000,
        }),
        { status: 200 }
      )
    );
    // 3. User profile /me
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'fb_user_10928374',
          name: 'Alex Professional',
        }),
        { status: 200 }
      )
    );
    global.fetch = mockFetch;

    let savedEncryptedToken = '';
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (typeof sql === 'string' && sql.includes('FROM platform_credentials')) {
          return Promise.resolve([
            {
              client_id: 'fb_app_id_123',
              encrypted_client_secret: validEncryptedFbAppSecret,
            },
          ]);
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO social_accounts')) {
          savedEncryptedToken = params[3] as string;
          return Promise.resolve([{ id: 'acc_123' }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=mock_code_123&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleFacebookCallback(req, mockDb);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/tenant/acme/accounts?connected=1');

    expect(mockDb.query).toHaveBeenCalled();
    expect(savedEncryptedToken).toBeTypeOf('string');
    expect(savedEncryptedToken).toContain(':');

    // Verify encrypted token decodes back to original long-lived token
    const decrypted = await decryptToken(savedEncryptedToken, TEST_ENCRYPTION_KEY);
    expect(decrypted).toBe('long_lived_token_xyz_60_days');
  });

  it('redirects to canonical tenant subdomain https://acme.vinsmokemedia.online/accounts?connected=1 when NEXT_PUBLIC_ROOT_DOMAIN is configured (Spec 029)', async () => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'vinsmokemedia.online';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.vinsmokemedia.online';

    const statePayload = {
      tenantSubdomain: 'acme',
      userId,
      nonce: 'random_nonce_prod_subdomain',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const validState = await signOAuthState(statePayload, TEST_SECRET);

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'short_token',
            token_type: 'bearer',
            expires_in: 7200,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'long_token',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'fb_user_prod_99',
            name: 'Acme Operator',
          }),
          { status: 200 }
        )
      );

    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_prod_99' }]);
        }
        if (typeof sql === 'string' && sql.includes('FROM platform_credentials')) {
          return Promise.resolve([
            {
              client_id: 'fb_app_id_123',
              encrypted_client_secret: validEncryptedFbAppSecret,
            },
          ]);
        }
        return Promise.resolve([{ id: 'acc_prod_99' }]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest(
      `https://app.vinsmokemedia.online/api/auth/facebook/callback?code=prod_code_99&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleFacebookCallback(req, mockDb);
    expect(res.status).toBe(307);
    // Option B dialogue: the fresh direct redirect also carries the
    // account name for the "[Name] connected" toast.
    expect(res.headers.get('location')).toBe(
      'https://acme.vinsmokemedia.online/accounts?connected=1&accountName=Acme+Operator'
    );
  });

  it('pins expired accounts to the top of the returned array ahead of active accounts in handleListAccounts (Spec 029)', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        return Promise.resolve([
          {
            id: '11111111-2222-4333-8444-555555555501',
            fb_account_id: 'fb_active_newer',
            display_name: 'Active Newer Account',
            profile_picture_url: null,
            gender: 'female',
            account_link: null,
            status: 'active',
            token_expires_at: new Date(Date.now() + 86400 * 1000).toISOString(),
            connected_pages_count: 2,
            created_at: new Date('2026-10-10T12:00:00Z'),
            updated_at: new Date('2026-10-10T12:00:00Z'),
          },
          {
            id: '11111111-2222-4333-8444-555555555502',
            fb_account_id: 'fb_expired_older',
            display_name: 'Expired Older Account',
            profile_picture_url: null,
            gender: 'male',
            account_link: null,
            status: 'expired',
            token_expires_at: new Date(Date.now() - 86400 * 1000).toISOString(),
            connected_pages_count: 1,
            created_at: new Date('2026-09-01T12:00:00Z'),
            updated_at: new Date('2026-09-01T12:00:00Z'),
          },
        ]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListAccounts(req, 'acme', mockDb);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts[0].displayName).toBe('Expired Older Account');
    expect(body.accounts[0].status).toBe('expired');
    expect(body.accounts[1].displayName).toBe('Active Newer Account');
    expect(body.accounts[1].status).toBe('active');
  });

  it('redirects remote Magic Link cancellation (isMagic: true, error=access_denied) to /connect/facebook/error?reason=cancelled (Spec 031)', async () => {
    const magicState = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'magic_cancel_nonce_12345',
        isMagic: true,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );

    const mockDb = { query: vi.fn() } as unknown as DatabaseClient;
    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?error=access_denied&error_description=Permissions+error&state=${magicState}`
    );

    const res = await handleFacebookCallback(req, mockDb);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toBe('http://localhost:3000/connect/facebook/error?reason=cancelled');
    expect(location).not.toContain('/accounts');
  });

  it('redirects remote Magic Link token exchange or /me failure (isMagic: true) to /connect/facebook/error?reason=oauth_failed (Spec 031)', async () => {
    const magicState = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'magic_fail_nonce_12345',
        isMagic: true,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );

    // 1. Short-lived token exchange fails
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid verification code' } }), {
        status: 400,
      })
    );

    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (typeof sql === 'string' && sql.includes('FROM platform_credentials')) {
          return Promise.resolve([
            {
              client_id: 'fb_app_id_123',
              encrypted_client_secret: validEncryptedFbAppSecret,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;
    const req1 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=bad_code&state=${magicState}`
    );

    const res1 = await handleFacebookCallback(req1, mockDb);
    expect(res1.status).toBe(307);
    expect(res1.headers.get('location')).toBe(
      'http://localhost:3000/connect/facebook/error?reason=oauth_failed'
    );

    // 2. /me profile fetch fails
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'short_tok', token_type: 'bearer' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'long_tok', token_type: 'bearer' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response('Graph API error', { status: 500 }));

    const req2 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=good_code&state=${magicState}`
    );
    const res2 = await handleFacebookCallback(req2, mockDb);
    expect(res2.status).toBe(307);
    expect(res2.headers.get('location')).toBe(
      'http://localhost:3000/connect/facebook/error?reason=oauth_failed'
    );
  });

  it('maps connected_pages onto connectedPages array in handleListAccounts (Spec 031)', async () => {
    const page1Id = '22222222-3333-4444-8555-666666666601';
    const page2Id = '22222222-3333-4444-8555-666666666602';
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        return Promise.resolve([
          {
            id: '11111111-2222-4333-8444-555555555501',
            fb_account_id: 'fb_with_pages',
            display_name: 'Account With Linked Pages',
            profile_picture_url: null,
            gender: 'female',
            account_link: null,
            status: 'active',
            token_expires_at: new Date(Date.now() + 86400 * 1000).toISOString(),
            connected_pages_count: 2,
            connected_pages: [
              {
                id: page1Id,
                pageName: 'Alpha Brand Page',
                profilePictureUrl: 'https://graph.facebook.com/v26.0/p1/picture',
              },
              {
                id: page2Id,
                pageName: 'Beta Creator Page',
                profilePictureUrl: null,
              },
            ],
            created_at: new Date('2026-10-10T12:00:00Z'),
            updated_at: new Date('2026-10-10T12:00:00Z'),
          },
        ]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListAccounts(req, 'acme', mockDb);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].connectedPagesCount).toBe(2);
    expect(body.accounts[0].connectedPages).toEqual([
      {
        id: page1Id,
        pageName: 'Alpha Brand Page',
        profilePictureUrl: 'https://graph.facebook.com/v26.0/p1/picture',
      },
      {
        id: page2Id,
        pageName: 'Beta Creator Page',
        profilePictureUrl: null,
      },
    ]);
  });
});


describe('Facebook OAuth callback account-save failures (BL1 fix)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let validEncryptedFbAppSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;

    validEncryptedFbAppSecret = await encryptToken(
      'mock_fb_app_secret_value',
      TEST_ENCRYPTION_KEY
    );

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

  function mockGraphSuccess() {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'short_lived_token_abc',
            token_type: 'bearer',
            expires_in: 7200,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'long_lived_token_xyz_60_days',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'fb_user_10928374', name: 'Alex Professional' }),
          { status: 200 }
        )
      );
  }

  async function validState(isMagic = false) {
    return signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'bl1_nonce_1234567890',
        ...(isMagic ? { isMagic: true } : {}),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );
  }

  /**
   * Minimal chainable Supabase-shaped mock. `from()` records the table so
   * the test can prove page-token refresh never ran (it starts by
   * querying `destinations`), and the social_accounts branches let each
   * test force exactly one failure mode.
   */
  function makeSupabaseMock(options: {
    existing?: Record<string, unknown> | null;
    existingError?: { message: string } | null;
    upsertError?: { message: string } | null;
  }) {
    const fromCalls: string[] = [];
    let upsertCalls = 0;
    let currentTable = '';
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.upsert = () => {
      upsertCalls += 1;
      return builder;
    };
    builder.update = () => builder;
    builder.maybeSingle = async () => {
      if (currentTable === 'workspaces') {
        return { data: { id: 'ws_123' }, error: null };
      }
      if (currentTable === 'platform_credentials') {
        return {
          data: {
            client_id: 'fb_app_id_123',
            encrypted_client_secret: validEncryptedFbAppSecret,
            status: 'valid',
          },
          error: null,
        };
      }
      if (currentTable === 'social_accounts') {
        if (options.existingError) {
          return { data: null, error: options.existingError };
        }
        return { data: options.existing ?? null, error: null };
      }
      return { data: null, error: null };
    };
    builder.single = async () => {
      if (options.upsertError) {
        return { data: null, error: options.upsertError };
      }
      return { data: { id: 'acc_123' }, error: null };
    };
    const client = {
      from: (table: string) => {
        fromCalls.push(table);
        currentTable = table;
        return builder;
      },
    };
    return {
      client: client as unknown as Parameters<typeof handleFacebookCallback>[1],
      fromCalls,
      get upsertCalls() {
        return upsertCalls;
      },
    };
  }

  it('redirects to the save-error surface, not success, when a new account upsert fails — and never refreshes page tokens', async () => {
    mockGraphSuccess();
    const mock = makeSupabaseMock({
      existing: null,
      upsertError: { message: 'duplicate key violates unique constraint' },
    });
    const state = await validState();
    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=mock_code_123&state=${state}`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleFacebookCallback(req, mock.client);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/tenant/acme/accounts?error=account_save_failed');
    expect(location).not.toContain('connected=1');
    expect(location).not.toContain('accountName=');
    expect(mock.upsertCalls).toBe(1);
    // Page-token refresh starts by querying destinations; it must not run
    // for an account that was never saved.
    expect(mock.fromCalls).not.toContain('destinations');
  });

  it('is a hard error, not connected-with-old-token, when an existing account update fails', async () => {
    mockGraphSuccess();
    const mock = makeSupabaseMock({
      existing: { id: 'acc_existing', status: 'active', metadata: {} },
      upsertError: { message: 'row-level security violation' },
    });
    const state = await validState();
    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=mock_code_123&state=${state}`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleFacebookCallback(req, mock.client);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/tenant/acme/accounts?error=account_save_failed');
    expect(location).not.toContain('connected=already');
    expect(location).not.toContain('connected=1');
    expect(mock.fromCalls).not.toContain('destinations');
  });

  it('is a hard error when the existing-row lookup itself fails, before any upsert', async () => {
    mockGraphSuccess();
    const mock = makeSupabaseMock({
      existingError: { message: 'multiple rows returned' },
    });
    const state = await validState();
    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=mock_code_123&state=${state}`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleFacebookCallback(req, mock.client);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/tenant/acme/accounts?error=account_save_failed');
    expect(location).not.toContain('connected=1');
    expect(mock.upsertCalls).toBe(0);
    expect(mock.fromCalls).not.toContain('destinations');
  });

  it('sends magic flows to the app-host magic error page with the save-failed reason', async () => {
    mockGraphSuccess();
    const mock = makeSupabaseMock({
      existing: null,
      upsertError: { message: 'duplicate key violates unique constraint' },
    });
    const state = await validState(true);
    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=mock_code_123&state=${state}`
    );

    const res = await handleFacebookCallback(req, mock.client);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toBe(
      'http://localhost:3000/connect/facebook/error?reason=account_save_failed'
    );
    expect(location).not.toContain('/accounts?connected');
    expect(mock.fromCalls).not.toContain('destinations');
  });
});
