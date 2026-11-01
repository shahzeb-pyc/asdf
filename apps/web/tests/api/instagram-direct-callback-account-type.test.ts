import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signOAuthState,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleInstagramCallback } from '../../src/app/api/auth/instagram/callback/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-for-ig-direct-patch-tests-0123456789';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Ported from the deleted `connect-instagram.test.ts` (which tested the
 * removed framework static complete route): the account-type patch
 * survives in the DIRECT callback, which writes the provider-reported
 * account type into the destination row's metadata itself
 * (step 4 of `handleInstagramCallback`). These tests pin that live
 * behavior: the story gate reads this key, so losing it would
 * silently unoffer Stories to Business accounts.
 */
describe('Instagram direct callback writes the account type', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let validEncryptedIgAppSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;

    validEncryptedIgAppSecret = await encryptToken('ig_app_secret_456', TEST_ENCRYPTION_KEY);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals?.();
  });

  interface CapturedQuery {
    sql: string;
    params?: unknown[] | undefined;
  }

  function mockDb(): { db: DatabaseClient; queries: CapturedQuery[] } {
    const queries: CapturedQuery[] = [];
    const db = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
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
    return { db, queries };
  }

  function mockInstagramFetch(accountType: string): void {
    const profile = {
      id: 'ig_user_999',
      username: 'sunsetbakery',
      name: 'Sunset Bakery',
      account_type: accountType,
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

  async function runDirectCallback(accountType: string): Promise<{
    res: Response;
    queries: CapturedQuery[];
  }> {
    mockInstagramFetch(accountType);
    const state = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'test_nonce_12345678',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );
    const req = new NextRequest(
      `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`,
      { headers: { cookie: validSessionCookie } }
    );
    const { db, queries } = mockDb();
    const res = await handleInstagramCallback(req, db);
    return { res, queries };
  }

  function destinationPatch(queries: CapturedQuery[]): Record<string, unknown> | null {
    const update = queries.find((q) => q.sql.startsWith('UPDATE destinations'));
    if (!update || !Array.isArray(update.params) || typeof update.params[0] !== 'string') {
      return null;
    }
    try {
      return JSON.parse(update.params[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  it('writes the Business type verbatim into the destination metadata', async () => {
    const { res, queries } = await runDirectCallback('BUSINESS');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(destinationPatch(queries)).toEqual({ account_type: 'BUSINESS' });
  });

  it('writes the Creator type verbatim too (the gate needs the real type, not just Business)', async () => {
    const { res, queries } = await runDirectCallback('CREATOR');
    expect(res.status).toBe(307);
    expect(destinationPatch(queries)).toEqual({ account_type: 'CREATOR' });
  });

  it('never writes the account type into social_accounts metadata', async () => {
    const { res, queries } = await runDirectCallback('BUSINESS');
    expect(res.status).toBe(307);
    const socialAccountWrites = queries.filter(
      (q) =>
        q.sql.includes('social_accounts') &&
        (q.sql.includes('account_type') ||
          JSON.stringify(q.params ?? []).includes('account_type'))
    );
    expect(socialAccountWrites).toEqual([]);
  });
});
