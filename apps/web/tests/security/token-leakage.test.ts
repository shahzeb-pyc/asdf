import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleListAccounts } from '../../src/app/api/tenant/[subdomain]/accounts/route';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import { handleDiscoverPages } from '../../src/app/api/tenant/[subdomain]/accounts/[accountId]/pages/discover/route';
import { handleImportPages } from '../../src/app/api/tenant/[subdomain]/pages/import/route';
import type { Database } from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Security Audit: Zero Token & Credential Leakage (T075)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const accountId = '22222222-2222-4222-a222-222222222222';
  const pageId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;
  let sampleCiphertext: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;

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
    sampleCiphertext = await encryptToken('super_confidential_raw_fb_token_xyz', TEST_KEY);
  });

  it('GET /accounts never leaks raw or encrypted access tokens in JSON body or headers', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          const builder: any = {
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: accountId,
                  external_account_id: 'fb_123',
                  display_name: 'Marketing Lead',
                  avatar_url: null,
                  metadata: {},
                  status: 'active',
                  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
                  encrypted_access_token: sampleCiphertext,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  destinations: [
                    {
                      id: pageId,
                      name: 'Brand Main Page',
                      avatar_url: null,
                      status: 'active',
                      workspace_id: 'ws_123',
                      metadata: {},
                    },
                  ],
                },
              ],
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListAccounts(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('super_confidential_raw_fb_token_xyz');
    expect(bodyText).not.toContain(sampleCiphertext);
    expect(bodyText).not.toContain('encrypted_access_token');
    expect(bodyText).not.toContain('encryptedAccessToken');
    expect(bodyText).not.toContain('TOKEN_ENCRYPTION_KEY');
  });

  it('GET /pages never leaks raw or encrypted access tokens in JSON body', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            order: vi.fn(() => builder),
              data: [
                {
                  id: pageId,
                  account_id: accountId,
                  workspace_id: 'ws_123',
                  external_destination_id: 'page_987',
                  name: 'Brand Main Page',
                  avatar_url: null,
                  status: 'active',
                  metadata: {
                    category: 'Retail',
                    starting_followers: 50000,
                    current_followers: 50000,
                    tasks: ['CREATE_CONTENT'],
                  },
                  encrypted_destination_token: sampleCiphertext,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  social_accounts: {
                    display_name: 'Marketing Lead',
                  },
                },
              ],
              error: null,
          };
          builder.eq = vi.fn(() => builder);
          builder.neq = vi.fn(() => builder);
          builder.or = vi.fn(() => builder);
          builder.not = vi.fn(() => builder);
          builder.range = vi.fn(() =>
            Promise.resolve({ data: builder.data, error: null })
          );
          builder.then = vi.fn((resolve: (value: unknown) => void) =>
            resolve({
              count: (builder.data as unknown[]).length,
              data: builder.data,
              error: null,
            })
          );
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
      headers: { cookie: validSessionCookie },
    });

    const res = await handleListPages(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('super_confidential_raw_fb_token_xyz');
    expect(bodyText).not.toContain(sampleCiphertext);
    expect(bodyText).not.toContain('encrypted_access_token');
    expect(bodyText).not.toContain('encryptedAccessToken');
  });

  it('GET /discover strips Graph API Page access tokens from client payload', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          const builder: any = {
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: accountId,
                external_account_id: 'fb_123',
                display_name: 'Marketing Lead',
                encrypted_access_token: sampleCiphertext,
                status: 'active',
              },
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            then: (resolve: (val: any) => void) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page_12345',
              name: 'Enterprise Page',
              category: 'Business',
              followers_count: 1000,
              tasks: ['MANAGE'],
              access_token: 'EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK',
            },
          ],
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/accounts/${accountId}/pages/discover`,
      { headers: { cookie: validSessionCookie } }
    );

    const res = await handleDiscoverPages(req, 'acme', accountId, mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK');
    expect(bodyText).not.toContain('access_token');
    expect(bodyText).not.toContain(sampleCiphertext);
  });

  it('POST /import returns sanitized confirmation without leaking tokens', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'workspaces') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 'ws_123' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'social_accounts') {
          const builder: any = {
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: accountId,
                external_account_id: 'fb_123',
                display_name: 'Marketing Lead',
                encrypted_access_token: sampleCiphertext,
                status: 'active',
              },
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
          };
        }
        if (table === 'destinations') {
          const builder: any = {
            in: vi.fn().mockResolvedValue({
              data: [],
              error: null,
            }),
          };
          builder.eq = vi.fn(() => builder);
          return {
            select: vi.fn().mockReturnValue(builder),
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: pageId,
                    external_destination_id: 'page_12345',
                    name: 'Enterprise Page',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page_12345',
              name: 'Enterprise Page',
              category: 'Business',
              followers_count: 1000,
              tasks: ['MANAGE'],
              access_token: 'EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK',
            },
          ],
        }),
        { status: 200 }
      )
    );

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/pages/import',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: validSessionCookie,
        },
        body: JSON.stringify({
          accountId,
          selectedPageIds: ['page_12345'],
        }),
      }
    );

    const res = await handleImportPages(req, 'acme', mockSupabase);
    expect(res.status).toBe(200);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('EAA_RAW_PAGE_TOKEN_SECRET_NEVER_LEAK');
    expect(bodyText).not.toContain('access_token');
    expect(bodyText).not.toContain(sampleCiphertext);
  });
});
