import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { decryptToken, encryptToken, signOAuthState, signSessionToken } from '@fbuploadpro/contracts';
import { handleFacebookCallback, refreshConnectedPageTokens } from '../../src/app/api/auth/facebook/callback/route';
import * as authModule from '@/lib/auth/clients';
import type { Database } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Multi-Account Facebook OAuth Connection (User Story 1 - T059 & Spec 031)', () => {
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

    validEncryptedFbAppSecret = await encryptToken('fb_app_secret_456', TEST_ENCRYPTION_KEY);

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

  function createMockAccountStore() {
    // Emulates the UNIFIED tables (Phase 7): accounts live in
    // social_accounts keyed by (workspace_id, platform,
    // external_account_id) with gender/account_link inside metadata;
    // pages live in destinations keyed by account row id, with the
    // destination token in encrypted_destination_token and a paused
    // page represented as status 'disconnected' + metadata.fb_status.
    const WORKSPACE_ID = 'ws_multi_123';
    const storedAccounts = new Map<
      string,
      {
        id: string;
        fbAccountId: string;
        displayName: string;
        token: string;
        profilePictureUrl: string | null;
        gender: string | null;
        accountLink: string | null;
        status: string;
      }
    >();

    const storedPages = new Map<
      string,
      {
        id: string;
        accountId: string;
        fbPageId: string;
        encryptedPageToken: string;
        status: string;
        metadata: Record<string, unknown>;
      }
    >();

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'social_accounts') {
          return {
            select: vi.fn().mockImplementation((_cols: string) => {
              let selectedFbAccountId = '';
              const chain = {
                eq: vi.fn().mockImplementation((col: string, val: string) => {
                  if (col === 'external_account_id') selectedFbAccountId = val;
                  return chain;
                }),
                maybeSingle: vi.fn().mockImplementation(() => {
                  const existing = storedAccounts.get(`${WORKSPACE_ID}:${selectedFbAccountId}`);
                  return Promise.resolve({
                    data: existing
                      ? {
                          id: existing.id,
                          status: existing.status,
                          metadata: {
                            gender: existing.gender,
                            account_link: existing.accountLink,
                          },
                        }
                      : null,
                    error: null,
                  });
                }),
              };
              return chain;
            }),
            upsert: vi.fn().mockImplementation((record: Record<string, any>) => {
              const fbAccountId = record.external_account_id as string;
              const existing = storedAccounts.get(`${WORKSPACE_ID}:${fbAccountId}`);
              const rowId = existing?.id ?? `acc_${fbAccountId}`;
              const metadata = (record.metadata ?? {}) as Record<string, unknown>;
              storedAccounts.set(`${WORKSPACE_ID}:${fbAccountId}`, {
                id: rowId,
                fbAccountId,
                displayName: record.display_name,
                token: record.encrypted_access_token,
                profilePictureUrl: record.avatar_url ?? null,
                gender: (metadata.gender as string | null) ?? null,
                accountLink: (metadata.account_link as string | null) ?? null,
                status: 'active',
              });
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { id: rowId },
                    error: null,
                  }),
                }),
              };
            }),
          };
        }

        if (table === 'destinations') {
          return {
            select: vi.fn().mockImplementation((_cols: string) => {
              let filterAccountId = '';
              const chain: any = {
                eq: vi.fn().mockImplementation((col: string, val: string) => {
                  if (col === 'account_id') filterAccountId = val;
                  return chain;
                }),
                then: (resolve: (val: any) => void) => {
                  const matching = Array.from(storedPages.values())
                    .filter((p) => !filterAccountId || p.accountId === filterAccountId)
                    .map((p) => ({
                      id: p.id,
                      external_destination_id: p.fbPageId,
                      status: p.status,
                      metadata: p.metadata,
                    }));
                  return Promise.resolve({ data: matching, error: null }).then(resolve);
                },
              };
              return chain;
            }),
            update: vi.fn().mockImplementation((updates: Record<string, any>) => {
              let targetPageId = '';
              const applyUpdates = () => {
                const existingPage = storedPages.get(targetPageId);
                if (existingPage) {
                  if (updates.encrypted_destination_token) {
                    existingPage.encryptedPageToken = updates.encrypted_destination_token;
                  }
                  if (updates.status) {
                    existingPage.status = updates.status;
                  }
                }
              };
              const chain: any = {
                eq: vi.fn().mockImplementation((col: string, val: string) => {
                  if (col === 'id') targetPageId = val;
                  applyUpdates();
                  return chain;
                }),
                then: (resolve: (val: any) => void) => {
                  applyUpdates();
                  return Promise.resolve({ error: null }).then(resolve);
                },
              };
              return chain;
            }),
          };
        }

        if (table === 'workspaces') {
          const wsQuery = {
            eq: vi.fn().mockImplementation(() => wsQuery),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: 'ws_multi_123', subdomain: 'acme' },
              error: null,
            }),
          };
          return {
            select: vi.fn().mockReturnValue(wsQuery),
          };
        }

        if (table === 'platform_credentials') {
          const credsBuilder: any = {
            eq: vi.fn(() => credsBuilder),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                client_id: 'fb_app_id_123',
                encrypted_client_secret: validEncryptedFbAppSecret,
              },
              error: null,
            }),
          };
          return {
            select: vi.fn().mockReturnValue(credsBuilder),
          };
        }

        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    return { storedAccounts, storedPages, mockSupabase };
  }

  it('allows connecting multiple distinct Facebook accounts under the same workspace without collisions', async () => {
    const statePayload = {
      tenantSubdomain: 'acme',
      userId,
      nonce: 'nonce_multi_12345',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const validState = await signOAuthState(statePayload, TEST_SECRET);
    const { storedAccounts, mockSupabase } = createMockAccountStore();

    // Simulate Account 1 connection (with picture.data.url, gender, and link)
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short_1', token_type: 'bearer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long_1', token_type: 'bearer', expires_in: 5184000 })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'fb_user_alpha',
            name: 'Alpha Agency Profile',
            gender: 'female',
            link: 'https://www.facebook.com/app_scoped_user_id/fb_user_alpha/',
            picture: { data: { url: 'https://platform-lookaside.fbsbx.com/platform/profilepic/alpha.jpg' } },
          })
        )
      );

    const req1 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_alpha&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );
    await handleFacebookCallback(req1, mockSupabase);

    // Simulate Account 2 connection (without picture, gender, or link -> null fallback)
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short_2', token_type: 'bearer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long_2', token_type: 'bearer', expires_in: 5184000 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'fb_user_beta', name: 'Beta Personal Profile' })));

    const req2 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_beta&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );
    await handleFacebookCallback(req2, mockSupabase);

    // Verify both distinct accounts are preserved in the workspace with profile_picture_url, gender, and account_link
    expect(storedAccounts.size).toBe(2);
    expect(storedAccounts.get(`ws_multi_123:fb_user_alpha`)?.displayName).toBe('Alpha Agency Profile');
    expect(storedAccounts.get(`ws_multi_123:fb_user_alpha`)?.profilePictureUrl).toBe(
      'https://platform-lookaside.fbsbx.com/platform/profilepic/alpha.jpg'
    );
    expect(storedAccounts.get(`ws_multi_123:fb_user_alpha`)?.gender).toBe('female');
    expect(storedAccounts.get(`ws_multi_123:fb_user_alpha`)?.accountLink).toBe(
      'https://www.facebook.com/app_scoped_user_id/fb_user_alpha/'
    );
    expect(storedAccounts.get(`ws_multi_123:fb_user_beta`)?.displayName).toBe('Beta Personal Profile');
    expect(storedAccounts.get(`ws_multi_123:fb_user_beta`)?.profilePictureUrl).toBeNull();
    expect(storedAccounts.get(`ws_multi_123:fb_user_beta`)?.gender).toBeNull();
    expect(storedAccounts.get(`ws_multi_123:fb_user_beta`)?.accountLink).toBeNull();
  });

  it('updates existing credentials, profile_picture_url, gender, and account_link when reconnecting the same Facebook account', async () => {
    const statePayload = {
      tenantSubdomain: 'acme',
      userId,
      nonce: 'nonce_multi_reconnect',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const validState = await signOAuthState(statePayload, TEST_SECRET);
    const { storedAccounts, mockSupabase } = createMockAccountStore();

    // Initial connection
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short_1', token_type: 'bearer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long_initial', token_type: 'bearer', expires_in: 5184000 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'fb_user_same', name: 'Same Profile' })));

    const req1 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_1&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );
    await handleFacebookCallback(req1, mockSupabase);

    // Reconnection of same fbAccountId with updated avatar, gender, and link
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'short_2', token_type: 'bearer' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'long_refreshed', token_type: 'bearer', expires_in: 5184000 })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'fb_user_same',
            name: 'Same Profile Renamed',
            gender: 'male',
            link: 'https://www.facebook.com/app_scoped_user_id/fb_user_same/',
            picture: { data: { url: 'https://platform-lookaside.fbsbx.com/platform/profilepic/refreshed.jpg' } },
          })
        )
      );

    const req2 = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_2&state=${validState}`,
      { headers: { cookie: validSessionCookie } }
    );
    const res2 = await handleFacebookCallback(req2, mockSupabase);

    // Standard connect flow for already-connected account redirects with ?connected=already&accountName=...
    expect(res2.status).toBe(307);
    expect(res2.headers.get('location')).toBe(
      'http://localhost:3000/tenant/acme/accounts?connected=already&accountName=Same+Profile+Renamed'
    );

    // Size remains 1 (no duplicate rows created)
    expect(storedAccounts.size).toBe(1);
    expect(storedAccounts.get(`ws_multi_123:fb_user_same`)?.displayName).toBe('Same Profile Renamed');
    expect(storedAccounts.get(`ws_multi_123:fb_user_same`)?.profilePictureUrl).toBe(
      'https://platform-lookaside.fbsbx.com/platform/profilepic/refreshed.jpg'
    );
    expect(storedAccounts.get(`ws_multi_123:fb_user_same`)?.gender).toBe('male');
    expect(storedAccounts.get(`ws_multi_123:fb_user_same`)?.accountLink).toBe(
      'https://www.facebook.com/app_scoped_user_id/fb_user_same/'
    );
  });

  it('auto-refreshes the destination token for all linked pages on reconnect and sets status = active ONLY for error (invalid-token) pages without importing unlinked pages (Spec 031)', async () => {
    const { storedAccounts, storedPages, mockSupabase } = createMockAccountStore();
    storedAccounts.set(`ws_multi_123:fb-john`, {
      id: 'acc_fb-john',
      fbAccountId: 'fb-john',
      displayName: 'John Doe',
      token: 'old_encrypted_token',
      profilePictureUrl: null,
      gender: 'male',
      accountLink: null,
      status: 'expired',
    });

    // Unified destination states: the legacy 'invalid_token' page is
    // status 'error'; the legacy 'paused' page is status
    // 'disconnected' carrying the fb_status paused marker.
    storedPages.set('page_row_a', {
      id: 'page_row_a',
      accountId: 'acc_fb-john',
      fbPageId: 'fb_page_a',
      encryptedPageToken: 'stale_token_a',
      status: 'error',
      metadata: {},
    });
    storedPages.set('page_row_b', {
      id: 'page_row_b',
      accountId: 'acc_fb-john',
      fbPageId: 'fb_page_b',
      encryptedPageToken: 'stale_token_b',
      status: 'disconnected',
      metadata: { fb_status: 'paused' },
    });
    storedPages.set('page_row_c', {
      id: 'page_row_c',
      accountId: 'acc_fb-john',
      fbPageId: 'fb_page_c',
      encryptedPageToken: 'stale_token_c',
      status: 'active',
      metadata: {},
    });

    const reconnectState = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'nonce_page_sync_12345',
        expectedFbAccountId: 'fb-john',
        expectedDisplayName: 'John Doe',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );

    global.fetch = vi
      .fn()
      // 1. Short-lived token
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'short_john', token_type: 'bearer' }))
      )
      // 2. Long-lived token
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'long_john_fresh',
            token_type: 'bearer',
            expires_in: 5184000,
          })
        )
      )
      // 3. /me
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'fb-john', name: 'John Doe' }))
      )
      // 4. /me/accounts?fields=id,access_token (includes 3 linked pages + 1 unlinked page)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: 'fb_page_a', access_token: 'fresh_page_token_a' },
              { id: 'fb_page_b', access_token: 'fresh_page_token_b' },
              { id: 'fb_page_c', access_token: 'fresh_page_token_c' },
              { id: 'fb_page_unlinked_d', access_token: 'fresh_page_token_d' },
            ],
          })
        )
      );

    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_john&state=${reconnectState}`,
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleFacebookCallback(req, mockSupabase);

    expect(res.status).toBe(307);
    // The direct-flow redirect now carries accountName so the Accounts
    // page can toast the connected account by name (Option B dialogue).
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/tenant/acme/accounts?connected=1&accountName=John+Doe'
    );

    // Verify all 3 linked pages had their tokens encrypted and updated
    expect(
      await decryptToken(storedPages.get('page_row_a')!.encryptedPageToken, TEST_ENCRYPTION_KEY)
    ).toBe('fresh_page_token_a');
    expect(
      await decryptToken(storedPages.get('page_row_b')!.encryptedPageToken, TEST_ENCRYPTION_KEY)
    ).toBe('fresh_page_token_b');
    expect(
      await decryptToken(storedPages.get('page_row_c')!.encryptedPageToken, TEST_ENCRYPTION_KEY)
    ).toBe('fresh_page_token_c');

    // Verify status transition: error -> active, paused (disconnected
    // + marker) -> still paused, active -> active
    expect(storedPages.get('page_row_a')!.status).toBe('active');
    expect(storedPages.get('page_row_b')!.status).toBe('disconnected');
    expect(storedPages.get('page_row_b')!.metadata.fb_status).toBe('paused');
    expect(storedPages.get('page_row_c')!.status).toBe('active');

    // Verify unlinked page was NOT auto-imported
    expect(storedPages.size).toBe(3);
  });

  it('saves the newly authenticated account AND redirects with ?reconnected_mismatch=1 when Facebook returns a different account than expectedFbAccountId (Spec 031)', async () => {
    const { storedAccounts, mockSupabase } = createMockAccountStore();
    storedAccounts.set(`ws_multi_123:fb-john`, {
      id: 'acc_fb-john',
      fbAccountId: 'fb-john',
      displayName: 'John Doe',
      token: 'expired_token',
      profilePictureUrl: null,
      gender: 'male',
      accountLink: null,
      status: 'expired',
    });

    const mismatchState = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'nonce_mismatch_12345',
        expectedFbAccountId: 'fb-john',
        expectedDisplayName: 'John Doe',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'short_jane', token_type: 'bearer' }))
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'long_jane',
            token_type: 'bearer',
            expires_in: 5184000,
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'fb-jane', name: 'Jane Smith' }))
      );

    const req = new NextRequest(
      `http://localhost:3000/api/auth/facebook/callback?code=code_jane&state=${mismatchState}`,
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleFacebookCallback(req, mockSupabase);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/tenant/acme/accounts?reconnected_mismatch=1&newAccountName=Jane+Smith&expectedAccountName=John+Doe'
    );

    // Jane Smith is saved as active while John Doe remains untouched in the store
    expect(storedAccounts.get(`ws_multi_123:fb-jane`)?.displayName).toBe('Jane Smith');
    expect(storedAccounts.get(`ws_multi_123:fb-jane`)?.status).toBe('active');
    expect(storedAccounts.get(`ws_multi_123:fb-john`)?.status).toBe('expired');
  });

  it('updates destinations with encrypted_destination_token and no token_expires_at via Supabase, logging errors if any occur', async () => {
    const updateSpy = vi.fn();
    const selectEqMock: any = {
      eq: vi.fn().mockImplementation(() => selectEqMock),
      then: (resolve: (val: any) => void) =>
        Promise.resolve({
          data: [
            { id: 'page_123', external_destination_id: 'fb_p_1', status: 'error', metadata: {} },
          ],
          error: null,
        }).then(resolve),
    };
    const updateEqMock = {
      eq: vi.fn().mockImplementation((col: string) => {
        if (col === 'workspace_id') {
          return Promise.resolve({ error: { message: 'database permission denied' } });
        }
        return updateEqMock;
      }),
    };

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'destinations') {
          return {
            select: vi.fn().mockReturnValue(selectEqMock),
            update: updateSpy.mockReturnValue(updateEqMock),
          };
        }
        return {};
      }),
    };

    vi.spyOn(authModule, 'getSupabaseAdminClient').mockReturnValue(mockSupabase as any);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'fb_p_1', access_token: 'fresh_page_secret' }],
        })
      )
    );

    await refreshConnectedPageTokens(
      null,
      userId,
      'ws_123',
      'acc_123',
      'long_access_token_123',
      new Date(),
      TEST_ENCRYPTION_KEY
    );

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_destination_token: expect.any(String),
        status: 'active',
      })
    );
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('token_expires_at');
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('encrypted_page_token');
    expect(updateSpy.mock.calls[0][0]).not.toHaveProperty('encrypted_access_token');

    expect(warnSpy).toHaveBeenCalledWith(
      '[FacebookOAuth] Failed to update destination token:',
      'database permission denied'
    );

    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });
});

