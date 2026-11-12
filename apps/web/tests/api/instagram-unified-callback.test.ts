import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signOAuthState,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleInstagramCallback } from '../../src/app/api/auth/instagram/callback/route';
import { handleInitiateInstagramOAuth } from '../../src/app/api/auth/instagram/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * Unified Login callback tests, mirroring the PR #113 send-back fix:
 * a declined scope saves nothing (direct and magic), a failed probe
 * fails open, a missing Configuration ID never reaches a dialog, and
 * one connect persists every shared account. The old
 * instagram-direct-callback-account-type tests are superseded: BISU
 * assigned accounts carry no account_type, so destinations now carry
 * token_kind 'bisu' instead.
 */
describe('Instagram Unified Login callback', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  let validSessionCookie: string;
  let validEncryptedSecret: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;

    validEncryptedSecret = await encryptToken('ig_app_secret_456', TEST_ENCRYPTION_KEY);
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

  function mockDb(withConfigId: boolean): { db: DatabaseClient; queries: CapturedQuery[] } {
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
              encrypted_client_secret: validEncryptedSecret,
              ...(withConfigId ? { config_id: 'ig_config_789' } : {}),
            },
          ]);
        }
        if (sql.includes('SELECT id FROM social_accounts')) {
          return Promise.resolve([]);
        }
        if (sql.includes('INSERT INTO social_accounts')) {
          return Promise.resolve([{ id: `mock-account-${queries.length}` }]);
        }
        if (sql.includes('INSERT INTO destinations')) {
          return Promise.resolve([{ id: 'mock-destination-uuid' }]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;
    return { db, queries };
  }

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)),
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  function unifiedFetch(permissions: Array<{ permission: string; status: string }>): typeof fetch {
    return (async (url: string) => {
      if (url.includes('/oauth/access_token')) {
        return jsonResponse({ access_token: 'bisu_token_abc', token_type: 'bearer' });
      }
      if (url.includes('/me?fields=client_business_id')) {
        return jsonResponse({ client_business_id: 'biz_1', id: 'sys_1' });
      }
      if (url.includes('/me/assigned_instagram_accounts')) {
        return jsonResponse({
          data: [
            { id: 'ig_1', username: 'bakery' },
            { id: 'ig_2', username: 'bakery2' },
          ],
        });
      }
      if (url.includes('/me/permissions')) {
        return jsonResponse({ data: permissions });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
  }

  const allGranted = [
    { permission: 'instagram_basic', status: 'granted' },
    { permission: 'instagram_content_publish', status: 'granted' },
    { permission: 'instagram_manage_comments', status: 'granted' },
    { permission: 'instagram_manage_insights', status: 'granted' },
  ];

  async function runCallback(options: {
    isMagic?: boolean;
    fetchFn: typeof fetch;
    withConfigId?: boolean;
  }): Promise<{ res: Response; queries: CapturedQuery[] }> {
    const state = await signOAuthState(
      {
        tenantSubdomain: 'acme',
        userId,
        nonce: 'test_nonce_12345678',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        ...(options.isMagic ? { isMagic: true } : {}),
      },
      TEST_SECRET
    );
    const req = new NextRequest(
      `http://localhost:3000/api/auth/instagram/callback?code=mock_code&state=${state}`,
      { headers: { cookie: validSessionCookie } }
    );
    const { db, queries } = mockDb(options.withConfigId ?? true);
    const res = await handleInstagramCallback(req, db, options.fetchFn);
    return { res, queries };
  }

  it('declined direct: exact scope_rejected redirect and nothing saved', async () => {
    const declined = allGranted.map((entry) =>
      entry.permission === 'instagram_manage_comments'
        ? { ...entry, status: 'declined' }
        : entry
    );
    const { res, queries } = await runCallback({
      fetchFn: unifiedFetch(declined),
    });
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('error=scope_rejected');
    expect(location).toContain('missing=instagram_manage_comments');
    expect(queries.filter((q) => q.sql.includes('INSERT INTO social_accounts'))).toEqual([]);
    expect(queries.filter((q) => q.sql.includes('INSERT INTO destinations'))).toEqual([]);
  });

  it('declined magic: error page scope_rejected and nothing saved', async () => {
    const declined = allGranted.map((entry) =>
      entry.permission === 'instagram_manage_insights'
        ? { ...entry, status: 'declined' }
        : entry
    );
    const { res, queries } = await runCallback({
      isMagic: true,
      fetchFn: unifiedFetch(declined),
    });
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/connect/instagram/error');
    expect(location).toContain('reason=scope_rejected');
    expect(location).toContain('missing=instagram_manage_insights');
    expect(queries.filter((q) => q.sql.includes('INSERT INTO social_accounts'))).toEqual([]);
  });

  it('probe non-OK: fail-open success, accounts saved', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/me/permissions')) {
        return jsonResponse({ error: 'boom' }, false, 500);
      }
      return unifiedFetch(allGranted)(url);
    }) as unknown as typeof fetch;
    const { res, queries } = await runCallback({ fetchFn });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(
      queries.filter((q) => q.sql.includes('INSERT INTO social_accounts')).length
    ).toBe(2);
  });

  it('probe throws: fail-open success, accounts saved', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('/me/permissions')) {
        throw new Error('network down');
      }
      return unifiedFetch(allGranted)(url);
    }) as unknown as typeof fetch;
    const { res } = await runCallback({ fetchFn });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('connected=1');
  });

  it('several shared accounts: several account rows and zero destinations (spec 174 2A)', async () => {
    const { res, queries } = await runCallback({ fetchFn: unifiedFetch(allGranted) });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('connected=1');
    expect(
      queries.filter((q) => q.sql.includes('INSERT INTO social_accounts')).length
    ).toBe(2);
    // Connecting an account must never create a destinations row
    // (spec 174 2A): the accounts live only in Accounts, and every
    // section imports from there.
    expect(
      queries.filter((q) => q.sql.includes('INSERT INTO destinations')).length
    ).toBe(0);
    expect(
      queries.filter((q) => q.sql.startsWith('UPDATE destinations')).length
    ).toBe(0);
  });

  it('missing Configuration ID at callback: credentials_required, nothing saved', async () => {
    const { res, queries } = await runCallback({
      fetchFn: unifiedFetch(allGranted),
      withConfigId: false,
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=credentials_required');
    expect(queries.filter((q) => q.sql.includes('INSERT INTO social_accounts'))).toEqual([]);
  });

  it('initiate triple gate: missing Configuration ID goes to Settings, never to a dialog', async () => {
    const { db } = mockDb(false);
    const req = new NextRequest('http://localhost:3000/api/auth/instagram', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleInitiateInstagramOAuth(req, db);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings');
    expect(location).toContain('credentials_required');
    expect(location).not.toContain('dialog/oauth');
  });

  it('initiate with the triple: Unified dialog URL, no scope parameter', async () => {
    const { db } = mockDb(true);
    const req = new NextRequest('http://localhost:3000/api/auth/instagram', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleInitiateInstagramOAuth(req, db);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('facebook.com/dialog/oauth');
    expect(location).toContain('config_id=ig_config_789');
    expect(location).toContain('response_type=code');
    expect(location).not.toContain('scope=');
  });
});
